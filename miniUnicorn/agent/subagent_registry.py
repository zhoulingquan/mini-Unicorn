"""Declarative subagent registry (TRAE-style .md definitions).

Subagents are defined as Markdown files with YAML frontmatter in the
workspace's `agents/` directory. The main agent's system prompt lists
their `description` so the LLM can autonomously delegate via the
`delegate` tool (mirrors TRAE's built-in Agent → Subagent dispatch).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger


@dataclass(slots=True)
class SubagentDefinition:
    """A declarative subagent definition parsed from a .md file."""
    name: str
    description: str
    system_prompt: str
    model: str | None = None
    tools: list[str] | None = None  # None = all tools
    avatar: str | None = None  # Optional emoji avatar (e.g. "🔍")
    file_path: Path | None = None

    def to_summary(self) -> str:
        """One-line summary for system prompt injection."""
        tools_hint = ""
        if self.tools is not None:
            tools_hint = f" (tools: {', '.join(self.tools)})"
        return f"- {self.name}: {self.description}{tools_hint}"


class SubagentRegistry:
    """Loads subagent definitions from agents/ directory (.md files)."""

    _FRONTMATTER_RE = re.compile(
        r"^---\s*\n(.*?)\n---\s*\n(.*)$",
        re.DOTALL,
    )

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.agents_dir = workspace / "agents"
        self._definitions: dict[str, SubagentDefinition] = {}

    def load(self) -> int:
        """Scan agents/ dir and load all .md files. Returns count loaded."""
        self._definitions.clear()
        if not self.agents_dir.is_dir():
            return 0
        count = 0
        for md_file in sorted(self.agents_dir.glob("*.md")):
            try:
                defn = self._parse_file(md_file)
                if defn:
                    # First loaded wins (TRAE-style: project-level could override)
                    if defn.name not in self._definitions:
                        self._definitions[defn.name] = defn
                        count += 1
                    else:
                        logger.debug("Subagent '{}' already defined, skipping {}", defn.name, md_file)
            except Exception:
                logger.exception("Failed to parse subagent file: {}", md_file)
        if count:
            logger.info("Loaded {} subagent definitions from {}", count, self.agents_dir)
        return count

    def _parse_file(self, path: Path) -> SubagentDefinition | None:
        """Parse a .md file with YAML frontmatter."""
        text = path.read_text(encoding="utf-8")
        match = self._FRONTMATTER_RE.match(text)
        if not match:
            logger.warning("Subagent file {} has no frontmatter, skipping", path)
            return None
        fm_text, body = match.group(1), match.group(2)
        # Parse frontmatter as simple YAML (avoid pyyaml dependency for simple cases)
        meta = self._parse_simple_yaml(fm_text)
        name = meta.get("name", "").strip()
        description = meta.get("description", "").strip()
        if not name or not description:
            logger.warning("Subagent file {} missing name/description, skipping", path)
            return None
        model = meta.get("model", "").strip() or None
        tools_str = meta.get("tools", "").strip()
        tools = None
        if tools_str:
            # Comma-separated, allow empty string meaning "no tools"
            if tools_str == '""' or tools_str == "''":
                tools = []
            else:
                tools = [t.strip() for t in tools_str.split(",") if t.strip()]
        avatar = meta.get("avatar", "").strip() or None
        return SubagentDefinition(
            name=name,
            description=description,
            system_prompt=body.strip(),
            model=model,
            tools=tools,
            avatar=avatar,
            file_path=path,
        )

    def _parse_simple_yaml(self, text: str) -> dict[str, str]:
        """Parse simple key: value YAML (no nested structures for frontmatter).

        Handles:
          name: value
          description: multi line text
          model: value
          tools: a, b, c
        """
        result: dict[str, str] = {}
        lines = text.split("\n")
        i = 0
        while i < len(lines):
            line = lines[i]
            if not line.strip() or line.strip().startswith("#"):
                i += 1
                continue
            if ":" not in line:
                i += 1
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            # Handle quoted values
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1]
            # Handle multiline description (value empty, continuation lines)
            if not value:
                collected = []
                j = i + 1
                while j < len(lines):
                    nxt = lines[j]
                    if not nxt.strip():
                        break
                    # Continuation: indented or plain text (no key: value)
                    if ":" in nxt and not nxt.startswith(" ") and not nxt.startswith("\t"):
                        break
                    collected.append(nxt.strip())
                    j += 1
                if collected:
                    value = " ".join(collected)
                    i = j
                    result[key] = value
                    continue
            result[key] = value
            i += 1
        return result

    def get(self, name: str) -> SubagentDefinition | None:
        return self._definitions.get(name)

    def list_all(self) -> list[SubagentDefinition]:
        return list(self._definitions.values())

    def build_prompt_section(self) -> str:
        """Build the 'Available Subagents' section for the main agent's system prompt."""
        if not self._definitions:
            return ""
        lines = [
            "# Available Subagents",
            "",
            "You can delegate tasks to specialized subagents via the `delegate` tool.",
            "The LLM autonomously decides when to delegate based on the descriptions below.",
            "",
        ]
        for defn in self._definitions.values():
            lines.append(defn.to_summary())
        lines.append("")
        lines.append("Usage: delegate(subagent=\"<name>\", task=\"<task description>\")")
        return "\n".join(lines)
