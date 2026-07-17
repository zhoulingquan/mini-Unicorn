# CLI Reference

| Command | Description |
|---------|-------------|
| `miniUnicorn onboard` | Initialize config & workspace at `~/.miniUnicorn/` |
| `miniUnicorn onboard --wizard` | Launch the interactive onboarding wizard |
| `miniUnicorn onboard -c <config> -w <workspace>` | Initialize or refresh a specific instance config and workspace |
| `miniUnicorn agent -m "..."` | Chat with the agent |
| `miniUnicorn agent -w <workspace>` | Chat against a specific workspace |
| `miniUnicorn agent -w <workspace> -c <config>` | Chat against a specific workspace/config |
| `miniUnicorn agent` | Interactive chat mode |
| `miniUnicorn agent --no-markdown` | Show plain-text replies |
| `miniUnicorn agent --logs` | Show runtime logs during chat |
| `miniUnicorn serve` | Start the OpenAI-compatible API |
| `miniUnicorn gateway` | Start the gateway |
| `miniUnicorn status` | Show status |
| `miniUnicorn provider login openai-codex` | OAuth login for providers |
| `miniUnicorn channels login <channel>` | Authenticate a channel interactively |
| `miniUnicorn channels status` | Show channel status |

Interactive mode exits: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`.
