"""handler 共享的小工具。

鉴权失败响应、服务不可用响应等高频样板,集中在此避免各 handler 重复。
"""

from __future__ import annotations

from websockets.http11 import Response

from .._http_routes import _http_error


def unauthorized() -> Response:
    """401 Unauthorized 标准响应。"""
    return _http_error(401, "Unauthorized")


def service_unavailable(message: str = "service unavailable") -> Response:
    """503 Service Unavailable,用于 session_manager / cron_service 等未注入时。"""
    return _http_error(503, message)
