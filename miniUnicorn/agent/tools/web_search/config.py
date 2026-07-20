"""web_search 独立配置 schema。

不挂在 WebToolsConfig 下,与 web_fetch 平级,便于独立升级维护。
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from miniUnicorn.config.schema import Base


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
    # auto = 按区域走默认降级链;否则指定单个后端
    provider: str = "auto"
    # cn = 国内降级链;global = 国外降级链(国外后端需配 proxy)
    region: str = "cn"
    max_results: int = 5
    timeout: int = 30
    # 空则按 region 自动选择降级链
    fallback_chain: list[str] = Field(default_factory=list)
    enable_cache: bool = True
    cache_ttl: int = 3600  # 秒
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


# 默认降级链(纯 API,零 docker 依赖,不含 searxng)
# 顺序说明:
#   bocha   - 国内 AI Search API,有 Key 时质量最好(无 Key 自动跳过)
#   bing_cn - Bing RSS,免 Key 最稳,国内外通用
#   sogou   - 免 Key 抓取,备份
#   baidu   - 免 Key 抓取,容易被风控,放后面
#   tencent - 需要腾讯云凭证,签名复杂,最后兜底
DEFAULT_FALLBACK_CN = ["bocha", "bing_cn", "sogou", "baidu", "tencent"]
DEFAULT_FALLBACK_GLOBAL = ["bing_cn", "duckduckgo"]  # bing_cn 国外也能用,作为 duckduckgo 的备份


def resolve_fallback_chain(region: str, explicit: list[str] | None = None) -> list[str]:
    """解析降级链。显式指定时优先使用,否则按区域取默认。"""
    if explicit:
        return list(explicit)
    return list(DEFAULT_FALLBACK_CN if region.lower() == "cn" else DEFAULT_FALLBACK_GLOBAL)
