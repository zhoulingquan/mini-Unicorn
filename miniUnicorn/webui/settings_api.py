"""Settings REST helpers for the WebUI HTTP surface.

The WebSocket channel owns transport/authentication. This module owns the
settings payload shape and the allowlisted config mutations exposed to WebUI.

拆分后实际实现分布在四个子模块中,本文件仅作为公共 API 的 re-export 入口,
保持 ``from miniUnicorn.webui.settings_api import ...`` 的向后兼容:

- ``_runtime``: 常量、``WebUISettingsError``、surface/capabilities/decorate helpers
- ``_helpers``: 私有 helpers(query/secret/provider/parse/context-window/slug)
- ``_payload``: ``settings_payload`` 主函数
- ``_updates``: 所有 update handlers
"""

from __future__ import annotations

# Public API (re-exported for backwards compatibility with call sites that
# import from ``miniUnicorn.webui.settings_api``).
from ._payload import settings_payload
from ._runtime import (
    QueryParams,
    RuntimeSurface,
    WebUISettingsError,
    decorate_settings_payload,
    restart_behavior_by_section,
    runtime_capabilities,
)
from ._updates import (
    create_model_configuration,
    delete_all_providers,
    delete_model_configuration,
    delete_provider_settings,
    list_provider_models,
    login_oauth_provider,
    logout_oauth_provider,
    update_agent_settings,
    update_model_configuration,
    update_network_safety_settings,
    update_provider_settings,
    update_runtime_settings,
    update_web_fetch_settings,
    update_web_search_settings,
)

__all__ = [
    "QueryParams",
    "RuntimeSurface",
    "WebUISettingsError",
    "create_model_configuration",
    "decorate_settings_payload",
    "delete_all_providers",
    "delete_model_configuration",
    "delete_provider_settings",
    "list_provider_models",
    "login_oauth_provider",
    "logout_oauth_provider",
    "restart_behavior_by_section",
    "runtime_capabilities",
    "settings_payload",
    "update_agent_settings",
    "update_model_configuration",
    "update_network_safety_settings",
    "update_provider_settings",
    "update_runtime_settings",
    "update_web_fetch_settings",
    "update_web_search_settings",
]
