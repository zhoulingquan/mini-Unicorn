"""Settings REST helpers for the WebUI HTTP surface.

The WebSocket channel owns transport/authentication. This module owns the
settings payload shape and the allowlisted config mutations exposed to WebUI.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Literal

from loguru import logger

from miniUnicorn.config.loader import (
    DEFAULT_CONTEXT_WINDOW,
    get_config_path,
    load_config,
    save_config,
)
from miniUnicorn.config.schema import ModelPresetConfig
from miniUnicorn.providers.registry import PROVIDERS, find_by_name
from miniUnicorn.security.workspace_access import workspace_sandbox_status
from miniUnicorn.webui.workspaces import (
    read_webui_default_access_mode,
    write_webui_default_access_mode,
)

QueryParams = dict[str, list[str]]
RuntimeSurface = Literal["browser", "native"]

_RUNTIME_CAPABILITIES = {
    "can_restart_engine": False,
    "can_pick_folder": False,
    "can_open_logs": False,
    "can_export_diagnostics": False,
}

_NATIVE_RUNTIME_CAPABILITIES = {
    **_RUNTIME_CAPABILITIES,
    "can_restart_engine": True,
    "can_pick_folder": True,
    "can_open_logs": True,
    "can_export_diagnostics": True,
}

_BROWSER_RESTART_BEHAVIOR_BY_SECTION = {
    "appearance": "none",
    "models": "none",
    "providers": "none",
    "runtime": "none",
    "browser": "engineRestart",
    "apps": "engineRestart",
    "advanced": "appRestart",
}

_NATIVE_RESTART_BEHAVIOR_BY_SECTION = {
    **_BROWSER_RESTART_BEHAVIOR_BY_SECTION,
    "browser": "engineRestart",
    "apps": "engineRestart",
}

_MODEL_CONFIGURATION_SLUG_RE = re.compile(r"[^a-z0-9_-]+")


class WebUISettingsError(ValueError):
    """User-facing settings validation failure."""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _normalize_surface(surface: str | None) -> RuntimeSurface:
    return "native" if surface in {"native", "desktop"} else "browser"


def runtime_capabilities(
    surface: str | None = "browser",
    overrides: dict[str, Any] | None = None,
) -> dict[str, bool]:
    """Return the capability flags exposed to the WebUI runtime."""
    base = (
        _NATIVE_RUNTIME_CAPABILITIES
        if _normalize_surface(surface) == "native"
        else _RUNTIME_CAPABILITIES
    )
    result = dict(base)
    for key, value in (overrides or {}).items():
        if key in result:
            result[key] = bool(value)
    return result


def restart_behavior_by_section(surface: str | None = "browser") -> dict[str, str]:
    return dict(
        _NATIVE_RESTART_BEHAVIOR_BY_SECTION
        if _normalize_surface(surface) == "native"
        else _BROWSER_RESTART_BEHAVIOR_BY_SECTION
    )


def decorate_settings_payload(
    payload: dict[str, Any],
    *,
    surface: str | None = "browser",
    runtime_capability_overrides: dict[str, Any] | None = None,
    restart_required_sections: list[str] | None = None,
    apply_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Attach runtime-surface metadata without changing the core settings shape."""
    surface_value = _normalize_surface(surface)
    sections = restart_required_sections
    if sections is None:
        raw_sections = payload.get("restart_required_sections") or []
        sections = [str(section) for section in raw_sections if isinstance(section, str)]
    sections = sorted(dict.fromkeys(sections))
    result = dict(payload)
    result["surface"] = surface_value
    result["runtime_surface"] = surface_value
    result["runtime_capabilities"] = runtime_capabilities(
        surface_value,
        runtime_capability_overrides,
    )
    result["restart_behavior_by_section"] = restart_behavior_by_section(surface_value)
    result["restart_required_sections"] = sections
    if sections:
        result["requires_restart"] = True
    else:
        result["requires_restart"] = bool(result.get("requires_restart", False))
    result["apply_state"] = apply_state or {
        "status": "pending" if result["requires_restart"] else "idle",
        "sections": sections,
    }
    return result


def _query_first(query: QueryParams, key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def _query_first_alias(query: QueryParams, snake: str, camel: str) -> str | None:
    value = _query_first(query, snake)
    return _query_first(query, camel) if value is None else value


def _mask_secret_hint(secret: str | None) -> str | None:
    if not secret:
        return None
    if len(secret) <= 8:
        return "••••"
    return f"{secret[:4]}••••{secret[-4:]}"


def _provider_requires_api_key(spec: Any) -> bool:
    if spec.is_local or spec.is_direct:
        return False
    return True


def _provider_configured_for_settings(spec: Any, provider_config: Any) -> bool:
    if _provider_requires_api_key(spec):
        return bool(provider_config.api_key)
    return bool(
        provider_config.api_key
        or provider_config.api_base
        or getattr(provider_config, "region", None)
        or getattr(provider_config, "profile", None)
    )


def _parse_bool(value: str, field: str) -> bool:
    normalized = value.strip().lower()
    if normalized not in {"1", "0", "true", "false", "yes", "no"}:
        raise WebUISettingsError(f"{field} must be boolean")
    return normalized in {"1", "true", "yes"}


def _parse_context_window_tokens(value: str | None) -> int | None:
    """解析上下文窗口输入,支持 ``k``/``K``/``m``/``M`` 后缀。

    示例:
        "32000"   -> 32000
        "32k"/"32K"  -> 32000
        "1m"/"1M"    -> 1000000
        "1.5k"    -> 1500
        "0.5m"    -> 500000
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    # 单位映射: k/K → 1000, m/M → 1_000_000
    multiplier = 1
    if raw[-1] in ("k", "K"):
        multiplier = 1_000
        raw = raw[:-1]
    elif raw[-1] in ("m", "M"):
        multiplier = 1_000_000
        raw = raw[:-1]
    try:
        parsed = float(raw)
    except ValueError:
        raise WebUISettingsError(
            "context_window_tokens 必须是整数或带 k/m 后缀的数字(如 32000、32k、1m)"
        ) from None
    parsed = int(round(parsed * multiplier))
    if parsed <= 0:
        raise WebUISettingsError("context_window_tokens must be a positive integer")
    return parsed


def _resolve_context_window_for_settings(
    model: str, configured: int | None
) -> dict[str, Any]:
    """Return the effective context window size and its resolution status.

    Resolution order (read-only, does NOT trigger HF queries):
    1. Explicit user-configured value (``context_window_tokens`` in config).
    2. Permanent learning table entry (already learned by a prior save).

    Use :func:`_trigger_model_learning` to actively query HF when a model is
    saved/selected.

    Returns a dict:
    {
        "limit": int,                     # resolved context window size
        "status": "configured" | "learned" | "unknown" | "not_found" | "default",
        "error": str | None,              # populated when status == "unknown" / "not_found"
                                          # (carries the last failure reason)
    }
    """
    if isinstance(configured, int) and configured > 0:
        return {"limit": configured, "status": "configured", "error": None}
    if not model:
        return {"limit": DEFAULT_CONTEXT_WINDOW, "status": "default", "error": None}
    try:
        from miniUnicorn.cli.models import (
            LEARNED_FAILURE_SKIP_THRESHOLD,
            _load_learned_entry,
            _normalize_model_name,
        )

        key = _normalize_model_name(model)
        entry = _load_learned_entry(key) if key else None
    except Exception:
        entry = None

    if entry is not None and isinstance(entry.get("limit"), int):
        return {
            "limit": entry["limit"],
            "status": "learned",
            "error": None,
        }
    # 失败计数达阈值 → not_found(已确认模型在 HF/ModelScope 上不存在)
    if isinstance(entry, dict):
        fail_count = entry.get("failure_count", 0)
        if isinstance(fail_count, int) and fail_count >= LEARNED_FAILURE_SKIP_THRESHOLD:
            return {
                "limit": DEFAULT_CONTEXT_WINDOW,
                "status": "not_found",
                "error": entry.get("error") or f"已在 HF/ModelScope 查询 {fail_count} 次均未找到,请手动输入上下文大小",
            }
    # Not yet learned — surface the last failure reason if any.
    error = entry.get("error") if isinstance(entry, dict) else None
    return {
        "limit": DEFAULT_CONTEXT_WINDOW,
        "status": "unknown",
        "error": error or "尚未查询,保存模型后将自动从 HuggingFace 查询",
    }


async def _run_model_learning_async(model: str) -> None:
    """Run the blocking HF context-window query in a worker thread.

    Persists success/failure to the learning table so the next
    ``settings_payload`` read surfaces the result without re-querying.
    """
    try:
        from miniUnicorn.cli.models import learn_model_context_limit

        result = await asyncio.to_thread(learn_model_context_limit, model)
    except Exception as exc:
        logger.warning("Background HF learning failed for '{}': {}", model, exc)
        _persist_learning_failure(model, str(exc))
        return

    if result.get("status") == "ok" and isinstance(result.get("limit"), int):
        return  # Success — already persisted by learn_model_context_limit.
    error = result.get("error") or "未知错误"
    _persist_learning_failure(model, error)


def _persist_learning_failure(model: str, error: str) -> None:
    """Persist a learning failure, logging instead of silently swallowing."""
    try:
        from miniUnicorn.cli.models import _save_learned_failure

        _save_learned_failure(model, error)
    except Exception as exc:
        logger.warning(
            "Failed to persist model learning failure for '{}': {}", model, exc
        )


def _trigger_model_learning(model: str) -> None:
    """Schedule Hugging Face context-window learning as a background task.

    Previously this blocked the settings save response on a synchronous HF
    query.  Now the query runs in a background task (via
    :func:`asyncio.create_task`) so the HTTP response returns immediately;
    the learned result is persisted to the learning table and surfaced on
    the next settings payload read.

    Falls back to an inline run when no event loop is running (e.g. CLI or
    test context) so learning still works outside the WebUI.
    """
    if not model:
        return
    try:
        asyncio.create_task(_run_model_learning_async(model))
    except RuntimeError:
        # No running event loop — run synchronously as a fallback.
        _run_model_learning_sync(model)


def _run_model_learning_sync(model: str) -> None:
    """Synchronous fallback for non-async contexts (CLI/tests)."""
    try:
        from miniUnicorn.cli.models import learn_model_context_limit

        result = learn_model_context_limit(model)
    except Exception as exc:
        logger.warning("HF learning failed for '{}': {}", model, exc)
        _persist_learning_failure(model, str(exc))
        return

    if result.get("status") == "ok" and isinstance(result.get("limit"), int):
        return
    error = result.get("error") or "未知错误"
    _persist_learning_failure(model, error)


def _model_configuration_slug(label: str) -> str:
    normalized = _MODEL_CONFIGURATION_SLUG_RE.sub("-", label.strip().lower())
    normalized = normalized.strip("-_")
    if not normalized:
        raise WebUISettingsError("configuration name is required")
    if normalized == "default":
        raise WebUISettingsError("configuration name is reserved")
    if len(normalized) > 48:
        normalized = normalized[:48].rstrip("-_")
    return normalized


def _validate_configured_provider(config: Any, provider: str) -> None:
    if provider == "auto":
        return
    spec = find_by_name(provider)
    if spec is None:
        raise WebUISettingsError("unknown provider")
    provider_config = getattr(config.providers, provider, None)
    if (
        provider_config is None
        or not _provider_configured_for_settings(spec, provider_config)
    ):
        raise WebUISettingsError("provider is not configured")


def _ctx_fields(model: str, configured: int | None) -> dict[str, Any]:
    """Build the resolved-context-window fields for a model row."""
    info = _resolve_context_window_for_settings(model, configured)
    return {
        "resolved_context_window_tokens": info["limit"],
        "resolved_context_window_status": info["status"],
        "resolved_context_window_error": info["error"],
    }


def _infer_custom_label_from_api_base(api_base: str) -> str:
    """从 api_base 推断 custom 配置的可读 label(取二级域名主体)。"""
    if not api_base:
        return "Custom"
    try:
        from urllib.parse import urlparse
        host = (urlparse(api_base).hostname or "").lower()
    except Exception:
        return "Custom"
    if not host:
        return "Custom"
    parts = host.split(".")
    # 跳过常见的无意义前缀/后缀(含以 api 开头的子域),取第一个有意义的部分
    skip = {"api", "apiv1", "v1", "www", "com", "cn", "org", "net", "io", "ai"}
    for part in parts:
        if part and part not in skip and not part.startswith("api"):
            return part.capitalize()
    return host.capitalize()


def _maybe_migrate_legacy_custom_provider(config: Any) -> bool:
    """把旧的 ``providers.custom`` 单例配置懒迁移为独立的 custom model_preset。

    旧模式下,用户通过 custom 单例添加的配置保存在 ``providers.custom``。
    新模式改为 per-preset 凭证(每个 custom 配置是独立的 model_preset)。
    如果检测到旧数据且 ``model_presets`` 中没有带凭证的 custom preset,则迁移。
    返回 True 表示发生了迁移(调用方可知悉)。
    """
    custom_config = getattr(config.providers, "custom", None)
    if custom_config is None:
        return False
    if not (custom_config.api_key or custom_config.api_base):
        return False
    # 已经有带凭证的 custom preset,不需要迁移
    for preset in config.model_presets.values():
        if preset.provider == "custom" and (preset.api_key or preset.api_base):
            return False
    defaults = config.agents.defaults
    api_base = custom_config.api_base or ""
    label = _infer_custom_label_from_api_base(api_base)
    name = _model_configuration_slug(label)
    # 确保 name 唯一
    base_name = name
    idx = 1
    while name in config.model_presets:
        idx += 1
        name = f"{base_name}_{idx}"
    config.model_presets[name] = ModelPresetConfig(
        label=label,
        model=defaults.model or "",
        provider="custom",
        max_tokens=defaults.max_tokens,
        # 不继承 default 的 context_window_tokens(见 create_model_configuration)
        context_window_tokens=None,
        temperature=defaults.temperature,
        reasoning_effort=defaults.reasoning_effort,
        api_key=custom_config.api_key,
        api_base=custom_config.api_base,
        extra_headers=custom_config.extra_headers,
        extra_body=custom_config.extra_body,
    )
    # 设为活跃 preset(若当前指向 default 或为空)
    if not defaults.model_preset or defaults.model_preset == "default":
        defaults.model_preset = name
    # 清空 providers.custom 单例的凭证(已迁移到 preset,避免重复显示)
    custom_config.api_key = None
    custom_config.api_base = None
    custom_config.extra_headers = None
    custom_config.extra_body = None
    save_config(config)
    logger.info(
        "Migrated legacy providers.custom credentials into model_preset '{}'",
        name,
    )
    return True


def _migrate_learned_binary_context_windows() -> bool:
    """把学习表中遗留的 1024 进位值(如 1048576)转换为 1000 进位等价值。

    背景:历史版本中 HF 查询返回的 ``max_position_embeddings`` 是 2 的幂,
    直接存入学习表。新版本在写入前统一调用 ``_normalize_to_decimal_k``
    转换为十进制值,但已存的旧数据需要一次性迁移。

    迁移规则:对学习表中每个 ``limit`` 字段,若为 1024 的整数倍,则转换为
    ``limit // 1024 * 1000``(如 1048576 → 1000000)。
    """
    try:
        from miniUnicorn.cli.models import (
            _get_learning_table_path,
            _load_learning_table,
            _normalize_to_decimal_k,
        )
    except Exception:
        return False

    try:
        path = _get_learning_table_path()
        if not path.exists():
            return False
        data = _load_learning_table()
        changed = False
        for key, entry in data.items():
            if not isinstance(entry, dict):
                continue
            limit = entry.get("limit")
            if not isinstance(limit, int) or limit <= 0:
                continue
            new_limit = _normalize_to_decimal_k(limit)
            if new_limit != limit:
                entry["limit"] = new_limit
                changed = True
                logger.info(
                    "Migrated learned context window for '{}' (binary {} → decimal {})",
                    key, limit, new_limit,
                )
        if changed:
            import json as _json
            path.write_text(
                _json.dumps(data, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        return changed
    except Exception as exc:
        logger.debug("迁移学习表二进制上下文值失败: {}", exc)
        return False


def _cleanup_inherited_context_window(config: Any) -> bool:
    """清理非 default preset 从 default 继承的 ``context_window_tokens``。

    历史版本中,创建 preset 时会复制 default 的 ``context_window_tokens``。
    这导致用户在 default 上手动配置的值(如 1000000)被所有 preset 继承,
    切换 preset 后输入框数字不变(后端 configured > 0 时直接返回,不走 HF 查询)。

    清理条件:preset 非 default,且 ``context_window_tokens`` 等于 default 的值,
    且 model 与 default 不同(说明是不同模型,继承值无意义)。
    清零后该 preset 会根据自身 model 走 HF 学习或显示默认值。

    额外清理:如果 default 自身的 ``context_window_tokens`` 是用户手动配置的,
    但 HF learned 表里已经有该 model 的学习值,也清除 default 的配置,
    让 learned 值能正常显示(用户期望看到查询到的上下文大小,而非旧的手动输入)。
    """
    defaults = config.agents.defaults
    default_cwt = defaults.context_window_tokens
    default_model = defaults.model
    changed = False

    if isinstance(default_cwt, int) and default_cwt > 0:
        # 1. 清理非 default preset 的继承值
        for preset in config.model_presets.values():
            if preset.context_window_tokens != default_cwt:
                continue
            if preset.model == default_model:
                # 同 model 的 preset,保留配置(用户可能确实想用这个值)
                continue
            preset.context_window_tokens = None
            changed = True

        # 2. 如果 default 自身的 configured 值存在,但 learned 表里已有该 model
        #    的学习值,清除 configured 让 learned 值生效。
        #    (用户手动输入通常是临时操作,learned 值更权威)
        if default_model:
            try:
                from miniUnicorn.cli.models import _load_learned_entry, _normalize_model_name

                key = _normalize_model_name(default_model)
                entry = _load_learned_entry(key) if key else None
            except Exception:
                entry = None
            if entry is not None and isinstance(entry.get("limit"), int):
                defaults.context_window_tokens = None
                changed = True

    if changed:
        save_config(config)
        logger.info(
            "Cleared inherited/manual context_window_tokens "
            "(inherited value={}, default model={})",
            default_cwt,
            default_model,
        )
    return changed


def _build_providers_section(config: Any) -> list[dict[str, Any]]:
    """Build the ``providers`` array for the settings payload.

    重构后"已配置区域"是配置的源:每个 ``model_presets`` 中的 preset(非 default)
    都生成一个 provider 条目作为已配置卡片。下拉列表(model_presets)与已配置区域
    一一对应。

    命名规则:
    - custom preset: ``custom__<preset_name>``(保留旧约定)
    - 其他 provider 的 preset: ``<provider>__<preset_name>``
    - custom 单例(``custom``)作为未配置区域的添加入口,保持现有逻辑

    向后兼容:对于非 custom provider 单例有凭证但没有 preset 引用的情况,
    仍显示 provider 单例(避免凭证配置丢失可见性)。
    """
    providers: list[dict[str, Any]] = []
    # 记录已被 preset 引用的 provider 单例名,避免重复显示
    consumed_provider_specs: set[str] = set()

    # 1) 为每个 model_preset 生成一个已配置卡片(源)
    for preset_name, preset in config.model_presets.items():
        provider_name = preset.provider
        is_custom_preset = provider_name == "custom"
        if is_custom_preset:
            card_name = f"custom__{preset_name}"
        else:
            card_name = f"{provider_name}__{preset_name}"
            # 标记该 provider 单例已被 preset 引用(不再单独显示)
            consumed_provider_specs.add(provider_name)

        # 凭证来源:preset 自带的 api_key/api_base 优先,
        # 否则回退到 provider 单例的凭证(向后兼容)
        provider_config = getattr(config.providers, provider_name, None)
        if preset.api_key or preset.api_base:
            api_key_hint = _mask_secret_hint(preset.api_key)
            api_base = preset.api_base
        elif provider_config is not None:
            api_key_hint = _mask_secret_hint(provider_config.api_key)
            api_base = preset.api_base or provider_config.api_base
        else:
            api_key_hint = None
            api_base = preset.api_base

        # 找到 provider spec 用于 default_api_base
        spec = find_by_name(provider_name)
        default_api_base = spec.default_api_base if spec else None

        providers.append({
            "name": card_name,
            "label": preset.label or preset_name,
            "configured": True,
            "auth_type": "api_key",
            "api_key_required": _provider_requires_api_key(spec) if spec else False,
            "api_key_hint": api_key_hint,
            "api_base": api_base,
            "default_api_base": default_api_base,
            "is_custom_preset": is_custom_preset,
            "preset_name": preset_name,
            "provider": provider_name,
            "model": preset.model,
        })

    # 2) 非 custom provider 单例:有凭证但未被任何 preset 引用则保留(向后兼容)
    for spec in PROVIDERS:
        if spec.name == "custom":
            continue
        if spec.name in consumed_provider_specs:
            continue
        provider_config = getattr(config.providers, spec.name, None)
        if provider_config is None:
            continue
        providers.append({
            "name": spec.name,
            "label": spec.label,
            "configured": _provider_configured_for_settings(spec, provider_config),
            "auth_type": "api_key",
            "api_key_required": _provider_requires_api_key(spec),
            "api_key_hint": _mask_secret_hint(provider_config.api_key),
            "api_base": provider_config.api_base,
            "default_api_base": spec.default_api_base or None,
        })

    # 3) custom 单例(未配置)作为未配置区域的添加入口
    custom_spec = find_by_name("custom")
    custom_config = getattr(config.providers, "custom", None) if custom_spec else None
    if custom_spec is not None:
        providers.append({
            "name": "custom",
            "label": custom_spec.label,
            "configured": _provider_configured_for_settings(custom_spec, custom_config) if custom_config else False,
            "auth_type": "api_key",
            "api_key_required": False,
            "api_key_hint": _mask_secret_hint(custom_config.api_key) if custom_config else None,
            "api_base": custom_config.api_base if custom_config else None,
            "default_api_base": None,
        })
    return providers


def _build_model_presets_section(
    config: Any,
    active_preset_name: str,
    defaults: Any,
) -> list[dict[str, Any]]:
    """Build the ``model_presets`` array for the settings payload.

    重构后 ``model_presets`` 仅包含 ``config.model_presets`` 中的实际 preset,
    不再硬编码 virtual "default" 条目。default 作为内部 fallback 由
    ``agents.defaults`` 字段直接表达,前端通过 ``agent.model_preset`` 是否为
    "default"/null 判断是否处于 fallback 状态,并在下拉列表显示占位符。
    """
    model_presets: list[dict[str, Any]] = []
    for name, preset in config.model_presets.items():
        model_presets.append(
            {
                "name": name,
                "label": preset.label or name,
                "active": active_preset_name == name,
                "is_default": False,
                "model": preset.model,
                "provider": preset.provider,
                "max_tokens": preset.max_tokens,
                "context_window_tokens": preset.context_window_tokens,
                **_ctx_fields(preset.model, preset.context_window_tokens),
                "temperature": preset.temperature,
                "reasoning_effort": preset.reasoning_effort,
                # Per-preset 凭证(用于多个独立 custom endpoint)
                "api_base": preset.api_base,
                "api_key_hint": _mask_secret_hint(preset.api_key),
            }
        )
    return model_presets


def settings_payload(
    *,
    requires_restart: bool = False,
    surface: str | None = "browser",
    runtime_capability_overrides: dict[str, Any] | None = None,
    restart_required_sections: list[str] | None = None,
    apply_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = load_config()
    # 懒迁移:把旧的 providers.custom 单例凭证迁移为独立的 custom model_preset
    _maybe_migrate_legacy_custom_provider(config)
    # 清理非 default preset 从 default 继承的 context_window_tokens
    _cleanup_inherited_context_window(config)
    # 一次性迁移:把学习表中遗留的二进制上下文值(如 1048576)转为十进制(如 1000000)
    _migrate_learned_binary_context_windows()
    defaults = config.agents.defaults
    active_preset_name = defaults.model_preset or "default"
    try:
        effective_preset = config.resolve_preset()
    except Exception:
        effective_preset = config.resolve_default_preset()
        active_preset_name = "default"

    provider_name = (
        config.get_provider_name(effective_preset.model, preset=effective_preset)
        or effective_preset.provider
    )
    provider = config.get_provider(effective_preset.model, preset=effective_preset)
    selected_provider = provider_name
    if effective_preset.provider != "auto":
        spec = find_by_name(effective_preset.provider)
        selected_provider = spec.name if spec else provider_name

    exec_config = config.tools.exec
    sandbox_status = workspace_sandbox_status(
        restrict_to_workspace=config.tools.restrict_to_workspace,
        workspace=config.workspace_path,
    )
    payload = {
        "agent": {
            "model": effective_preset.model,
            "provider": selected_provider,
            "resolved_provider": provider_name,
            "has_api_key": bool(provider and provider.api_key),
            "model_preset": active_preset_name,
            "max_tokens": effective_preset.max_tokens,
            "context_window_tokens": effective_preset.context_window_tokens,
            **_ctx_fields(effective_preset.model, effective_preset.context_window_tokens),
            "temperature": effective_preset.temperature,
            "reasoning_effort": effective_preset.reasoning_effort,
            "tool_hint_max_length": defaults.tool_hint_max_length,
        },
        "model_presets": _build_model_presets_section(config, active_preset_name, defaults),
        "providers": _build_providers_section(config),
        "web": {
            "enable": config.tools.web.enable,
            "proxy": config.tools.web.proxy,
            "user_agent": config.tools.web.user_agent,
            "fetch": {
                "use_jina_reader": config.tools.web.fetch.use_jina_reader,
            },
        },
        "runtime": {
            "config_path": str(get_config_path().expanduser()),
            "workspace_path": str(config.workspace_path),
            "gateway_host": config.gateway.host,
            "gateway_port": (
                getattr(config.channels, "websocket", None).get("port", 8765)
                if isinstance(getattr(config.channels, "websocket", None), dict)
                else getattr(getattr(config.channels, "websocket", None), "port", 8765)
                if getattr(config.channels, "websocket", None) is not None
                else 8765
            ),
            "heartbeat": {
                "enabled": config.gateway.heartbeat.enabled,
                "interval_s": config.gateway.heartbeat.interval_s,
                "keep_recent_messages": config.gateway.heartbeat.keep_recent_messages,
            },
            "dream": {
                "schedule": defaults.dream.describe_schedule(),
                "max_batch_size": defaults.dream.max_batch_size,
                "max_iterations": defaults.dream.max_iterations,
                "annotate_line_ages": defaults.dream.annotate_line_ages,
            },
            "unified_session": defaults.unified_session,
        },
        "advanced": {
            "restrict_to_workspace": config.tools.restrict_to_workspace,
            "workspace_sandbox": sandbox_status.as_dict(),
            "webui_allow_local_service_access": config.tools.webui_allow_local_service_access,
            "allow_local_preview_access": config.tools.webui_allow_local_service_access,
            "webui_default_access_mode": read_webui_default_access_mode(),
            "private_service_protection_enabled": True,
            "ssrf_whitelist_count": len(config.tools.ssrf_whitelist),
            "mcp_server_count": len(config.tools.mcp_servers),
            "exec_enabled": exec_config.enable,
            "exec_sandbox": exec_config.sandbox or None,
            "exec_path_append_set": bool(exec_config.path_append),
        },
        "requires_restart": requires_restart,
    }
    return decorate_settings_payload(
        payload,
        surface=surface,
        runtime_capability_overrides=runtime_capability_overrides,
        restart_required_sections=restart_required_sections,
        apply_state=apply_state,
    )


def update_agent_settings(query: QueryParams) -> dict[str, Any]:
    config = load_config()
    defaults = config.agents.defaults
    changed = False
    restart_required = False
    preset_changed = False

    if "model_preset" in query or "modelPreset" in query:
        preset = (_query_first_alias(query, "model_preset", "modelPreset") or "").strip()
        preset_value = None if not preset or preset == "default" else preset
        if preset_value is not None and preset_value not in config.model_presets:
            raise WebUISettingsError("unknown model preset")
        if defaults.model_preset != preset_value:
            defaults.model_preset = preset_value
            changed = True
            preset_changed = True

    model = _query_first(query, "model")
    model_changed = False
    if model is not None:
        model = model.strip()
        if not model:
            raise WebUISettingsError("model is required")
        if defaults.model != model:
            defaults.model = model
            changed = True
            model_changed = True

    provider = _query_first(query, "provider")
    if provider is not None:
        provider = provider.strip()
        if not provider:
            raise WebUISettingsError("provider is required")
        # custom preset 虚拟条目(name=custom__<preset_name>):实际 provider 是 "custom",
        # 需要激活对应的 model_preset
        if provider.startswith("custom__"):
            preset_name = provider[len("custom__"):]
            preset = config.model_presets.get(preset_name)
            if preset is None or preset.provider != "custom":
                raise WebUISettingsError("unknown provider")
            if not (preset.api_key or preset.api_base):
                raise WebUISettingsError("provider is not configured")
            real_provider = "custom"
            if defaults.provider != real_provider:
                defaults.provider = real_provider
                changed = True
            # 激活对应的 model_preset(若未指定其他 preset)
            if defaults.model_preset != preset_name:
                defaults.model_preset = preset_name
                changed = True
        else:
            _validate_configured_provider(config, provider)
            if defaults.provider != provider:
                defaults.provider = provider
                changed = True

    context_window_tokens = _parse_context_window_tokens(
        _query_first_alias(query, "context_window_tokens", "contextWindowTokens")
    )
    if (
        context_window_tokens is not None
        and defaults.context_window_tokens != context_window_tokens
    ):
        defaults.context_window_tokens = context_window_tokens
        changed = True

    tool_hint_max_length = _query_first_alias(
        query,
        "tool_hint_max_length",
        "toolHintMaxLength",
    )
    if tool_hint_max_length is not None:
        try:
            parsed = int(tool_hint_max_length)
        except ValueError:
            raise WebUISettingsError("tool_hint_max_length must be an integer") from None
        if parsed < 20 or parsed > 500:
            raise WebUISettingsError("tool_hint_max_length must be between 20 and 500")
        if defaults.tool_hint_max_length != parsed:
            defaults.tool_hint_max_length = parsed
            changed = True
            restart_required = True

    if changed:
        save_config(config)
    # Trigger HF learning when the default model changed.
    if model_changed:
        _trigger_model_learning(defaults.model)
    elif preset_changed:
        # 切换 preset 后,effective model 可能改变,触发新 model 的 HF 学习。
        # 不修改 defaults.model(那是 default preset 的),只触发学习;
        # 若已学习过会从缓存返回,无副作用。
        try:
            new_effective = config.resolve_preset()
            if new_effective.model:
                _trigger_model_learning(new_effective.model)
        except Exception:
            pass
    return settings_payload(requires_restart=restart_required)


def create_model_configuration(query: QueryParams) -> dict[str, Any]:
    label = (_query_first_alias(query, "label", "displayName") or "").strip()
    raw_name = (_query_first(query, "name") or label).strip()
    model = (_query_first(query, "model") or "").strip()
    provider = (_query_first(query, "provider") or "").strip()
    # 可选的 per-preset 凭证(仅 custom provider 使用,支持多个独立 endpoint)
    api_key = _query_first_alias(query, "api_key", "apiKey")
    api_key = api_key.strip() if api_key else None
    api_base = _query_first_alias(query, "api_base", "apiBase")
    api_base = api_base.strip() if api_base else None

    if not label:
        label = raw_name
    if not model:
        raise WebUISettingsError("model is required")
    if not provider:
        raise WebUISettingsError("provider is required")

    name = _model_configuration_slug(raw_name or label)
    config = load_config()
    if name in config.model_presets:
        raise WebUISettingsError("configuration already exists", status=409)

    spec = find_by_name(provider)
    is_custom_with_creds = (
        spec is not None
        and spec.name == "custom"
        and (api_key or api_base)
    )
    if is_custom_with_creds:
        # custom preset 自带凭证时,跳过 _validate_configured_provider
        # (providers.custom 单例可能未配置,但 preset 独立携带 api_key/api_base)
        if not api_base:
            raise WebUISettingsError("api_base is required for custom provider")
    else:
        _validate_configured_provider(config, provider)

    base = config.resolve_default_preset()
    preset_kwargs: dict[str, Any] = dict(
        label=label,
        model=model,
        provider=provider,
        max_tokens=base.max_tokens,
        # 不继承 default 的 context_window_tokens:每个 preset 根据自身 model
        # 独立解析(走 HF 学习或显示默认值),避免用户在 default 上的手动配置
        # 被所有新 preset 继承,导致切换 preset 后输入框数字不变。
        context_window_tokens=None,
        temperature=base.temperature,
        reasoning_effort=base.reasoning_effort,
    )
    if is_custom_with_creds:
        preset_kwargs["api_key"] = api_key
        preset_kwargs["api_base"] = api_base
    config.model_presets[name] = ModelPresetConfig(**preset_kwargs)
    config.agents.defaults.model_preset = name
    save_config(config)
    # Trigger HF learning for the newly configured model (skips if already
    # learned successfully; retries on prior failure).
    _trigger_model_learning(model)
    return settings_payload()


def update_model_configuration(query: QueryParams) -> dict[str, Any]:
    name = (_query_first(query, "name") or "").strip()
    if not name or name == "default":
        raise WebUISettingsError("model configuration is required")

    config = load_config()
    preset = config.model_presets.get(name)
    if preset is None:
        raise WebUISettingsError("unknown model configuration")

    changed = False
    label = _query_first_alias(query, "label", "displayName")
    if label is not None:
        label = label.strip()
        if not label:
            raise WebUISettingsError("label is required")
        if preset.label != label:
            preset.label = label
            changed = True

    model = _query_first(query, "model")
    model_changed = False
    if model is not None:
        model = model.strip()
        if not model:
            raise WebUISettingsError("model is required")
        if preset.model != model:
            preset.model = model
            changed = True
            model_changed = True

    provider = _query_first(query, "provider")
    if provider is not None:
        provider = provider.strip()
        if not provider:
            raise WebUISettingsError("provider is required")
        # custom preset 虚拟条目(name=custom__<preset_name>):实际 provider 是 "custom"
        if provider.startswith("custom__"):
            real_provider = "custom"
            if preset.provider != real_provider:
                preset.provider = real_provider
                changed = True
        else:
            _validate_configured_provider(config, provider)
            if preset.provider != provider:
                preset.provider = provider
                changed = True

    # Per-preset 凭证更新(用于 custom preset 虚拟卡片的编辑)
    api_key = _query_first_alias(query, "api_key", "apiKey")
    if api_key is not None:
        api_key = api_key.strip() or None
        if preset.api_key != api_key:
            preset.api_key = api_key
            changed = True
    api_base = _query_first_alias(query, "api_base", "apiBase")
    if api_base is not None:
        api_base = api_base.strip() or None
        if preset.api_base != api_base:
            preset.api_base = api_base
            changed = True

    context_window_tokens = _parse_context_window_tokens(
        _query_first_alias(query, "context_window_tokens", "contextWindowTokens")
    )
    if (
        context_window_tokens is not None
        and preset.context_window_tokens != context_window_tokens
    ):
        preset.context_window_tokens = context_window_tokens
        changed = True

    if config.agents.defaults.model_preset != name:
        config.agents.defaults.model_preset = name
        changed = True

    if changed:
        save_config(config)
    # Trigger HF learning when the model name changed (skips if already
    # learned successfully; retries on prior failure).
    if model_changed:
        _trigger_model_learning(preset.model)
    return settings_payload()


def delete_model_configuration(query: QueryParams) -> dict[str, Any]:
    """删除一个 model_preset 配置(用于已配置区域的 custom 卡片删除)。

    - 不允许删除 default(preset_name == "default" 时报错)。
    - 若当前激活的 preset 被删除,切回 default 并同步 agent model/provider。
    - 不清除 providers.<name> 单例凭证(那是 provider 级别配置,由 delete_provider_settings 管理)。
    """
    name = (_query_first(query, "name") or "").strip()
    if not name or name == "default":
        raise WebUISettingsError("model configuration is required")

    config = load_config()
    if name not in config.model_presets:
        raise WebUISettingsError("unknown model configuration")

    del config.model_presets[name]

    # 若当前激活的 preset 被删除,切回 default
    if config.agents.defaults.model_preset == name:
        config.agents.defaults.model_preset = "default"
        default_preset = config.model_presets.get("default")
        if default_preset is not None:
            config.agents.defaults.model = default_preset.model
            config.agents.defaults.provider = default_preset.provider
        else:
            config.agents.defaults.model = ""
            config.agents.defaults.provider = "auto"

    save_config(config)
    return settings_payload()


def update_provider_settings(query: QueryParams) -> dict[str, Any]:
    provider_name = (_query_first(query, "provider") or "").strip()
    if not provider_name:
        raise WebUISettingsError("provider is required")
    spec = find_by_name(provider_name)
    if spec is None:
        raise WebUISettingsError("unknown provider")

    config = load_config()
    provider_config = getattr(config.providers, spec.name, None)
    if provider_config is None:
        raise WebUISettingsError("unknown provider")

    changed = False
    if "api_key" in query or "apiKey" in query:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = (api_key or "").strip() or None
        if provider_config.api_key != api_key:
            provider_config.api_key = api_key
            changed = True

    if "api_base" in query or "apiBase" in query:
        api_base = _query_first_alias(query, "api_base", "apiBase")
        api_base = (api_base or "").strip() or None
        if provider_config.api_base != api_base:
            provider_config.api_base = api_base
            changed = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=False)


def delete_provider_settings(query: QueryParams) -> dict[str, Any]:
    """清除一个 provider 的配置并将其移回未配置区域。

    做三件事:
    1. 清空该 provider 的 api_key / api_base(使其 ``configured=False``)。
    2. 删除所有以该 provider 为归属的非 default model_preset
       (default preset 由系统保留,不删除)。
    3. 如果当前激活的 preset 被删除,切回 default 并同步 agent.defaults
       的 model/provider,避免悬空引用。
    """
    provider_name = (_query_first(query, "provider") or "").strip()
    if not provider_name:
        raise WebUISettingsError("provider is required")
    spec = find_by_name(provider_name)
    if spec is None:
        raise WebUISettingsError("unknown provider")

    config = load_config()
    provider_config = getattr(config.providers, spec.name, None)
    if provider_config is None:
        raise WebUISettingsError("unknown provider")

    changed = False

    # 1) 清除 provider 凭证
    if provider_config.api_key or provider_config.api_base:
        provider_config.api_key = None
        provider_config.api_base = None
        changed = True

    # 2) 删除以该 provider 为归属的非 default model_preset
    preset_names_to_remove = [
        name for name, preset in config.model_presets.items()
        if name != "default" and preset.provider == spec.name
    ]
    for name in preset_names_to_remove:
        del config.model_presets[name]
        changed = True

    # 3) 若当前激活 preset 被删除,切回 default
    active_preset = config.agents.defaults.model_preset
    if active_preset and active_preset in preset_names_to_remove:
        config.agents.defaults.model_preset = "default"
        default_preset = config.model_presets.get("default")
        if default_preset is not None:
            config.agents.defaults.model = default_preset.model
            config.agents.defaults.provider = default_preset.provider
        else:
            config.agents.defaults.model = ""
            config.agents.defaults.provider = "auto"
        changed = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=False)


def login_oauth_provider(query: QueryParams) -> dict[str, Any]:
    raise WebUISettingsError("No OAuth providers available in this build")


def logout_oauth_provider(query: QueryParams) -> dict[str, Any]:
    raise WebUISettingsError("No OAuth providers available in this build")


async def list_provider_models(query: QueryParams) -> dict[str, Any]:
    """Fetch available models from a provider's /v1/models endpoint.

    Uses the api_key and api_base from the provider config, or from query
    params (for testing before saving). Returns a list of model id strings.
    """
    provider_name = (_query_first(query, "provider") or "").strip()
    if not provider_name:
        raise WebUISettingsError("provider is required")

    spec = find_by_name(provider_name)
    if spec is None:
        raise WebUISettingsError("unknown provider")

    config = load_config()
    provider_config = getattr(config.providers, spec.name, None)
    if provider_config is None:
        raise WebUISettingsError("unknown provider")

    # Allow query params to override config values (for testing before saving).
    api_key = (
        _query_first_alias(query, "api_key", "apiKey")
        or (provider_config.api_key if provider_config else None)
    )
    api_base = (
        _query_first_alias(query, "api_base", "apiBase")
        or provider_config.api_base
        or spec.default_api_base
    )
    if not api_base:
        raise WebUISettingsError("api_base is required")

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=api_key or "unused", base_url=api_base)
        models = await client.models.list()
        model_ids = sorted(
            [m.id for m in models.data if m.id],
            key=lambda x: x.lower(),
        )
        await client.close()
        return {"provider": provider_name, "models": model_ids}
    except Exception as exc:
        raise WebUISettingsError(f"Failed to fetch models: {exc}") from exc


def update_network_safety_settings(query: QueryParams) -> dict[str, Any]:
    raw_allow = (
        _query_first_alias(query, "webui_allow_local_service_access", "webuiAllowLocalServiceAccess")
        or _query_first_alias(query, "allow_local_preview_access", "allowLocalPreviewAccess")
    )
    raw_default_access_mode = _query_first_alias(query, "webui_default_access_mode", "webuiDefaultAccessMode")
    if raw_allow is None and raw_default_access_mode is None:
        raise WebUISettingsError("webui_allow_local_service_access or webui_default_access_mode is required")

    config = load_config()
    changed = False
    if raw_allow is not None:
        webui_allow_local_service_access = _parse_bool(raw_allow, "webui_allow_local_service_access")
        if config.tools.webui_allow_local_service_access != webui_allow_local_service_access:
            config.tools.webui_allow_local_service_access = webui_allow_local_service_access
            changed = True

    if changed:
        save_config(config)
    if raw_default_access_mode is not None:
        default_access_mode = raw_default_access_mode.strip().lower()
        if default_access_mode == "restricted":
            default_access_mode = "default"
        if default_access_mode not in {"default", "full"}:
            raise WebUISettingsError("webui_default_access_mode must be default or full")
        try:
            write_webui_default_access_mode(default_access_mode)
        except ValueError as exc:
            raise WebUISettingsError(str(exc)) from exc
    return settings_payload(requires_restart=changed)


def update_runtime_settings(query: QueryParams) -> dict[str, Any]:
    """Update heartbeat interval and/or dream interval from WebUI query params."""
    raw_heartbeat_interval = _query_first_alias(
        query, "heartbeat_interval_s", "heartbeatIntervalS"
    )
    raw_dream_interval = _query_first_alias(
        query, "dream_interval_h", "dreamIntervalH"
    )
    if raw_heartbeat_interval is None and raw_dream_interval is None:
        raise WebUISettingsError("heartbeat_interval_s or dream_interval_h is required")

    config = load_config()
    changed = False

    if raw_heartbeat_interval is not None:
        try:
            heartbeat_interval = int(raw_heartbeat_interval)
        except ValueError:
            raise WebUISettingsError("heartbeat_interval_s must be an integer") from None
        if heartbeat_interval < 60 or heartbeat_interval > 86400:
            raise WebUISettingsError("heartbeat_interval_s must be between 60 and 86400")
        if config.gateway.heartbeat.interval_s != heartbeat_interval:
            config.gateway.heartbeat.interval_s = heartbeat_interval
            changed = True

    if raw_dream_interval is not None:
        try:
            dream_interval = int(raw_dream_interval)
        except ValueError:
            raise WebUISettingsError("dream_interval_h must be an integer") from None
        if dream_interval < 1 or dream_interval > 48:
            raise WebUISettingsError("dream_interval_h must be between 1 and 48")
        if config.agents.defaults.dream.interval_h != dream_interval:
            config.agents.defaults.dream.interval_h = dream_interval
            changed = True

    if changed:
        save_config(config)
    # Heartbeat/dream intervals are re-registered on the running cron service
    # by the WebSocket channel handler, so no gateway restart is required.
    return settings_payload(requires_restart=False)


def update_web_fetch_settings(query: QueryParams) -> dict[str, Any]:
    """Update web_fetch settings (currently only ``use_jina_reader``).

    The ``web_search`` tool and its 7 providers were removed (all blocked in
    mainland China). The web_fetch tool remains; its only WebUI-exposed knob
    is the Jina Reader toggle.
    """
    use_jina_reader_raw = _query_first_alias(query, "use_jina_reader", "useJinaReader")
    if use_jina_reader_raw is None:
        raise WebUISettingsError("use_jina_reader is required")
    normalized = use_jina_reader_raw.strip().lower()
    if normalized not in {"1", "0", "true", "false", "yes", "no"}:
        raise WebUISettingsError("use_jina_reader must be boolean")

    config = load_config()
    web_config = config.tools.web
    new_value = normalized in {"1", "true", "yes"}
    if web_config.fetch.use_jina_reader != new_value:
        web_config.fetch.use_jina_reader = new_value
        save_config(config)
    return settings_payload(requires_restart=True)
