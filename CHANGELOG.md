# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org).

## Unreleased

### Added (experimental)

- `tethertrace analyze app.apk` and `tethertrace compatibility app.apk --target ios`: read an APK without running it (framework, DEX code, native libraries, web layer, Google dependencies) and report which parts could be carried to iOS, which cannot, and why. The report always says the APK does not run unmodified.
- `.tapp`, a portable package for web-technology apps: `tethertrace pack` writes a ZIP with a manifest that lists every file's SHA-256, optionally signed with Ed25519 (`tapp keygen`, `pack --key`). `tapp verify` checks it.
- Runtimes for `.tapp`: `run app.tapp --platform desktop` (a local preview with the same content policy as the phone) and `--platform android` (a small host app with a WebView, in `runtime/android`). Each package gets its own origin, is served only its own files, reaches the network only where its manifest says, and uses device features through one API, `window.tapp`, checked against its permissions.
- `convert app.tapp --to apk` builds a standalone Android app with the package inside. `convert app.apk --to tapp` packs the web layer of a Cordova or Capacitor APK.
- Asking for what cannot work (`run app.apk --platform ios`, `convert … --to ios`) prints the reason and exits with code 2.
- Research reports with sources in `docs/universal-runtime`. Not verified: the Android runtime on a real phone, and anything on iOS.

## 0.1.1 - 2026-11-11

### Fixed

- An install on a link that stopped moving hung forever: there was no timeout while the APK was being sent. A write now fails after 30 seconds without progress, and the error says how much was sent (`Install stalled after 37.0 of 150.0 MB`).
- The APK was read into memory whole before it was sent. It is now read and sent one chunk at a time, and each chunk waits for both the socket and the phone's acknowledgement. Installing an 82 MB APK on a real phone peaked at 112 MB of memory instead of 352 MB.

### Added

- `tethertrace install` shows progress for APKs over 20 MB. `Device.install` takes `onProgress` and `stallTimeoutMs`.

## 0.1.0 - 2026-11-11

### Added

- Test memory and `tethertrace verify`: tethertrace now remembers, per app, the builds it has seen, the screens the explorer reached and how each flow went (`~/.tethertrace/memory`, plain JSON you can edit). `verify --changed` re-runs only the flows that could be affected by a new build, `--full` runs everything, `--discover` records the screens. A flow can declare `covers:` source paths so a new build only re-runs it when that source changed. Flows that are not run are reported as not run, and a flow that passed on the previous build and fails now is reported as a regression. `tethertrace memory` shows or forgets what is stored. MCP tools `verify_app` and `app_memory`. See `docs/verify.md`.
- `integrations/hol-guard`: an optional, opt-in catalog entry for HOL Guard (external trust, matched by the `tethertrace` command, no `allow` defaults), with a test that keeps it in step with the tool list. Not submitted upstream.
- `tethertrace build`: builds the app in a folder with its own build system (Gradle wrapper, Flutter, React Native's Gradle project) and returns the APKs with package name and signature state, or a categorized failure. `--install` and `--test` continue onto the phone.
- Managed Android toolchain: finds a JDK and Android SDK that fit the project (from `local.properties`, the environment and the usual install folders), and with your approval downloads a Temurin JDK and Google's SDK command-line tools, accepts the SDK licenses and installs the one platform the project compiles against. Checksums are verified; everything lives in `~/.tethertrace/toolchains`. `tethertrace toolchain list|clean` manages it.
- `tethertrace doctor` and `tethertrace devices`: what is in a folder, what a build would use, what is missing, and which phones are reachable.
- Project detection for native Android (Groovy and Kotlin DSL, version catalogs, several app modules, flavors), Flutter, React Native, Expo, SwiftPM/xtool and Xcode projects, and prebuilt APK/IPA files, including in monorepos. iOS projects are detected and reported as not buildable yet.
- MCP tools `inspect_project`, `toolchain_status` (read) and `build_project` (execute, only with `--allow-build`; downloads only with `--allow-downloads`).
- Agent skill `skills/tethertrace/SKILL.md` for Claude Code, Codex and other agents that read SKILL.md: when to use tethertrace, which command fits, how to write flows from real labels, how to read verdicts and coverage, and safety rules. Included in the npm package.
- MCP prompt `write_test`: asks the connected model to inspect the app (and its source), write a YAML flow for a goal, run it and fix it until it passes.
- README screenshots from real runs, and a section on letting an AI write flows for your app.
- Screen recording: `tethertrace record`, `--record` on `run`, `test` and `smoke`, `record_screen` and `record: true` in MCP. Uses Android's `screenrecord` when it works and falls back to continuous screenshots with a built-in player (plus an MP4 when ffmpeg is installed).
- Explorer coverage: `coverage.level` (`ok`, `limited`, `none`) next to the verdict in the report, CLI, `summary.json` and MCP, with plain warnings when nothing could be tapped (canvas UIs, games, secure screens), when screens exposed no elements, when unlabeled controls were skipped, or when the action/time limit was hit.

### Security

- One authorization policy (`src/policy.ts`) now sits in front of every MCP tool. Each tool has a permission class (`read`, `interact`, `install`, `execute`, `sensitive`), and a call is checked on the server before it reaches the phone. MCP annotations are hints only.
- Fixed: `--read-only --allow-shell` exposed the raw shell. Read-only now wins.
- Fixed: `--package` only checked tool arguments. `tap`, `type_text`, `press_key`, `scroll`, `swipe`, `screenshot`, `ui_tree` and `wait_for` worked on whatever app was in front, and a YAML flow could leave its app and keep going. The server now checks which app has focus before every such call and every acting flow step. It refuses raw coordinates and elements that belong to another app, refuses the `home`, `recents` and `menu` keys, and refuses when it cannot tell.
- Fixed: `smoke_test` and `explore_app` installed `apkPath` unchecked when `package` was also given, so an APK of another app could be installed under an allowed name.
- Fixed: a server started with `--device` could be moved to another phone with `select_device`.
- `shell` and `record_screen` are unavailable in a package-scoped session, and `list_apps` shows only the scoped apps.
- New: `--confirm <classes>` for server-enforced approval (MCP elicitation, or `tethertrace approve <id>` from a terminal), `--preauthorize <classes>` for unattended runs, and a local audit log at `~/.tethertrace/audit.jsonl` (`--no-audit` turns it off).

### Changed

- The package can be published to npm: `npm install -g tethertrace` or `npx tethertrace`. `npm publish` runs the tests first.
- The managed Android SDK no longer uses Google's `sdkmanager`, which is deprecated. tethertrace reads Google's SDK index itself, downloads the one platform the project compiles against, checks its SHA-1 and writes the same `package.xml` the SDK manager would. This drops the 150 MB command-line tools download and the need for a JDK just to set up the SDK. An existing SDK that has `sdkmanager` still falls back to it if the direct install fails.
- Project detection reads `compileSdk`, `minSdk` and `targetSdk` that a project defines in its root build file or `gradle.properties` (`compileSdk rootProject.ext.compileSdkVersion`), as React Native projects do. Platforms that Google publishes with a minor version (`android-37.0`) are installed and recognised.
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
