# Live development: `tethertrace dev`

```bash
tethertrace doctor      # what is in this folder, what a build needs
tethertrace dev         # build + install once, then update the phone on every save
```

`dev` finds the app project in the folder (or `--project <dir>`), connects to the phone over
Wi-Fi with tethertrace's own ADB implementation, deploys once, and then watches the source.
Each batch of saves is applied with the fastest mechanism that really works for that change,
and the running app is checked afterwards. The terminal always says which mechanism was used.

## How a change reaches the phone

| Project | Change | Mechanism | What tethertrace can confirm |
|---|---|---|---|
| Flutter, `flutter` on PATH **and** `flutter devices` lists the phone | `.dart` edit | hot reload through `flutter run --machine` | Flutter answered code 0 |
| | file added/removed, or Flutter rejects the reload | hot restart | Flutter answered code 0 |
| | `pubspec.yaml`, `android/…`, Gradle files | `flutter run` again (rebuild + install) | the app started |
| Flutter, Flutter cannot see the phone | any | rebuild with `flutter build apk`, reinstall, restart | install + restart succeeded |
| React Native, Metro answering on `127.0.0.1:8081` | JS/TS/asset | Metro Fast Refresh | **not confirmed**: Metro pushes the change, tethertrace cannot see whether the app accepted it, so the update is reported as *sent, not confirmed* and the verdict is at best *inconclusive* |
| | `android/…`, `package.json`, Gradle | rebuild + reinstall | install + restart succeeded |
| React Native without Metro | any | rebuild + reinstall (a debug build still needs Metro for its JS) | install + restart succeeded |
| Native Android (Kotlin, Java, Compose) | any | incremental Gradle build of the debug variant, reinstall, restart | install + restart succeeded |

Why Flutter needs `flutter devices` to list the phone: hot reload is done by Flutter's own tool,
which talks to the phone through its own `adb`. tethertrace does not require `adb`; if you have
platform-tools, `adb connect <phone-ip>:<port>` makes the phone visible to Flutter. Without it,
`dev` still works, by rebuilding.

Compose Live Edit is an Android Studio feature and is not available outside it; native Android
always rebuilds. Gradle's own incremental build and build cache keep that fast after the first build.

React Native: the phone must reach Metro. Without `adb reverse`, set the dev menu's *Change bundle
location* to `<your computer's LAN IP>:8081`.

## After every update

`--verify` chooses how much is checked on the phone. The default is cheap and safe.

| `--verify` | What runs |
|---|---|
| `off` | nothing; verdict `not_run` |
| `smoke` (default) | app process alive, no crash or ANR in the logs since the update; screenshot and app log saved on failure |
| `changed` | smoke, then the flows in `./flows` that cover the changed source (see [verify.md](verify.md)) |
| `full` | smoke, then every flow |

Verdicts per update: `passed` (applied, confirmed, checked, nothing failed), `failed` (build
error, crash, ANR, failing flow), `blocked` (phone unreachable), `inconclusive` (process gone
without a crash report, or a Metro update tethertrace could not confirm), `not_run` (nothing was
checked). A passed smoke check means "no crash observed", not "the screens work".

Evidence for each update is in `<project>/build/tethertrace/dev/<time>-<n>/` (`cycle.json`,
`app.log` and `screen.png` when relevant). History is in `~/.tethertrace/dev/<project-hash>/history.jsonl`.

## Watching

- One recursive file watcher (native on Windows and macOS, Node's own on Linux); no polling.
- Ignored: `.git`, `node_modules`, `build`, `.gradle`, `.dart_tool`, `.expo`, `Pods`, `reports`,
  editor temp/swap files, APKs and the patterns in the project's `.gitignore` (negations are not supported).
- Saves are debounced (`--debounce`, default 300 ms) and grouped into one update. A save that does
  not change the file's bytes is dropped, so a build never triggers itself.
- One update at a time. Changes that arrive during an update are merged into the next one.
- Changes are sorted into source, dependency, config and native, which decides reload vs rebuild.

## Sessions

```bash
tethertrace dev status          # from any terminal: state, mode, last update
tethertrace dev status --json
tethertrace dev stop            # asks the running session to stop, and waits
```

One session per project. Ctrl+C (or `dev stop`) stops the watcher, cancels a running build,
stops `flutter run` and its child processes (process tree on Windows), and closes the phone
connection. A session that was killed is detected by `status` as *interrupted* and replaced by
the next `dev`.

`--json` prints one JSON line per event (`started`, `update`, `stopped`); progress goes to stderr.

## From an AI agent (MCP)

Start the server with `--allow-build` (dev runs the project's build and installs the app):

```bash
tethertrace mcp --allow-build --package com.example.app
```

| Tool | Class | Use |
|---|---|---|
| `dev_start` | execute + install | start a session for a folder; returns after the first deploy |
| `dev_wait` | read | after editing a file, wait for the update and get its result as JSON (mechanism, build error, crash lines, flows, evidence, verdict, next action) |
| `dev_status` | read | state and recent updates; also reads a session another process runs |
| `dev_stop` | execute | stop it |

The agent edits files with its own tools; tethertrace never modifies source. There is no repair loop
inside tethertrace: each `dev_wait` reports one update.

## Not done in this version

- No dashboard (`tethertrace dashboard`) yet.
- No visual regression comparison.
- No `adb reverse` for Metro (needs the phone to open connections back over ADB).
- Real-device runs of `dev` with Flutter hot reload and Metro have not been done by the maintainers yet;
  the Flutter protocol is tested against a scripted stand-in for `flutter run --machine`.
