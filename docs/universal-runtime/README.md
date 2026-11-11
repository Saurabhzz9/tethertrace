# Universal runtime (experimental)

This is a research track inside tethertrace. It asks two questions:

1. Can an existing Android APK run on an iPhone without its source code?
2. Can one package run the same application on Android, iOS and the desktop?

The short answers, with the evidence behind them in the two reports in this folder:

| Question | Answer |
|---|---|
| Run an APK on iOS as it is | No. Nothing on iOS can load it, and nothing here pretends to. [apk-on-ios.md](apk-on-ios.md) |
| Convert an APK into an iOS app | No. There is no converter, and the reports explain why one would still leave the Android framework missing. |
| One package for web-technology apps on several platforms | Yes for Android and the desktop, both built and run here (Android on a real phone). iOS is designed, not built. [architectures.md](architectures.md) |

Nothing in this folder has been tested on an iOS device. The project has no iPhone, no Mac and no Apple signing certificate.

## What exists today

| Piece | Status |
|---|---|
| `tethertrace analyze app.apk` | Implemented, tested on real APKs |
| `tethertrace compatibility app.apk --target ios` | Implemented. A static report that always says "does not run unmodified" |
| `.tapp` format 1: `pack`, `tapp verify`, `tapp keygen` | Implemented, tested |
| Desktop runtime: `run app.tapp --platform desktop` | Implemented, tested automatically and in a real browser |
| Android runtime: `run app.tapp --platform android` | Implemented, run on a real phone (see "Verified on a phone" below) |
| `convert app.tapp --to apk` | Implemented. The standalone APK was installed and explored on a real phone, and CI builds one on Windows, Linux and macOS |
| `convert app.apk --to tapp` | Implemented for Cordova and Capacitor APKs: packs their web layer only |
| iOS runtime, `--platform ios`, `--to ios` | Not implemented. The commands explain why and exit with code 2 |

## Part 1: an APK on iOS

Read [apk-on-ios.md](apk-on-ios.md) for the full analysis and sources. The parts of an APK, and what happens to each:

| Part of the APK | Portable to iOS | Why |
|---|---|---|
| Web assets (HTML, CSS, JS, images) | yes | They run in any web engine. Calls into the Android side of a hybrid app are not carried over |
| WebAssembly modules | yes | They run in the web engine |
| Images, fonts, media, data | yes | Plain data |
| DEX bytecode (Java, Kotlin) | only with a runtime that does not exist | DEX can be interpreted, so it is not tied to a CPU. It still needs an Android runtime and the whole Android framework under it |
| Android resources and layouts | only with that runtime | Meaningful only to Android's resource system and view classes |
| Native libraries (`lib/*/*.so`) | no | ELF code linked against Android's C library, using Linux system calls. iOS loads only signed Mach-O code. Sharing a CPU type is not enough |
| Manifest components (activities, services, receivers, providers) | no | Android's system server starts and connects them. iOS has no such service |
| Google Play Services, Firebase, Play Billing, Play Integrity | no | Proprietary Google software outside the APK |
| DRM and hardware-backed keys | no | Bound to the Android device and the app's signature |

So the five problems the question hides have five different answers:

| Problem | Answer |
|---|---|
| Run the original APK unmodified | Not possible |
| Translate it to another executable format | DEX to native code has precedent, but the framework is still missing. Translating native libraries is a hypothesis with no tooling |
| A compatibility runtime (the Wine idea) | Possible in principle for a narrow class of apps: an interpreter for DEX plus a reimplementation of the Android framework. A multi-year effort, and Apple's review outcome is unknown |
| Emulate Android inside iOS | An interpreter-only full-system emulator is the one route on a stock iPhone. Very slow, no GPU acceleration, no Google services |
| Rebuild from source | The normal, supported path |

What tethertrace does with this is the honest, useful part: `analyze` and `compatibility` read an APK and say which route applies to it.

```text
$ tethertrace compatibility app.apk --target ios
Built with: flutter (libflutter.so)
Code: 3 DEX file(s), 14068 classes, 111759 methods (15.2 MB)
Native code: arm64-v8a (7), 67.0 MB
Depends on: Google Play Services, Firebase, Google Play Billing, …

Target: iOS
Runs unmodified: no
Route: rebuild from source
Flutter builds for iOS from the same Dart source. The APK holds Dart compiled ahead of time
for Android (libapp.so), which cannot be converted. With the source code this is a rebuild,
not a conversion. Without the source there is no route.
```

Routes it can report:

| Route | When | Meaning |
|---|---|---|
| `rebuild_from_source` | Flutter, React Native, Unity, Unreal, Godot, .NET MAUI, Compose | The framework targets iOS from the same source. The APK alone is not enough |
| `repackage_web_layer` | Cordova, Capacitor | The screens are a web app inside the APK. `convert app.apk --to tapp` packs that layer. It is not the Android app: native plugin calls have nothing to answer them |
| `none` | native Android apps, unknown | No route from the APK |

## Part 2: one package, several platforms

[architectures.md](architectures.md) compares six architectures. The one chosen:

- **The package holds standard web content**: HTML, CSS, JavaScript, WebAssembly, data. No custom virtual machine and no native code.
- **It can be delivered two ways from the same file**: loaded by a runtime app that is already installed (host mode), or wrapped into a standalone app for one platform (export mode).

Why web content: on iOS the system web view is the only place where code that did not ship inside the signed app gets a just-in-time compiler, and "HTML5 and JavaScript" is the only kind of downloaded software Apple's review rules name for mini apps. A package built on anything else would be interpreted and slow on iOS, or not allowed.

Why both delivery modes: a general host that runs any package is the right tool for development and testing, and is allowed on Android. On iOS a host from a small publisher may not pass review, so a standalone signed app per package is the realistic route there.

```text
                         your web app (any framework, or none)
                                      │  build with your own tools
                                      ▼
                    tethertrace pack  ──►  app.tapp
                                           ├─ tapp.json   id, version, entry, permissions,
                                           │              network list, SHA-256 of every file
                                           ├─ tapp.sig    optional Ed25519 signature of tapp.json
                                           └─ index.html, app.js, *.wasm, images …
                                      │
              ┌───────────────────────┼─────────────────────────┐
              ▼                       ▼                         ▼
     desktop runtime           Android runtime             iOS runtime
     (local preview)           (host app, WebView)         (not built)
     verify package            verify package again        same design:
     serve from 127.0.0.1      own origin per package      WKWebView host,
     same content policy       serve from the archive      signed by Apple
                               refuse other origins        certificate
              │                       │                         │
              └───────────┬───────────┴─────────────────────────┘
                          ▼
              window.tapp  (runtime API 1, the same on every platform)
              info · has · storage · vibrate      each call checked against
                                                  the manifest's permissions

     host mode:    tethertrace run app.tapp --platform android | desktop
     export mode:  tethertrace convert app.tapp --to apk   (same runtime, package inside)
```

### The `.tapp` format, version 1

A `.tapp` file is a ZIP archive.

| Entry | Required | Content |
|---|---|---|
| `tapp.json` | yes | The manifest |
| `tapp.sig` | no | `{ "algorithm": "ed25519", "publicKey": <SPKI, base64>, "signature": <base64> }`, a signature over the exact bytes of `tapp.json` |
| everything else | yes | The application's files, each one listed in the manifest |

`tapp.json`:

```json
{
  "tapp": 1,
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.2.3",
  "entry": "index.html",
  "runtime": { "kind": "web", "api": 1 },
  "permissions": ["storage"],
  "network": [],
  "targets": {},
  "files": {
    "index.html": { "size": 512, "sha256": "…" },
    "app.js": { "size": 2048, "sha256": "…" }
  }
}
```

| Field | Rule |
|---|---|
| `tapp` | Format version. A runtime refuses a version it does not know |
| `id` | Reverse-DNS name. It decides the package's origin and its storage, so two packages never share either |
| `version` | `major.minor.patch` |
| `entry` | An HTML file listed in `files` |
| `runtime` | `kind` is `web`. `api` is the lowest runtime API the app needs |
| `permissions` | Any of `network`, `storage`, `vibrate`, `clipboard`, `geolocation`, `camera`, `microphone`, `notifications`. Format 1 runtimes implement `network`, `storage` and `vibrate` |
| `network` | https origins the app may contact. Used only with the `network` permission. Empty means nothing outside the package is reachable |
| `targets` | Reserved for per-platform artifacts in a later format. Must be empty |
| `files` | Every file with its size and SHA-256. Paths use forward slashes and may not contain `..`, a leading slash, a backslash or a colon |

What a runtime must do before showing anything:

1. Refuse an unknown format, an invalid manifest or an unsafe path.
2. Check that every listed file is present with the stated SHA-256, and that nothing unlisted is inside.
3. If `tapp.sig` is present, check it against `tapp.json`.
4. Give the package its own origin and serve only the listed files there.
5. Send a Content-Security-Policy that allows the package's own files, and network connections only to the origins in `network`.
6. Check each runtime API call against `permissions` on the native side, not only in JavaScript.

Because the signature covers the manifest and the manifest covers every file, one signature protects the whole package. `pack` writes files in a fixed order with a fixed timestamp, so the same input always produces the same bytes.

### Runtime API 1

Every runtime puts `window.tapp` in front of the page. All calls return a Promise.

| Call | Permission | Android | Desktop |
|---|---|---|---|
| `tapp.info()` | none | yes | yes |
| `tapp.has(permission)` | none | yes | yes |
| `tapp.storage.get/set/remove` | `storage` | per-package preferences | browser storage |
| `tapp.vibrate(ms)` | `vibrate` | yes | only if the browser can |

A call for something the manifest did not ask for is rejected with code `permission_denied`. Something a platform cannot do is rejected with `unavailable`. The JavaScript side is one shared file, [`runtime/shared/bridge.js`](../../runtime/shared/bridge.js); each platform adds only a small native object behind it.

### The platform adapters

| Adapter | Where | How a package gets there |
|---|---|---|
| desktop | `startDesktopRuntime` in `src/runtime.ts` | Read from the verified archive and served on 127.0.0.1 |
| android | [`runtime/android`](../../runtime/android) (Java, one activity) and `runOnAndroid` | Installed once with tethertrace's own ADB. The package is written into the runtime's private folder with `run-as`, then the runtime is started with the package's name. It verifies the package again on the phone |
| ios | not built | Would be a WKWebView host with the same checks |

### What is reused from tethertrace

| Existing capability | Used for |
|---|---|
| ADB over Wi-Fi in TypeScript | Installing the runtime, sending a package, starting it |
| `build` and the managed JDK and SDK | Building the runtime and `convert --to apk`. No new toolchain |
| APK and ZIP parsing | `analyze`, `compatibility`, reading packages |
| `test`, `smoke`, `run`, `verify` | A running package is an ordinary app to them, so it can be explored and tested like one |

## Trying it

```bash
tethertrace pack examples/tapp-hello -o hello.tapp
tethertrace tapp verify hello.tapp
tethertrace run hello.tapp --platform desktop
tethertrace run hello.tapp --platform android
tethertrace convert hello.tapp --to apk

tethertrace analyze app.apk
tethertrace compatibility app.apk --target ios
```

`pack` takes what is already built. It looks for `index.html` in the project folder, then in `dist`, `build`, `out`, `www` and `public`. It does not run your build or any package script. Settings go in an optional `tapp.config.json`.

## What a package cannot do

- Run server code. An app with a Node.js backend has to reach that backend over the network. A Next.js app has to be a static export; pages that need a server cannot be packed.
- Use a device feature the runtime did not build in. Format 1 has storage and vibration. Camera, location and the rest are named in the format and not implemented.
- Reach the network unless the manifest lists the origin.
- Run native code. Games work as far as WebGL, WebGPU and WebAssembly in the web view take them.
- On a stock iPhone, in any future version: run just-in-time compiled code outside the web view, load native code that is not in the signed app, or install without Apple-issued signing.

## Verified on a phone

On a realme RMX3563 with Android 14, with the sample in `examples/tapp-hello`:

| Check | Result |
|---|---|
| `run hello.tapp --platform android` | The runtime was built, installed, given the package and started. First start about 1 second |
| The page inside the runtime | Reported `android`, ran WebAssembly, and its request to a site outside the package was refused |
| Storage | A counter set with `tapp.storage` was still there after the runtime was stopped and started again |
| A 12-step YAML flow (`tethertrace run`) | Passed, including a restart in the middle |
| A package with one file changed after packing, pushed straight to the phone | Refused on the phone: "app.js does not match the manifest" |
| A package path that leaves the runtime's folder | Refused |
| `convert hello.tapp --to apk`, then `tethertrace test` on it | Installed under the package's own id, explored without a crash, coverage `ok` |

Running it this way found two bugs in tethertrace itself, both fixed: a label containing a double quote was invisible (Android then writes the attribute in single quotes), and the first read of a WebView screen came back empty because a WebView builds its accessibility tree only after it is first asked.

## Not verified

- Any phone other than that one.
- A package that uses the `network` permission against a real server.
- Signature checking on the phone. The command line verifies `tapp.sig`; the Android host checks file hashes only.
- Performance. Nothing was measured, so no numbers are given.
- Anything on iOS.
- Whether Apple would approve an iOS host. That is a question for App Review, not for code.

## Roadmap

1. Verify `tapp.sig` in the Android host and remember each package's key, so an update must come from the same publisher.
2. More runtime API: clipboard, geolocation, camera, with a permission prompt in the host.
3. An iOS host project generated from the same package. This needs a contributor with a Mac, an iPhone and an Apple developer account.
4. Packages driven by `verify`, so packages get the same regression checks as APKs.

The APK-on-iOS question stays a research note. The analyzer is the part of it that is real.
