"""Context builder for assembling agent prompts."""

import base64
import mimetypes
import platform
from pathlib import Path
from typing import Any, Mapping, Sequence

from miniUnicorn.agent.memory import MemoryStore
from miniUnicorn.agent.skills import SkillsLoader
from miniUnicorn.agent.subagent_registry import SubagentDefinition
from miniUnicorn.agent.tools import mcp as mcp_tools
from miniUnicorn.agent.tools.registry import ToolRegistry
from miniUnicorn.apps.cli import utils as cli_app_utils
from miniUnicorn.bus.events import InboundMessage
from miniUnicorn.session.goal_state import goal_state_runtime_lines
from miniUnicorn.utils.helpers import (
    current_time_str,
    detect_image_mime,
    load_bundled_template,
    truncate_text,
)
from miniUnicorn.utils.prompt_templates import render_template


def session_extra(metadata: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return persisted kwargs for turn-attached capabilities."""
    return cli_app_utils.session_extra(metadata) | mcp_tools.session_extra(metadata)


def runtime_lines(state: Any, msg: Any, workspace: Path, *, skip: bool = False) -> list[str]:
    """Return model-visible runtime annotations for turn-attached capabilities."""
    return [
        *cli_app_utils.runtime_lines(msg, workspace, skip=skip),
        *mcp_tools.runtime_lines(
            msg,
            configured_server_names=set(state._mcp_servers),
            connected_server_names=set(state._mcp_stacks),
            skip=skip,
        ),
    ]


async def connect_mcp(state: Any, tools: ToolRegistry) -> None:
    await mcp_tools.connect_missing_servers(state, tools)


async def handle_runtime_control(state: Any, msg: InboundMessage, tools: ToolRegistry) -> bool:
    return await mcp_tools.handle_runtime_control(state, msg, tools)


class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md"]
    _RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]"
    _MAX_RECENT_HISTORY = 50
    _MAX_HISTORY_CHARS = 32_000  # hard cap on recent history section size
    _RUNTIME_CONTEXT_END = "[/Runtime Context]"

    def __init__(self, workspace: Path, timezone: str | None = None, disabled_skills: list[str] | None = None, subagent_registry: Any = None):
        self.workspace = workspace
        self.timezone = None
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace, disabled_skills=set(disabled_skills) if disabled_skills else None)
        self.subagent_registry = subagent_registry
        # bootstrap 文件（AGENTS.md/SOUL.md/USER.md）的 mtime+size 缓存。
        # build_system_prompt 每次 turn 都会读取，turn 内不变；外部修改（Dream
        # 或用户）通过 mtime 自动失效。key=Path, value=(mtime_ns, size, content)。
        self._bootstrap_cache: dict[Path, tuple[int, int, str]] = {}

    def build_system_prompt(
        self,
        skill_names: list[str] | None = None,
        channel: str | None = None,
        session_summary: str | None = None,
        workspace: Path | None = None,
        query_embedding: list[float] | None = None,
        vector_recall: bool = False,
        agent_override: SubagentDefinition | None = None,
    ) -> str:
        """Build the system prompt from identity, bootstrap files, memory, and skills.

        When ``agent_override`` is provided (subagent takeover mode), the
        subagent's system_prompt replaces the default agent identity and the
        "Available Subagents" delegation list is omitted — the subagent runs
        as the primary identity for the turn.
        """
        root = workspace or self.workspace
        if agent_override is not None:
            # Subagent takeover mode: user selected a subagent via @. Run as
            # that subagent's identity instead of the default agent identity.
            header = (
                f"You are running as the '{agent_override.name}' agent. "
                f"{agent_override.description}"
            )
            parts = [header, agent_override.system_prompt]
        else:
            parts = [self._get_identity(channel=channel, workspace=root)]

        bootstrap = self._load_bootstrap_files(root)
        if bootstrap:
            parts.append(bootstrap)

        parts.append(render_template("agent/tool_contract.md"))

        # Memory injection: full MEMORY.md by default; top-k vector recall when enabled.
        vs = self.memory.vector_store
        if (
            vector_recall
            and query_embedding is not None
            and vs is not None
            and vs.enabled
        ):
            recalled = vs.search(query_embedding, k=5)
            if recalled:
                recall_text = "\n".join(
                    f"- [{r['kind']}] ({r['similarity']:.2f}) {r['text']}"
                    for r in recalled
                )
                parts.append("# Memory (Relevant Recall)\n\n" + recall_text)
            # No results: fall back to nothing (don't inject full memory in recall mode)
        else:
            memory = self.memory.get_memory_context()
            if memory and not self._is_template_content(self.memory.read_memory(), "memory/MEMORY.md"):
                parts.append(f"# Memory\n\n{memory}")

        # Inject cross-session shared memory (global facts that apply to every
        # session, written by Dream when it promotes universally-relevant
        # content). Injected in both legacy and vector-recall modes so the
        # agent always has access to the shared baseline regardless of how
        # per-session memory is fetched.
        shared = self.memory.read_shared_memory()
        if shared and shared.strip():
            parts.append(f"# Shared Memory (Cross-Session)\n\n{shared}")

        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary(exclude=set(always_skills))
        if skills_summary:
            parts.append(render_template("agent/skills_section.md", skills_summary=skills_summary))

        # History injection: full recent history by default; vector recall when enabled.
        if (
            vector_recall
            and query_embedding is not None
            and vs is not None
            and vs.enabled
        ):
            recalled_hist = vs.search(query_embedding, k=10, kind="history")
            if recalled_hist:
                history_text = "\n".join(
                    f"- [{r['created_at']}] ({r['similarity']:.2f}) {r['text']}"
                    for r in recalled_hist
                )
                history_text = truncate_text(history_text, self._MAX_HISTORY_CHARS)
                parts.append("# Recent History (Relevant Recall)\n\n" + history_text)
        else:
            entries = self.memory.read_unprocessed_history(since_cursor=self.memory.get_last_dream_cursor())
            if entries:
                capped = entries[-self._MAX_RECENT_HISTORY:]
                history_text = "\n".join(
                    f"- [{e['timestamp']}] {e['content']}" for e in capped
                )
                history_text = truncate_text(history_text, self._MAX_HISTORY_CHARS)
                parts.append("# Recent History\n\n" + history_text)

        if session_summary:
            parts.append(f"[Archived Context Summary]\n\n{session_summary}")

        # Inject available declarative subagents (TRAE-style auto-delegation).
        # Skip in takeover mode — a subagent running as the primary identity
        # should not delegate to other subagents.
        if agent_override is None and self.subagent_registry:
            subagent_section = self.subagent_registry.build_prompt_section()
            if subagent_section:
                parts.append(subagent_section)

        return "\n\n---\n\n".join(parts)

    def _get_identity(self, channel: str | None = None, workspace: Path | None = None) -> str:
        """Get the core identity section."""
        root = workspace or self.workspace
        workspace_path = str(root.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"

        return render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template("agent/platform_policy.md", system=system),
            channel=channel or "",
        )

    @staticmethod
    def _build_runtime_context(
        channel: str | None,
        chat_id: str | None,
        timezone: str | None = None,
        sender_id: str | None = None,
        supplemental_lines: Sequence[str] | None = None,
    ) -> str:
        """Build untrusted runtime metadata block appended after user content."""
        lines = [f"Current Time: {current_time_str()}"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]
        if sender_id:
            lines += [f"Sender ID: {sender_id}"]
        if supplemental_lines:
            lines.extend(supplemental_lines)
        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines) + "\n" + ContextBuilder._RUNTIME_CONTEXT_END

    @staticmethod
    def _merge_message_content(left: Any, right: Any) -> str | list[dict[str, Any]]:
        if isinstance(left, str) and isinstance(right, str):
            return f"{left}\n\n{right}" if left else right

        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [item if isinstance(item, dict) else {"type": "text", "text": str(item)} for item in value]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]

        return _to_blocks(left) + _to_blocks(right)

    def _load_bootstrap_files(self, workspace: Path | None = None) -> str:
        """Load all bootstrap files from workspace."""
        parts = []
        root = workspace or self.workspace

        for filename in self.BOOTSTRAP_FILES:
            file_path = root / filename
            content = self._cached_read_bootstrap(file_path)
            if content:
                parts.append(f"## {filename}\n\n{content}")

        return "\n\n".join(parts) if parts else ""

    def _cached_read_bootstrap(self, path: Path) -> str:
        """带 mtime+size 校验的缓存读取 bootstrap 文件。

        AGENTS.md/SOUL.md/USER.md 在 turn 内不变，Dream 改写后通过 mtime
        自动失效。避免每次 build_system_prompt 都做磁盘 IO。
        """
        try:
            st = path.stat()
        except (FileNotFoundError, OSError):
            self._bootstrap_cache.pop(path, None)
            return ""
        key = (st.st_mtime_ns, st.st_size)
        cached = self._bootstrap_cache.get(path)
        if cached is not None and (cached[0], cached[1]) == key:
            return cached[2]
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return ""
        self._bootstrap_cache[path] = (st.st_mtime_ns, st.st_size, content)
        return content

    @staticmethod
    def _is_template_content(content: str, template_path: str) -> bool:
        """Check if *content* is identical to the bundled template (user hasn't customized it)."""
        tpl = load_bundled_template(template_path)
        if tpl is not None:
            return content.strip() == tpl.strip()
        return False

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        current_role: str = "user",
        sender_id: str | None = None,
        session_summary: str | None = None,
        session_metadata: Mapping[str, Any] | None = None,
        current_runtime_lines: Sequence[str] | None = None,
        workspace: Path | None = None,
        runtime_state: Any | None = None,
        inbound_message: Any | None = None,
        skip_runtime_lines: bool = False,
        query_embedding: list[float] | None = None,
        vector_recall: bool = False,
        agent_override: SubagentDefinition | None = None,
    ) -> list[dict[str, Any]]:
        """Build the complete message list for an LLM call."""
        root = workspace or self.workspace
        extra = [
            *goal_state_runtime_lines(session_metadata),
        ]
        if runtime_state is not None and inbound_message is not None:
            extra.extend(runtime_lines(runtime_state, inbound_message, root, skip=skip_runtime_lines))
        if current_runtime_lines:
            extra.extend(line for line in current_runtime_lines if line)
        runtime_ctx = self._build_runtime_context(
            channel,
            chat_id,
            self.timezone,
            sender_id=sender_id,
            supplemental_lines=extra or None,
        )
        user_content = self._build_user_content(current_message, media)

        # Merge runtime context and user content into a single user message
        # to avoid consecutive same-role messages that some providers reject.
        # Runtime context is appended to keep the user-content prefix stable
        # for prompt-cache hits (the context changes every turn due to time).
        if isinstance(user_content, str):
            merged = f"{user_content}\n\n{runtime_ctx}"
        else:
            merged = user_content + [{"type": "text", "text": runtime_ctx}]
        messages = [
            {
                "role": "system",
                "content": self.build_system_prompt(
                    skill_names,
                    channel=channel,
                    session_summary=session_summary,
                    workspace=root,
                    query_embedding=query_embedding,
                    vector_recall=vector_recall,
                    agent_override=agent_override,
                ),
            },
            *history,
        ]
        if messages[-1].get("role") == current_role:
            last = dict(messages[-1])
            last["content"] = self._merge_message_content(last.get("content"), merged)
            messages[-1] = last
            return messages
        messages.append({"role": current_role, "content": merged})
        return messages

    def _build_user_content(self, text: str, media: list[str] | None) -> str | list[dict[str, Any]]:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text

        images = []
        for path in media:
            p = Path(path)
            if not p.is_file():
                continue
            raw = p.read_bytes()
            mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
            if not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(raw).decode()
            images.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
                "_meta": {"path": str(p)},
            })

        if not images:
            return text
        return images + [{"type": "text", "text": text}]
