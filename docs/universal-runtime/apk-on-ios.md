# Can an existing Android APK run on an iPhone?

Status: desk research only, November 2026. Nothing in this report was tested on an iOS device by this project. Claims are tagged as verified (a primary source was read), unverified (secondary source or memory only), or hypothesis.

Short answer: not as a general capability. An unmodified APK cannot be loaded by iOS. A small class of APKs could in principle run slowly inside an interpreter-only emulator or a purpose-built runtime. No shipping product does this for arbitrary apps today.

## 1. What an APK needs at run time

An APK is a zip that holds DEX bytecode, resources, a manifest, and often native libraries.

**DEX.** ART runs DEX with a mix of ahead-of-time compilation, JIT, and interpretation. AOSP states that methods that are not AOT-compiled are interpreted, and only hot ones are then JIT-compiled. The `verify` compiler filter does no AOT compilation at all [2]. So DEX can be executed by an interpreter alone. JIT is an optimisation, not a requirement. This matters because it is the one part of an APK that iOS rules do not block in principle.

**Native libraries.** The NDK defines an ABI as instruction set, endianness, calling convention, and executable format, and says Android always uses ELF. Libraries live at `lib/<abi>/lib<name>.so` [3]. An arm64-v8a `.so` and an iOS binary share the AArch64 instruction set and nothing else that matters:

- Container: ELF versus Mach-O. The iOS loader (dyld) does not load ELF.
- Linker and libc: Android libraries import symbols from bionic and are bound by Android's linker. iOS has libSystem and dyld.
- Kernel interface: bionic issues Linux syscalls. XNU has different syscall numbers and semantics, plus Mach traps.
- Register and TLS conventions differ. Android reserves x18 for its own use [3]. Details of the iOS side are unverified here.
- Code signing: see section 2. This is the decisive one.

**Framework.** App code calls the Android framework, which talks to system services over Binder. AOSP documents Binder as a kernel driver exposing `/dev/binder` for framework and app IPC [4]. A running app also expects Zygote, system_server (activity, package, window managers), SurfaceFlinger, an input pipeline, and GLES or Vulkan. iOS offers Metal. ANGLE and MoltenVK can translate GLES and Vulkan to Metal (unverified here, not researched in depth).

## 2. iOS execution rules as documented

- **Mandatory code signing.** Apple states that all executable code must be signed with an Apple-issued certificate, and that this prevents third-party apps from loading unsigned code or using self-modifying code [5]. Verified.
- **W^X and JIT.** Apple states that pages that are both writable and executable are available only under tightly controlled conditions, gated by an Apple-only dynamic code-signing entitlement, and names Safari's JavaScript JIT as the user [6]. Verified.
- **Browser engines.** In the EU, authorised alternative browser engines get access to JIT. The entitlement is for browser apps or in-app browsing whose primary purpose is web browsing, with web-standards test thresholds [7]. Guideline 2.5.6 mentions the EU and Japan [1]. An Android runtime does not qualify. Verified.
- **Debugger-attached JIT.** Sideloaded development builds that carry `get-task-allow` can gain JIT when a debugger attaches. StikDebug's README lists iOS 17.4 to 18.x as fully supported and iOS 26.0+ as supported only for apps that developers have updated [8]. Community reports say iOS 26 tightened this on newer devices (TXM) and that some 26.4 betas broke it. Those details are unverified. This route is fragile and is not a distribution channel.
- **Guideline 2.5.2.** Apps must be self-contained and may not download, install, or execute code that introduces or changes features, with a narrow exception for educational coding apps [1]. Verified, paraphrased.
- **Guideline 4.7.** Permits HTML5 and JavaScript mini apps and mini games, streaming games, chatbots, and plug-ins, and says "retro game console and PC emulator apps can offer to download games" [1]. 4.7.2 forbids exposing native platform APIs to that software without Apple's permission. 4.7.4 requires an index of offered software. 4.7.5 requires age gating [1]. Verified. Read [1] for the exact text. An Android app runtime is not obviously a retro console or PC emulator. Whether App Review would accept one is a hypothesis.

Interpretation is allowed in practice: iSH and UTM SE are on the App Store and execute foreign machine code with interpreters [9][10].

## 3. The five problems

### 3.1 Running the original APK unmodified

Not possible. iOS has no APK installer, no DEX runtime, no ELF loader, no bionic, and no Binder. The native code is unsigned from Apple's point of view [5]. Renaming or repackaging the file changes none of this.

### 3.2 Translating the APK to another format

Two sub-problems.

*DEX to native.* Static translation of Java bytecode to iOS machine code has prior art. RoboVM used an AOT compiler to avoid the JIT ban and was discontinued in 2016 [11]. The result is ordinary signed code, so iOS accepts it. The blockers are elsewhere: reflection, dynamic class loading, and above all the Android framework that the code calls. Translation without a framework produces a binary with thousands of unresolved calls. Feasible for the bytecode, hypothesis for whole apps.

*ELF to Mach-O.* Rewriting a compiled arm64 `.so` into a Mach-O dylib means re-resolving every bionic import, converting syscalls, relocations, TLS and unwind data, without source. I found no tool that does this for Android libraries. Hypothesis, and very hard. Any translated output must then be signed and shipped inside an app bundle, which means per-app builds by someone with the right to redistribute that app.

### 3.3 Compatibility runtime (Wine style)

Wine reimplements the Windows API in user space on the same CPU (unverified from primary source; winehq.org refused the fetch). The Android equivalent on iOS would need:

- An ART interpreter built as signed code inside an iOS app. No JIT.
- A reimplementation of the Android framework surface: activities, views, resources, Binder semantics in-process, package and window management, graphics over Metal.
- For native libraries: either a user-space ELF loader plus a bionic shim, or CPU emulation of the app's own ARM64 code. Loading and running the `.so` directly would execute unsigned code, which iOS forbids [5]. So native code must be interpreted even though the CPU matches. This is the point most people miss.

Prior art:

- **Alien Dalvik 2.0 (Myriad, 2011)** was demonstrated running Android apps on an iPad without jailbreak by wrapping each app with its own VM. The vendor warned about performance and compatibility [12]. I found no evidence it shipped to consumers (unverified). It shows the DEX half is doable. It predates ART and modern framework size.
- **Cider (ASPLOS 2014) and Cycada** ran iOS apps on Android. That is the opposite direction, and it worked by modifying the Android kernel with per-thread personas and "diplomatic functions" [13]. It proves cross-ABI execution is possible when you own the kernel. On iOS you do not. The brief cites Cycada as ASPLOS 2016. I could not confirm that venue. The follow-up graphics paper appears to be Middleware 2017 (unverified).
- **Darling** runs macOS binaries on Linux and requires a real Linux kernel (secondary source, unverified) [14].
- **J2ObjC** translates Java source, states it cannot convert Android binary applications, and provides no UI toolkit [15].

Feasible in principle for pure-DEX apps with simple UI. Size: a multi-year project comparable to Wine's early years. Hypothesis.

### 3.4 Emulating Android inside iOS

- **Containers** (Waydroid, Anbox) boot Android in Linux namespaces on a Linux host [16]. They need a Linux kernel. Not applicable to iOS.
- **Virtual machines.** Windows Subsystem for Android was a Hyper-V VM and ended support on 5 March 2025 (secondary sources) [17]. On iOS, UTM documents that the hypervisor works only on jailbroken or TrollStore installs and requires an M1 iPad or newer [18]. No stock iPhone route.
- **Full-system emulation without JIT.** UTM SE runs QEMU with a threaded interpreter, needs no JIT, and is on the App Store [10][18]. UTM describes it as slower than JIT and suited to older or minimal systems such as DOS or Alpine Linux [18]. Third-party guides describe booting Android-x86 images in UTM on iOS with no graphics acceleration and no Google services (unverified, not from UTM). This is the only route that runs a real Android userspace on a stock iPhone today, in principle. It runs a whole OS in a window, not an app that integrates with iOS.
- **Replacing iOS.** Project Sandcastle ran Android on a few checkm8-era iPhones [19]. That is a different OS on Apple hardware, on a modified device. Out of scope for a stock phone.

### 3.5 Rebuilding from source

This is the normal, supported path. Kotlin/Native compiles Kotlin to native binaries without a VM and targets iOS [20]. Kotlin Multiplatform shares logic. Skip goes the other way, from Swift to Android [21]. J2ObjC covers Java logic only [15]. UI and platform APIs must be rewritten or abstracted. This is porting, not running an APK.

## 4. Distribution routes

| Route | What it allows | What it does not change |
|---|---|---|
| App Store, worldwide | Signed, reviewed apps. Interpreters allowed in practice [9][10]. | No JIT. 2.5.2 and 4.7 apply [1]. |
| EU alternative marketplaces and Web Distribution | Apps outside the App Store. Notarization applies to all apps. Since 1 October 2026 a 5% Core Technology Commission replaces the Core Technology Fee. Web Distribution has eligibility criteria [22]. | Same OS enforcement. No JIT for non-browsers [7]. |
| Free Apple ID sideloading, AltStore, SideStore | Developer-signed builds that expire after 7 days and need refresh (secondary sources) [23]. Debugger-attached JIT on some versions [8]. | Still signed code only. Fragile. |
| TrollStore | Arbitrary entitlements via a CoreTrust bug on iOS 14.0 beta 2 to 16.6.1, 16.7 RC and 17.0 only. Later versions will not be supported [24]. | Old firmware only. Not a basis for a product. |
| Enterprise and ad hoc | Signed apps for owned or registered devices (unverified, not researched). | Same runtime rules. |
| Jailbroken devices | Can lift JIT and hypervisor limits [18]. | Not stock. Classified here only. |
| Security Research Device | Shell access and custom entitlements. Not for personal use. Must stay on premises [25]. | Not a user or product route. |

## 5. Dependencies that break apps even if code runs

- **Google Mobile Services.** GMS is not part of AOSP and is available only under licence from Google [26]. Apps that need Play Services, Firebase push, Maps, or Google sign-in lose those features.
- **Play Integrity.** Verdicts attest a genuine Play-installed binary on a genuine certified Android device, using hardware-backed signals, and explicitly flag emulated environments [27]. An iPhone cannot pass. Banking, payments, and many games stop here.
- **Widevine and hardware keystore.** Higher Widevine levels and key attestation depend on a device TEE with provisioned keys [28]. A runtime on iOS has none. This report does not discuss circumvention.

**Licensing.** AOSP prefers Apache 2.0, so ART and the framework could be redistributed in a runtime [29]. GMS cannot [26]. Redistributing someone else's APK needs that owner's permission.

## 6. Performance

No published benchmark of Android under UTM SE was found. Published statements:

- iSH: its threaded-code interpreter gives roughly 3 to 5 times speedup over simple switch dispatch [9]. It is still an interpreter.
- UTM SE: "slower than JIT", no numbers [10][18].
- ART: a third-party book claims nterp is 2 to 5 times faster than a C++ switch interpreter (unverified). No primary ART interpreter versus JIT figures were found.

Expectation, as a hypothesis: full-system emulation of Android under an interpreter is one to two orders of magnitude slower than native, with software rendering. An ART interpreter running natively compiled as iOS code would be far better for DEX, but native `.so` code would still be interpreted.

## 7. Verdict

| Approach | Feasible in principle | Stock iPhone | Signing, entitlement, EU | Modified device | Performance | Main blocker | Status |
|---|---|---|---|---|---|---|---|
| Unmodified APK loaded by iOS | No | No | Not applicable | Would not help alone | None | No loader, no runtime, unsigned code [5] | Not possible today |
| DEX to native translation | Partly | Only as a rebuilt, signed app | Normal signing | No | Good for logic | Framework missing, reflection | Hypothesis |
| ELF to Mach-O translation | Barely | Only as a rebuilt, signed app | Normal signing | No | Unknown | bionic, syscalls, no tooling | Hypothesis |
| Compatibility runtime (ART interpreter plus framework) | Yes, narrow app class | Yes if App Review accepts | Review risk under 2.5.2 and 4.7 [1] | No | Moderate DEX, poor native | Framework size, interpreted native code | Hypothesis |
| Full Android in interpreter-only emulator | Yes | Yes (UTM SE exists) [10] | None extra | No | Very slow, no GPU | Speed, no GMS | Mechanism verified by source, Android usability unverified |
| Android VM with hypervisor or JIT | Yes | No | Not grantable to this use | Yes (jailbreak, TrollStore, M1 iPad) [18] | Good | OS policy | Verified by source |
| Rebuild from source | Yes | Yes | Normal signing | No | Native | Engineering effort | Verified by source |

## 8. Conclusions

**(a) Most realistic path.** A full Android-x86 or ARM userspace under an interpreter-only emulator, as UTM SE does for PCs. It already passes App Review as a PC emulator and needs no new invention. It would be slow, without GPU acceleration or Google services, and would suit simple, offline, pure-DEX utilities at best. The better-performing alternative is an ART interpreter port plus a framework reimplementation. That is a multi-year effort for a team, with uncertain App Review outcome, and it would cover only apps with no GMS, no integrity checks, no DRM, and little or no native code.

**(b) What should not be claimed.**

- That an APK can be "converted" to an IPA.
- That shared ARM64 hardware makes native libraries portable.
- That EU sideloading removes code signing or the JIT restriction.
- That any of this was tested by this project.
- That apps using Play Integrity, Widevine, or Play Services would work.

**(c) What tethertrace could honestly do today.** Static APK analysis that reports portability: presence and ABIs of native libraries, GMS and Firebase dependencies, Play Integrity and DRM use, reflection and dynamic loading, graphics APIs used. The output would say which route applies (rebuild from source, possible under an emulator, or not portable) and why. That is useful, cheap, and true.

## Sources

1. Apple, App Review Guidelines (2.5.2, 2.5.6, 4.7): https://developer.apple.com/app-store/review/guidelines/
2. AOSP, Configure ART: https://source.android.com/docs/core/runtime/configure
3. Android NDK, ABIs: https://developer.android.com/ndk/guides/abis
4. AOSP, Use binder IPC: https://source.android.com/docs/core/architecture/hidl/binder-ipc
5. Apple Platform Security, App code signing process: https://support.apple.com/guide/security/app-code-signing-process-sec7c917bf14/web
6. Apple Platform Security, Runtime process security: https://support.apple.com/guide/security/runtime-process-security-sec15bfe098e/web
7. Apple, Using alternative browser engines in the EU: https://developer.apple.com/support/alternative-browser-engines/
8. StikDebug README: https://github.com/StephenDev0/StikDebug
9. iSH README: https://github.com/ish-app/ish
10. UTM README: https://github.com/utmapp/UTM
11. The Register, Microsoft discontinues RoboVM (2016): https://www.theregister.co.uk/2016/04/15/microsoft_discontinues_robovm/
12. Engadget, Hands-on with Myriad's Alien Dalvik 2.0 on an iPad (2011): https://www.engadget.com/2011/10/10/hands-on-with-myriads-alien-dalvik-2-0-on-an-ipad-video/
13. Columbia University, Cycada project page and Cider paper: https://systems.cs.columbia.edu/projects/cycada and https://www.cs.columbia.edu/~alduaij/pubs/cider-asplos2014.pdf
14. Darling: https://darlinghq.org/
15. J2ObjC README: https://github.com/google/j2objc
16. Waydroid docs: https://docs.waydro.id/
17. Windows Central, Microsoft ends Android app support on Windows 11: https://www.windowscentral.com/software-apps/windows-11/microsoft-is-killing-support-for-running-android-apps-on-windows-11
18. UTM docs, iOS installation: https://docs.getutm.app/installation/ios/
19. Project Sandcastle: https://projectsandcastle.org/
20. Kotlin/Native overview: https://kotlinlang.org/docs/native-overview.html
21. Skip, modes documentation: https://skip.tools/docs/modes
22. Apple, Update on apps distributed in the European Union: https://developer.apple.com/support/dma-and-apps-in-the-eu/
23. SideStore README: https://github.com/SideStore/SideStore
24. TrollStore README: https://github.com/opa334/TrollStore
25. Apple Security Research Device Program: https://security.apple.com/research-device
26. Google Mobile Services: https://www.android.com/gms/
27. Play Integrity API overview: https://developer.android.com/google/play/integrity/overview
28. AOSP, Key and ID attestation: https://source.android.com/security/keystore/attestation
29. AOSP, Licenses: https://source.android.com/docs/setup/about/licenses
