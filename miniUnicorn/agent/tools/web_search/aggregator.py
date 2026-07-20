"""搜索聚合器 - 并发聚合 + 单后端兜底。

核心职责:
1. auto 模式: 并发调用所有已注册后端,合并去重后返回最全面的结果
   - 国内后端(bocha/bing_cn/sogou/baidu/tencent)和国外后端(duckduckgo)同时尝试
   - 有代理时国外后端走代理;无代理时国外后端自然失败被跳过,不影响国内结果
2. 单后端模式: provider != "auto" 时只调一个后端
3. 缓存: 命中即返回,失败不缓存(单后端模式下生效)
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlsplit, urlunsplit

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends import BACKEND_REGISTRY
from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)
from miniUnicorn.agent.tools.web_search.cache import SearchCache
from miniUnicorn.agent.tools.web_search.config import DEFAULT_CACHE_TTL_S, WebSearchConfig


# 后端结果合并优先级(按单条结果质量从高到低)。
# 并发模式下,所有后端同时跑;合并去重时排在前面的后端结果优先占位。
# 依据:AI Search / 官方 API 的 snippet 完整度和相关性 > 抓取型后端;
# 抓取型后端中 baidu 易被风控返回不完整结果,放最后(仅高于海外兜底)。
# 顺序可随实测数据调整。
BACKEND_PRIORITY: tuple[str, ...] = (
    "bocha",      # AI Search API,snippet 最完整最相关(需 Key,无 Key 自动失败跳过)
    "tencent",    # 腾讯云官方 API,结构化字段完整(需凭证)
    "bing_cn",    # Bing RSS,标题/snippet 中规中矩,稳定
    "duckduckgo", # 海外免 Key,中文查询质量一般但英文/技术查询好
    "sogou",      # 抓取型,snippet 偶有截断
    "baidu",      # 抓取型,易被风控返回不完整结果
)


class SearchAggregator:
    """搜索聚合器。"""

    def __init__(self, config: WebSearchConfig) -> None:
        self.config = config
        # 缓存始终启用,TTL 由内部常量控制(不暴露给 UI)
        self.cache = SearchCache(ttl=DEFAULT_CACHE_TTL_S)
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

        - backend 显式指定且非 auto 时,只调这一个后端
        - backend 为 None / "auto" 时,并发调用所有已注册后端,合并去重
        """
        n = min(max(count or self.config.max_results, 1), 10)
        provider = (backend or self.config.provider or "auto").strip().lower()

        # 单后端模式
        if provider not in ("", "auto"):
            return await self._search_single(query, n, provider)

        # 并发聚合模式
        return await self._search_concurrent(query, n)

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

    async def _search_concurrent(
        self,
        query: str,
        count: int,
    ) -> BackendResponse:
        """并发调用所有已注册后端,合并去重后返回。

        - 任一后端失败被跳过(不影响其他后端)
        - 全部失败时返回聚合错误
        - 按 BACKEND_PRIORITY 顺序合并去重,截取 count 条
        """
        backend_names = list(BACKEND_REGISTRY.keys())
        tasks = [self._search_single(query, count, name) for name in backend_names]
        responses = await asyncio.gather(*tasks, return_exceptions=False)

        # 收集成功响应,按 BACKEND_PRIORITY 排序
        ok_responses: dict[str, BackendResponse] = {}
        failed: list[str] = []
        for name, resp in zip(backend_names, responses):
            if resp.ok and resp.results:
                ok_responses[name] = resp
            else:
                failed.append(f"{name}: {resp.error or 'no results'}")

        if not ok_responses:
            return BackendResponse(
                backend="auto",
                error=f"all backends failed: {'; '.join(failed)}",
            )

        # 合并去重
        merged = _merge_dedupe(ok_responses, count)

        if failed:
            logger.debug(
                "web_search concurrent: {} backends ok, {} failed: {}",
                len(ok_responses),
                len(failed),
                "; ".join(failed),
            )

        # 标记来源(用于结果中显示)
        return BackendResponse(
            backend="auto",
            results=merged,
            from_cache=any(r.from_cache for r in ok_responses.values()),
        )

    def invalidate_cache(self) -> None:
        """清空缓存。"""
        if self.cache is not None:
            self.cache.clear()


def _normalize_url(url: str) -> str:
    """URL 标准化用于去重:去 fragment、去 trailing slash、转小写 host。

    保留 query string,因为同一 URL 不同 query 可能指向不同内容;
    但去掉 fragment(锚点不影响内容)。
    """
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip().lower()
    if not parts.netloc:
        return url.strip().lower()
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(
        (
            parts.scheme.lower(),
            parts.netloc.lower(),
            path,
            parts.query,
            "",  # 丢弃 fragment
        )
    )


def _merge_dedupe(
    responses: dict[str, BackendResponse],
    count: int,
) -> list[SearchResult]:
    """按 BACKEND_PRIORITY 顺序合并多个后端的结果,URL 去重,截取 count 条。

    - 同一 URL 只保留首次出现(优先级高的后端优先)
    - 单个后端内部原本就按相关性排序,保留其相对顺序
    """
    seen: set[str] = set()
    merged: list[SearchResult] = []

    # 优先级顺序,未在 BACKEND_PRIORITY 中的后端追加在末尾(按响应字典插入顺序)
    ordered_names = [n for n in BACKEND_PRIORITY if n in responses]
    ordered_names += [n for n in responses if n not in BACKEND_PRIORITY]

    for name in ordered_names:
        resp = responses[name]
        for result in resp.results:
            key = _normalize_url(result.url)
            if not key or key in seen:
                continue
            seen.add(key)
            # 标记来源后端(便于调试和展示)
            if not result.source_backend:
                result.source_backend = name
            merged.append(result)
            if len(merged) >= count:
                return merged
    return merged
