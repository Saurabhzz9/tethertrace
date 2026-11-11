import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  detectProjects, inspectGradleAndroid, build, classifyBuildFailure, shouldRetryOverIpv4, findApks, apkSignature, pickArtifact,
  resolveAndroidToolchain, findJdks, pickJdk, parseJavaVersion, parseCmdlineTools, parseLocalProperties, installJdk,
  download, extractZip, ToolchainError,
} from "../dist/index.js";
import { buildApk, zip } from "./helpers/apk.mjs";

const tmp = (p = "tt-build-") => mkdtemp(join(tmpdir(), p));
async function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}
const WRAPPER = (v) => `distributionUrl=https\\://services.gradle.org/distributions/gradle-${v}-bin.zip\n`;

const KTS_APP = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.example.shop"
    compileSdk = 35
    // compileSdk = 99
    defaultConfig {
        applicationId = "com.example.shop"
        minSdk = 24
        targetSdk = 35
    }
    buildTypes {
        release { isMinifyEnabled = true }
        create("staging") { initWith(getByName("debug")) }
    }
    flavorDimensions += "tier"
    productFlavors {
        create("free") { dimension = "tier" }
        create("paid") { dimension = "tier" }
    }
}
`;

test("native Android (Kotlin DSL): modules, versions, variants and the Java it needs", async () => {
  const dir = await tree(await tmp(), {
    "settings.gradle.kts": `pluginManagement { repositories { google() } }\nplugins {\n  id("com.android.application") version "8.7.2" apply false\n  id("org.jetbrains.kotlin.android") version "2.0.21" apply false\n}\ninclude(":app", ":core")\n`,
    "build.gradle.kts": "",
    "gradlew": "#!/bin/sh\n",
    "gradle/wrapper/gradle-wrapper.properties": WRAPPER("8.10.2"),
    "app/build.gradle.kts": KTS_APP,
    "app/src/main/kotlin/Main.kt": "",
    "core/build.gradle.kts": `plugins { id("com.android.library") }\nandroid { namespace = "com.example.core" }\n`,
  });
  const [p, ...rest] = await detectProjects(dir);
  assert.equal(rest.length, 0);
  assert.equal(p.kind, "android-native");
  assert.deepEqual(p.build, { supported: "local", adapter: "gradle" });
  assert.equal(p.android.gradleVersion, "8.10.2");
  assert.equal(p.android.agpVersion, "8.7.2");
  assert.equal(p.android.kotlinVersion, "2.0.21");
  assert.equal(p.android.requiredJdk, 17);
  assert.equal(p.android.maxJdk, 23);
  assert.equal(p.android.modules.length, 1, "the library module is not an app");
  const m = p.android.modules[0];
  assert.equal(m.path, ":app");
  assert.equal(m.applicationId, "com.example.shop");
  assert.equal(m.compileSdk, 35, "a commented-out compileSdk must not win");
  assert.equal(m.language, "kotlin");
  assert.deepEqual(m.flavors, ["free", "paid"]);
  assert.deepEqual(m.variants.sort(), ["freeDebug", "freeRelease", "freeStaging", "paidDebug", "paidRelease", "paidStaging"]);
});

test("native Android (Groovy, version catalog, two apps): does not just take the first build.gradle", async () => {
  const groovy = (id) => `plugins {\n  alias(libs.plugins.android.application)\n}\nandroid {\n  namespace '${id}'\n  compileSdkVersion 34\n  defaultConfig {\n    applicationId "${id}"\n    minSdkVersion 21\n  }\n}\n`;
  const dir = await tree(await tmp(), {
    "settings.gradle": "include ':phone', ':tv'\ninclude ':lib'\n",
    "build.gradle": "// top level\n",
    "gradlew.bat": "",
    "gradle/wrapper/gradle-wrapper.properties": WRAPPER("7.5"),
    "gradle/libs.versions.toml": `[versions]\nagp = "7.4.2"\nkotlin = "1.8.22"\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\n`,
    "phone/build.gradle": groovy("com.example.phone"),
    "phone/src/main/java/A.java": "",
    "tv/build.gradle": groovy("com.example.tv"),
    "lib/build.gradle": "plugins { id 'com.android.library' }\n",
  });
  const info = await inspectGradleAndroid(dir);
  assert.deepEqual(info.modules.map((m) => [m.path, m.applicationId, m.compileSdk, m.minSdk]), [[":phone", "com.example.phone", 34, 21], [":tv", "com.example.tv", 34, 21]]);
  assert.equal(info.agpVersion, "7.4.2");
  assert.equal(info.requiredJdk, 11);
  assert.equal(info.maxJdk, 18);
  assert.equal(info.modules[0].language, "java");
  // Building needs a choice: it must say so, not guess.
  const r = await build({ dir });
  assert.equal(r.ok, false);
  assert.equal(r.error.category, "ambiguous_project");
  assert.match(r.error.hints.join(" "), /--module: :phone, :tv/);
});

test("Flutter, React Native, Expo, SwiftPM and Xcode projects are told apart, including in a monorepo", async () => {
  const dir = await tree(await tmp(), {
    "apps/shop/pubspec.yaml": "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n",
    "apps/shop/android/settings.gradle.kts": 'include(":app")\n',
    "apps/shop/android/gradlew": "",
    "apps/shop/android/gradle/wrapper/gradle-wrapper.properties": WRAPPER("8.12"),
    "apps/shop/android/app/build.gradle.kts": KTS_APP,
    "apps/shop/ios/Runner.xcodeproj/project.pbxproj": "",
    "apps/rn/package.json": JSON.stringify({ name: "rnapp", dependencies: { "react-native": "0.76.1", react: "18" } }),
    "apps/rn/android/settings.gradle": "include ':app'\n",
    "apps/rn/android/gradlew": "",
    "apps/rn/android/app/build.gradle": "apply plugin: 'com.android.application'\nandroid { namespace 'com.rnapp'\n compileSdk 35 }\n",
    "apps/expo/package.json": JSON.stringify({ name: "expoapp", dependencies: { "react-native": "0.76.1", expo: "~52.0.0" } }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "18" } }),
    "apps/dartlib/pubspec.yaml": "name: dartlib\n",
    "ios/Swifty/Package.swift": "// swift-tools-version: 6.0\n",
    "ios/Swifty/xtool.yml": "version: 1\nbundleID: com.example.Swifty\n",
    "ios/Legacy/Legacy.xcodeproj/project.pbxproj": "",
    "ios/JustALib/Package.swift": "// swift-tools-version: 6.0\n",
    "node_modules/react-native/package.json": JSON.stringify({ name: "react-native", dependencies: { "react-native": "x" } }),
  });
  const by = Object.fromEntries((await detectProjects(dir)).map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ["Legacy", "Swifty", "expoapp", "rnapp", "shop"]);
  assert.equal(by.shop.kind, "flutter");
  assert.deepEqual(by.shop.platforms, ["android", "ios"]);
  assert.equal(by.shop.build.adapter, "flutter");
  assert.equal(by.shop.android.modules[0].compileSdk, 35);
  assert.equal(by.rnapp.kind, "react-native");
  assert.equal(by.rnapp.build.adapter, "react-native");
  assert.match(by.rnapp.notes.join(" "), /node_modules is missing/);
  assert.equal(by.expoapp.build.supported, "none");
  assert.match(by.expoapp.notes.join(" "), /expo prebuild/);
  assert.equal(by.Swifty.kind, "ios-swiftpm");
  assert.equal(by.Swifty.build.adapter, "xtool");
  assert.equal(by.Legacy.kind, "ios-xcode");
  assert.equal(by.Legacy.build.supported, "remote-mac");
  // Unsupported targets are reported, never built or faked.
  const r = await build({ dir: join(dir, "ios", "Legacy") });
  assert.equal(r.ok, false);
  assert.equal(r.error.category, "unsupported");
  assert.match(r.error.message, /Mac with Xcode/);
  assert.equal((await build({ dir: join(dir, "apps", "web") })).error.category, "no_project");
  assert.equal((await build({ dir })).error.category, "ambiguous_project");
});

test("prebuilt APK and IPA files are listed as artifacts, not projects to build", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "app-release.apk"), buildApk("com.example.notes"));
  await writeFile(join(dir, "App.ipa"), "x");
  const found = await detectProjects(dir);
  assert.deepEqual(found.map((p) => p.kind).sort(), ["apk", "ipa"]);
  assert.equal((await build({ dir })).error.category, "no_project");
});

test("JDK discovery and choice: reads `release`, prefers a fitting LTS, respects Gradle's upper limit", async () => {
  assert.equal(parseJavaVersion('JAVA_VERSION="17.0.13"\n'), 17);
  assert.equal(parseJavaVersion('JAVA_VERSION="1.8.0_392"\n'), 8);
  assert.equal(parseJavaVersion("nothing"), undefined);
  const dir = await tmp();
  const javac = process.platform === "win32" ? "javac.exe" : "javac";
  for (const [name, v] of [["corretto-8", "1.8.0_392"], ["jdk-19", "19.0.2"], ["jdk-21", "21.0.1"], ["jdk-23", "23.0.1"]])
    await tree(dir, { [`${name}/bin/${javac}`]: "", [`${name}/release`]: `JAVA_VERSION="${v}"\n` });
  await tree(dir, { "jre-only/release": 'JAVA_VERSION="17.0.1"\n' }); // no compiler: not a JDK
  const jdks = await findJdks({ hermetic: true, env: {}, extraJdkDirs: [dir] });
  assert.deepEqual(jdks.map((j) => j.version).sort((a, b) => a - b), [8, 19, 21, 23]);
  assert.equal(pickJdk(jdks, 17, 23).version, 21, "LTS first");
  assert.equal(pickJdk(jdks, 17, 20).version, 19, "Gradle 8.3 cannot run on 21");
  assert.equal(pickJdk(jdks, 11, 18), undefined, "8 is too old and 19 too new for AGP 7 on Gradle 7.5");
  assert.equal(pickJdk(jdks, 8, 15).version, 8);
});

test("toolchain: reports exactly what is missing and downloads nothing without consent", async () => {
  process.env.TETHERTRACE_HOME = await tmp("tt-home-");
  const project = { gradleRoot: await tmp(), hasWrapper: true, requiredJdk: 17, maxJdk: 23, modules: [{ path: ":app", compileSdk: 35 }] };
  const tc = await resolveAndroidToolchain(project, { hermetic: true, env: {} });
  assert.deepEqual(tc.missing.map((m) => m.what), ["jdk", "sdk"]);
  assert.match(tc.missing[0].detail, /JDK 17 to 23 is needed; none found/);

  // With install on but consent declined: the index may be read, the binary must not be fetched.
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    if (String(url).includes("api.adoptium.net")) return new Response(JSON.stringify([{ release_name: "jdk-17.0.13+11", binary: { package: { link: "https://github.com/adoptium/temurin17-binaries/releases/download/x/jdk.zip", checksum: "a".repeat(64), size: 190e6, name: "jdk.zip" } } }]));
    throw new Error("the JDK binary was requested without consent");
  };
  const asked = [];
  await assert.rejects(
    resolveAndroidToolchain(project, { hermetic: true, env: {}, install: true, fetchImpl, consent: async (q) => { asked.push(q); return false; } }),
    (e) => e instanceof ToolchainError && e.code === "CONSENT" && /not approved for download \(190 MB\)/.test(e.message),
  );
  assert.equal(fetched.length, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0].what, /JDK 17/);
  assert.equal(asked[0].downloadMb, 190);
  // No consent callback at all means no.
  await assert.rejects(installJdk(17, { fetchImpl }), /not approved/);
  // A download link that is not on Adoptium's GitHub is refused.
  const evil = async () => new Response(JSON.stringify([{ release_name: "x", binary: { package: { link: "https://evil.example/jdk.zip", checksum: "a".repeat(64), size: 1, name: "jdk.zip" } } }]));
  await assert.rejects(installJdk(17, { fetchImpl: evil, consent: async () => true }), /Unexpected JDK download host/);
});

test("toolchain: an SDK named in local.properties is found, with its platforms and license state", async () => {
  process.env.TETHERTRACE_HOME = await tmp("tt-home-");
  const sdk = await tree(await tmp("tt-sdk-"), { "platforms/android-34/android.jar": "", "platforms/android-35/android.jar": "", "build-tools/35.0.0/aapt2": "", "licenses/android-sdk-license": "x" });
  const gradleRoot = await tree(await tmp(), { "local.properties": `sdk.dir=${sdk.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\nflutter.sdk=C\\:\\\\flutter\n` });
  assert.equal(parseLocalProperties("sdk.dir=C\\:\\\\Android\\\\sdk\n# x=1\n")["sdk.dir"], "C:\\Android\\sdk");
  const jdkDir = await tmp();
  await tree(jdkDir, { [`jdk-17/bin/${process.platform === "win32" ? "javac.exe" : "javac"}`]: "", "jdk-17/release": 'JAVA_VERSION="17.0.1"\n' });
  const base = { gradleRoot, hasWrapper: true, requiredJdk: 17, maxJdk: 23 };
  const ok = await resolveAndroidToolchain({ ...base, modules: [{ path: ":app", compileSdk: 35 }] }, { hermetic: true, env: {}, extraJdkDirs: [jdkDir] });
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.sdk.root, sdk);
  assert.equal(ok.sdk.source, "local.properties");
  assert.deepEqual(ok.sdk.platforms, [34, 35]);
  assert.equal(ok.env.ANDROID_HOME, sdk);
  assert.equal(ok.env.JAVA_HOME, join(jdkDir, "jdk-17"));
  const needs36 = await resolveAndroidToolchain({ ...base, modules: [{ path: ":app", compileSdk: 36 }] }, { hermetic: true, env: {}, extraJdkDirs: [jdkDir] });
  assert.deepEqual(needs36.missing.map((m) => m.what), ["platform"]);
  assert.match(needs36.missing[0].detail, /platform 36 is not installed/);
});

test("Google's SDK index: picks the newest stable command-line tools for this OS, with its checksum", () => {
  const archive = (os, n) => `<archive><complete><size>${150000000 + n}</size><checksum type="sha1">${String(n).repeat(40).slice(0, 40)}</checksum><url>commandlinetools-${os}-${n}_latest.zip</url></complete><host-os>${os === "win" ? "windows" : os === "mac" ? "macosx" : "linux"}</host-os></archive>`;
  const pkg = (v, n, channel) => `<remotePackage path="cmdline-tools;${v}"><channelRef ref="channel-${channel}"/><archives>${archive("linux", n)}${archive("mac", n)}${archive("win", n)}</archives></remotePackage>`;
  const xml = `<sdk>${pkg("12.0", 1, 0)}${pkg("19.0", 2, 0)}${pkg("20.0", 3, 1)}<remotePackage path="platforms;android-35"><archives>${archive("win", 9)}</archives></remotePackage></sdk>`;
  assert.deepEqual(parseCmdlineTools(xml, "windows"), { url: "commandlinetools-win-2_latest.zip", sha1: "2".repeat(40), size: 150000002 });
  assert.equal(parseCmdlineTools(xml, "linux").url, "commandlinetools-linux-2_latest.zip");
  assert.equal(parseCmdlineTools(xml, "plan9"), undefined);
  assert.equal(parseCmdlineTools("<sdk/>", "linux"), undefined);
});

test("download: verifies the checksum, retries network failures, and never keeps a bad file", async () => {
  const body = Buffer.from("toolchain bytes ".repeat(1000));
  const sha256 = createHash("sha256").update(body).digest("hex");
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/flaky" && hits < 3) { res.statusCode = 503; return res.end(); }
    if (req.url === "/missing") { res.statusCode = 404; return res.end(); }
    res.setHeader("content-length", body.length);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await tmp();
  try {
    await download(`${base}/ok`, join(dir, "ok.bin"), { checksum: { algorithm: "sha256", hex: sha256 } });
    assert.deepEqual(await readFile(join(dir, "ok.bin")), body);
    hits = 0;
    await download(`${base}/flaky`, join(dir, "flaky.bin"), { checksum: { algorithm: "sha256", hex: sha256 } });
    assert.equal(hits, 3);
    hits = 0;
    await assert.rejects(download(`${base}/ok`, join(dir, "bad.bin"), { checksum: { algorithm: "sha256", hex: "0".repeat(64) } }), (e) => e instanceof ToolchainError && e.code === "CHECKSUM");
    assert.equal(hits, 1, "a wrong checksum is not retried");
    await assert.rejects(download(`${base}/missing`, join(dir, "gone.bin"), { checksum: { algorithm: "sha256", hex: sha256 }, retries: 1 }), (e) => e.code === "DOWNLOAD");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(download(`${base}/ok`, join(dir, "c.bin"), { checksum: { algorithm: "sha256", hex: sha256 }, signal: ac.signal }), (e) => e.code === "CANCELLED");
    assert.deepEqual((await readdir(dir)).sort(), ["flaky.bin", "ok.bin"], "no partial or unverified files left behind");
  } finally {
    server.close();
  }
});

test("extractZip: unpacks with a stripped top folder and refuses entries that escape the target", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "a.zip"), zip([{ name: "cmdline-tools/bin/sdkmanager", data: Buffer.from("#!/bin/sh\n"), deflate: true }, { name: "cmdline-tools/lib/x.jar", data: Buffer.from("jar"), deflate: false }]));
  assert.equal(await extractZip(join(dir, "a.zip"), join(dir, "out"), 1), 2);
  assert.equal(await readFile(join(dir, "out", "bin", "sdkmanager"), "utf8"), "#!/bin/sh\n");
  assert.equal(await readFile(join(dir, "out", "lib", "x.jar"), "utf8"), "jar");
  await writeFile(join(dir, "evil.zip"), zip([{ name: "../../escaped.txt", data: Buffer.from("x"), deflate: false }]));
  await assert.rejects(extractZip(join(dir, "evil.zip"), join(dir, "out2")), /outside/);
  assert.equal(await stat(join(dir, "escaped.txt")).catch(() => undefined), undefined);
  await writeFile(join(dir, "not.zip"), "hello");
  await assert.rejects(extractZip(join(dir, "not.zip"), join(dir, "out3")), /not a ZIP/);
});

test("build failures are sorted into categories with the lines that matter", () => {
  const c = (s) => classifyBuildFailure(s).category;
  assert.equal(c("FAILURE: Build failed\n* What went wrong:\nSDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable"), "toolchain_missing");
  assert.equal(c("* What went wrong:\nFailed to install the following Android SDK packages as some licences have not been accepted.\n platforms;android-35"), "license_not_accepted");
  assert.equal(c("* What went wrong:\nUnsupported class file major version 67"), "jdk_incompatible");
  assert.equal(c("* What went wrong:\nCould not resolve com.squareup.okhttp3:okhttp:4.12.0.\n > Could not GET 'https://repo.maven.apache.org/...'"), "dependency_download_failed");
  assert.match(classifyBuildFailure("No cached version of com.x:y:1 available for offline mode.\nCould not resolve com.x:y:1").hints[0], /without --offline/);
  assert.equal(c("java.io.IOException: No space left on device"), "out_of_disk");
  // A dead IPv6 route makes Java time out on downloads that work over IPv4: retried once, never twice.
  const timedOut = 'Exception in thread "main" java.net.ConnectException: Connection timed out: connect';
  assert.equal(c(timedOut), "dependency_download_failed");
  assert.equal(shouldRetryOverIpv4(timedOut, {}), true);
  assert.equal(shouldRetryOverIpv4(timedOut, { JAVA_TOOL_OPTIONS: "-Djava.net.preferIPv4Stack=true" }), false);
  assert.equal(shouldRetryOverIpv4("Could not GET 'https://repo/x'. Received status code 404", {}), false);
  assert.equal(shouldRetryOverIpv4("e: Main.kt:1 Unresolved reference", {}), false);
  const oom = classifyBuildFailure("* What went wrong:\nGradle build daemon disappeared unexpectedly (it may have been killed or may have crashed)\n");
  assert.equal(oom.category, "out_of_memory");
  assert.match(oom.hints[0], /org\.gradle\.jvmargs/);
  const kt = classifyBuildFailure("> Task :app:compileDebugKotlin FAILED\ne: file:///src/Main.kt:12:5 Unresolved reference: foo\n* What went wrong:\nExecution failed for task ':app:compileDebugKotlin'.");
  assert.equal(kt.category, "compile_error");
  assert.deepEqual(kt.excerpt, ["e: file:///src/Main.kt:12:5 Unresolved reference: foo"]);
  assert.equal(c("lib/main.dart:10:3: Error: Expected ';' after this.\nFAILURE: Build failed"), "compile_error");
  const other = classifyBuildFailure("* What went wrong:\nA problem occurred configuring project ':app'.\n> something odd\n\n* Try:\n> Run with --info");
  assert.equal(other.category, "build_failed");
  assert.deepEqual(other.excerpt.slice(0, 2), ["A problem occurred configuring project ':app'.", "> something odd"]);
});

test("artifacts: the variant's APKs are found even when the build was up to date, and other variants are left out", async () => {
  const meta = (variantName, files) => JSON.stringify({ version: 3, variantName, elements: files.map((outputFile) => ({ type: "SINGLE", outputFile })) });
  const out = await tree(await tmp(), {
    "debug/output-metadata.json": meta("debug", ["app-debug.apk"]),
    "debug/app-debug.apk": "x",
    "debug/old-leftover.apk": "x",
    "release/output-metadata.json": meta("release", ["app-release.apk", "missing.apk"]),
    "release/app-release.apk": "x",
    "free/debug/output-metadata.json": meta("freeDebug", ["app-free-arm64-v8a-debug.apk", "app-free-x86_64-debug.apk"]),
    "free/debug/app-free-arm64-v8a-debug.apk": "x",
    "free/debug/app-free-x86_64-debug.apk": "x",
  });
  const names = async (...a) => (await findApks(out, ...a)).map((p) => p.replace(/^.*[\\/]/, ""));
  assert.deepEqual(await names("debug"), ["app-debug.apk"], "not the leftover, not other variants");
  assert.deepEqual(await names("release"), ["app-release.apk"], "a file the metadata names but that is absent is not reported");
  assert.deepEqual(await names("freeDebug"), ["app-free-arm64-v8a-debug.apk", "app-free-x86_64-debug.apk"]);
  assert.deepEqual(await names("paidDebug"), [], "a variant that was not built has no artifacts");
  const flutter = await tree(await tmp(), { "app-debug.apk": "x", "app-release.apk": "x", "app-arm64-v8a-release.apk": "x", "app-debug.apk.sha1": "x" });
  assert.deepEqual((await findApks(flutter, "release", "release")).map((p) => p.replace(/^.*[\\/]/, "")), ["app-arm64-v8a-release.apk", "app-release.apk"]);
  const legacy = await tree(await tmp(), { "debug/app-debug.apk": "x", "release/app-release-unsigned.apk": "x" });
  assert.deepEqual((await findApks(legacy, "debug")).map((p) => p.replace(/^.*[\\/]/, "")), ["app-debug.apk"], "no metadata: match by build type");
});

test("artifacts: signature detection and choosing the APK that fits the phone", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "unsigned.apk"), buildApk("com.example.notes"));
  assert.deepEqual(await apkSignature(join(dir, "unsigned.apk")), { v1: false, v2plus: false });
  await writeFile(join(dir, "v1.apk"), zip([{ name: "AndroidManifest.xml", data: Buffer.from("x"), deflate: false }, { name: "META-INF/CERT.RSA", data: Buffer.from("sig"), deflate: false }]));
  assert.deepEqual(await apkSignature(join(dir, "v1.apk")), { v1: true, v2plus: false });
  const a = (path, signed = true) => ({ path, sizeBytes: 1, signature: { v1: false, v2plus: signed } });
  const split = [a("out/app-arm64-v8a-debug.apk"), a("out/app-armeabi-v7a-debug.apk"), a("out/app-x86_64-debug.apk")];
  assert.equal(pickArtifact(split, "arm64-v8a").path, "out/app-arm64-v8a-debug.apk");
  assert.equal(pickArtifact([...split, a("out/app-universal-debug.apk")], "arm64-v8a").path, "out/app-universal-debug.apk");
  assert.equal(pickArtifact([a("out/app-debug.apk"), ...split], "x86").path, "out/app-debug.apk");
  assert.equal(pickArtifact([a("out/app-release-unsigned.apk", false)]), undefined, "an unsigned APK is never chosen");
});
