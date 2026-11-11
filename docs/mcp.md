# Using tethertrace from AI agents (MCP)

`tethertrace mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. Any MCP client can then see and drive your phone.

Pair the phone once first (`tethertrace pair <code>`); the server reuses that pairing. Install tethertrace globally so the `tethertrace` command exists:

```bash
npm install -g tethertrace
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
| `record_screen` | no | Record the screen for N seconds; `run_flow`, `explore_app` and `smoke_test` also take `record: true` |
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
| `explore_app` | yes | Zero-config: install, walk the screens (skipping risky buttons), catch crashes, write flows; returns `coverage.level` so "no crash" on a screen it couldn't tap isn't read as a pass |
| `run_flow` | yes | Run a YAML flow (file or inline) and return the result |
| `verify_app` | yes | Check the installed build against what is remembered: re-run the flows that could be affected, explore a new build, report regressions ([verify.md](verify.md)) |
| `app_memory` | no | What is remembered about an app: builds, screens, how each flow went |
| `shell` | yes | Only with `--allow-shell` |

## Prompts

| Prompt | What it does |
|---|---|
| `write_test` (package, goal) | Asks the model to inspect the app on the phone (and its source, if available), write a YAML flow for the goal, run it and fix it until it passes |

## Options

| Flag | Effect |
|---|---|
| `--device host:port` | Use this phone instead of auto-discovery. The server then stays on it: `select_device` refuses any other address |
| `--read-only` | Expose only the "no" rows above. Wins over `--allow-shell` |
| `--package <name...>` | Limit the session to these apps (see below) |
| `--allow-shell` | Add the raw `shell` tool. Never with `--read-only` or `--package` |
| `--confirm <classes>` | A person must approve every call of these kinds: `interact`, `install`, `execute`, `sensitive` |
| `--preauthorize <classes>` | Approve these kinds in advance for an unattended run (overrides `--confirm`) |
| `--no-audit` | Do not write the audit log |
| `--reports <dir>` | Where reports go (default `./reports`) |

## Security model

The server decides what is allowed. It does not rely on the client asking you, and the `readOnlyHint` style annotations it sends are only hints.

Every tool belongs to a permission class, and every call passes one policy check before it touches the phone:

| Class | Tools | Granted when |
|---|---|---|
| `read` | `discover_devices`, `select_device`, `device_info`, `list_apps`, `apk_info`, `screenshot`, `record_screen`, `ui_tree`, `wait_for`, `app_logs`, `explain_report`, `app_memory` | always |
| `interact` | `tap`, `type_text`, `press_key`, `scroll`, `swipe`, `launch_app`, `stop_app`, `run_flow`, `smoke_test`, `explore_app`, `verify_app` | not `--read-only` |
| `install` | `install_apk`, and `smoke_test` / `explore_app` when given an APK | not `--read-only` |
| `execute` | `shell` | `--allow-shell`, and neither `--read-only` nor `--package` |
| `sensitive` | `pair_device` | not `--read-only` |

A tool whose class is not granted is not listed, and is refused again if it is called anyway.

### `--package` is enforced on the phone

It is not only a check on tool arguments. Before a tool reads or touches the screen, the server asks Android which app has focus:

- If another app is in front, `tap`, `type_text`, `press_key`, `scroll`, `swipe`, `screenshot`, `ui_tree` and `wait_for` are refused. `launch_app` brings your app back.
- If Android does not name an app (notification shade, lock screen) or the check fails, the answer is also no.
- Raw coordinates must land on an element of your app, and outside the status bar, navigation bar and gesture strips that Android reports (an app can draw underneath those, but a touch there opens the shade or goes home). A tap by text must match an element of your app.
- The `home`, `recents` and `menu` keys are refused.
- A YAML flow is checked before every step that acts, so it stops as soon as it leaves the app.
- `record_screen` is off, because a recording cannot be limited to one app. Use `record: true` on a test instead. `list_apps` shows only your apps.
- Permission dialogs belong to Android's own package, so an agent cannot answer them in a scoped session. Grant permissions yourself, or add that package to `--package` on purpose.

An APK is installed only as the app it contains: `smoke_test` and `explore_app` refuse an `apkPath` whose package differs from `package`.

### Confirmation

With `--confirm install,execute` (any classes), each such call needs a person.

- If your client supports MCP elicitation, it asks you there.
- Otherwise the call is refused with an id. You run `tethertrace approve <id>` in a terminal and the agent repeats the call. One approval covers one call and expires after 10 minutes. `tethertrace approve` with no id lists what is waiting.
- For CI, either leave `--confirm` out or name the classes you trust with `--preauthorize`.

This protects you from a client that approves tool calls automatically. It cannot protect you from an agent that may run any shell command on your computer, because that agent could run `tethertrace approve` itself. Keep your client's own shell permissions on.

### Audit log

Every decision is appended to `~/.tethertrace/audit.jsonl` (`TETHERTRACE_HOME` moves it): time, tool, classes, allowed or denied, the reason, and the package or file involved. Typed text is never written. Shell commands are recorded up to 200 characters.

### HOL Guard

[HOL Guard](https://github.com/hashgraph-online/hol-guard) users can find a ready catalog entry for tethertrace in [`integrations/hol-guard`](../integrations/hol-guard/README.md): read tools keep the existing policy, everything that acts is reviewed, and `shell` is blocked. It is optional and tethertrace does not depend on it.

### Known limits

- The focus check and the action are two steps, so an app that changes the screen in between can still receive one action.
- These checks apply to the MCP server. The `tethertrace` CLI runs as you and is not restricted.
- The scope checks were run on one real phone (realme, Android 14, 21 cases) and against a mock device. Other phones may report focus or system bars differently; when the server cannot read them it refuses.

## Good prompts

- "Take a screenshot of my phone and describe the screen."
- "Install `build/app-release.apk`, run a smoke test and tell me the cold start time."
- "Explore `app-release.apk` on my phone and tell me which screen crashes."
- "Open the app, go to Settings → Account, and check the delete-account button is there."
- "Run `flows/checkout.yaml`. If it fails, read the app logs and tell me the likely cause."
- "Write a YAML flow for the onboarding screens you just walked through."
