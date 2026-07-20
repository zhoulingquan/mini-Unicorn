"""WebSearchTool - web_search 工具入口。

独立于 web_fetch,只负责关键词搜索。
支持多后端 + 降级链 + 缓存,详见 aggregator.py。
"""

from __future__ import annotations

import json
from typing import Any

from miniUnicorn.agent.tools.base import Tool, tool_parameters
from miniUnicorn.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from miniUnicorn.agent.tools.web_search.aggregator import SearchAggregator
from miniUnicorn.agent.tools.web_search.config import WebSearchConfig


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Search query keywords"),
        count=IntegerSchema(5, minimum=1, maximum=10),
        backend={
            "type": "string",
            "description": (
                "Search backend. 'auto' (default) = use fallback chain. "
                "Options: auto / bing_cn / baidu / sogou / bocha / tencent / duckduckgo."
            ),
            "default": "auto",
        },
        required=["query"],
    )
)
class WebSearchTool(Tool):
    """Search the web for keywords. Returns a list of results (title, url, snippet)."""

    _scopes = {"core", "subagent"}

    name = "web_search"
    description = (
        "Search the web with a keyword query. Returns up to `count` results, "
        "each with title, url, and a short snippet. "
        "Default backend='auto' picks an available engine automatically (CN-friendly). "
        "Use web_fetch to read full content of a specific URL."
    )

    config_key = "web_search"

    @classmethod
    def config_cls(cls):
        return WebSearchConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        # ctx.config 是 ToolsConfig;web_search 字段默认存在
        cfg = getattr(ctx.config, "web_search", None)
        return cfg is None or cfg.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        cfg = getattr(ctx.config, "web_search", None) or WebSearchConfig()
        return cls(config=cfg)

    def __init__(self, config: WebSearchConfig | None = None) -> None:
        self.config = config or WebSearchConfig()
        self.aggregator = SearchAggregator(self.config)

    @property
    def read_only(self) -> bool:
        return True

    @property
    def compactable(self) -> bool:
        return True

    @property
    def cacheable(self) -> bool:
        # 工具结果由内部 SearchCache 管理,不让 runner 层重复缓存
        return False

    @property
    def exclusive(self) -> bool:
        # duckduckgo 用 ddgs 同步库,需串行;其余后端可并发
        provider = (self.config.provider or "auto").lower()
        if provider not in ("", "auto"):
            return provider == "duckduckgo"
        # auto 模式:国内降级链不含 duckduckgo,可并发
        return self.config.region.lower() != "cn"

    async def execute(
        self,
        query: str,
        count: int | None = None,
        backend: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not query or not query.strip():
            return json.dumps({"error": "query is required"}, ensure_ascii=False)

        try:
            resp = await self.aggregator.search(query, count, backend)
        except Exception as e:
            return json.dumps(
                {"error": f"search failed: {type(e).__name__}: {e}", "query": query},
                ensure_ascii=False,
            )

        if not resp.ok:
            return json.dumps(
                {
                    "error": resp.error,
                    "backend": resp.backend,
                    "query": query,
                    "hint": (
                        "Tip: configure api_key for bocha/tencent, or set proxy for duckduckgo. "
                        "See config.web_search.backends / config.web_search.proxy."
                    ),
                },
                ensure_ascii=False,
            )

        results = [r.to_dict() for r in resp.results]
        return json.dumps(
            {
                "query": query,
                "backend": resp.backend,
                "count": len(results),
                "from_cache": resp.from_cache,
                "results": results,
            },
            ensure_ascii=False,
        )
