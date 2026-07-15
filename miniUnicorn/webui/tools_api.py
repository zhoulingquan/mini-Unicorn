"""Tools REST helpers for the WebUI HTTP surface.

Lists registered tools (built-in + MCP) and manages user-uploaded .py tool
files stored in ``<workspace>/tools/``.  Uploaded files are only loaded into
the running agent after a gateway restart — this module owns storage only.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any


class WebUIToolsError(ValueError):
    """User-facing tool validation failure."""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


QueryParams = dict[str, list[str]]

_SAFE_FILENAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_\-]*\.py$")
_BUILTIN_TOOL_SOURCES = {"builtin", "mcp"}


def _query_first(query: QueryParams, key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def _query_first_alias(query: QueryParams, snake: str, camel: str) -> str | None:
    value = _query_first(query, snake)
    return _query_first(query, camel) if value is None else value


def _user_tools_dir(workspace: Path) -> Path:
    """Return the user tools directory, creating it if missing."""
    tools_dir = workspace / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)
    return tools_dir


def _classify_source(name: str) -> str:
    """Classify a tool as 'mcp', 'builtin', or 'user'."""
    if name.startswith("mcp_"):
        return "mcp"
    return "builtin"


def _scan_user_tool_files(workspace: Path) -> list[dict[str, Any]]:
    """List .py files in ``<workspace>/tools/`` (user-uploaded tools)."""
    tools_dir = workspace / "tools"
    if not tools_dir.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for entry in sorted(tools_dir.iterdir()):
        if not entry.is_file() or entry.suffix != ".py":
            continue
        stat = entry.stat()
        result.append(
            {
                "name": entry.stem,
                "filename": entry.name,
                "source": "user",
                "size_bytes": stat.st_size,
                "modified_at_ms": int(stat.st_mtime * 1000),
                "loaded": False,
            }
        )
    return result


def list_tools(
    registry: Any | None,
    workspace: Path,
) -> dict[str, Any]:
    """Return all tools: registered (builtin+mcp) + user files on disk."""
    registered: list[dict[str, Any]] = []
    user_files = _scan_user_tool_files(workspace)
    user_file_names = {f["name"] for f in user_files}

    if registry is not None:
        for name in registry.tool_names:
            tool = registry.get(name)
            source = _classify_source(name)
            # If a builtin tool name matches a user file stem, mark as user.
            if name in user_file_names:
                source = "user"
            entry: dict[str, Any] = {
                "name": name,
                "description": getattr(tool, "description", "") if tool else "",
                "source": source,
                "read_only": bool(getattr(tool, "read_only", False)) if tool else False,
                "loaded": True,
            }
            registered.append(entry)

    # Add user files that are not yet loaded (no matching registered tool).
    registered_names = {r["name"] for r in registered}
    for f in user_files:
        if f["name"] not in registered_names:
            registered.append(
                {
                    "name": f["name"],
                    "description": "",
                    "source": "user",
                    "read_only": False,
                    "loaded": False,
                    "filename": f["filename"],
                }
            )

    # Sort: builtin first, then user (loaded), then user (not loaded).
    def _sort_key(item: dict[str, Any]) -> tuple[int, str]:
        src = item.get("source", "builtin")
        loaded = item.get("loaded", False)
        if src == "builtin":
            return (0, item["name"])
        if src == "mcp":
            return (1, item["name"])
        return (2 if loaded else 3, item["name"])

    registered.sort(key=_sort_key)

    builtin_count = sum(1 for r in registered if r["source"] == "builtin")
    mcp_count = sum(1 for r in registered if r["source"] == "mcp")
    user_count = sum(1 for r in registered if r["source"] == "user")

    return {
        "tools": registered,
        "counts": {
            "builtin": builtin_count,
            "mcp": mcp_count,
            "user": user_count,
            "total": len(registered),
        },
    }


def _validate_tool_py(content: str) -> None:
    """Basic syntax + structure check for an uploaded tool file.

    Ensures the file is valid Python and contains at least one class that
    inherits from ``Tool``.  This is a lightweight gate — full validation
    happens at load time.
    """
    try:
        tree = ast.parse(content)
    except SyntaxError as e:
        raise WebUIToolsError(f"Python syntax error: {e.msg} (line {e.lineno})") from None

    has_tool_class = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                base_name = getattr(base, "id", None) or getattr(base, "attr", None)
                if base_name == "Tool":
                    has_tool_class = True
                    break
    if not has_tool_class:
        raise WebUIToolsError(
            "Tool file must define at least one class inheriting from Tool"
        )


def import_tool(
    workspace: Path,
    filename: str,
    content: bytes,
) -> dict[str, Any]:
    """Save an uploaded .py tool file into ``<workspace>/tools/``."""
    if not filename:
        raise WebUIToolsError("filename is required")
    if not _SAFE_FILENAME_RE.match(filename):
        raise WebUIToolsError(
            "filename must match [a-zA-Z][a-zA-Z0-9_-]*.py and have .py extension"
        )

    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise WebUIToolsError("file must be UTF-8 encoded") from None

    _validate_tool_py(text)

    tools_dir = _user_tools_dir(workspace)
    dest = tools_dir / filename
    dest.write_text(text, encoding="utf-8")

    return {
        "imported": True,
        "filename": filename,
        "name": dest.stem,
        "message": "Tool saved. Restart the gateway to load it.",
    }


def delete_tool(workspace: Path, query: QueryParams) -> dict[str, Any]:
    """Delete a user tool .py file by name (builtin/mcp tools are protected)."""
    name = (_query_first_alias(query, "name", "toolName") or "").strip()
    if not name:
        raise WebUIToolsError("name is required")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9_\-]*$", name):
        raise WebUIToolsError("invalid tool name")

    tools_dir = workspace / "tools"
    target = tools_dir / f"{name}.py"
    if not target.is_file():
        raise WebUIToolsError(f"user tool '{name}' not found", status=404)

    target.unlink()
    return {"deleted": True, "name": name}
