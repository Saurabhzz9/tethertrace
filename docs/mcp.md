# Using tethertrace from AI agents (MCP)

`tethertrace mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. Any MCP client can then see and drive your phone.

Pair the phone once first (`tethertrace pair <code>`); the server reuses that pairing. Install tethertrace globally so the `tethertrace` command exists:

```bash
npm install -g github:Saurabhzz9/tethertrace
```

If a client cannot find the command (common on Windows GUI apps), use Node directly: `"command": "node"`, `"args": ["<path-to>/tethertrace/dist/cli.js", "mcp"]`. `npm root -g` prints where global packages live.

## Clients

### Claude Code

```bash
claude mcp add tethertrace -- tethertrace mcp
# only for one project, shared with your team via .mcp.json:
claude mcp add --scope project tethertrace -- tethertrace mcp --package com.example.app
```

### Codex CLI

`~/.codex/config.toml`

```toml
[mcp_servers.tethertrace]
command = "tethertrace"
args = ["mcp"]
```

### Gemini CLI

`~/.gemini/settings.json`

```json
{ "mcpServers": { "tethertrace": { "command": "tethertrace", "args": ["mcp"] } } }
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project)

```json
{ "mcpServers": { "tethertrace": { "command": "tethertrace", "args": ["mcp"] } } }
```

### VS Code (agent mode)

`.vscode/mcp.json`

```json
{ "servers": { "tethertrace": { "type": "stdio", "command": "tethertrace", "args": ["mcp"] } } }
```

### Claude Desktop

`claude_desktop_config.json`

```json
{ "mcpServers": { "tethertrace": { "command": "tethertrace", "args": ["mcp"] } } }
```

### Local models (Ollama, LM Studio, …)

Any MCP-capable client that runs a local model can use the same server. If you only want an explanation of a failed run, no agent is needed at all:

```bash
tethertrace explain reports/<run> -m ollama:qwen3:8b
tethertrace explain reports/<run> -m lmstudio:<model>
tethertrace explain reports/<run> -m openai-compatible:<model> --base-url http://localhost:8080/v1
```

> These snippets follow each client's documented MCP configuration format. tethertrace's MCP server itself is tested with the official MCP SDK client over stdio and against a real phone; each client's own setup is not separately tested here. If one needs a tweak, please open an issue.

## Tools

| Tool | Changes the phone | What it does |
|---|---|---|
| `discover_devices` | no | Find phones with Wireless debugging on this Wi-Fi |
| `pair_device` | yes (adds a trusted key) | Pair with a 6-digit code the user reads out |
| `select_device` | no | Pick a phone when several are around |
| `device_info` | no | Manufacturer, model, Android version, SDK, ABI |
| `list_apps` | no | Installed packages |
| `apk_info` | no | Package/version/SDKs of a local APK |
| `screenshot` | no | PNG of the screen (half size by default to save tokens) |
| `ui_tree` | no | Every visible label/button with ids and bounds |
| `wait_for` | no | Wait for an element to appear or disappear |
| `app_logs` | no | One app's logcat and crash buffer |
| `explain_report` | no | Summary of a report folder |
| `tap` | yes | By text, description, id, substring, index, or x/y |
| `type_text` | yes | ASCII into the focused field |
| `press_key` | yes | back, home, enter, tab, delete, menu, recents |
| `scroll` · `swipe` | yes | Gestures |
| `launch_app` · `stop_app` | yes | Cold start (with launch time) · force-stop |
| `install_apk` | yes | Install a local APK over Wi-Fi |
| `smoke_test` | yes | Install → launch → watch → evidence and verdict |
| `explore_app` | yes | Zero-config: install, walk the screens (skipping risky buttons), catch crashes, write flows |
| `run_flow` | yes | Run a YAML flow (file or inline) and return the result |
| `shell` | yes | Only with `--allow-shell` |

## Options

| Flag | Effect |
|---|---|
| `--device host:port` | Use this phone instead of auto-discovery |
| `--read-only` | Expose only the "no" rows above |
| `--package <name...>` | App tools refuse any other package |
| `--allow-shell` | Add the raw `shell` tool |
| `--reports <dir>` | Where reports go (default `./reports`) |

## Good prompts

- "Take a screenshot of my phone and describe the screen."
- "Install `build/app-release.apk`, run a smoke test and tell me the cold start time."
- "Explore `app-release.apk` on my phone and tell me which screen crashes."
- "Open the app, go to Settings → Account, and check the delete-account button is there."
- "Run `flows/checkout.yaml`. If it fails, read the app logs and tell me the likely cause."
- "Write a YAML flow for the onboarding screens you just walked through."
