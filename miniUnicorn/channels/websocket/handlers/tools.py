"""用户工具导入/删除 handler。"""

from __future__ import annotations

import base64
from urllib.parse import unquote

from websockets.http11 import Response

from .._http_routes import _http_error, _http_json_response, _query_first, _collect_chunked_header
from .._http_router import RouteContext, router
from ._common import unauthorized


@router.route("/api/tools")
def list(ctx: RouteContext) -> Response:
    """List all registered tools + user tool files on disk."""
    from miniUnicorn.webui.tools_api import list_tools

    if not ctx.deps.check_api_token(ctx.request):
        return unauthorized()
    try:
        payload = list_tools(ctx.deps.tool_registry, ctx.deps.workspace_path)
    except Exception as exc:
        return _http_error(500, str(exc))
    return _http_json_response(payload)


@router.route("/api/tools/import")
def import_tool(ctx: RouteContext) -> Response:
    """Import a .py tool file into <workspace>/tools/."""
    from miniUnicorn.webui.tools_api import WebUIToolsError, import_tool as _import_tool

    if not ctx.deps.check_api_token(ctx.request):
        return unauthorized()

    filename = _query_first(ctx.query, "filename")
    filename = unquote(filename) if filename else None

    b64_data = _collect_chunked_header(ctx.request.headers, "X-MiniUnicorn-Tool-Content")
    if not b64_data:
        return _http_error(400, "missing tool content (send via X-MiniUnicorn-Tool-Content headers)")

    try:
        content = base64.b64decode(b64_data)
    except Exception as exc:
        return _http_error(400, f"invalid base64 data: {exc}")

    try:
        payload = _import_tool(ctx.deps.workspace_path, filename or "", content)
    except WebUIToolsError as e:
        return _http_error(e.status, e.message)
    except Exception as exc:
        return _http_error(500, str(exc))
    return _http_json_response(payload)


@router.route("/api/tools/delete")
def delete(ctx: RouteContext) -> Response:
    """Delete a user tool .py file by name."""
    from miniUnicorn.webui.tools_api import WebUIToolsError, delete_tool

    if not ctx.deps.check_api_token(ctx.request):
        return unauthorized()
    try:
        payload = delete_tool(ctx.deps.workspace_path, ctx.query)
    except WebUIToolsError as e:
        return _http_error(e.status, e.message)
    except Exception as exc:
        return _http_error(500, str(exc))
    return _http_json_response(payload)
