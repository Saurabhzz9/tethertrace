# HOL Guard contribution for tethertrace

[HOL Guard](https://github.com/hashgraph-online/hol-guard) sits between an AI client and its MCP servers and decides which tool calls run, which need review and which are blocked. It keeps a catalog of known MCP servers with default policies. The files in this folder are tethertrace's entry for that catalog.

This is optional. tethertrace does not depend on HOL Guard, and its own server-side policy (`docs/mcp.md`, "Security model") works without it. The entry only tells Guard users what each tethertrace tool does so Guard can apply sensible defaults.

## Files

| File | Goes to (in the hol-guard repository) |
|---|---|
| `mcp.tethertrace.json` | `contributions/mcp-servers/mcp.tethertrace.json` |
| `command.mcp-tethertrace.v1.json` | `contracts/extensions/trust/command.mcp-tethertrace.v1.json` |

No packaging edit is needed: `pyproject.toml` already force-includes the whole `contributions/mcp-servers` folder.

## What the entry declares

- **Trust class `external`, activation `opt-in`.** The entry does nothing until a local admin turns it on in Guard.
- **Launch identity `direct-command`, command `tethertrace`.** tethertrace is not published to npm, so it cannot use a `package-launcher` identity. Guard matches a stdio server whose executable is named `tethertrace` (it strips `.exe`, `.cmd` and `.bat`). A server started another way, for example `node dist/cli.js mcp`, does not match and keeps Guard's normal handling.
- **No `allow` defaults.** Guard does not permit them for a direct-command entry, because a command name does not prove which program is running. Every state here is `inherit`, `review` or `block`, so the entry can only make Guard stricter.

### Tool defaults

They follow tethertrace's own permission classes in `src/policy.ts`:

| tethertrace class | Tools | Guard state | Why |
|---|---|---|---|
| `read` | `discover_devices`, `select_device`, `device_info`, `list_apps`, `apk_info`, `screenshot`, `record_screen`, `ui_tree`, `wait_for`, `app_logs`, `explain_report`, `inspect_project`, `toolchain_status`, `app_memory` | `inherit` | They look and change nothing. The user's existing Guard policy decides |
| `interact` | `tap`, `type_text`, `press_key`, `scroll`, `swipe`, `launch_app`, `stop_app`, `run_flow`, `smoke_test`, `explore_app`, `verify_app` | `review` | They act on a real phone |
| `install` | `install_apk` | `review` | Installs third-party code on the phone |
| `execute` | `build_project` | `review` | Runs the project's build on the computer |
| `execute` | `shell` | `block` | Arbitrary commands on the phone. It cannot be limited to one app |
| `sensitive` | `pair_device` | `review` | Changes which computers may control the phone |
| anything else | `other` | `review` | A tool added later is reviewed until this entry lists it |

`shell` and `build_project` are not even listed by tethertrace unless the server is started with `--allow-shell` or `--allow-build`. A Guard user who really wants the shell can still grant it on their own device; a this-device grant overrides a contributed default.

`tests/hol-guard.test.mjs` in this repository fails if a tool is added to tethertrace without a line here, if a read tool is not `inherit`, or if anything is set to `allow`.

## What was checked

- `mcp.tethertrace.json` validates against HOL Guard's `contracts/mcp-servers/contribution.v1.schema.json` (checked on 2026-11-11 against the `main` branch).
- The rules in Guard's Python validator that can be read from its source are met: external, opt-in, allowlisted icon, no duplicate tool names, no `allow` on a direct command.
- The trust binding has the same shape as the existing ones.

Not checked here, because they need a checkout of hol-guard with its native runtime:

- `python scripts/refresh_extension_artifacts.py --trust-only` and `--check-trust`. Run the first one in the hol-guard checkout and use the binding it writes; the file in this folder is hand-written to the same shape.
- `tests/test_guard_mcp_server_contribution.py` and the trust checks.
- Guard's native check that `tethertrace` is not a reserved command name. The name is not a shell, an interpreter or a package launcher, and no other entry uses it.

## Submitting it

Nothing has been submitted. To propose it upstream:

1. Fork `hashgraph-online/hol-guard` and copy the two files to the paths above.
2. Run `python scripts/refresh_extension_artifacts.py --trust-only`, then `--check-trust`.
3. Run `pytest tests/test_guard_mcp_server_contribution.py`.
4. Open a pull request with the JSON, the trust binding and a link to this page. Follow their guide: `docs/guard/mcp-server-contributions.md`.

## Using tethertrace with HOL Guard today

Without the catalog entry Guard treats tethertrace like any unknown MCP server, which is safe. For the strictest setup combine both:

```bash
tethertrace mcp --package com.example.app --confirm install
```

Guard reviews the calls it sees, and tethertrace still refuses on its own anything outside the app, whatever the client or Guard allowed.
