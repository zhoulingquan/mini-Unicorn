"""Private helpers for settings_api:query parsing, secret masking, provider
validation, primitive parsing, context-window resolution, and slug generation.

拆分自 ``settings_api.py``:这些 helper 不直接进入 WebUI 公共 API,仅被
``_payload`` 和 ``_updates`` 子模块复用。
"""

from __future__ import annotations

import re
from typing import Any

from miniUnicorn.providers.registry import find_by_name

from ._runtime import QueryParams, WebUISettingsError

_MODEL_CONFIGURATION_SLUG_RE = re.compile(r"[^a-z0-9_-]+")


def _query_first(query: QueryParams, key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def _query_first_alias(query: QueryParams, snake: str, camel: str) -> str | None:
    value = _query_first(query, snake)
    return _query_first(query, camel) if value is None else value


def _clip_ws_string(value: Any, limit: int = 240) -> str | None:
    """截断字符串到指定长度,非字符串或空字符串返回 None。

    用于规范化 WebUI 提交的 mention/attachment 字段值。
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:limit]


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
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        raise WebUISettingsError("context_window_tokens must be an integer") from None
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
        "status": "configured" | "learned" | "unknown" | "default",
        "error": str | None,              # populated when status == "unknown"
                                          # (carries the last failure reason)
    }
    """
    if isinstance(configured, int) and configured > 0:
        return {"limit": configured, "status": "configured", "error": None}
    if not model:
        return {"limit": 65_536, "status": "default", "error": None}
    try:
        from miniUnicorn.cli.models import _load_learned_entry, _normalize_model_name

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
    # Not yet learned — surface the last failure reason if any.
    error = entry.get("error") if isinstance(entry, dict) else None
    return {
        "limit": 65_536,
        "status": "unknown",
        "error": error or "尚未查询,保存模型后将自动从 HuggingFace 查询",
    }


def _trigger_model_learning(model: str) -> dict[str, Any]:
    """Actively query Hugging Face for *model*'s context window.

    Called by create/update model configuration handlers when a model is
    saved or changed. Persists the result (success or failure) to the
    learning table so subsequent page loads can display the status without
    re-querying HF.
    """
    if not model:
        return {"limit": 65_536, "status": "default", "error": None}
    try:
        from miniUnicorn.cli.models import learn_model_context_limit

        result = learn_model_context_limit(model)
    except Exception as exc:
        return {"limit": 65_536, "status": "failed", "error": str(exc)}

    if result.get("status") == "ok" and isinstance(result.get("limit"), int):
        return {
            "limit": result["limit"],
            "status": "learned",
            "error": None,
        }
    error = result.get("error") or "未知错误"
    # Persist the failure reason so the settings page can show it.
    try:
        from miniUnicorn.cli.models import _save_learned_failure

        _save_learned_failure(model, error)
    except Exception:
        pass
    return {"limit": 65_536, "status": "failed", "error": error}


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
        # custom provider 允许通过 per-preset 凭证绕过单例校验:
        # 调用方(create/update_model_configuration)会在传入 api_key+api_base
        # 后再调用本函数,这里只做 provider 注册表校验。
        if provider != "custom":
            raise WebUISettingsError("provider is not configured")
