# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- MCP prompt `write_test`: asks the connected model to inspect the app (and its source), write a YAML flow for a goal, run it and fix it until it passes.
- README screenshots from real runs, and a section on letting an AI write flows for your app.
- Screen recording: `tethertrace record`, `--record` on `run`, `test` and `smoke`, `record_screen` and `record: true` in MCP. Uses Android's `screenrecord` when it works and falls back to continuous screenshots with a built-in player (plus an MP4 when ffmpeg is installed).

### Changed

- The explorer never taps switches, checkboxes or radio buttons, so it can't change an app's settings (found on a real phone).
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
