# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org).

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
