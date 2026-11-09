---
name: tethertrace
description: Test Android apps on the user's real phone over Wi-Fi with tethertrace (no adb, no Android SDK). Use when the user wants to install an APK on their phone, check an Android build for crashes, explore an app automatically, write or run a YAML UI test, see what is on the phone's screen, tap through a flow, read the app's logs, record the screen, or explain why a test failed. Works through the tethertrace CLI or its MCP tools.
---

# tethertrace

tethertrace drives a real Android phone over Wireless debugging. It speaks the ADB protocol itself, so the only requirement is Node.js 22+. It works with native Views, Jetpack Compose, Flutter and React Native, because it tests the built app.

Use the MCP tools when they are connected (`explore_app`, `run_flow`, `ui_tree`, `tap`, …). Otherwise use the CLI in a shell. Both give the same results.

## 1. Check the setup first

Run `tethertrace info`.

- **Command not found:** install with `npm install -g github:Saurabhzz9/tethertrace`.
- **`No phone found on this network`:** ask the user to turn on **Settings → Developer options → Wireless debugging**, with the phone and computer on the same Wi-Fi.
- **`TLS_REJECTED` or never paired:** ask the user to tap **Pair device with pairing code** and give you the 6-digit code, then run `tethertrace pair <code>`. Pairing is remembered.
- **`ECONNREFUSED`:** Wireless debugging turned itself off (screen lock, Wi-Fi change). Ask the user to turn it on again; no re-pairing is needed.
- **Several phones:** pass `--device host:port` or set `TETHERTRACE_DEVICE`.

Never guess or reuse a pairing code. Only the user can read it from their phone.

## 2. Pick the right command

| The user wants | Run |
|---|---|
| "Does my APK work?" with no test written | `tethertrace test app.apk` (installs, explores, catches crashes, writes flows) |
| Install, cold start and a quick crash check | `tethertrace smoke --apk app.apk` |
| A repeatable test for a specific path | Write a YAML flow (section 3), then `tethertrace run flow.yaml` |
| See what is on screen | `tethertrace ui` (elements, `[tap]` = clickable) and `tethertrace screenshot -o screen.png` |
| Interact by hand | `tethertrace tap "Sign in"`, `tap --id sign_in`, `tap --desc Close`, `type "text"`, `key back`, `scroll down` |
| The app's logs only | `tethertrace logs com.example.app` |
| A video of the run | add `--record` to `test`, `run` or `smoke`, or `tethertrace record --seconds 30` |
| A summary of a report | `tethertrace explain reports/<run>` |
| Find a package name | `tethertrace apps --filter example` or `tethertrace apk-info app.apk` |

Every test command writes a folder under `reports/` with `report.html`, `summary.json`, screenshots and the app's own logs. `run` exits 0 on pass and 2 on failure; `test` and `smoke` exit 2 for any verdict other than `no_crash_observed`.

## 3. Writing a YAML flow

1. Get the package with `apk-info` or `apps`.
2. Open each screen on the phone and run `tethertrace ui` to read the real labels and ids. Never invent labels; copy them from `ui` output. If you have the app's source, use it to know the screens, but still confirm labels on the phone.
3. Write the flow, run it, read the failure, fix, run again until it passes.

```yaml
app: com.example.app
name: login
steps:
  - launch
  - tap: { id: email }
  - type: "${TEST_EMAIL}"
  - tap: { id: password }
  - type: "${TEST_PASSWORD}"
  - tap: "Sign in"
  - waitFor: "Home"
    timeoutMs: 20000
  - assertVisible: { contains: "Welcome" }
  - screenshot: home
```

Selectors: `"Text"` (visible text or description), `{ text }`, `{ desc }` for icon buttons, `{ id }` (most stable), `{ contains }`, and `index` when several match. Steps: `launch`, `tap`, `longPress`, `type`, `key`, `back`, `home`, `waitFor`, `assertVisible`, `assertHidden`, `scroll`, `sleep`, `screenshot`. Prefer `waitFor` over `sleep`.

Secrets go in environment variables (`${TEST_PASSWORD}`); typed text is never written to reports. `type` sends ASCII only.

A run of `tethertrace test` also saves `explored-flow.yaml`, a replayable starting point you can trim into a real test.

## 4. Reading results honestly

Report what the evidence shows, nothing more.

- **`no_crash_observed`** means no crash was logged while it ran. It does **not** mean the app works. Say exactly that.
- For `test`, always read **`coverage.level`** next to the verdict:
  - `ok`: it tried every safe, labeled control it found.
  - `limited`: some screens or controls were out of reach, or it hit the limit. List the warnings.
  - `none`: it could tap nothing (canvas UI, game, secure screen). The run only covered launching. Suggest a flow that taps by position, or adding content descriptions.
- Flow failures come with a category. Act on it:
  - `element_not_found`: compare your selector with `visibleOnScreen` in `summary.json`. The label may differ, the screen may need more time (`timeoutMs`) or a scroll.
  - `ambiguous_selector`: add `index` or use `id`.
  - `assertion_failed`: the previous step probably did not navigate. Check its screenshot.
  - `app_crash`, `anr`, `app_exited`: quote the lines from `crash.txt` or `logcat.txt`. This is a bug in the app, not in the test.
  - `device_disconnected`, `timeout`: the phone dropped off. Ask the user to check Wireless debugging and re-run.
- When a run crashes, `repro.yaml` reproduces it: `tethertrace run reports/<run>/repro.yaml --record`.

## 5. Safety rules

- Only the user's own phone and apps, with their consent.
- Ask before anything that sends, posts, pays, buys, deletes, logs out or changes account settings, even inside a flow. The explorer skips these on its own; you must too.
- Never type real passwords or personal data into the phone yourself. Ask the user to put test credentials in environment variables.
- Over MCP, prefer `tethertrace mcp --package com.example.app` (only that app) and `--read-only` when you only need to look. Raw shell is off unless the user adds `--allow-shell`.
- Screenshots, recordings, `ui` output and logs can contain notifications, names and messages. Do not paste them anywhere public, and remind the user before they share a report.

## More

- Full flow reference: https://github.com/Saurabhzz9/tethertrace/blob/main/docs/flows.md
- MCP setup for every client: https://github.com/Saurabhzz9/tethertrace/blob/main/docs/mcp.md
- Troubleshooting: https://github.com/Saurabhzz9/tethertrace/blob/main/docs/troubleshooting.md
