# Building apps

`tethertrace build` builds the app in the current folder with the project's own build system. It finds the JDK and Android SDK the project needs, and can fetch the missing parts for you. You do not need Android Studio, and you do not need to set `JAVA_HOME` or `ANDROID_HOME`.

It does not replace Gradle, the Android Gradle Plugin, Flutter or any compiler. It runs them.

```bash
tethertrace doctor          # what is in this folder, what a build would use, what is missing
tethertrace build           # debug APK
tethertrace build --test    # build, install on the phone, explore for crashes
```

## What it can build

| Project | How it is detected | Built with | On this computer |
|---|---|---|---|
| Native Android (Java or Kotlin) | `settings.gradle(.kts)` with an app module | the project's Gradle wrapper | yes |
| Flutter | `pubspec.yaml` that depends on the Flutter SDK | `flutter build apk` | yes, when Flutter is installed |
| React Native | `package.json` with `react-native` and an `android/` folder | Gradle in `android/` | yes, after you install `node_modules` |
| Expo (managed) | `expo` in `package.json`, no `android/` | | no: run `npx expo prebuild` first |
| SwiftPM iOS app | `Package.swift` and `xtool.yml` | xtool | not yet |
| Xcode project | `.xcodeproj` / `.xcworkspace` | Xcode | no: needs a Mac |
| Prebuilt `.apk` | file in the folder | | install with `tethertrace install` |

Monorepos work: detection looks three folders deep and skips `node_modules`, `build` and similar. When a folder holds several projects, or a project has several app modules or flavors, `build` stops and lists them. It never picks one silently.

```bash
tethertrace build apps/shop --module :app --variant paidDebug
```

## What a build needs, and where it comes from

An Android build needs three things. tethertrace looks for each one on your computer first.

| Need | Looked for in | If missing |
|---|---|---|
| A JDK that fits the project (17+ for Android Gradle Plugin 8, and no newer than its Gradle version supports) | `JAVA_HOME`, `~/.jdks`, `~/.gradle/jdks`, SDKMAN, the system JVM folders, Android Studio's bundled JDK, `PATH` | Eclipse Temurin from adoptium.net, about 190 MB |
| An Android SDK | the project's `local.properties`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default SDK folders | Google's command-line tools from dl.google.com, about 150 MB |
| The platform the project compiles against, and accepted SDK licenses | that SDK | installed with `sdkmanager` (one platform, about 80 MB) |

Build-tools are left to the Android Gradle Plugin, which downloads the exact version it wants once the licenses are accepted. Gradle itself comes from the project's wrapper, and libraries from the project's own repositories, as in any Gradle build.

A first build on an empty computer therefore downloads roughly 0.5 GB of tools plus the project's dependencies. That is the smallest set that can compile an Android app. tethertrace does not download Android Studio, emulator images, `adb` or SDK platforms your project does not use.

### Nothing is downloaded without you

- `tethertrace build` asks before each download and before accepting the Android SDK licenses, and says how big it is.
- `tethertrace build --yes` approves them all, for scripts and CI.
- Without a terminal and without `--yes`, the answer is no, and the build stops with what is missing.
- Downloads are checksum-verified (SHA-256 for the JDK, SHA-1 from Google's index for the SDK tools) and deleted if they do not match.
- Everything goes into `~/.tethertrace/toolchains` (`TETHERTRACE_HOME` moves it). Nothing global is changed, and your project files are not modified.

```bash
tethertrace toolchain list     # what was downloaded, and its size
tethertrace toolchain clean    # delete it
```

`--offline` builds from the caches only. `--timeout <minutes>` stops a build that hangs (default 30). Ctrl+C stops it cleanly.

## The result

`--json` prints a machine-readable result:

```json
{
  "kind": "build",
  "ok": true,
  "project": { "kind": "android-native", "root": "/work/hello", "name": "hello" },
  "module": ":app",
  "variant": "debug",
  "toolchain": { "jdk": "/home/me/.jdks/openjdk-21", "jdkVersion": 21, "sdk": "/home/me/Android/Sdk" },
  "artifacts": [
    { "path": "/work/hello/app/build/outputs/apk/debug/app-debug.apk", "packageName": "com.example.hello", "versionName": "1.0", "sizeBytes": 5210031, "signature": { "v1": false, "v2plus": true } }
  ],
  "logFile": "/work/hello/build/tethertrace/build.log"
}
```

Only APKs written by this build are listed, and each one is read back to confirm its package name and that it is signed. An unsigned APK cannot be installed, so a build that produces only unsigned APKs is reported as failed.

When a build fails, `error.category` says why, with the lines that matter in `error.excerpt` and what to do in `error.hints`:

| Category | Meaning |
|---|---|
| `no_project` / `ambiguous_project` | Nothing to build here, or more than one candidate |
| `unsupported` | The project cannot be built on this computer (for example an Xcode project) |
| `toolchain_missing` | A JDK, SDK or Flutter is missing |
| `consent_declined` | A needed download was not approved |
| `license_not_accepted` | The Android SDK licenses are not accepted |
| `jdk_incompatible` | The JDK does not fit the project's Gradle or plugin version |
| `dependency_download_failed` | A library could not be fetched (network, proxy, `--offline`) |
| `compile_error` | The app's own code does not compile |
| `out_of_memory` | The build or its Gradle daemon ran out of RAM |
| `out_of_disk`, `timeout`, `cancelled` | As named |
| `no_artifact` | The build finished without an installable APK |
| `build_failed` | Anything else; see the build log |

Exit code is `0` on success and `2` on failure.

## From an AI agent

The MCP server has three tools for this:

| Tool | Class | What it does |
|---|---|---|
| `inspect_project` | read | What projects are in a folder and how each is built |
| `toolchain_status` | read | Which JDK and SDK a build would use, and what is missing |
| `build_project` | execute | Runs the build. Only with `tethertrace mcp --allow-build` |

A build runs the project's build scripts on your computer, so `build_project` is off unless you start the server with `--allow-build`. An agent cannot approve downloads or licenses: that needs `--allow-downloads` from you as well. `--allow-build` does not enable the `shell` tool, and `--allow-shell` does not enable builds.

## Limits

- Flutter itself is not downloaded. If it is missing, `build` tells you where to get it.
- React Native dependencies are not installed for you, because that runs package scripts and changes the project.
- Gradle files are read with pattern matching, not by running Gradle. Unusual build scripts (variants created in loops, settings computed at runtime) may show fewer variants than exist; `--variant` still accepts any name Gradle knows.
- iOS builds are not implemented.

## Ignoring the tools already installed

`TETHERTRACE_MANAGED_ONLY=1` makes tethertrace ignore every JDK and Android SDK on the computer and use only what it downloaded itself. Use it for reproducible builds. CI uses it to build `examples/android-hello` from nothing on Windows, Linux and macOS, so the download path is tested on every change.
