"""Shared lifecycle hook primitives for agent runs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from miniUnicorn.providers.base import LLMResponse, ToolCallRequest


@dataclass(slots=True)
class AgentHookContext:
    """Mutable per-iteration state exposed to runner hooks."""

    iteration: int
    messages: list[dict[str, Any]]
    response: LLMResponse | None = None
    usage: dict[str, int] = field(default_factory=dict)
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    tool_results: list[Any] = field(default_factory=list)
    tool_events: list[dict[str, str]] = field(default_factory=list)
    streamed_content: bool = False
    streamed_reasoning: bool = False
    final_content: str | None = None
    stop_reason: str | None = None
    error: str | None = None


class AgentHook:
    """Minimal lifecycle surface for shared runner customization."""

    def __init__(self, reraise: bool = False) -> None:
        self._reraise = reraise

    def wants_streaming(self) -> bool:
        return False

    async def before_iteration(self, context: AgentHookContext) -> None:
        pass

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        pass

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        pass

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        pass

    async def emit_reasoning(self, reasoning_content: str | None) -> None:
        pass

    async def emit_reasoning_end(self) -> None:
        """Mark the end of an in-flight reasoning stream.

        Hooks that buffer ``emit_reasoning`` chunks (for in-place UI updates)
        flush and freeze the rendered group here. One-shot hooks ignore.
        """
        pass

    async def after_iteration(self, context: AgentHookContext) -> None:
        pass

    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        return content


class CompositeHook(AgentHook):
    """Fan-out hook that delegates to an ordered list of hooks.

    Error isolation: async methods catch and log per-hook exceptions
    so a faulty custom hook cannot crash the agent loop.
    ``finalize_content`` is a pipeline (no isolation — bugs should surface).

    Circuit breaker: a hook that fails ``_FAILURE_THRESHOLD`` times in a row
    is tripped (skipped) so a persistently faulty custom hook cannot keep
    spamming exceptions and slowing the agent loop. Recoverable (transient)
    errors are counted; ``_reraise`` hooks bypass the breaker because their
    contract is to surface errors to the caller.
    """

    __slots__ = ("_hooks", "_failure_counts", "_tripped")

    # Number of consecutive failures before a hook is tripped (skipped).
    _FAILURE_THRESHOLD = 5

    def __init__(self, hooks: list[AgentHook]) -> None:
        super().__init__()
        self._hooks = list(hooks)
        # Per-hook consecutive failure counters (hook -> count).
        self._failure_counts: dict[AgentHook, int] = {}
        # Hooks whose circuit breaker has tripped (skipped on future calls).
        self._tripped: set[AgentHook] = set()

    def wants_streaming(self) -> bool:
        return any(h.wants_streaming() for h in self._hooks)

    async def _for_each_hook_safe(self, method_name: str, *args: Any, **kwargs: Any) -> None:
        for h in self._hooks:
            # Circuit breaker: skip hooks tripped after too many consecutive
            # failures so a persistently faulty hook cannot keep spamming.
            if h in self._tripped:
                continue
            if getattr(h, "_reraise", False):
                await getattr(h, method_name)(*args, **kwargs)
                self._failure_counts.pop(h, None)
                continue

            try:
                await getattr(h, method_name)(*args, **kwargs)
                # Success resets the consecutive failure counter.
                self._failure_counts.pop(h, None)
            except Exception:
                count = self._failure_counts.get(h, 0) + 1
                self._failure_counts[h] = count
                logger.exception(
                    "AgentHook.{} error in {} ({}/{})",
                    method_name, type(h).__name__, count, self._FAILURE_THRESHOLD,
                )
                if count >= self._FAILURE_THRESHOLD:
                    self._tripped.add(h)
                    logger.error(
                        "AgentHook {} tripped circuit breaker after {} "
                        "consecutive failures; skipping future calls",
                        type(h).__name__, count,
                    )

    async def before_iteration(self, context: AgentHookContext) -> None:
        await self._for_each_hook_safe("before_iteration", context)

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        await self._for_each_hook_safe("on_stream", context, delta)

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        await self._for_each_hook_safe("on_stream_end", context, resuming=resuming)

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        await self._for_each_hook_safe("before_execute_tools", context)

    async def emit_reasoning(self, reasoning_content: str | None) -> None:
        await self._for_each_hook_safe("emit_reasoning", reasoning_content)

    async def emit_reasoning_end(self) -> None:
        await self._for_each_hook_safe("emit_reasoning_end")

    async def after_iteration(self, context: AgentHookContext) -> None:
        await self._for_each_hook_safe("after_iteration", context)

    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        for h in self._hooks:
            content = h.finalize_content(context, content)
        return content


class SDKCaptureHook(AgentHook):
    """Record tool names and the final message list for ``RunResult``.

    The runner mutates ``context.messages`` in place across iterations, so the
    snapshot is refreshed on every ``after_iteration`` call; the last call
    reflects the end-of-turn state the SDK caller cares about.
    """

    def __init__(self) -> None:
        super().__init__()
        self.tools_used: list[str] = []
        self.messages: list[dict[str, Any]] = []

    async def after_iteration(self, context: AgentHookContext) -> None:
        for call in context.tool_calls:
            self.tools_used.append(call.name)
        self.messages = list(context.messages)
