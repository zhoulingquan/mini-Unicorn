"""web_search 独立配置 schema。

不挂在 WebToolsConfig 下,与 web_fetch 平级,便于独立升级维护。

后端选择策略:
- provider="auto" (默认): 并发调用所有已注册后端,合并去重后返回最全面的结果。
  国内后端(bocha/bing_cn/sogou/baidu/tencent)和国外后端(duckduckgo)同时尝试,
  有代理时国外后端走代理,无代理时国外后端自然失败被跳过,不影响国内结果。
- provider="<name>": 仅调用指定后端,用于调试或特定场景。

结果缓存:默认启用,TTL 固定 1 小时,不暴露给用户配置(默认值已足够,
真有需要可改这里的常量或 config.json)。
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from miniUnicorn.config.schema import Base


# 结果缓存内部常量(不暴露到 UI)。如需调整,改这里或 config.json 的同名字段。
DEFAULT_CACHE_TTL_S: int = 3600


class WebSearchBackendConfig(Base):
    """单个后端的独立配置(api_key、base_url 等)。"""

    api_key: str = ""
    base_url: str = ""
    timeout: int = 30


class WebSearchConfig(Base):
    """web_search 工具的独立配置。

    通过根 Config 的 `web_search` 字段访问,与 `tools.web` 平级。
    """

    enable: bool = True
    # auto = 并发调用所有已注册后端,合并去重;指定具体名 = 只调该后端
    provider: str = "auto"
    max_results: int = 5
    timeout: int = 30
    # 国外后端专用代理;None 时复用系统环境变量
    proxy: str | None = None
    user_agent: str | None = None
    # 每个后端独立配置,Key 优先级:backends[name].api_key > 环境变量
    backends: dict[str, WebSearchBackendConfig] = Field(default_factory=dict)

    def get_backend_config(self, name: str) -> WebSearchBackendConfig:
        """取后端配置,不存在则返回默认空配置。"""
        return self.backends.get(name) or WebSearchBackendConfig()

    def get_api_key(self, name: str, env_var: str = "") -> str:
        """取后端 API Key,优先 backends[name].api_key,其次环境变量。"""
        cfg = self.backends.get(name)
        if cfg and cfg.api_key:
            return cfg.api_key
        if env_var:
            import os

            return os.environ.get(env_var, "")
        return ""
