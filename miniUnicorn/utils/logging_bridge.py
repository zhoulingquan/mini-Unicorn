"""Utilities for redirecting stdlib logging to loguru."""
from __future__ import annotations

import logging

from loguru import logger


class _LoguruBridge(logging.Handler):
    """Route stdlib log records into loguru with consistent formatting."""

    _LEVEL_MAP: dict[int, str] = {
        logging.DEBUG: "DEBUG",
        logging.INFO: "INFO",
        logging.WARNING: "WARNING",
        logging.ERROR: "ERROR",
        logging.CRITICAL: "CRITICAL",
    }

    def __init__(self, lib_name: str) -> None:
        super().__init__()
        self.lib_name = lib_name

    def emit(self, record: logging.LogRecord) -> None:
        level = self._LEVEL_MAP.get(record.levelno, "INFO")
        # Stack-frame traversal to find the real caller is expensive at high
        # log volumes.  Only do it for DEBUG records where the precise caller
        # location aids troubleshooting; higher levels skip the walk.
        if level == "DEBUG":
            frame, depth = logging.currentframe(), 2
            while frame and frame.f_code.co_filename == logging.__file__:
                frame, depth = frame.f_back, depth + 1
            logger.opt(depth=depth, exception=record.exc_info).log(
                level, "[{lib}] {message}", lib=self.lib_name, message=record.getMessage()
            )
        else:
            logger.opt(exception=record.exc_info).log(
                level, "[{lib}] {message}", lib=self.lib_name, message=record.getMessage()
            )


def redirect_lib_logging(name: str, level: str | None = None) -> None:
    """Redirect stdlib logging from *name* into loguru.

    Adds a bridge handler if one is not already present and disables
    propagation so messages are not duplicated.  When *level* is None the
    handler does not filter — loguru's own level controls visibility.
    """
    lib_logger = logging.getLogger(name)
    if not any(isinstance(h, _LoguruBridge) for h in lib_logger.handlers):
        handler = _LoguruBridge(name)
        if level is not None:
            handler.setLevel(getattr(logging, level.upper(), logging.WARNING))
        lib_logger.handlers = [handler]
        lib_logger.propagate = False
