"""DeepResearchTool - deep_research 工具入口。

工作流:Plan(拆查询) -> Search(并发搜索) -> Reflect(补查询) -> Write(成报告)。

设计原则:
- 独立模块,与 web_fetch / web_search 解耦,便于升级维护。
- 复用 web_search 的 SearchAggregator(降级链、缓存、后端选择)。
- LLM 调用复用主对话 provider(通过 provider_snapshot_loader)。
- 不直接调用 web_fetch 抓取详情,仅基于搜索 snippet 生成报告(Phase 1 实现)。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import TYPE_CHECKING, Any

from loguru import logger

from miniUnicorn.agent.tools.base import Tool, tool_parameters
from miniUnicorn.agent.tools.deep_research.config import DeepResearchConfig
from miniUnicorn.agent.tools.deep_research.prompts import (
    PLAN_SYSTEM,
    PLAN_USER,
    REFLECT_SYSTEM,
    REFLECT_USER,
    WRITE_SYSTEM,
    WRITE_USER,
)
from miniUnicorn.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from miniUnicorn.agent.tools.web_search.aggregator import SearchAggregator
from miniUnicorn.agent.tools.web_search.config import WebSearchConfig

if TYPE_CHECKING:
    from miniUnicorn.providers.base import LLMProvider


# 提取 LLM 返回的 JSON 数组(容忍前后多余文本)
_JSON_ARRAY_RE = re.compile(r"\[\s*(?:\".*?\"\s*,?\s*)+\s*\]", re.DOTALL)


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Research topic or question to investigate"),
        max_queries=IntegerSchema(
            5,
            minimum=1,
            maximum=10,
            description="Max number of web searches to perform (default 5).",
        ),
        required=["query"],
    )
)
class DeepResearchTool(Tool):
    """Plan -> Search -> Reflect -> Write workflow for in-depth research."""

    _scopes = {"core", "subagent"}

    name = "deep_research"
    description = (
        "Run a multi-step research workflow on a topic: plan search queries, "
        "execute them in parallel via web_search, reflect on whether more "
        "queries are needed, then write a structured Markdown report with "
        "inline citations and a Sources list. Use this for complex questions "
        "that need synthesis across multiple sources; for a single lookup use "
        "web_search directly."
    )

    config_key = "deep_research"

    @classmethod
    def config_cls(cls):
        return DeepResearchConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = getattr(ctx.config, "deep_research", None)
        if cfg is not None and not cfg.enable:
            return False
        # web_search 必须可用(否则无搜索能力)
        ws_cfg = getattr(ctx.config, "web_search", None)
        return ws_cfg is None or ws_cfg.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        deep_cfg = getattr(ctx.config, "deep_research", None) or DeepResearchConfig()
        ws_cfg = getattr(ctx.config, "web_search", None) or WebSearchConfig()

        provider = None
        model = None
        loader = getattr(ctx, "provider_snapshot_loader", None)
        if callable(loader):
            try:
                snapshot = loader()
            except Exception:
                snapshot = None
            if snapshot is not None:
                provider = getattr(snapshot, "provider", None)
                model = getattr(snapshot, "model", None)

        return cls(
            config=deep_cfg,
            web_search_config=ws_cfg,
            provider=provider,
            model=model,
        )

    def __init__(
        self,
        config: DeepResearchConfig | None = None,
        web_search_config: WebSearchConfig | None = None,
        provider: "LLMProvider | None" = None,
        model: str | None = None,
    ) -> None:
        self.config = config or DeepResearchConfig()
        self.web_search_config = web_search_config or WebSearchConfig()
        self._provider = provider
        self._model = model
        # 复用同一 aggregator:共享缓存与降级链
        self.aggregator = SearchAggregator(self.web_search_config)

    @property
    def read_only(self) -> bool:
        return True

    @property
    def compactable(self) -> bool:
        # 报告内容较长且含引用,不应被压缩
        return False

    @property
    def cacheable(self) -> bool:
        # 每次研究的查询都可能不同,且 LLM 输出有随机性,不做结果缓存
        return False

    @property
    def exclusive(self) -> bool:
        # 内部已并发执行搜索;且占满 LLM 调度,串行避免资源争抢
        return True

    async def execute(
        self,
        query: str,
        max_queries: int | None = None,
        **kwargs: Any,
    ) -> str:
        if not query or not query.strip():
            return json.dumps({"error": "query is required"}, ensure_ascii=False)
        if self._provider is None:
            return json.dumps(
                {"error": "LLM provider not available", "query": query},
                ensure_ascii=False,
            )

        # 覆盖配置:运行时传入的 max_queries 优先(受 config.max_queries 上限)
        budget = self.config.max_queries
        if max_queries is not None:
            budget = min(max(1, int(max_queries)), self.config.max_queries)

        topic = query.strip()
        try:
            return await asyncio.wait_for(
                self._run_research(topic, budget),
                timeout=self.config.overall_timeout_s,
            )
        except asyncio.TimeoutError:
            return json.dumps(
                {
                    "error": f"research timed out after {self.config.overall_timeout_s}s",
                    "query": topic,
                },
                ensure_ascii=False,
            )
        except Exception as e:
            logger.exception("deep_research failed for query: {}", topic)
            return json.dumps(
                {
                    "error": f"research failed: {type(e).__name__}: {e}",
                    "query": topic,
                },
                ensure_ascii=False,
            )

    async def _run_research(self, topic: str, budget: int) -> str:
        """执行完整 Plan -> Search -> Reflect -> Write 流程。"""
        # 1. Plan
        initial_n = min(self.config.initial_queries, budget)
        plan_queries = await self._plan(topic, initial_n)
        if not plan_queries:
            return json.dumps(
                {"error": "plan step produced no queries", "query": topic},
                ensure_ascii=False,
            )

        # 2. Search
        executed: list[str] = []
        results: list[dict[str, Any]] = []
        await self._search_batch(plan_queries, executed, results, budget)

        # 3. Reflect (可选)
        if self.config.enable_reflect and self.config.reflect_rounds > 0:
            remaining = budget - len(executed)
            if remaining > 0:
                extra = await self._reflect(topic, executed, results, remaining)
                if extra:
                    await self._search_batch(extra, executed, results, budget)

        if not results:
            return json.dumps(
                {
                    "error": "no search results obtained",
                    "query": topic,
                    "executed_queries": executed,
                },
                ensure_ascii=False,
            )

        # 4. Write
        report = await self._write(topic, results)

        # 附带执行元信息,便于排查
        meta = {
            "query": topic,
            "executed_queries": executed,
            "total_results": len(results),
            "report": report,
        }
        return json.dumps(meta, ensure_ascii=False)

    async def _plan(self, topic: str, n: int) -> list[str]:
        """让 LLM 把主题拆成 n 条具体查询。"""
        system = PLAN_SYSTEM.format(N=n)
        user = PLAN_USER.format(topic=topic, N=n)
        raw = await self._llm_chat(system, user, max_tokens=self.config.plan_max_tokens)
        return self._parse_query_list(raw)

    async def _reflect(
        self,
        topic: str,
        executed: list[str],
        results: list[dict[str, Any]],
        extra_budget: int,
    ) -> list[str]:
        """让 LLM 看已有结果,决定是否补充查询。"""
        if extra_budget <= 0:
            return []
        system = REFLECT_SYSTEM.format(extra=extra_budget)
        digest = self._build_results_digest(results, max_items=8)
        user = REFLECT_USER.format(
            topic=topic,
            executed_queries="\n".join(f"- {q}" for q in executed) or "(none)",
            results_digest=digest or "(no results yet)",
            extra=extra_budget,
        )
        raw = await self._llm_chat(system, user, max_tokens=self.config.plan_max_tokens)
        if not raw:
            return []
        if "SUFFICIENT" in raw.upper():
            return []
        queries = self._parse_query_list(raw)
        # 去重:不重复已执行过的
        seen = set(executed)
        deduped: list[str] = []
        for q in queries:
            if q and q not in seen:
                seen.add(q)
                deduped.append(q)
            if len(deduped) >= extra_budget:
                break
        return deduped

    async def _write(self, topic: str, results: list[dict[str, Any]]) -> str:
        """基于所有搜索结果生成 Markdown 报告。"""
        block = self._build_results_block(results)
        user = WRITE_USER.format(topic=topic, results_block=block)
        report = await self._llm_chat(
            WRITE_SYSTEM,
            user,
            max_tokens=self.config.write_max_tokens,
        )
        return report.strip() or "(LLM produced empty report)"

    async def _search_batch(
        self,
        queries: list[str],
        executed: list[str],
        results: list[dict[str, Any]],
        budget: int,
    ) -> None:
        """并发执行一批查询,把结果汇总到 results 里(受 budget 限制)。"""
        # 受 budget 限制:已执行 + 待执行 不超过 budget
        remaining = budget - len(executed)
        if remaining <= 0:
            return
        todo = queries[:remaining]
        if not todo:
            return

        tasks = [self.aggregator.search(q, self.config.per_query_results) for q in todo]
        responses = await asyncio.gather(*tasks, return_exceptions=False)

        for q, resp in zip(todo, responses):
            executed.append(q)
            if not resp.ok:
                logger.debug("deep_research search failed: {} -> {}", q, resp.error)
                continue
            for r in resp.results:
                results.append(
                    {
                        "query": q,
                        "title": r.title,
                        "url": r.url,
                        "snippet": self._truncate(r.snippet, self.config.snippet_max_chars),
                    }
                )

    async def _llm_chat(self, system: str, user: str, max_tokens: int) -> str:
        """调用 LLM 返回纯文本(失败时返回空串)。"""
        if self._provider is None:
            return ""
        try:
            model = self._model or self._provider.get_default_model()
            response = await self._provider.chat(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                tools=None,
                model=model,
                max_tokens=max_tokens,
                temperature=self.config.temperature,
            )
            return (response.content or "").strip()
        except Exception:
            logger.exception("deep_research LLM call failed")
            return ""

    @staticmethod
    def _truncate(text: str, max_chars: int) -> str:
        if not text:
            return ""
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 1].rstrip() + "…"

    @staticmethod
    def _parse_query_list(raw: str) -> list[str]:
        """从 LLM 输出中提取查询列表。

        优先尝试整段 JSON 解析,失败则用正则找第一个 JSON 数组。
        """
        if not raw:
            return []
        text = raw.strip()
        # 去掉常见代码围栏
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
            text = text.strip()
        # 尝试直接解析
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if str(x).strip()]
        except json.JSONDecodeError:
            pass
        # 正则兜底
        match = _JSON_ARRAY_RE.search(text)
        if match:
            try:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, list):
                    return [str(x).strip() for x in parsed if str(x).strip()]
            except json.JSONDecodeError:
                pass
        return []

    @staticmethod
    def _build_results_digest(results: list[dict[str, Any]], max_items: int) -> str:
        """给 Reflect 阶段用的精简结果摘要。"""
        if not results:
            return ""
        lines: list[str] = []
        for r in results[:max_items]:
            title = (r.get("title") or "").strip()
            snippet = (r.get("snippet") or "").strip()[:160]
            lines.append(f"- {title}: {snippet}")
        if len(results) > max_items:
            lines.append(f"... and {len(results) - max_items} more results")
        return "\n".join(lines)

    @staticmethod
    def _build_results_block(results: list[dict[str, Any]]) -> str:
        """给 Write 阶段用的完整结果列表(带 idx)。"""
        lines: list[str] = []
        for idx, r in enumerate(results, start=1):
            q = (r.get("query") or "").strip()
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            snippet = (r.get("snippet") or "").strip()
            lines.append(f"[{idx}] {q} | {title} | {url} | {snippet}")
        return "\n".join(lines)
