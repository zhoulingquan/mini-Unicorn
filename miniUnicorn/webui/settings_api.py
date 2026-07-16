"""Settings REST helpers for the WebUI HTTP surface.

The WebSocket channel owns transport/authentication. This module owns the
settings payload shape and the allowlisted config mutations exposed to WebUI.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from miniUnicorn.config.loader import get_config_path, load_config, save_config
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

_WEB_SEARCH_PROVIDER_OPTIONS: tuple[dict[str, str], ...] = (
    {"name": "duckduckgo", "label": "DuckDuckGo", "credential": "none"},
    {"name": "brave", "label": "Brave Search", "credential": "api_key"},
    {"name": "tavily", "label": "Tavily", "credential": "api_key"},
    {"name": "searxng", "label": "SearXNG", "credential": "base_url"},
    {"name": "jina", "label": "Jina", "credential": "api_key"},
    {"name": "kagi", "label": "Kagi", "credential": "api_key"},
    {"name": "olostep", "label": "Olostep", "credential": "api_key"},
)
_WEB_SEARCH_PROVIDER_BY_NAME = {
    provider["name"]: provider for provider in _WEB_SEARCH_PROVIDER_OPTIONS
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
        raise WebUISettingsError("provider is not configured")


def settings_payload(
    *,
    requires_restart: bool = False,
    surface: str | None = "browser",
    runtime_capability_overrides: dict[str, Any] | None = None,
    restart_required_sections: list[str] | None = None,
    apply_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = load_config()
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

    providers = []
    for spec in PROVIDERS:
        provider_config = getattr(config.providers, spec.name, None)
        if provider_config is None:
            continue
        row = {
            "name": spec.name,
            "label": spec.label,
            "configured": _provider_configured_for_settings(spec, provider_config),
            "auth_type": "api_key",
            "api_key_required": _provider_requires_api_key(spec),
            "api_key_hint": _mask_secret_hint(provider_config.api_key),
            "api_base": provider_config.api_base,
            "default_api_base": spec.default_api_base or None,
        }
        providers.append(row)

    search_config = config.tools.web.search
    search_provider = (
        search_config.provider
        if search_config.provider in _WEB_SEARCH_PROVIDER_BY_NAME
        else "duckduckgo"
    )

    def _ctx_fields(model: str, configured: int | None) -> dict[str, Any]:
        info = _resolve_context_window_for_settings(model, configured)
        return {
            "resolved_context_window_tokens": info["limit"],
            "resolved_context_window_status": info["status"],
            "resolved_context_window_error": info["error"],
        }

    model_presets = [
        {
            "name": "default",
            "label": "Default",
            "active": active_preset_name == "default",
            "is_default": True,
            "model": defaults.model,
            "provider": defaults.provider,
            "max_tokens": defaults.max_tokens,
            "context_window_tokens": defaults.context_window_tokens,
            **_ctx_fields(defaults.model, defaults.context_window_tokens),
            "temperature": defaults.temperature,
            "reasoning_effort": defaults.reasoning_effort,
        }
    ]
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
            }
        )

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
        "model_presets": model_presets,
        "providers": providers,
        "web_search": {
            "provider": search_provider,
            "api_key_hint": _mask_secret_hint(search_config.api_key),
            "base_url": search_config.base_url or None,
            "max_results": search_config.max_results,
            "timeout": search_config.timeout,
            "providers": list(_WEB_SEARCH_PROVIDER_OPTIONS),
        },
        "web": {
            "enable": config.tools.web.enable,
            "proxy": config.tools.web.proxy,
            "user_agent": config.tools.web.user_agent,
            "search": {
                "max_results": search_config.max_results,
                "timeout": search_config.timeout,
            },
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

    if "model_preset" in query or "modelPreset" in query:
        preset = (_query_first_alias(query, "model_preset", "modelPreset") or "").strip()
        preset_value = None if not preset or preset == "default" else preset
        if preset_value is not None and preset_value not in config.model_presets:
            raise WebUISettingsError("unknown model preset")
        if defaults.model_preset != preset_value:
            defaults.model_preset = preset_value
            changed = True

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
    return settings_payload(requires_restart=restart_required)


def create_model_configuration(query: QueryParams) -> dict[str, Any]:
    label = (_query_first_alias(query, "label", "displayName") or "").strip()
    raw_name = (_query_first(query, "name") or label).strip()
    model = (_query_first(query, "model") or "").strip()
    provider = (_query_first(query, "provider") or "").strip()

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
    _validate_configured_provider(config, provider)

    base = config.resolve_default_preset()
    config.model_presets[name] = ModelPresetConfig(
        label=label,
        model=model,
        provider=provider,
        max_tokens=base.max_tokens,
        context_window_tokens=base.context_window_tokens,
        temperature=base.temperature,
        reasoning_effort=base.reasoning_effort,
    )
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
        _validate_configured_provider(config, provider)
        if preset.provider != provider:
            preset.provider = provider
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


def update_web_search_settings(query: QueryParams) -> dict[str, Any]:
    provider_name = (_query_first(query, "provider") or "").strip().lower()
    provider_option = _WEB_SEARCH_PROVIDER_BY_NAME.get(provider_name)
    if provider_option is None:
        raise WebUISettingsError("unknown web search provider")

    config = load_config()
    search_config = config.tools.web.search
    web_config = config.tools.web
    previous_provider = search_config.provider
    changed = False
    restart_required = False

    def set_search_value(attr: str, value: object) -> None:
        nonlocal changed
        if getattr(search_config, attr) != value:
            setattr(search_config, attr, value)
            changed = True

    def set_fetch_value(attr: str, value: object) -> None:
        nonlocal changed
        if getattr(web_config.fetch, attr) != value:
            setattr(web_config.fetch, attr, value)
            changed = True

    if search_config.provider != provider_name:
        search_config.provider = provider_name
        changed = True

    credential = provider_option["credential"]
    if credential == "none":
        set_search_value("api_key", "")
        set_search_value("base_url", "")
    elif credential == "base_url":
        base_url = _query_first_alias(query, "base_url", "baseUrl")
        base_url = base_url.strip() if base_url is not None else None
        if not base_url and previous_provider == provider_name and search_config.base_url:
            base_url = search_config.base_url
        if not base_url:
            raise WebUISettingsError("base_url is required")
        set_search_value("base_url", base_url)
        set_search_value("api_key", "")
    else:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = api_key.strip() if api_key is not None else None
        if not api_key and previous_provider == provider_name and search_config.api_key:
            api_key = search_config.api_key
        if not api_key:
            raise WebUISettingsError("api_key is required")
        set_search_value("api_key", api_key)
        set_search_value("base_url", "")

    max_results = _query_first_alias(query, "max_results", "maxResults")
    if max_results is not None:
        try:
            parsed = int(max_results)
        except ValueError:
            raise WebUISettingsError("max_results must be an integer") from None
        if parsed < 1 or parsed > 10:
            raise WebUISettingsError("max_results must be between 1 and 10")
        set_search_value("max_results", parsed)

    timeout = _query_first(query, "timeout")
    if timeout is not None:
        try:
            parsed_timeout = int(timeout)
        except ValueError:
            raise WebUISettingsError("timeout must be an integer") from None
        if parsed_timeout < 1 or parsed_timeout > 120:
            raise WebUISettingsError("timeout must be between 1 and 120")
        set_search_value("timeout", parsed_timeout)

    use_jina_reader = _query_first_alias(query, "use_jina_reader", "useJinaReader")
    if use_jina_reader is not None:
        normalized = use_jina_reader.strip().lower()
        if normalized not in {"1", "0", "true", "false", "yes", "no"}:
            raise WebUISettingsError("use_jina_reader must be boolean")
        previous_jina_reader = web_config.fetch.use_jina_reader
        set_fetch_value("use_jina_reader", normalized in {"1", "true", "yes"})
        if web_config.fetch.use_jina_reader != previous_jina_reader:
            restart_required = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=restart_required)
