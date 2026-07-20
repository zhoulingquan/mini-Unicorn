"""搜索聚合器 - 降级链与并发聚合。

核心职责:
1. 降级链:按顺序尝试后端,前一个失败时切到下一个
2. 缓存:命中即返回,失败不缓存
3. 单后端模式:provider != "auto" 时只调一个后端
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends import BACKEND_REGISTRY
from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)
from miniUnicorn.agent.tools.web_search.cache import SearchCache
from miniUnicorn.agent.tools.web_search.config import (
    WebSearchConfig,
    resolve_fallback_chain,
)


class SearchAggregator:
    """搜索聚合器。"""

    def __init__(self, config: WebSearchConfig) -> None:
        self.config = config
        self.cache = (
            SearchCache(ttl=config.cache_ttl)
            if config.enable_cache
            else None
        )
        # 后端实例缓存: name -> SearchBackend
        self._backend_instances: dict[str, SearchBackend] = {}

    def _get_backend(self, name: str) -> SearchBackend | None:
        """获取后端实例(单例)。"""
        if name in self._backend_instances:
            return self._backend_instances[name]
        cls = BACKEND_REGISTRY.get(name)
        if cls is None:
            logger.warning("Unknown search backend: {}", name)
            return None
        try:
            instance = cls(self.config)
            self._backend_instances[name] = instance
            return instance
        except Exception:
            logger.exception("Failed to instantiate backend: {}", name)
            return None

    async def search(
        self,
        query: str,
        count: int | None = None,
        backend: str | None = None,
    ) -> BackendResponse:
        """执行搜索。

        - backend 显式指定时,只调这一个后端
        - backend 为 None 或 "auto" 时,走降级链
        """
        n = min(max(count or self.config.max_results, 1), 10)
        provider = (backend or self.config.provider or "auto").strip().lower()

        # 单后端模式
        if provider not in ("", "auto"):
            return await self._search_single(query, n, provider)

        # 自动降级链模式
        chain = resolve_fallback_chain(self.config.region, self.config.fallback_chain)
        return await self._search_with_fallback(query, n, chain)

    async def _search_single(
        self,
        query: str,
        count: int,
        backend_name: str,
    ) -> BackendResponse:
        """调用单个后端(带缓存)。"""
        # 1. 命中缓存
        if self.cache is not None:
            cached = self.cache.get(query, backend_name, count)
            if cached is not None:
                return BackendResponse(
                    backend=backend_name,
                    results=cached,
                    from_cache=True,
                )

        # 2. 调用后端
        backend = self._get_backend(backend_name)
        if backend is None:
            return BackendResponse(
                backend=backend_name,
                error=f"backend '{backend_name}' not registered",
            )
        resp = await backend.search(query, count)

        # 3. 成功才缓存
        if resp.ok and self.cache is not None:
            self.cache.set(query, backend_name, count, resp.results)
        return resp

    async def _search_with_fallback(
        self,
        query: str,
        count: int,
        chain: list[str],
    ) -> BackendResponse:
        """按降级链依次尝试,直到有一个成功。"""
        errors: list[str] = []
        for name in chain:
            resp = await self._search_single(query, count, name)
            if resp.ok:
                if errors:
                    # 记录前面降级的失败原因(调试用)
                    logger.debug(
                        "search fallback: {} succeeded after failures: {}",
                        name,
                        "; ".join(errors),
                    )
                return resp
            errors.append(f"{name}: {resp.error}")
        # 全部失败
        return BackendResponse(
            backend=",".join(chain),
            error=f"all backends failed: {'; '.join(errors)}",
        )

    async def search_multi(
        self,
        query: str,
        count: int,
        backend_names: list[str],
    ) -> list[BackendResponse]:
        """并发调用多个后端(用于聚合模式,Phase 2+)。"""
        tasks = [self._search_single(query, count, name) for name in backend_names]
        return await asyncio.gather(*tasks, return_exceptions=False)

    def invalidate_cache(self) -> None:
        """清空缓存。"""
        if self.cache is not None:
            self.cache.clear()
