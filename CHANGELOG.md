# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- Agent skill `skills/tethertrace/SKILL.md` for Claude Code, Codex and other agents that read SKILL.md: when to use tethertrace, which command fits, how to write flows from real labels, how to read verdicts and coverage, and safety rules. Included in the npm package.
- MCP prompt `write_test`: asks the connected model to inspect the app (and its source), write a YAML flow for a goal, run it and fix it until it passes.
- README screenshots from real runs, and a section on letting an AI write flows for your app.
- Screen recording: `tethertrace record`, `--record` on `run`, `test` and `smoke`, `record_screen` and `record: true` in MCP. Uses Android's `screenrecord` when it works and falls back to continuous screenshots with a built-in player (plus an MP4 when ffmpeg is installed).
- Explorer coverage: `coverage.level` (`ok`, `limited`, `none`) next to the verdict in the report, CLI, `summary.json` and MCP, with plain warnings when nothing could be tapped (canvas UIs, games, secure screens), when screens exposed no elements, when unlabeled controls were skipped, or when the action/time limit was hit.

### Changed

- The explorer never taps switches, checkboxes or radio buttons, so it can't change an app's settings (found on a real phone).
- The explorer also skips the area around a switch (a row or frame that holds one) and controls whose id names a switch or toggle. On a real phone it tapped the frame around a clock app's alarm switch, which opened "Turn off alarm".
- The explorer skips controls that change the window mode (floating window, picture-in-picture, split screen). On a real phone it had left Calculator floating over another app.
- The explorer skips controls as big as the screen, such as the "Dismiss" backdrop behind a dialog. On a real phone it tapped one eight times, each tap landing on a day in a date picker.
- Launching an app after a force-stop starts it in a clean task. Before, a photo picker the app had opened survived in its task, so the launch showed the picker again and the app never started, which turned into a false `app_exited`. Exploring also returns to the app when its last tap opened something else.
- When something other than the app is on screen, the explorer waits for transients (an app recreating itself after a language change) and otherwise closes system UI and brings the app back. It no longer presses back there, which on a real phone opened the launcher and notification shade and put personal notifications into a recording.
- Screenshots retry when the phone returns an empty image, which happened during screen transitions.
- Downscaled screenshots (MCP `screenshot`) are about 5× faster: the PNG is shrunk on the computer instead of pulling the raw framebuffer over Wi-Fi.
- `@types/node` pinned to Node 22, the oldest supported version.

## 0.1.0 — 2026-11-07

First public version.

### Added

- Pure-TypeScript ADB client: mDNS discovery, Wireless debugging pairing (TLS 1.3 + SPAKE2 + AES-128-GCM), STLS/TLS connection, classic RSA auth, streams, shell v2. No adb binary or Android SDK.
- Device actions: info, app list, install (streamed), launch with timing, stop, screenshot (full or downscaled), UI element list, logs scoped to one app, tap/type/keys/scroll/swipe by text, id, description or coordinates.
- APK reader: package name, version and SDK levels from any APK.
- `smoke`: install → cold start → watch → evidence and an honest verdict.
- YAML flow runner with failure categories, "what was on screen instead", screenshots, filtered logs and an HTML report. Typed text is never written to reports.
- `explain`: deterministic report summary, optionally with Claude, OpenAI, Ollama, LM Studio or any OpenAI-compatible model.
- `test <apk>`: zero-config explorer that walks the app's screens, skips risky controls, catches crashes and writes `repro.yaml` and `explored-flow.yaml`.
- MCP server with 22 tools and `--read-only`, `--package` and `--allow-shell` switches.

### Verified

- Physical realme RMX3563, Android 14, Windows 11 host: pairing, reconnect, install, smoke and flows on a Flutter app, Settings (typing), Calculator and Clock; MCP server over stdio.
- Wire compatibility with Google's `adb` 1.0.41 (pair, connect, shell) via the test harness.
