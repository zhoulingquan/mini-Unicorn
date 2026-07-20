"""DuckDuckGo 后端 - 国外免 Key,国内需代理。

使用 ddgs 库(项目已依赖),通过 asyncio.to_thread 包装同步调用。
"""

from __future__ import annotations

import asyncio

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)


class DuckDuckGoBackend(SearchBackend):
    """DuckDuckGo 搜索后端(通过 ddgs 库)。"""

    name = "duckduckgo"
    requires_api_key = False
    needs_proxy_in_cn = True  # 国内需配 proxy
    env_var = ""

    async def search(self, query: str, count: int) -> BackendResponse:
        try:
            # ddgs 是同步库,用 to_thread 避免阻塞事件循环
            results_raw = await asyncio.to_thread(self._sync_search, query, count)
        except Exception as e:
            logger.debug("duckduckgo search failed: {}", e)
            return BackendResponse(
                backend=self.name,
                error=f"duckduckgo fetch failed: {type(e).__name__}: {e}",
            )

        if not results_raw:
            return BackendResponse(
                backend=self.name,
                error="duckduckgo returned no results (may need proxy in CN)",
            )

        results = [
            SearchResult(
                title=str(r.get("title", "")),
                url=str(r.get("href") or r.get("link") or r.get("url") or ""),
                snippet=str(r.get("body") or r.get("snippet") or ""),
                source_backend=self.name,
            )
            for r in results_raw
        ]
        results = [r for r in results if r.title and r.url]
        if not results:
            return BackendResponse(backend=self.name, error="duckduckgo: no valid results after parsing")
        return BackendResponse(backend=self.name, results=results)

    def _sync_search(self, query: str, count: int) -> list[dict]:
        """同步调用 ddgs。"""
        try:
            from ddgs import DDGS
        except ImportError as e:
            raise RuntimeError("ddgs package not installed. Run: pip install ddgs") from e

        proxy = self.proxy or None
        with DDGS(proxy=proxy, timeout=self.timeout) as ddgs:
            return list(ddgs.text(query, max_results=count))
