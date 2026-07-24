"""handler 共享的小工具。

鉴权失败响应、服务不可用响应等高频样板,集中在此避免各 handler 重复。
"""

from __future__ import annotations

import asyncio
import functools

from websockets.http11 import Response

from .._http_routes import _http_error


def unauthorized() -> Response:
    """401 Unauthorized 标准响应。"""
    return _http_error(401, "Unauthorized")


def service_unavailable(message: str = "service unavailable") -> Response:
    """503 Service Unavailable,用于 session_manager / cron_service 等未注入时。"""
    return _http_error(503, message)


def require_auth(fn):
    """装饰器:在 handler 执行前校验 API token,失败则返回 401。

    兼容 sync 和 async handler。用法::

        @router.route("/api/foo")
        @require_auth
        def foo(ctx: RouteContext) -> Response: ...
    """
    if asyncio.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(ctx, *args, **kwargs):
            if not ctx.deps.check_api_token(ctx.request):
                return unauthorized()
            return await fn(ctx, *args, **kwargs)
        return async_wrapper

    @functools.wraps(fn)
    def sync_wrapper(ctx, *args, **kwargs):
        if not ctx.deps.check_api_token(ctx.request):
            return unauthorized()
        return fn(ctx, *args, **kwargs)
    return sync_wrapper
