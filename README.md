# 🧙 MiniUnicorn

<div align="center">

**一个开源、超轻量级的个人 AI 代理框架**

围绕一个可读的核心循环构建——消息进来，LLM 决策，工具执行，记忆按需注入。

[![Python](https://img.shields.io/badge/python-≥3.11-blue)](https://www.python.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![PyPI](https://img.shields.io/pypi/v/miniUnicorn-ai)](https://pypi.org/project/miniUnicorn-ai/)
[![Code Lines](https://img.shields.io/badge/core%20runtime-~13K%20lines-success)](#-为什么选择-miniunicorn)

</div>

---

## 这是什么

MiniUnicorn 是一个可以长期运行的个人 AI 代理。它不是聊天机器人框架，也不是编排引擎——它只是一个**小的代理循环**：接收消息、调用 LLM、执行工具、返回结果。所有重的东西（频道适配、工具实现、记忆策略）都挂在循环外围，核心保持可读、可审计、可替换。

基于 [Nanobot](https://github.com/marm-io/nanobot) 项目二次开发，在其轻量级代理核心基础上扩展了频道适配、记忆系统、WebUI 和多平台部署能力。

## 组成结构

整个系统围绕一个异步消息总线展开，分四层：

```
┌─────────────────────────────────────────────────────┐
│  频道层  (channels/)                                  │
│  飞书 · 钉钉 · 企微 · 微信 · QQ · WebSocket(WebUI)    │
└──────────────────┬──────────────────────────────────┘
                   │ InboundMessage
                   ▼
┌─────────────────────────────────────────────────────┐
│  消息总线  (bus/queue.py · ~130 行)                   │
│  异步队列，解耦频道与代理                              │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  代理核心  (agent/)                                   │
│  AgentLoop ─→ AgentRunner ─→ LLM Provider            │
│              ├─ ToolRegistry (工具调度)               │
│              ├─ SessionManager (会话与压缩)            │
│              ├─ Dream (两阶段记忆整合)                 │
│              └─ SubagentManager (子代理委派)           │
└──────────────────┬──────────────────────────────────┘
                   │ OutboundMessage
                   ▼
┌─────────────────────────────────────────────────────┐
│  能力层  (tools/ · skills/ · providers/)              │
│  文件系统 · Shell · 网页搜索 · MCP · 定时任务 · ...    │
└─────────────────────────────────────────────────────┘
```

### 核心运行时（~13K 行）

| 模块 | 职责 | 规模 |
|------|------|------|
| `agent/` | AgentLoop 协调对话轮次，AgentRunner 执行 LLM 循环 | ~9.6K 行 |
| `session/` | 会话历史持久化、自动压缩、目标状态跟踪 | ~1.3K 行 |
| `config/` | Pydantic 配置模型，支持 `${VAR}` 环境变量 | ~0.9K 行 |
| `cron/` | 自然语言定时任务，持久化，重启补执行 | ~0.8K 行 |
| `bus/` | 异步消息总线 | ~0.1K 行 |

### 扩展模块（~41K 行）

| 模块 | 职责 | 规模 |
|------|------|------|
| `channels/` | 6 个频道适配器（飞书/钉钉/企微/微信/QQ/WebSocket） | ~11.6K 行 |
| `agent/tools/` | 17 类内置工具（文件/Shell/搜索/MCP/子代理...） | ~9.5K 行 |
| `webui/` | 网关 HTTP/WebSocket 路由与负载构建 | ~6.3K 行 |
| `cli/` | Typer CLI 命令、终端渲染、网关运行器 | ~4.8K 行 |
| `utils/` | 文档解析、媒体解码、Git 存储等工具 | ~3.4K 行 |
| `providers/` | LLM 提供商抽象与 OpenAI 兼容实现 | ~3.9K 行 |
| `security/` | 工作区限制、SSRF 防护、Shell 沙箱 | ~1.0K 行 |
| `api/` | OpenAI 兼容 HTTP API | ~0.6K 行 |

## 技术特点

### 1. 核心循环可读

`AgentLoop` → `AgentRunner` 是整个系统唯一的处理路径。没有插件钩子链，没有中间件栈，没有动态编排。读这两个文件就能理解代理如何工作。

### 2. 总线解耦

频道与代理通过 `MessageBus`（130 行）完全解耦。频道只管发布 `InboundMessage`、消费 `OutboundMessage`，不感知代理内部状态。添加新频道不需要修改核心。

### 3. 扩展在边缘

新能力通过五种方式接入，**不进入核心循环**：

- **频道**（`channels/`）— 接入新的聊天平台
- **工具**（`agent/tools/`）— 暴露新能力给 LLM
- **技能**（`skills/`）— Markdown 知识包，按需注入上下文
- **CLI 应用**（`run_cli_app`）— 调用本机已安装的命令行程序（ffmpeg、pandoc、git 等），通过 SKILL.md 指导代理使用
- **MCP 服务器** — 外部进程，通过 MCP 协议调用

### 4. 记忆即上下文

Dream 两阶段记忆将历史整合为上下文片段，按需注入而非持久编排。会话写入是原子的（临时文件 + fsync + rename），崩溃安全。自动压缩基于 Token 预算，跳过活跃任务。

### 5. 安全边界明确

| 边界 | 机制 |
|------|------|
| 文件访问 | `_resolve_path` 强制路径在工作区内 |
| Shell 执行 | 可选 `bwrap` 沙箱，工作区限制 |
| 出站 HTTP | `validate_url_target` 阻止 RFC1918 和云元数据端点 |
| DM 准入 | 频道发送者配对码审批 |

### 6. 工具生态

17 类内置工具，覆盖代理的主要能力需求：

| 类别 | 工具 |
|------|------|
| 文件系统 | `read_file` · `write_file` · `edit_file` · `list_dir` |
| 执行 | `exec`（沙箱可选）· `run_cli_app`（本机 CLI） |
| 检索 | `web_search`（5 后端聚合）· `web_fetch` · `deep_research` |
| 编排 | `cron` · `long_task` · `execute_plan` · `delegate` |
| 外部 | `mcp_*`（多服务器）· `message`（跨频道） |
| 自省 | `self` · `runtime_state` · `recall` |

## 适用场景

### 适合

- **个人 AI 助手**：接入飞书/钉钉/微信，7×24 小时在线，记忆跨会话保留
- **开发辅助**：文件读写、Shell 执行、代码搜索、补丁应用——代理可自主完成多步任务
- **定时自动化**：自然语言调度，`/goal` 持续目标，重启后补执行
- **研究实验**：代码可读，核心循环可审计，适合研究工具使用、记忆策略、代理行为
- **编程式集成**：Python SDK 或 OpenAI 兼容 API 嵌入现有系统
- **多平台部署**：Docker、Linux 服务、macOS LaunchAgent

### 不适合

- 需要复杂 DAG 编排或工作流引擎的场景
- 需要多租户隔离的 SaaS 部署
- 不接受文件系统/Shell 访问的高沙箱要求环境

## 安装

```bash
# 从 PyPI（稳定版）
pip install miniUnicorn-ai

# 用 uv（推荐）
uv tool install miniUnicorn-ai

# 从源码（最新特性）
git clone https://github.com/HKUDS/miniUnicorn.git
cd miniUnicorn
pip install -e .
```

运行时依赖 28 个 Python 包，无原生编译依赖（除 lxml 外）。

## 快速开始

**1. 初始化配置**

```bash
miniUnicorn onboard
```

**2. 编辑 `~/.miniUnicorn/config.json`**

```json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-v1-xxx" }
  },
  "agents": {
    "defaults": { "provider": "openrouter", "model": "anthropic/claude-opus-4-6" }
  }
}
```

**3. 启动**

```bash
# CLI 对话
miniUnicorn agent

# 网关模式（带 WebUI）
miniUnicorn gateway
# → 浏览器访问 http://127.0.0.1:8765
```

WebUI 内置在 wheel 中，无需额外构建。启用 WebSocket 频道即可：

```json
{ "channels": { "websocket": { "enabled": true } } }
```

## 编程式接入

### Python SDK

```python
from miniUnicorn import MiniUnicorn

bot = MiniUnicorn.from_config()
result = await bot.run("总结这个仓库的架构", hooks=[MyHook()])
print(result.content)
print(result.tools_used)
```

### OpenAI 兼容 API

```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

端点：`/v1/chat/completions`（支持 SSE 流式）、`/v1/models`、文件上传。

## 频道接入

| 频道 | 接入方式 | 扫码登录 |
|------|---------|---------|
| WebSocket | 内置 WebUI | — |
| 飞书 | App ID + App Secret | ✓ |
| 钉钉 | App Key + App Secret | — |
| 企业微信 | Bot ID + Bot Secret | — |
| 微信 | 扫码 | ✓ |
| QQ | App ID + App Secret | — |

频道通过 `pkgutil` 自动发现，支持入口点插件扩展。

## LLM 提供商

基于统一基类，支持：

- **OpenAI 兼容**：OpenRouter、DeepSeek、Moonshot/Kimi、MiniMax、VolcEngine、StepFun、LongCat、Azure、Bedrock、NVIDIA NIM、GitHub Copilot、LM Studio、Ollama、vLLM
- **OpenAI Responses API**：GPT-5 / o-series 推理模型
- **Anthropic**：Claude 系列，自适应思考与缓存优化
- **Fallback**：主模型失败自动切换备用
- **自动检测**：根据 API Key 识别提供商

## 内置技能

Markdown + YAML frontmatter 定义，按需加载：

`cron` · `document-processing` · `github` · `image-generation` · `long-goal` · `memory` · `my` · `skill-creator` · `summarize` · `tmux` · `update-setup` · `weather`

## 文档

- [配置参考](./docs/configuration.md) — 提供商、工具、频道、MCP、安全设置
- [聊天应用](./docs/chat-apps.md) — 频道接入详细说明
- [部署指南](./docs/deployment.md) — Docker、Linux 服务、macOS LaunchAgent
- [OpenAI API](./docs/openai-api.md) · [Python SDK](./docs/python-sdk.md)
- [记忆系统](./docs/memory.md) · [频道插件](./docs/channel-plugin-guide.md)
- [WebUI 开发](./webui/README.md) — Vite 开发服务器工作流

## 贡献

PR 欢迎。代码库刻意保持可读。

| 分支 | 用途 |
|------|------|
| `main` | 稳定发布 |
| `nightly` | 实验特性 |

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

## 联系

由 [Xubin Ren](https://github.com/re-bin) 发起并维护。交流：xubinrencs@gmail.com。

---

<div align="center">

<em>核心小，扩展在边缘，记忆即上下文。</em>

</div>
