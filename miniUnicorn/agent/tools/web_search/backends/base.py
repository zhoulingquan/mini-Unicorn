"""搜索后端抽象基类。

每个后端只需继承 SearchBackend,实现 search() 方法。
aggregator 负责降级链与并发聚合,后端只关心单次查询。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from miniUnicorn.agent.tools.web_search.config import WebSearchConfig


@dataclass
class SearchResult:
    """单条搜索结果。"""

    title: str
    url: str
    snippet: str = ""
    source_backend: str = ""  # 标记来源后端,聚合时区分

    def to_dict(self) -> dict[str, str]:
        return {
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "source": self.source_backend,
        }


@dataclass
class BackendResponse:
    """后端响应封装。"""

    backend: str
    results: list[SearchResult] = field(default_factory=list)
    error: str = ""  # 非空表示失败
    from_cache: bool = False

    @property
    def ok(self) -> bool:
        return not self.error


class SearchBackend(ABC):
    """搜索后端抽象基类。"""

    # 子类必须覆盖
    name: str = "base"
    # 是否需要 API Key
    requires_api_key: bool = False
    # 对应的环境变量名(供 get_api_key 自动读取)
    env_var: str = ""
    # 是否需要代理才能在国内使用
    needs_proxy_in_cn: bool = False

    def __init__(self, config: WebSearchConfig) -> None:
        self.config = config
        self.timeout = self._resolve_timeout()
        self.proxy = config.proxy
        self.user_agent = config.user_agent or _DEFAULT_USER_AGENT

    def _resolve_timeout(self) -> float:
        backend_cfg = self.config.get_backend_config(self.name)
        return float(backend_cfg.timeout or self.config.timeout)

    def get_api_key(self) -> str:
        """获取该后端的 API Key。"""
        return self.config.get_api_key(self.name, self.env_var)

    def make_client(self, *, timeout: float | None = None, follow_redirects: bool = True) -> httpx.AsyncClient:
        """创建带 SSRF 防护的 httpx 客户端。

        SSRF 钩子会在每次请求(含重定向)时触发,因此 follow_redirects 安全。
        """
        from miniUnicorn.security.network import create_ssrf_safe_client

        return create_ssrf_safe_client(
            proxy=self.proxy,
            timeout=timeout or self.timeout,
            follow_redirects=follow_redirects,
        )

    @abstractmethod
    async def search(self, query: str, count: int) -> BackendResponse:
        """执行搜索,返回 BackendResponse。

        实现要点:
        - 抓取失败时返回 error 字段,不要抛异常(降级链依赖此约定)
        - 每条结果填充 source_backend = self.name
        """
        ...


_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
