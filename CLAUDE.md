# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiniUnicorn is a lightweight, open-source AI agent framework written in Python with a React/TypeScript WebUI. It centers around a small agent loop that receives messages from chat channels, invokes an LLM provider, executes tools, and manages session memory.

## Development Commands

```bash
# Python: run single test / lint
pytest tests/test_openai_api.py::test_function -v
ruff check miniUnicorn/

# WebUI: dev server (proxies API/WS to gateway :8765), build, test
# Build outputs to ../miniUnicorn/web/dist (bundled into the Python wheel)
cd webui && bun run dev      # or MINIUNICORN_API_URL=... bun run dev
cd webui && bun run build
cd webui && bun run test

# Gateway
miniUnicorn gateway
```

## High-Level Architecture

### Core Data Flow

Messages flow through an async `MessageBus` (`miniUnicorn/bus/queue.py`) that decouples chat channels from the agent core:

1. **Channels** (`miniUnicorn/channels/`) receive messages from external platforms and publish `InboundMessage` events to the bus.
2. **`AgentLoop`** (`miniUnicorn/agent/loop.py`) consumes inbound messages, builds context, and coordinates the turn.
3. **`AgentRunner`** (`miniUnicorn/agent/runner.py`) handles the actual LLM conversation loop: send messages to the provider, receive tool calls, execute tools, and stream responses.
4. Responses are published as `OutboundMessage` events back to the appropriate channel.

### Key Subsystems

- **Agent Loop** (`miniUnicorn/agent/loop.py`, `runner.py`): The core processing engine. `AgentLoop` manages session keys, hooks, and context building. `AgentRunner` executes the multi-turn LLM conversation with tool execution.
- **LLM Providers** (`miniUnicorn/providers/`): Provider implementations (Anthropic, OpenAI-compatible, OpenAI Responses API, Azure, Bedrock, GitHub Copilot, OpenAI Codex, etc.) built on a common base (`base.py`). Includes image generation (`image_generation.py`) and audio transcription (`transcription.py`). `factory.py` and `registry.py` handle instantiation and model discovery.
- **Channels** (`miniUnicorn/channels/`): Platform integrations (Telegram, Discord, Slack, Feishu, Matrix, WhatsApp, QQ, WeChat, WeCom, DingTalk, Email, MoChat, MS Teams, WebSocket). `manager.py` discovers and coordinates them. Channels are auto-discovered via `pkgutil` scan + entry-point plugins.
- **Tools** (`miniUnicorn/agent/tools/`): Agent capabilities exposed to the LLM: filesystem (read/write/edit/list), shell execution (with sandbox backends), web search/fetch, MCP servers, cron, notebook editing, subagent spawning, long-running tasks / sustained goals (`long_task.py`), image generation, and self-modification. Tools are auto-discovered via `pkgutil` scan + entry-point plugins.
- **Memory** (`miniUnicorn/agent/memory.py`): Session history persistence with Dream two-phase memory consolidation. Uses atomic writes with fsync for durability.
- **Session Management** (`miniUnicorn/session/`): Per-session history, context compaction, TTL-based auto-compaction (`manager.py`), and sustained goal state tracking (`goal_state.py`).
- **Config** (`miniUnicorn/config/schema.py`, `loader.py`): Pydantic-based configuration loaded from `~/.miniUnicorn/config.json`. Supports camelCase aliases for JSON compatibility.
- **WebUI** (`webui/`): Vite-based React SPA that talks to the gateway over a WebSocket multiplex protocol. The dev server proxies `/api`, `/webui`, `/auth`, and WebSocket traffic to the gateway.
- **API Server** (`miniUnicorn/api/server.py`): OpenAI-compatible HTTP API (`/v1/chat/completions`, `/v1/models`) for programmatic access.
- **Command Router** (`miniUnicorn/command/`): Slash command routing and built-in command handlers.
- **Heartbeat** (`miniUnicorn/templates/HEARTBEAT.md`): Periodic task list checked via `cron` jobs (legacy dedicated service removed).
- **Pairing** (`miniUnicorn/pairing/`): DM sender approval store with persistent pairing codes per channel.
- **Skills** (`miniUnicorn/skills/`): Built-in skill definitions (long-goal, cron, github, image-generation, etc.) loaded into agent context.
- **Security** (`miniUnicorn/security/`): PTH file guard and other security measures activated at CLI entry.

### Entry Points

- **CLI**: `miniUnicorn/cli/commands.py`
- **Python SDK**: `MiniUnicorn/MiniUnicorn.py`

## Project-Specific Notes

- Architecture constraints: [`.agent/design.md`](.agent/design.md)
- Security boundaries: [`.agent/security.md`](.agent/security.md)
- Common gotchas: [`.agent/gotchas.md`](.agent/gotchas.md)

## Branching Strategy

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full two-branch model (`main` vs `nightly`) and PR guidelines.

## Code Style

- Python 3.11+, asyncio throughout.
- Line length: 100.
- Linting: `ruff` with rules E, F, I, N, W (E501 ignored).
- pytest with `asyncio_mode = "auto"`.

## Common File Locations

- Config schema: `miniUnicorn/config/schema.py`
- Provider base / new provider template: `miniUnicorn/providers/base.py`
- Channel base / new channel template: `miniUnicorn/channels/base.py`
- Tool registry: `miniUnicorn/agent/tools/registry.py`
- WebUI dev proxy config: `webui/vite.config.ts`
- Tests mirror the `MiniUnicorn/` package structure.
