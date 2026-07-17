"""Built-in ContextStrategy implementations.

Each strategy delegates to the corresponding AgentRunner method so the
core logic stays in one place and P0-1's tool-metadata behavior is reused.
The runner instance is supplied via ``GovernanceContext._runner`` to avoid
a circular import between this module and ``runner.py``.
"""
from __future__ import annotations

from typing import Any

from miniUnicorn.agent.context_governor import GovernanceContext


class _RunnerBoundStrategy:
    """Base for strategies that delegate to AgentRunner's existing methods."""

    name = "base"

    def _runner(self, ctx: GovernanceContext) -> Any:
        runner = getattr(ctx, "_runner", None)
        if runner is None:
            raise RuntimeError("GovernanceContext._runner not set")
        return runner

    def apply(self, messages: list[dict[str, Any]], ctx: GovernanceContext) -> list[dict[str, Any]]:
        raise NotImplementedError


class DropOrphanStrategy(_RunnerBoundStrategy):
    name = "drop_orphan_tool_results"

    def apply(self, messages, ctx):
        return self._runner(ctx)._drop_orphan_tool_results(messages)


class BackfillMissingStrategy(_RunnerBoundStrategy):
    name = "backfill_missing_tool_results"

    def apply(self, messages, ctx):
        return self._runner(ctx)._backfill_missing_tool_results(messages)


class MicrocompactStrategy(_RunnerBoundStrategy):
    name = "microcompact"

    def apply(self, messages, ctx):
        return self._runner(ctx)._microcompact(messages, ctx.tools)


class ApplyToolResultBudgetStrategy(_RunnerBoundStrategy):
    name = "apply_tool_result_budget"

    def apply(self, messages, ctx):
        return self._runner(ctx)._apply_tool_result_budget(ctx.spec, messages)


class SnipHistoryStrategy(_RunnerBoundStrategy):
    name = "snip_history"

    def apply(self, messages, ctx):
        return self._runner(ctx)._snip_history(ctx.spec, messages)
