"""搜索后端通用熔断器。

从 ``miniUnicorn/agent/tools/web.py`` 的 ``_JinaCircuitBreaker`` 抽象而来,
供所有 ``SearchBackend`` 实例使用,避免某个 HTML 抓取型后端改版失效时
持续拖慢聚合搜索。

状态机:
    closed  ──连续失败 N 次──>  open(跳过该后端,直接返回错误)
                                 │
                                 └──冷却 T 秒──> half_open(试一次)
                                                       │
                                                       ├─成功─> closed
                                                       └─失败─> open

设计要点:
- 每个后端实例持有自己的熔断器(独立计数,互不影响)
- open 状态下直接返回 ``BackendResponse(error=...)``,不发网络请求
- half_open 试探成功才恢复正常,失败立即重新 open
- 阈值与冷却时间可配置(默认 3 次失败 / 5 分钟冷却,与 Jina 熔断器一致)
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from loguru import logger


@dataclass
class CircuitBreakerConfig:
    """熔断器参数。"""

    failure_threshold: int = 3  # 连续失败多少次后打开
    cooldown_s: float = 300.0   # 打开后冷却多少秒才允许 half_open 试探


class BackendCircuitBreaker:
    """单个搜索后端的熔断器。

    每个后端实例应持有自己的熔断器实例(通过 ``SearchBackend.circuit_breaker`` 访问)。
    线程安全:仅在 asyncio 事件循环中使用,无需加锁(单线程调度)。
    """

    def __init__(
        self,
        name: str,
        config: CircuitBreakerConfig | None = None,
    ) -> None:
        self.name = name
        self.cfg = config or CircuitBreakerConfig()
        self._failures = 0
        self._opened_at: float = 0.0  # open 状态起始时间戳;0 表示非 open
        self._half_open = False

    def allow(self) -> bool:
        """是否允许调用后端。open 状态下冷却期满才放行一次(half_open)。"""
        if self._opened_at == 0.0:
            return True  # closed
        if time.time() - self._opened_at >= self.cfg.cooldown_s:
            if not self._half_open:
                self._half_open = True
                logger.debug(
                    "circuit_breaker[{}]: entering half_open, probing next call",
                    self.name,
                )
            return True  # half_open:放行一次试探
        return False  # open(冷却中)

    def record_success(self) -> None:
        """记录一次成功,重置计数并关闭熔断器。"""
        if self._opened_at != 0.0 or self._half_open:
            logger.info(
                "circuit_breaker[{}]: recovered, closing (was {})",
                self.name,
                "half_open" if self._half_open else "open",
            )
        self._failures = 0
        self._opened_at = 0.0
        self._half_open = False

    def record_failure(self) -> None:
        """记录一次失败,达到阈值则打开熔断器。"""
        if self._half_open:
            # 半开试探失败:立即重新打开
            self._failures = self.cfg.failure_threshold
            self._opened_at = time.time()
            self._half_open = False
            logger.info(
                "circuit_breaker[{}]: half-open probe failed, reopening (cooldown {}s)",
                self.name,
                self.cfg.cooldown_s,
            )
            return
        self._failures += 1
        if self._failures >= self.cfg.failure_threshold and self._opened_at == 0.0:
            self._opened_at = time.time()
            logger.info(
                "circuit_breaker[{}]: opened after {} consecutive failures; cooldown {}s",
                self.name,
                self._failures,
                self.cfg.cooldown_s,
            )

    def status(self) -> str:
        """当前状态字符串,用于日志诊断。"""
        if self._opened_at == 0.0:
            return "closed"
        if self._half_open:
            return "half_open"
        return "open"
