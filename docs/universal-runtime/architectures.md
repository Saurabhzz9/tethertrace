# Universal application package (".tapp"): architecture comparison

Status: research note, November 2026. Nothing here was tested on an iOS device by this project. Claims are tied to sources [n]. Items marked "unverified" could not be confirmed from a primary source during this research.

## 1. The rules that set the boundaries

**Apple, App Review Guideline 2.5.2** [1]: "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps."

**Apple, Developer Program License Agreement 3.3.1(B)** [2]: "Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application ... (b) does not bypass signing, sandbox, or other security features of the OS; and (c) for Applications distributed on the App Store, does not create a store or storefront for other Applications."

**Apple, Guideline 4.7** [1]: "Apps may offer certain software that is not embedded in the binary, specifically HTML5 and JavaScript mini apps and mini games, streaming games, chatbots, and plug-ins. Additionally, retro game console and PC emulator apps can offer to download games." The host is responsible for all of it. 4.7.2: "Your app may not extend or expose native platform APIs or technologies to the software without prior permission from Apple." 4.7.3 requires explicit user consent "in each instance" before sharing data or privacy permissions. 4.7.4 requires an index of the software with universal links. 4.7.5 requires age gating. The April 5, 2024 update added retro console emulators and clarified that mini apps and mini games "must be HTML5" [3].

**Apple, Guideline 2.5.6** [1]: "Apps that browse the web must use the appropriate WebKit framework and WebKit JavaScript." An entitlement for other engines exists for the EU and Japan.

**Google Play, Device and Network Abuse** [4]: "an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to code that runs in a virtual machine or an interpreter where either provides indirect access to Android APIs (such as JavaScript in a webview or browser)." Interpreted code loaded at run time "must not allow potential violations of Google Play policies."

**JIT on iOS.** iOS disallows execution of dynamically generated code in third-party apps. Microsoft's .NET documentation states this as a platform restriction and uses AOT plus an interpreter because of it [35]. Apple told the iSH project in 2024 that it "does not offer JIT compilation for non-browser apps on iOS" [34]. WKWebView runs web content in a separate system process that does have JIT; in-process JavaScriptCore does not. The second half of that sentence rests on WebKit bug reports and a developer write-up quoting a WebKit engineer, not on an Apple document, so treat the exact mechanism as unverified [36].

What follows from these four rules: on a stock iPhone, a store-distributed host can load HTML5 and JavaScript packages, including WebAssembly, inside WKWebView. It cannot load native code, cannot JIT anything outside WKWebView, cannot be a general app store, and cannot hand new native APIs to packages without Apple's permission.

## 2. The six architectures

### A. One package, one installed host per platform (mini-app model)

- Feasible: yes. WeChat, Alipay, Telegram, Expo Go and Delta Chat (webxdc) all do it. webxdc runs the same `.xdc` zip on Android, iOS and desktop [5][6].
- Host needed: yes. Standalone: no.
- Apple signing and a Mac: only for the host, once, by the host's publisher. Package authors need neither.
- Stock iPhone: yes, if the host passes review under 4.7.
- Offline: yes if the package is stored locally. webxdc is offline by design [6]. Telegram Mini Apps are not packages; they load from a remote URL [13].
- Hardware: only what the host bridges. On iOS the bridge is compiled into the signed host, and 4.7.2 requires Apple's permission to expose native APIs [1].
- Security: host is liable for package content (4.7). Needs per-package origin isolation. Studies of WeChat-style ecosystems found privilege escalation and cross-mini-app cookie leaks when hosts share one WebView state [50][51].
- Performance: WebView speed. JavaScript and wasm are JIT-compiled in WKWebView's content process (mechanism unverified, see above).
- Node backend: cannot run in the package. See section 6.
- Games and wasm: yes, inside the WebView. WebGL works; WebGPU ships in Safari 26 on iOS [19]. Whether WebGPU is enabled inside third-party WKWebView hosts is unverified.
- Versus existing: same idea as Expo Go, but Expo Go is a development tool. Apple App Clips are different: they are small native, signed parts of an App Store app, not a runtime for downloaded packages (unverified against the current Apple page; from general knowledge).

### B. One IR, a generator emits APK/AAB and IPA

- Feasible: yes. This is Capacitor, Cordova and Tauri mobile.
- Host needed: no. Standalone: yes.
- Apple signing: yes, per app. Mac: normally yes; see section 5 for the partial exceptions.
- Stock iPhone: yes. Offline: yes.
- Hardware: full, through native plugins compiled into each artifact.
- Security: normal app sandbox. 2.5.2 still applies to later code downloads.
- Performance: WebView for web content; native for plugins.
- Node backend: cannot be embedded in a practical way on iOS (section 6).
- Games and wasm: yes, in the WebView.
- Versus existing: it is the existing approach. The only new thing `.tapp` could add is a stricter, declarative input format.

### C. Browser only (PWA)

- Feasible: yes, with the narrowest capability set.
- Host: the browser. Signing: none. Mac: none. Stock iPhone: yes.
- Offline: yes, with service workers. WebKit origin quota is up to 60% of disk in browser apps and 15% in other apps; data can be evicted under storage pressure or after a period without user interaction [17]. Safari deletes script-writable storage after seven days of Safari use without interaction; Home Screen web apps keep their own counter [18].
- Web Push: since iOS 16.4, only for web apps added to the Home Screen, and only after a user gesture [16].
- Since Safari 26, every site added to the Home Screen opens as a web app by default, with no manifest required [19].
- WebAssembly: supported; Safari 26 added an in-place interpreter tier for faster start [19]. WebGPU: shipping in Safari 26.0 on iOS [19].
- Hardware: Web NFC and WebUSB are unsupported in Safari and WebKit opposes Web NFC [20][21][23]. WebKit's bug tracker says Web Bluetooth is not being considered [22].
- EU episode: in February 2024 Apple disabled Home Screen web apps in iOS 17.4 betas for the EU, then reversed on March 1, 2024. They remain WebKit-based [24].
- Third-party engines: allowed by entitlement in the EU from iOS 17.4, with heavy requirements [25]. As of 2026 no vendor has shipped Blink or Gecko on iOS in the EU, according to Open Web Advocacy [26]. Design for WebKit only.
- Node backend: remote only. Games and wasm: yes.
- Versus existing: it is the baseline. No install friction for developers, weakest discoverability and hardware reach.

### D. WebAssembly + WASI with a native runtime

- Feasible: yes for logic. Not for UI: WASI defines no windowing or GUI API. The closest proposal is WebGPU access at phase 2 [39].
- Status: WASI 0.2 was released at the end of January 2024; 0.3 with native async is the current release and Wasmtime 46 runs it by default [39].
- iOS: Wasmtime lists `aarch64-apple-ios` and `aarch64-linux-android` as tier 3 targets, and its Pulley interpreter as tier 2 [37]. Pulley is roughly ten times slower than compiled code by Wasmtime's own estimate [38]. wasm3, WAMR and wasmi interpreter modes on iOS are widely reported but were not verified from primary sources here: unverified.
- Therefore on iOS there are two real choices: interpret wasm in-process (slow, legal as interpreted code under 3.3.1(B)), or run it inside WKWebView (fast, but then it is architecture A or B).
- Whether App Review treats downloaded wasm run by a native interpreter as acceptable outside 4.7's "HTML5 and JavaScript" wording is unverified. This is a real policy risk.
- Host needed: yes, or embed per app (then it is B). Signing and Mac: as A or B.
- Hardware: only via host-defined imports. Offline: yes.
- Performance reference: wasm in browsers ran 45% to 55% slower than native on SPEC CPU in one study, despite the near-native design goal [48][49].
- Versus existing: good as a compute format inside the package. Not a complete app format.

### E. A portable bytecode VM in the runtime

- Feasible: yes. Interpreters are legal on iOS under 3.3.1(B) [2]. .NET ships an interpreter on iOS for this reason and warns the slowdown ranges "from unmeasurable to unacceptable" [35]. Hermes, QuickJS, Lua and Dart interpreter modes are widely used; their iOS behaviour was not checked against primary sources here: unverified.
- The limit is policy, not technology. Downloaded code may not change the app's primary purpose or create a storefront [2]. That is what bounds OTA systems. Expo documents the same clause, and its updates carry JavaScript and assets only; the native layer is fixed in the binary and updates must match its runtime version exactly [40][41]. Microsoft retired App Center CodePush on March 31, 2025 [42].
- UI: you must build your own UI toolkit and bridge per platform. That is React Native or Flutter again.
- Host, signing, Mac, hardware, offline: as A (shared host) or B (embedded).
- Games: possible with a custom renderer; much more work than WebGL.
- Versus existing: no advantage over a WebView host unless you need native widgets.

### F. One container with several native binaries

- Feasible as a file format, but it is not one application. It is N builds in one zip.
- Cosmopolitan's "actually portable executable" targets Linux, macOS, Windows, FreeBSD, OpenBSD, NetBSD and BIOS on x86-64 class CPUs; iOS and Android are not listed [15]. It produces a command-line process image. iOS and Android do not launch arbitrary executables. They launch signed app bundles (IPA) or APKs with a manifest and a framework-managed lifecycle. iOS additionally refuses native code that is not in the signed bundle (2.5.2) [1]; Play forbids downloaded `.so` files [4].
- So F reduces to B plus a shared wrapper. It adds size and nothing else on mobile.

## 3. Comparison table

| Item | A host + package | B generator | C PWA | D wasm/WASI | E bytecode VM | F fat container |
|---|---|---|---|---|---|---|
| Feasible | Yes | Yes | Yes | Logic only | Yes, costly | Not on mobile |
| Installed host needed | Yes | No | Browser | Yes or embed | Yes or embed | n/a |
| Standalone app | No | Yes | Home Screen icon | Only if embedded | Only if embedded | Only as B |
| Apple signing | Host only | Every app | No | As A or B | As A or B | Every app |
| Mac needed | Host publisher only | Normally yes | No | As A or B | As A or B | Yes |
| Stock iPhone | Yes, under 4.7 | Yes | Yes | Interpreter or WebView | Interpreter only | No |
| Offline | Yes | Yes | Yes, evictable | Yes | Yes | Yes |
| Native hardware | Host bridge, 4.7.2 limit | Full via plugins | Web APIs only | Host imports | Host bridge | Full |
| Main security limit | Host liable; isolation | App sandbox | Browser sandbox | Capability imports | 3.3.1(B) | Signing |
| Performance | WebView JIT | WebView JIT + native | Browser JIT | ~10x slower interpreted | Interpreter | Native |
| Node backend | Remote or rewrite | Remote or rewrite | Remote | Remote or port to wasm | Remote | Could bundle on desktop only |
| Games / wasm | Yes in WebView | Yes in WebView | Yes | Compute yes, no GUI | Custom renderer | Yes |
| Closest existing | webxdc, WeChat | Capacitor, Tauri | PWA | Wasmtime, WAMR | RN + Hermes, Flutter | Universal binaries |

## 4. Prior package formats: what to copy and avoid

- **webxdc (`.xdc`)** [5][6][7][8]. A zip with `index.html`, optional `manifest.toml` (`name`, `source_code_url`) and an icon. Hosts "MUST deny all forms of Internet access" and "MUST isolate all storage and state of one webxdc app from any other." Because apps cannot send data out, no consent dialog is needed. State sync goes through one host API with a default 128,000 byte update limit. Weaknesses: no signature, no version field, no permission model, old-WebView compatibility burden, and no hardware access. Copy: zip of plain web files, deny-by-default network, per-package storage isolation, tiny manifest. Avoid: no integrity and no versioning.
- **W3C MiniApp Packaging and Manifest** [9][10]. Zip container with `manifest.json`, `app.js`, `app.css`, `pages/`. Manifest has `app_id`, `version.code` and `version.name`, `platform_version.min_code`, and `req_permissions` with `name` and `reason`. Signatures are optional and no scheme is mandated. Both documents are now W3C Discontinued Drafts dated 11 August 2026. Copy: integer version code, minimum platform version, permissions with a reason string. Avoid: a custom page and component model that only vendor runtimes implement, and optional signing.
- **W3C Widgets (`.wgt`, `config.xml`)** [11]. Zip plus XML config with `feature` and `preference` elements; signing in a separate XML-DSig spec. Recommendation 2012, obsoleted 11 October 2018 in favour of service workers and Web App Manifest. Lesson: a format without a widely installed runtime dies.
- **Isolated Web Apps / Signed Web Bundles** [12]. Signed with Ed25519 or ECDSA P-256. The app's origin is derived from the public key (`isolated-app://`). Strict CSP, scripts only from the bundle. Limited to managed ChromeOS and partners. Copy: identity equals signing key, strict CSP. Limit: single-vendor.
- **Telegram Mini Apps** [13]. Remote URL, not a package. Launch data verified by HMAC-SHA-256 or Ed25519. Rich bridge (biometrics, secure storage, sensors). Shows what a host bridge can offer when the host owner has Apple's acceptance.
- **Fuchsia packages** [14]. Content-addressed blobs; `meta/contents` maps paths to Merkle roots; the package hash is the Merkle root of `meta.far`. Copy: per-file hashes with one signed root, which gives deduplication and delta updates.
- Tizen, Firefox OS and Farcaster formats were not researched from primary sources: unverified.

Security design for a host, derived from the above: per-file SHA-256 list in the manifest; one Ed25519 signature over the manifest; package identity derived from the public key; a distinct origin per package (on Android, `WebViewAssetLoader` serves local files over https URLs for same-origin compatibility [47]); a CSP that allows only bundled scripts; network off unless declared; capabilities declared with a reason and granted by the user per package (this also matches 4.7.3); monotonic version code with the previous version kept for rollback. These are design proposals, not tested results.

## 5. iOS distribution routes

| Route | Needs | Notes |
|---|---|---|
| App Store, TestFlight | Paid Developer Program | App Review applies [1][29] |
| Ad hoc | Paid program | Registered devices only. The 100-device limit is unverified |
| Enterprise | Enterprise Program | Internal employees only [29] |
| EU alternative marketplace | Paid program, notarization, Apple authorization | EU users only [27] |
| EU Web Distribution | Two years in good standing and over one million first annual installs, notarization | EU users, iOS 17.5+ [28] |
| Free Apple ID | Apple Account | Profiles expire after 7 days; 3 apps per device; 10 App IDs [29] |
| AltStore Classic, SideStore | Free Apple ID, computer for first install | Same 7-day and 3-app limits; SideStore refreshes on-device through a local VPN [30][31] |

Building without a Mac: xtool builds SwiftPM packages into iOS apps and signs and installs them from Linux or Windows (WSL) [32]. rcodesign signs and notarizes Apple software from Linux and Windows; its documentation does not mention IPA files explicitly [33]. Both still need Apple-issued certificates and profiles, so an Apple Account is always required. xtool depends on SDK files taken from Xcode (unverified detail). zsign, ldid, isign, Theos and fastlane's limits were not verified from primary sources: unverified. No route installs an unsigned app on a stock iPhone.

Android: a host can load a package into WebView and serve it from a private https origin [47]. A Trusted Web Activity is different: it shows a remote site in the user's browser and the host cannot touch the content, so it cannot load a local package [46].

## 6. Recommendation

**Use both A and B with the same package.** The `.tapp` file is a signed zip of standard web content (HTML, CSS, JavaScript, WebAssembly) plus a small manifest. It is delivered in two ways:

1. **Host mode (A).** A tethertrace host app on Android loads `.tapp` files directly. This fits the project's existing Android strength and Play's interpreter exception [4].
2. **Export mode (B).** A generator wraps the same package in a thin native shell and emits an APK/AAB and an Xcode project or IPA. This is the only route to a standalone, signed iOS app.
3. **PWA fallback (C).** The same files served over https are an installable web app.

Why not A alone: on iOS, a general-purpose host that runs arbitrary third-party packages must pass review under 4.7, needs Apple's permission for any native API it exposes, and may not act as a storefront [1][2]. Whether Apple would approve such a host from a small publisher is unknown. Why not B alone: it brings back per-platform builds and the Mac. Why web content and not a custom VM (D, E): WKWebView is the only place on iOS where third-party code gets a JIT, and "HTML5 and JavaScript" is the only downloaded-software category 4.7 names for mini apps.

Verified: the policy texts quoted; webxdc proves the zip-in-sandboxed-WebView model on both platforms; Safari 26 ships WebGPU and wasm. Hypotheses: that an iOS host would pass App Review; that WebGPU and full wasm tiers are active in third-party WKWebView; that the security design above is sufficient; performance on real devices.

## 7. What a `.tapp` can never do on a stock iPhone

- Run JIT-compiled code outside WKWebView [34][35].
- Load native code that is not in the signed host bundle [1].
- Use a native API the host did not compile in, or one Apple has not permitted the host to expose [1].
- Use Web Bluetooth, WebUSB or Web NFC through web APIs [20][21][22].
- Use a non-WebKit engine (outside the unshipped EU path) [1][26].
- Run unrestricted in the background. iOS limits background execution; details were not researched here: unverified.
- Install without Apple-issued signing of the host.
- Turn the host into an app store for other apps [2].

## 8. Hard cases

- **Node.js backend.** It must stay remote, be rewritten to run client-side, or run under a plain JS engine without Node APIs. nodejs-mobile embeds Node in apps and on iOS runs V8 with JIT disabled [44]. Its latest release found is based on Node 18 and its maintenance status is unclear (unverified) [43]. It is native code, so it can only ship inside a signed build (B), never inside a downloaded package.
- **Next.js.** `output: 'export'` produces static files that fit a package. Server Actions, cookies, rewrites, redirects, ISR, request-dependent Route Handlers and default image optimisation "require a Node.js server" and are not supported [45].
- **Games.** WebGL, WebGPU and wasm inside the WebView. No native-engine performance; interpreter-only if wasm runs outside the WebView.
- **Hardware beyond web APIs.** Needs a host bridge. On Android the host can add one freely within Play policy. On iOS it must be compiled into the signed host and falls under 4.7.2 and 4.7.3.

## Sources

1. Apple, App Review Guidelines. https://developer.apple.com/app-store/review/guidelines/
2. Apple Developer Program License Agreement, 3.3.1(B). https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
3. Apple news, April 5, 2024, guideline update. https://developer.apple.com/news/?id=0kjli9o1
4. Google Play, Device and Network Abuse. https://support.google.com/googleplay/android-developer/answer/16559646
5. webxdc container format. https://webxdc.org/docs/spec/format.html
6. webxdc messenger implementation requirements. https://webxdc.org/docs/spec/messenger.html
7. webxdc sendUpdate. https://webxdc.org/docs/spec/sendUpdate.html
8. webxdc compatibility FAQ. https://webxdc.org/docs/faq/compat.html
9. W3C MiniApp Packaging. https://www.w3.org/TR/miniapp-packaging/
10. W3C MiniApp Manifest. https://www.w3.org/TR/miniapp-manifest/
11. W3C Packaged Web Apps (Widgets). https://www.w3.org/TR/widgets/
12. Isolated Web Apps. https://chromeos.dev/en/web/isolated-web-apps
13. Telegram Mini Apps. https://core.telegram.org/bots/webapps
14. Fuchsia packages. https://fuchsia.dev/fuchsia-src/concepts/packages/package
15. Cosmopolitan libc. https://github.com/jart/cosmopolitan
16. WebKit, Web Push for Web Apps on iOS and iPadOS. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
17. WebKit, Updates to Storage Policy. https://webkit.org/blog/14403/updates-to-storage-policy/
18. WebKit, Full Third-Party Cookie Blocking and More. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
19. WebKit Features in Safari 26.0. https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
20. caniuse, Web NFC. https://caniuse.com/webnfc
21. caniuse, WebUSB. https://caniuse.com/webusb
22. WebKit bug 101034, Web Bluetooth. https://bugs.webkit.org/show_bug.cgi?id=101034
23. webkit-dev, WebKit position on Web NFC. https://lists.webkit.org/pipermail/webkit-dev/2020-January/031007.html
24. TechCrunch, Apple reverses decision on EU web apps (press, not primary). https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/
25. Apple, Using alternative browser engines in the EU. https://developer.apple.com/support/alternative-browser-engines/
26. Open Web Advocacy, Apple's browser engine ban persists (advocacy source). https://open-web-advocacy.org/blog/apples-browser-engine-ban-persists-even-under-the-dma/
27. Apple, DMA and apps in the EU. https://developer.apple.com/support/dma-and-apps-in-the-eu/
28. Apple, Web Distribution in the EU. https://developer.apple.com/support/web-distribution-eu/
29. Apple, Compare memberships. https://developer.apple.com/support/compare-memberships/
30. SideStore FAQ. https://docs.sidestore.io/docs/faq
31. AltStore PAL FAQ. https://faq.altstore.io/altstore-pal/what-is-altstore-pal
32. xtool. https://github.com/xtool-org/xtool
33. apple-codesign (rcodesign) documentation. https://gregoryszorc.com/docs/apple-codesign/stable/
34. iSH, JIT, and EU. https://ish.app/blog/ish-jit-and-eu
35. Microsoft, Interpreters on iOS and Mac Catalyst. https://learn.microsoft.com/en-us/dotnet/maui/macios/interpreter
36. A. Coote, To JSC or not to JSC (secondary). https://dev.to/alastaircoote/to-jsc-or-not-to-jsc-running-javascript-on-ios-in-2020-44ba
37. Wasmtime stability tiers. https://docs.wasmtime.dev/stability-tiers.html
38. Wasmtime, Using Pulley. https://docs.wasmtime.dev/examples-pulley.html
39. WASI releases. https://wasi.dev/releases
40. Expo FAQ. https://docs.expo.dev/faq/
41. Expo, How EAS Update works. https://docs.expo.dev/eas-update/how-it-works/
42. Microsoft code-push repository (retirement notice). https://github.com/microsoft/code-push
43. nodejs-mobile. https://github.com/nodejs-mobile/nodejs-mobile
44. Janea Systems, Node.js meets iOS. https://janeasystems.com/blog/node-js-meets-ios
45. Next.js, Static exports. https://nextjs.org/docs/app/guides/static-exports
46. Android, Trusted Web Activities. https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
47. AndroidX WebViewAssetLoader. https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader
48. Haas et al., Bringing the Web up to Speed with WebAssembly, PLDI 2017. https://pldi17.sigplan.org/event/pldi-2017-papers-bringing-the-web-up-to-speed-with-webassembly
49. Jangda et al., Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code, USENIX ATC 2019. https://www.usenix.org/conference/atc19/presentation/jangda
50. Lu et al., Demystifying Resource Management Risks in Emerging Mobile App-in-App Ecosystems, CCS 2020. https://experts.illinois.edu/en/publications/demystifying-resource-management-risks-in-emerging-mobile-app-in-/
51. Demystifying Cookie Sharing Risks in WebView-based Mobile App-in-app Ecosystems, arXiv 2510.24141. https://arxiv.org/html/2510.24141v1
