"""搜索后端抽象基类。

每个后端只需继承 SearchBackend,实现 search() 方法。
aggregator 负责降级链与并发聚合,后端只关心单次查询。
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Pattern

import httpx
from loguru import logger

from miniUnicorn.agent.tools.web_search.backends._html_utils import (
    clean_snippet,
    encode_query,
    make_absolute_url,
    strip_tags,
)
from miniUnicorn.agent.tools.web_search.circuit_breaker import BackendCircuitBreaker
from miniUnicorn.agent.tools.web_search.config import WebSearchConfig


def _read_system_proxy() -> str | None:
    """读取系统代理环境变量。

    当 config.proxy 为 None 时回退到此函数,让 web_search 自动复用
    用户已有的系统代理(如 HTTP_PROXY/HTTPS_PROXY 环境变量)。

    优先级: HTTPS_PROXY > HTTP_PROXY > https_proxy > http_proxy
    """
    for var in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    return None


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
    # 该后端的推荐默认超时(秒);子类可覆盖。
    # 用户未显式配置 backends[name].timeout 时使用此值。
    default_timeout: int = 30

    def __init__(self, config: WebSearchConfig) -> None:
        self.config = config
        self.timeout = self._resolve_timeout()
        # proxy 为 None 时回退到系统代理环境变量(HTTP_PROXY/HTTPS_PROXY),
        # 让 web_search 自动复用用户已有的代理配置,海外后端无需额外设置
        self.proxy = config.proxy or _read_system_proxy()
        self.user_agent = _DEFAULT_USER_AGENT
        # 每个后端实例持有独立的熔断器(独立计数,互不影响)
        self.circuit_breaker = BackendCircuitBreaker(name=self.name)

    def _resolve_timeout(self) -> float:
        # 优先级:backend_cfg.timeout(用户显式配置) > 子类 default_timeout > config.timeout(全局)
        backend_cfg = self.config.get_backend_config(self.name)
        return float(backend_cfg.timeout or self.default_timeout or self.config.timeout)

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

    async def safe_search(self, query: str, count: int) -> BackendResponse:
        """带熔断器的搜索包装。

        - open 状态下直接返回错误响应(不发网络请求)
        - 成功时重置熔断器
        - 失败时记录,达到阈值后打开熔断器

        aggregator 应调用本方法而非直接调 ``search()``,
        以获得熔断保护。子类无需覆盖本方法。
        """
        cb = self.circuit_breaker
        if not cb.allow():
            return BackendResponse(
                backend=self.name,
                error=f"{self.name}: circuit breaker open (status={cb.status()}, retry later)",
            )
        resp = await self.search(query, count)
        if resp.ok:
            cb.record_success()
        else:
            cb.record_failure()
        return resp


class HtmlScrapeBackend(SearchBackend):
    """免 API Key 的 HTML 抓取后端通用模板。

    子类只需声明 4 个类属性 (``_SEARCH_URL`` / ``_RESULT_RE`` /
    ``_LINK_RE`` / ``_SNIPPET_RE``) 与 ``_BASE_URL``,即可复用通用的
    fetch + parse 流程。可选覆盖 ``count_multiplier`` / ``count_cap``
    调整请求条数。

    当前注册的后端均基于 API/JSON,本类作为可扩展基类保留,便于将来
    添加新的免 Key 抓取型后端。
    """

    # 子类必须覆盖:
    _SEARCH_URL: str = ""  # 含 {query} 和 {count} 占位符
    _RESULT_RE: Pattern[str] = re.compile(r"$^")  # 默认不匹配任何内容
    _LINK_RE: Pattern[str] = re.compile(r"$^")
    _SNIPPET_RE: Pattern[str] = re.compile(r"$^")
    _BASE_URL: str = ""

    # 可选覆盖:
    count_multiplier: int = 2
    count_cap: int = 20

    def _build_url(self, query: str, count: int) -> str:
        """构造搜索 URL。子类可覆盖以注入额外参数。"""
        effective_count = min(count * self.count_multiplier, self.count_cap)
        return self._SEARCH_URL.format(
            query=encode_query(query),
            count=effective_count,
        )

    def _build_headers(self) -> dict[str, str]:
        """构造请求头。子类可覆盖。"""
        return {
            "User-Agent": self.user_agent,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }

    async def _fetch_html(self, url: str) -> str:
        """发起 GET 请求并返回响应文本。"""
        async with self.make_client() as client:
            resp = await client.get(url, headers=self._build_headers())
            resp.raise_for_status()
            return resp.text

    async def search(self, query: str, count: int) -> BackendResponse:
        url = self._build_url(query, count)
        try:
            html_text = await self._fetch_html(url)
        except Exception as e:
            logger.debug("{} search failed: {}", self.name, e)
            return BackendResponse(
                backend=self.name,
                error=f"{self.name} fetch failed: {type(e).__name__}: {e}",
            )

        results = self._parse(html_text, count)
        if not results:
            return BackendResponse(
                backend=self.name,
                error=f"{self.name} parse failed: no results (may be blocked or HTML changed)",
            )
        return BackendResponse(backend=self.name, results=results)

    def _parse(self, html_text: str, count: int) -> list[SearchResult]:
        """通用解析:用 _RESULT_RE 切块、_LINK_RE 取链接、_SNIPPET_RE 取摘要。

        子类可覆盖以处理特殊结构 (例如 Bing RSS 用 XML 而非 HTML)。
        """
        results: list[SearchResult] = []
        for match in self._RESULT_RE.finditer(html_text):
            block = match.group(1)
            link_match = self._LINK_RE.search(block)
            if not link_match:
                continue
            url = make_absolute_url(self._BASE_URL, link_match.group(1))
            title = strip_tags(link_match.group(2))
            if not title or not url:
                continue
            snippet = ""
            sn_match = self._SNIPPET_RE.search(block)
            if sn_match:
                snippet = clean_snippet(sn_match.group(1))
            results.append(
                SearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                    source_backend=self.name,
                )
            )
            if len(results) >= count:
                break
        return results


_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
