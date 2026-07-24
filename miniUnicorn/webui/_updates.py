"""Update handlers for settings_api:mutations on agent/model/provider/network/
runtime/web_search sections.

拆分自 ``settings_api.py``:每个 handler 接收 ``QueryParams`` 并返回新的
``settings_payload()``。所有持久化通过 ``save_config`` 完成,上下文窗口的
HuggingFace 学习由 ``_trigger_model_learning`` 触发。
"""

from __future__ import annotations

from typing import Any

from miniUnicorn.config.loader import load_config, save_config
from miniUnicorn.config.schema import ModelPresetConfig
from miniUnicorn.providers.registry import PROVIDERS, find_by_name
from miniUnicorn.webui.workspaces import write_webui_default_access_mode

from ._helpers import (
    _model_configuration_slug,
    _parse_bool,
    _parse_context_window_tokens,
    _query_first,
    _query_first_alias,
    _trigger_model_learning,
    _validate_configured_provider,
)
from ._payload import _WEB_SEARCH_PROVIDER_BY_NAME, settings_payload
from ._runtime import QueryParams, WebUISettingsError


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

    # Plan & Execute 双模型配置:开关 + 规划模型选择。
    # 修改任一字段都需要重启 gateway 才能让 AgentLoop 重新读取 defaults。
    raw_use_planner = _query_first_alias(query, "use_planner", "usePlanner")
    if raw_use_planner is not None:
        use_planner = _parse_bool(raw_use_planner, "use_planner")
        if defaults.use_planner != use_planner:
            defaults.use_planner = use_planner
            changed = True
            restart_required = True

    raw_planner_model = _query_first_alias(query, "planner_model", "plannerModel")
    if raw_planner_model is not None:
        # 空字符串或 "default" 表示使用主模型(None)
        preset_name = raw_planner_model.strip()
        preset_value = None if not preset_name or preset_name == "default" else preset_name
        if preset_value is not None and preset_value not in config.model_presets:
            raise WebUISettingsError("unknown planner model preset")
        if defaults.planner_model != preset_value:
            defaults.planner_model = preset_value
            changed = True
            restart_required = True

    if changed:
        save_config(config)
    # Trigger HF learning when the default model changed.
    # 后台线程执行,HTTP 立即返回;前端通过轮询获取查询结果。
    # 与 create_model_configuration 保持一致,避免 HF 查询阻塞 HTTP 请求。
    if model_changed:
        import threading
        threading.Thread(target=_trigger_model_learning, args=(defaults.model,), daemon=True).start()
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

    # Per-preset 凭证:允许 custom provider 的每个 preset 自带 api_key/api_base,
    # 不依赖 providers.custom 单例。运行时 _match_provider 的 _with_preset_creds
    # 会用 preset 的凭证覆盖 provider 单例值。
    api_key = _query_first_alias(query, "api_key", "apiKey")
    api_key = (api_key or "").strip() or None
    api_base = _query_first_alias(query, "api_base", "apiBase")
    api_base = (api_base or "").strip() or None
    # custom provider 必须自带凭证(因为单例未配置);其他 provider 可选自带凭证
    if provider == "custom" and not (api_key and api_base):
        raise WebUISettingsError("custom provider requires api_key and api_base")

    base = config.resolve_default_preset()
    config.model_presets[name] = ModelPresetConfig(
        label=label,
        model=model,
        provider=provider,
        max_tokens=base.max_tokens,
        context_window_tokens=base.context_window_tokens,
        temperature=base.temperature,
        reasoning_effort=base.reasoning_effort,
        api_key=api_key,
        api_base=api_base,
    )
    config.agents.defaults.model_preset = name
    save_config(config)
    # Trigger HF learning for the newly configured model (skips if already
    # learned successfully; retries on prior failure).
    # 后台线程执行,HTTP 立即返回;前端通过轮询获取查询结果。
    import threading
    threading.Thread(target=_trigger_model_learning, args=(model,), daemon=True).start()
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

    # Per-preset 凭证更新:空串视为清除(转 None),与 update_provider_settings 一致。
    if "api_key" in query or "apiKey" in query:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = (api_key or "").strip() or None
        if preset.api_key != api_key:
            preset.api_key = api_key
            changed = True

    if "api_base" in query or "apiBase" in query:
        api_base = _query_first_alias(query, "api_base", "apiBase")
        api_base = (api_base or "").strip() or None
        if preset.api_base != api_base:
            preset.api_base = api_base
            changed = True

    if config.agents.defaults.model_preset != name:
        config.agents.defaults.model_preset = name
        changed = True

    if changed:
        save_config(config)
    # Trigger HF learning when the model name changed (skips if already
    # learned successfully; retries on prior failure).
    # 后台线程执行,HTTP 立即返回;前端通过轮询获取查询结果。
    # 与 create_model_configuration 保持一致,避免 HF 查询阻塞 HTTP 请求。
    if model_changed:
        import threading
        threading.Thread(target=_trigger_model_learning, args=(preset.model,), daemon=True).start()
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
    search_config = config.tools.web_search
    previous_provider = search_config.provider
    changed = False
    restart_required = False

    def set_search_value(attr: str, value: object) -> None:
        nonlocal changed
        if getattr(search_config, attr) != value:
            setattr(search_config, attr, value)
            changed = True

    def set_backend_credential(name: str, *, api_key: str | None = None) -> None:
        """更新 backends[name] 的凭证字段;空值时移除该条目以保持配置干净。"""
        nonlocal changed
        existing = search_config.backends.get(name)
        if api_key is not None:
            new_cfg = existing or search_config.get_backend_config(name)
            if new_cfg.api_key != api_key:
                new_cfg.api_key = api_key
                search_config.backends[name] = new_cfg
                changed = True

    if search_config.provider != provider_name:
        search_config.provider = provider_name
        changed = True

    credential = provider_option["credential"]
    if credential == "none":
        # auto / 免 Key 后端:清空选中 provider 的 backends 凭证
        if provider_name != "auto" and provider_name in search_config.backends:
            search_config.backends.pop(provider_name, None)
            changed = True
    elif credential == "base_url":
        # 当前 _WEB_SEARCH_PROVIDER_OPTIONS 不含 base_url 类型,保留分支以备扩展。
        base_url = _query_first_alias(query, "base_url", "baseUrl")
        base_url = base_url.strip() if base_url is not None else None
        existing_cfg = search_config.backends.get(provider_name)
        if not base_url and previous_provider == provider_name and existing_cfg and existing_cfg.base_url:
            base_url = existing_cfg.base_url
        if not base_url:
            raise WebUISettingsError("base_url is required")
        new_cfg = existing_cfg or search_config.get_backend_config(provider_name)
        if new_cfg.base_url != base_url:
            new_cfg.base_url = base_url
            search_config.backends[provider_name] = new_cfg
            changed = True
    else:
        # api_key 类后端(bocha):从 query 或保留旧值
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = api_key.strip() if api_key is not None else None
        existing_cfg = search_config.backends.get(provider_name)
        if not api_key and previous_provider == provider_name and existing_cfg and existing_cfg.api_key:
            api_key = existing_cfg.api_key
        if not api_key:
            raise WebUISettingsError("api_key is required")
        set_backend_credential(provider_name, api_key=api_key)

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

    if changed:
        save_config(config)
    return settings_payload(requires_restart=restart_required)


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


def delete_all_providers(_query: QueryParams) -> dict[str, Any]:
    """一键清除所有 provider 配置,恢复初始状态。

    做三件事:
    1. 清空所有内置 provider 的 api_key / api_base(使其全部 configured=False)。
    2. 删除所有非 default model_preset。
    3. 重置 active preset 为 default,同步 agent.defaults 的 model/provider。
    """
    config = load_config()
    changed = False

    # 1) 清除所有内置 provider 凭证
    for spec in PROVIDERS:
        provider_config = getattr(config.providers, spec.name, None)
        if provider_config is not None and (provider_config.api_key or provider_config.api_base):
            provider_config.api_key = None
            provider_config.api_base = None
            changed = True

    # 2) 删除所有非 default model_preset
    preset_names_to_remove = [
        name for name in config.model_presets if name != "default"
    ]
    for name in preset_names_to_remove:
        del config.model_presets[name]
        changed = True

    # 3) 重置 active preset 为 default
    if config.agents.defaults.model_preset and config.agents.defaults.model_preset != "default":
        config.agents.defaults.model_preset = "default"
        config.agents.defaults.model = ""
        config.agents.defaults.provider = "auto"
        changed = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=False)


def update_web_fetch_settings(query: QueryParams) -> dict[str, Any]:
    """更新 web_fetch 工具配置(独立于 web_search)。

    目前唯一可配置项是 Jina Reader 开关(``use_jina_reader``)。
    """
    use_jina_reader = _query_first_alias(query, "use_jina_reader", "useJinaReader")
    if use_jina_reader is None:
        raise WebUISettingsError("use_jina_reader is required")

    normalized = use_jina_reader.strip().lower()
    if normalized not in {"1", "0", "true", "false", "yes", "no"}:
        raise WebUISettingsError("use_jina_reader must be boolean")

    config = load_config()
    new_value = normalized in {"1", "true", "yes"}
    restart_required = False
    if config.tools.web.fetch.use_jina_reader != new_value:
        config.tools.web.fetch.use_jina_reader = new_value
        save_config(config)
        restart_required = True

    return settings_payload(requires_restart=restart_required)
