# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-16

### Added
- Provider Registry as the single source of truth for LLM provider metadata.
- Model presets and fallback model chain for runtime model switching.
- Auto-compaction of idle sessions to reduce token cost and first-token latency.
- Pairing-based access control for DM channels.
- bwrap sandbox for shell command execution (Linux only).
- OpenAI-compatible API server (`miniUnicorn serve`).

### Changed
- Minimum Python version is now 3.11.
- Channel plugins discovered via `miniUnicorn.channels` entry-point group.

### Fixed
- Empty `allowFrom` now denies all access by default (previously allowed all).

## [0.1.0] - 2025-01-01

### Added
- Initial release of MiniUnicorn.
- Core agent loop with async message bus.
- Channel integrations: Telegram, Discord, WebSocket, and more.
- Built-in tools: filesystem, shell execution, web search/fetch, MCP.
- Pydantic-based configuration with camelCase JSON aliases.
