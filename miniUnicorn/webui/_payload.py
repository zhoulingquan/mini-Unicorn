"""``settings_payload``:build the full settings dict consumed by the WebUI.

拆分自 ``settings_api.py``:这是只读端点,聚合 config 各 section 并附加上下文
窗口解析结果与运行时 surface 元数据。所有写操作放在 ``_updates`` 子模块。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from miniUnicorn.config.loader import get_config_path, load_config
from miniUnicorn.providers.registry import PROVIDERS, find_by_name
from miniUnicorn.security.workspace_access import workspace_sandbox_status
from miniUnicorn.webui.workspaces import read_webui_default_access_mode

from ._helpers import (
    _mask_secret_hint,
    _provider_configured_for_settings,
    _provider_requires_api_key,
    _resolve_context_window_for_settings,
)
from ._runtime import decorate_settings_payload


def _extract_label_from_base_url(base_url: str | None) -> str | None:
    """从 api_base URL 提取 provider 显示名。

    规则:
    1. 解析 host,去掉通用前缀(www/api/apihub/api-gateway 等)
    2. 去掉顶级域名后缀(.com/.cn/.org/.ai/.io/.net 等)
    3. 返回主域名(支持多级子域,如 apihub.agnes-ai.com → agnes-ai)

    示例:
      https://apihub.agnes-ai.com/v1 → agnes-ai
      https://api.deepseek.com → deepseek
      https://opencode.ai/zen/v1 → opencode
    """
    if not base_url:
        return None
    try:
        parsed = urlparse(base_url)
        host = parsed.hostname or ""
    except Exception:
        return None
    if not host:
        return None
    parts = host.split(".")
    # 去掉通用前缀(www/api/apihub/apihub-xxx/api-gateway 等)
    while parts and parts[0].lower() in {"www", "api", "apihub", "api-gateway", "gateway"}:
        parts = parts[1:]
    if not parts:
        return None
    # 去掉顶级域名后缀(.com/.cn/.org/.ai/.io/.net/.dev 等)
    if len(parts) >= 2:
        parts = parts[:-1]
    label = ".".join(parts) if parts else host
    # 首字母大写
    return label[:24].capitalize() if label else None

# web_search 后端选项,必须与 miniUnicorn/agent/tools/web_search/backends/__init__.py
# 中的 BACKEND_REGISTRY 保持一致。auto 模式会并发调用所有后端,这里仅列出可在
# 单后端模式显式选择的 provider。credential 字段告诉 UI 是否需要 api_key/base_url。
# 精简为以 SearXNG 为主力的三层架构(2026-07-23):
#   searxng(主力,自托管) + tavily(AI 摘要) + bing_cn(国内免 Key 兜底)
_WEB_SEARCH_PROVIDER_OPTIONS: tuple[dict[str, str], ...] = (
    {"name": "auto", "label": "Auto (并发聚合)", "credential": "none"},
    # 主力:自托管元搜索(需配置 base_url,无需 api_key)
    {"name": "searxng", "label": "SearXNG (自托管)", "credential": "base_url"},
    # AI 摘要增强(需 api_key)
    {"name": "tavily", "label": "Tavily (AI Search)", "credential": "api_key"},
    # 国内免 Key 兜底
    {"name": "bing_cn", "label": "Bing (国内)", "credential": "none"},
)
_WEB_SEARCH_PROVIDER_BY_NAME = {
    provider["name"]: provider for provider in _WEB_SEARCH_PROVIDER_OPTIONS
}


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
    # 预先按 provider 名分组 preset,便于在 provider 卡片下展示"挂载的 preset 列表"。
    # default preset 不计入(provider="auto"或继承 agent.model),只展示命名的 preset。
    _presets_by_provider: dict[str, list[dict[str, Any]]] = {}
    active_preset_name = config.agents.defaults.model_preset
    for preset_name, preset_cfg in config.model_presets.items():
        provider_key = preset_cfg.provider or "auto"
        _presets_by_provider.setdefault(provider_key, []).append({
            "name": preset_name,
            "label": preset_cfg.label or preset_name,
            "model": preset_cfg.model,
            "active": preset_name == active_preset_name,
        })
    for spec in PROVIDERS:
        provider_config = getattr(config.providers, spec.name, None)
        if provider_config is None:
            continue
        # 该 provider 下挂载的 preset 列表(含 custom provider)
        provider_presets = _presets_by_provider.get(spec.name, [])
        configured = _provider_configured_for_settings(spec, provider_config)
        # custom provider 单例不持有凭证,但每个 custom preset 自带 api_key/api_base。
        # custom 始终保留在未配置区域作为"添加 provider"入口(configured=False),
        # 已配置的 custom preset 通过前端强制显示在已配置区域(基于 preset 列表非空)。
        # 凭证显示:custom 单例无凭证,用代表 preset(激活的或第一个)的凭证填充 row,
        # 让卡片 API Key/API Base 显示与单例凭证 provider 视觉一致。
        display_api_key = provider_config.api_key
        display_api_base = provider_config.api_base
        if spec.name == "custom" and provider_presets:
            # 从 config.model_presets 找到 custom 的代表 preset(激活优先)
            custom_preset_cfgs = [
                (name, cfg) for name, cfg in config.model_presets.items()
                if cfg.provider == "custom"
            ]
            represet = next(
                (cfg for _, cfg in custom_preset_cfgs if cfg.api_key),
                None,
            )
            if represet is None and custom_preset_cfgs:
                represet = custom_preset_cfgs[0][1]
            if represet is not None:
                display_api_key = represet.api_key
                display_api_base = represet.api_base
        # custom provider 的 label 从 api_base 自动提取(如 apihub.agnes-ai.com → Agnes-ai),
        # 无 preset 时回退到默认 "Custom"。
        if spec.name == "custom" and provider_presets:
            display_label = _extract_label_from_base_url(display_api_base) or spec.label
        else:
            display_label = spec.label
        # custom 单例:configured=False(未配置区域"+"入口),presets 清空。
        # 每个 custom preset 作为独立虚拟 provider row 追加(见循环后),
        # 让每个自定义端点在已配置区域和 header 下拉里独立显示。
        is_custom_singleton = spec.name == "custom"
        row = {
            "name": spec.name,
            "label": display_label,
            "configured": configured,
            "auth_type": "api_key",
            "api_key_required": _provider_requires_api_key(spec),
            "api_key_hint": _mask_secret_hint(display_api_key),
            "api_base": display_api_base,
            "default_api_base": spec.default_api_base or None,
            "preset_count": 0 if is_custom_singleton else len(provider_presets),
            "presets": [] if is_custom_singleton else provider_presets,
        }
        providers.append(row)

    # 为每个 custom preset 生成独立虚拟 provider row,让每个自定义端点在
    # 已配置区域和 header 下拉里显示为独立卡片(各自 label/图标/api_base)。
    # 前端通过 preset_name 字段识别虚拟 row,保存走 updateModelConfiguration,
    # 删除走 deleteModelConfiguration,name 格式 custom__<preset_name>。
    for preset_name, preset_cfg in config.model_presets.items():
        if preset_cfg.provider != "custom":
            continue
        virtual_row = {
            "name": f"custom__{preset_name}",
            "label": _extract_label_from_base_url(preset_cfg.api_base) or preset_cfg.label or preset_name,
            "configured": True,
            "auth_type": "api_key",
            "api_key_required": True,
            "api_key_hint": _mask_secret_hint(preset_cfg.api_key),
            "api_base": preset_cfg.api_base,
            "default_api_base": None,
            "is_custom_preset": True,
            "preset_name": preset_name,
            "provider": "custom",
            "model": preset_cfg.model,
            "preset_count": 0,
            "presets": [],
        }
        providers.append(virtual_row)

    search_config = config.tools.web_search
    # 空字符串或未配置时回退到 "auto"(并发聚合所有后端)。
    search_provider = (
        search_config.provider
        if search_config.provider in _WEB_SEARCH_PROVIDER_BY_NAME
        else "auto"
    )
    # 当前选中 provider 的凭证:从 backends[name] 读取(bocha 用 api_key,
    # 其余国内后端不需要凭证)。auto 模式下不展示凭证。
    _selected_provider_option = _WEB_SEARCH_PROVIDER_BY_NAME.get(search_provider, {})
    _selected_credential = _selected_provider_option.get("credential", "none")
    if _selected_credential == "api_key":
        _bocha_cfg = search_config.get_backend_config(search_provider)
        search_api_key_hint = _mask_secret_hint(_bocha_cfg.api_key or None)
    else:
        search_api_key_hint = None

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
            # Plan & Execute 双模型配置:use_planner 控制是否启用,
            # planner_model 指定规划阶段使用的 model_preset 名称(None=主模型)。
            "use_planner": defaults.use_planner,
            "planner_model": defaults.planner_model,
            "planner_max_replans": defaults.planner_max_replans,
        },
        "model_presets": model_presets,
        "providers": providers,
        "web_search": {
            "enable": search_config.enable,
            "provider": search_provider,
            "api_key_hint": search_api_key_hint,
            "max_results": search_config.max_results,
            "timeout": search_config.timeout,
            "proxy": search_config.proxy,
            "backends": {
                name: cfg.model_dump()
                for name, cfg in search_config.backends.items()
            },
            "providers": list(_WEB_SEARCH_PROVIDER_OPTIONS),
        },
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
