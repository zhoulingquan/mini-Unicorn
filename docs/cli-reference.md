# CLI Reference

| Command | Description |
|---------|-------------|
| `munchkin onboard` | Initialize config & workspace at `~/.munchkin/` |
| `munchkin onboard --wizard` | Launch the interactive onboarding wizard |
| `munchkin onboard -c <config> -w <workspace>` | Initialize or refresh a specific instance config and workspace |
| `munchkin agent -m "..."` | Chat with the agent |
| `munchkin agent -w <workspace>` | Chat against a specific workspace |
| `munchkin agent -w <workspace> -c <config>` | Chat against a specific workspace/config |
| `munchkin agent` | Interactive chat mode |
| `munchkin agent --no-markdown` | Show plain-text replies |
| `munchkin agent --logs` | Show runtime logs during chat |
| `Munchkin serve` | Start the OpenAI-compatible API |
| `munchkin gateway` | Start the gateway |
| `munchkin status` | Show status |
| `Munchkin provider login openai-codex` | OAuth login for providers |
| `munchkin channels login <channel>` | Authenticate a channel interactively |
| `munchkin channels status` | Show channel status |

Interactive mode exits: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`.
