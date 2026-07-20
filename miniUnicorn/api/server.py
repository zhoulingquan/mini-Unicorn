"""OpenAI-compatible HTTP API server for a fixed MiniUnicorn session.

Provides /v1/chat/completions and /v1/models endpoints.
All requests route to a single persistent API session.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json as _json
import os
import re
import time
import uuid
from typing import Any

from aiohttp import web
from loguru import logger

from miniUnicorn.config.paths import get_media_dir
from miniUnicorn.utils.helpers import safe_filename
from miniUnicorn.utils.media_decode import (
    MAX_FILE_SIZE,
)
from miniUnicorn.utils.media_decode import (
    FileSizeExceededError as _FileSizeExceededError,
)
from miniUnicorn.utils.media_decode import (
    save_base64_data_url as _save_base64_data_url,
)
from miniUnicorn.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

__all__ = (
    "MAX_FILE_SIZE",
    "_FileSizeExceededError",
    "_save_base64_data_url",
    "create_app",
    "handle_chat_completions",
)


API_SESSION_KEY = "api:default"
API_CHAT_ID = "default"

# Environment variable used to set the static API token when the CLI does
# not pass one explicitly. Kept as a plain string so it can be patched in tests.
API_TOKEN_ENV = "MINIUNICORN_API_TOKEN"

# Public endpoints exempt from authentication (health checks must remain open
# so orchestrators like Docker/kubernetes can probe readiness without creds).
_PUBLIC_PATHS = frozenset({"/health"})

# Server-side validation for client-supplied session_id values.  Used both to
# keep per-session locks bounded and to prevent path-traversal-style abuse of
# the session_key namespace.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_SESSION_ID_MAX_LEN = 64


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


def _error_json(status: int, message: str, err_type: str = "invalid_request_error") -> web.Response:
    return web.json_response(
        {"error": {"message": message, "type": err_type, "code": status}},
        status=status,
    )


def _chat_completion_response(content: str, model: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _response_text(value: Any) -> str:
    """Normalize process_direct output to plain assistant text."""
    if value is None:
        return ""
    if hasattr(value, "content"):
        return str(getattr(value, "content") or "")
    return str(value)

# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------


def _sse_chunk(delta: str, model: str, chunk_id: str, finish_reason: str | None = None) -> bytes:
    """Format a single OpenAI-compatible SSE chunk."""
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": delta} if delta else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {_json.dumps(payload)}\n\n".encode()


_SSE_DONE = b"data: [DONE]\n\n"

# ---------------------------------------------------------------------------
# Upload helpers
# ---------------------------------------------------------------------------


def _parse_json_content(body: dict) -> tuple[str, list[str]]:
    """Parse JSON request body. Returns (text, media_paths)."""
    messages = body.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        raise ValueError("Only a single user message is supported")
    message = messages[0]
    if not isinstance(message, dict) or message.get("role") != "user":
        raise ValueError("Only a single user message is supported")

    user_content = message.get("content", "")
    media_dir = get_media_dir("api")
    media_paths: list[str] = []

    if isinstance(user_content, list):
        text_parts: list[str] = []
        for part in user_content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text_parts.append(part.get("text", ""))
            elif part.get("type") == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    saved = _save_base64_data_url(url, media_dir)
                    if saved:
                        media_paths.append(saved)
                elif url:
                    raise ValueError(
                        "Remote image URLs are not supported. "
                        "Use base64 data URLs or upload files via multipart/form-data."
                    )
        text = " ".join(text_parts)
    elif isinstance(user_content, str):
        text = user_content
    else:
        raise ValueError("Invalid content format")

    return text, media_paths


async def _parse_multipart(request: web.Request) -> tuple[str, list[str], str | None, str | None]:
    """Parse multipart/form-data. Returns (text, media_paths, session_id, model)."""
    media_dir = get_media_dir("api")
    reader = await request.multipart()
    text = ""
    session_id = None
    model = None
    media_paths: list[str] = []

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "message":
            text = (await part.read()).decode("utf-8")
        elif part.name == "session_id":
            session_id = (await part.read()).decode("utf-8").strip()
        elif part.name == "model":
            model = (await part.read()).decode("utf-8").strip()
        elif part.name == "files":
            raw = await part.read()
            if len(raw) > MAX_FILE_SIZE:
                raise _FileSizeExceededError(
                    f"File '{part.filename}' exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit"
                )
            base = safe_filename(part.filename or "upload.bin")
            filename = f"{uuid.uuid4().hex[:12]}_{base}"
            dest = media_dir / filename
            dest.write_bytes(raw)
            media_paths.append(str(dest))

    if not text:
        text = "请分析上传的文件"

    return text, media_paths, session_id, model


# ---------------------------------------------------------------------------
# Authentication & session helpers
# ---------------------------------------------------------------------------


def _resolve_api_token(explicit: str | None) -> str:
    """Return the effective API token, falling back to the env var."""
    if explicit is None:
        return os.environ.get(API_TOKEN_ENV, "").strip()
    return explicit.strip()


def _bearer_token_from_request(request: web.Request) -> str | None:
    """Extract a Bearer token from the Authorization header (case-insensitive)."""
    headers = request.headers
    authorization = headers.get("Authorization") or headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


# Loopback 主机名集合,用于判定是否允许在无 api_token 的情况下提供 API 服务。
# 仅监听 loopback 时,无 token 便利访问是可接受的;其他地址必须配置 token。
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_loopback_host(host: str) -> bool:
    """判断绑定地址是否为 loopback。"""
    return host in _LOOPBACK_HOSTS


def _is_loopback_remote(request: web.Request) -> bool:
    """判断请求来源 IP 是否为 loopback。

    用于防御反向代理场景:即使绑定了 127.0.0.1,如果代理转发了非本机请求,
    也应当要求 token 认证。
    """
    remote = request.remote or ""
    # IPv6 aiohttp 可能带上端口或包在 [ ] 中,简单取首段做判断。
    if remote.startswith("["):
        remote = remote.strip("[]").split("%")[0]
    return remote in _LOOPBACK_HOSTS


def _authenticate_request(request: web.Request) -> web.Response | None:
    """Validate the Bearer token. Returns an error response on failure, None on success.

    When no ``api_token`` is configured (e.g. local-only dev bind), authentication
    is skipped so existing local workflows keep working.  But if the request remote
    is not loopback (e.g. service is reached via a reverse proxy), authentication
    is enforced to defend against accidental public exposure.
    """
    api_token: str = request.app.get("api_token", "")
    if not api_token:
        # 无 token 时,仅允许 loopback 来源;否则按未授权处理。
        if _is_loopback_remote(request):
            return None
        return _error_json(
            401,
            "Unauthorized: API token not configured and request is not from loopback",
            err_type="authentication_error",
        )
    supplied = _bearer_token_from_request(request)
    if supplied and hmac.compare_digest(supplied, api_token):
        return None
    return _error_json(401, "Unauthorized", err_type="authentication_error")


@web.middleware
async def _auth_middleware(request: web.Request, handler):
    """aiohttp middleware enforcing Bearer token auth on protected routes."""
    if request.path in _PUBLIC_PATHS:
        return await handler(request)
    err = _authenticate_request(request)
    if err is not None:
        return err
    return await handler(request)


def _validate_session_id(session_id: str | None) -> str | None:
    """Sanitize a client-supplied session_id.

    Returns a safe session_id string (or ``None`` when the input is empty),
    rejecting values that contain path separators, exceed the length cap, or
    use characters outside the allowlist.  This keeps per-session locks
    bounded and prevents ``api:<payload>`` style namespace abuse.
    """
    if session_id is None:
        return None
    value = session_id.strip()
    if not value:
        return None
    if len(value) > _SESSION_ID_MAX_LEN:
        raise ValueError("session_id too long")
    if _SESSION_ID_RE.match(value) is None:
        raise ValueError("invalid session_id")
    return value


async def _acquire_session_lock(request: web.Request, session_key: str) -> asyncio.Lock:
    """Atomically look up (or create) the per-session lock.

    ``dict.setdefault`` is not atomic across coroutines, so a dedicated
    guard lock serialises the dictionary mutation.
    """
    locks_lock: asyncio.Lock = request.app["session_locks_lock"]
    locks: dict[str, asyncio.Lock] = request.app["session_locks"]
    async with locks_lock:
        lock = locks.get(session_key)
        if lock is None:
            lock = asyncio.Lock()
            locks[session_key] = lock
    return lock


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


async def handle_chat_completions(request: web.Request) -> web.Response:
    """POST /v1/chat/completions — supports JSON and multipart/form-data."""
    content_type = request.content_type or ""
    if not isinstance(content_type, str):
        content_type = ""

    agent_loop = request.app["agent_loop"]
    timeout_s: float = request.app.get("request_timeout", 120.0)
    model_name: str = request.app.get("model_name", "MiniUnicorn")

    stream = False
    try:
        if content_type.startswith("multipart/"):
            text, media_paths, session_id, requested_model = await _parse_multipart(request)
        else:
            try:
                body = await request.json()
            except Exception:
                return _error_json(400, "Invalid JSON body")
            stream = body.get("stream", False)
            requested_model = body.get("model")
            text, media_paths = _parse_json_content(body)
            session_id = body.get("session_id")
    except ValueError as e:
        return _error_json(400, str(e))
    except _FileSizeExceededError as e:
        return _error_json(413, str(e), err_type="invalid_request_error")
    except Exception:
        logger.exception("Error parsing upload")
        return _error_json(413, "File too large or invalid upload")

    if requested_model and requested_model != model_name:
        return _error_json(400, f"Only configured model '{model_name}' is available")

    try:
        safe_session_id = _validate_session_id(session_id)
    except ValueError as e:
        return _error_json(400, str(e))
    session_key = f"api:{safe_session_id}" if safe_session_id else API_SESSION_KEY
    session_lock = await _acquire_session_lock(request, session_key)

    # 不记录用户消息原文,仅记录长度,避免敏感内容泄露到日志。
    logger.info(
        "API request session_key={} media={} text_len={} stream={}",
        session_key, len(media_paths), len(text), stream,
    )
    # -- streaming path --
    if stream:
        return await _stream_response(
            request, agent_loop, session_lock, session_key,
            text, media_paths, model_name, timeout_s,
        )

    # -- non-streaming path --
    return await _non_stream_response(
        agent_loop, session_lock, session_key,
        text, media_paths, model_name, timeout_s,
    )


async def _stream_response(
    request: web.Request,
    agent_loop,
    session_lock: asyncio.Lock,
    session_key: str,
    text: str,
    media_paths: list[str],
    model_name: str,
    timeout_s: float,
) -> web.Response:
    """Stream chat completion tokens as OpenAI-compatible SSE events."""
    resp = web.StreamResponse()
    resp.content_type = "text/event-stream"
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Connection"] = "keep-alive"
    await resp.prepare(request)

    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    stream_failed = False
    emitted_content = False

    async def _on_stream(token: str) -> None:
        nonlocal emitted_content
        if token:
            emitted_content = True
        await queue.put(token)

    async def _on_stream_end(*_a: Any, **_kw: Any) -> None:
        # Agent stream-end callbacks mark generation segment boundaries.
        # Tool-backed requests may continue after a segment ends, so the
        # HTTP SSE stream is closed only when process_direct returns.
        return None

    async def _run() -> None:
        nonlocal stream_failed
        try:
            async with session_lock:
                response = await asyncio.wait_for(
                    agent_loop.process_direct(
                        content=text,
                        media=media_paths if media_paths else None,
                        session_key=session_key,
                        channel="api",
                        chat_id=API_CHAT_ID,
                        on_stream=_on_stream,
                        on_stream_end=_on_stream_end,
                    ),
                    timeout=timeout_s,
                )
                if not emitted_content:
                    response_text = _response_text(response)
                    if response_text.strip():
                        await queue.put(response_text)
        except Exception:
            stream_failed = True
            logger.exception("Streaming error for session {}", session_key)
        finally:
            await queue.put(None)

    task = asyncio.create_task(_run())
    try:
        while True:
            token = await queue.get()
            if token is None:
                break
            await resp.write(_sse_chunk(token, model_name, chunk_id))
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    if not stream_failed:
        await resp.write(_sse_chunk("", model_name, chunk_id, finish_reason="stop"))
        await resp.write(_SSE_DONE)
    return resp


async def _non_stream_response(
    agent_loop,
    session_lock: asyncio.Lock,
    session_key: str,
    text: str,
    media_paths: list[str],
    model_name: str,
    timeout_s: float,
) -> web.Response:
    """Run the agent and return a single chat completion JSON response."""
    fallback = EMPTY_FINAL_RESPONSE_MESSAGE

    try:
        async with session_lock:
            try:
                response = await asyncio.wait_for(
                    agent_loop.process_direct(
                        content=text,
                        media=media_paths if media_paths else None,
                        session_key=session_key,
                        channel="api",
                        chat_id=API_CHAT_ID,
                    ),
                    timeout=timeout_s,
                )
                response_text = _response_text(response)

                if not response_text or not response_text.strip():
                    logger.warning("Empty response for session {}, retrying", session_key)
                    retry_response = await asyncio.wait_for(
                        agent_loop.process_direct(
                            content=text,
                            media=media_paths if media_paths else None,
                            session_key=session_key,
                            channel="api",
                            chat_id=API_CHAT_ID,
                        ),
                        timeout=timeout_s,
                    )
                    response_text = _response_text(retry_response)
                    if not response_text or not response_text.strip():
                        logger.warning("Empty response after retry, using fallback")
                        response_text = fallback

            except asyncio.TimeoutError:
                return _error_json(504, f"Request timed out after {timeout_s}s")
            except Exception:
                logger.exception("Error processing request for session {}", session_key)
                return _error_json(500, "Internal server error", err_type="server_error")
    except Exception:
        logger.exception("Unexpected API lock error for session {}", session_key)
        return _error_json(500, "Internal server error", err_type="server_error")

    return web.json_response(_chat_completion_response(response_text, model_name))


async def handle_models(request: web.Request) -> web.Response:
    """GET /v1/models"""
    model_name = request.app.get("model_name", "MiniUnicorn")
    return web.json_response(
        {
            "object": "list",
            "data": [
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "MiniUnicorn",
                }
            ],
        }
    )


async def handle_health(request: web.Request) -> web.Response:
    """GET /health"""
    return web.json_response({"status": "ok"})


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(
    agent_loop,
    model_name: str = "MiniUnicorn",
    request_timeout: float = 120.0,
    *,
    host: str = "127.0.0.1",
    api_token: str | None = None,
) -> web.Application:
    """Create the aiohttp application.

    Args:
        agent_loop: An initialized AgentLoop instance.
        model_name: Model name reported in responses.
        request_timeout: Per-request timeout in seconds.
        host: Bind address the server will listen on. Wildcard hosts
            (``0.0.0.0`` / ``::``) require a non-empty ``api_token`` to
            prevent unauthenticated access on untrusted networks.
        api_token: Static Bearer token protecting non-public endpoints.
            When ``None`` (default), the value of the
            ``MINIUNICORN_API_TOKEN`` environment variable is used. When
            empty, authentication is skipped (only safe for local binds).
    """
    effective_token = _resolve_api_token(api_token)
    # 若 api_token 为空,仅允许 loopback 绑定;监听其他地址必须配置 token,
    # 否则在启动阶段就明确拒绝,避免无认证 API 暴露到非本机网络。
    if not effective_token and not _is_loopback_host(host):
        raise ValueError(
            f"host '{host}' is not a loopback address but no API token is set — "
            "set api_token or the MINIUNICORN_API_TOKEN environment variable, "
            "or bind to 127.0.0.1/::1/localhost to prevent unauthenticated access"
        )

    app = web.Application(client_max_size=20 * 1024 * 1024, middlewares=[_auth_middleware])  # 20MB for base64 images
    app["agent_loop"] = agent_loop
    app["model_name"] = model_name
    app["request_timeout"] = request_timeout
    app["api_token"] = effective_token
    app["session_locks"] = {}  # per-user locks, keyed by session_key
    app["session_locks_lock"] = asyncio.Lock()  # guards mutations of session_locks

    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_get("/health", handle_health)
    return app
