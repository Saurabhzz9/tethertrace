import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { readApkInfo } from "./apk.js";
import { detectProjects, type AndroidModule, type DetectedProject, type Platform } from "./project/detect.js";
import { parseLocalProperties, resolveAndroidToolchain, type AndroidToolchain, type Consent } from "./toolchain/android.js";
import { pathExists, run, ToolchainError } from "./toolchain/fetch.js";

/**
 * Builds an app with the project's own build system (Gradle wrapper, Flutter, React Native) and
 * the toolchain resolved by ./toolchain. It does not reimplement any compiler or packager.
 */

export type BuildErrorCategory =
  | "no_project"
  | "ambiguous_project"
  | "unsupported"
  | "toolchain_missing"
  | "consent_declined"
  | "license_not_accepted"
  | "jdk_incompatible"
  | "dependency_download_failed"
  | "compile_error"
  | "out_of_disk"
  | "out_of_memory"
  | "timeout"
  | "cancelled"
  | "no_artifact"
  | "build_failed";

export interface BuildArtifact {
  path: string;
  sizeBytes: number;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  /** Which APK signature schemes are present. An unsigned APK cannot be installed. */
  signature: { v1: boolean; v2plus: boolean };
}

export interface BuildResult {
  tool: "tethertrace";
  schemaVersion: "0.1";
  kind: "build";
  ok: boolean;
  project?: { kind: string; root: string; name: string };
  adapter?: string;
  module?: string;
  variant?: string;
  command?: string;
  durationMs: number;
  toolchain?: { jdk?: string; jdkVersion?: number; sdk?: string; flutter?: string };
  artifacts: BuildArtifact[];
  logFile?: string;
  error?: { category: BuildErrorCategory; message: string; hints: string[]; excerpt: string[] };
}

export interface BuildOptions {
  dir?: string;
  platform?: Platform;
  /** Gradle module path (":app") when a project has several apps. */
  module?: string;
  /** Build variant, e.g. debug, release, freeDebug. Default debug. */
  variant?: string;
  /** Allow downloading missing toolchain parts (each one still goes through `consent`). */
  install?: boolean;
  consent?: Consent;
  /** Fail instead of using the network for dependencies. */
  offline?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** Where build.log goes. Default <project>/build/tethertrace. */
  logDir?: string;
}

export class BuildError extends Error {
  constructor(
    readonly category: BuildErrorCategory,
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "BuildError";
  }
}

/** Is the APK signed, and how. Reads only the ZIP structure. */
export async function apkSignature(path: string): Promise<{ v1: boolean; v2plus: boolean }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return { v1: false, v2plus: false };
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    let v2plus = false;
    if (cdOffset >= 24) {
      const magic = Buffer.alloc(16);
      await fh.read(magic, 0, 16, cdOffset - 16);
      v2plus = magic.toString("latin1") === "APK Sig Block 42";
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    return { v1: /META-INF\/[^/]+\.(RSA|DSA|EC)/.test(cd.toString("latin1")), v2plus };
  } finally {
    await fh.close();
  }
}

async function findApks(dir: string, since: number): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!e.isFile() || !/\.apk$/i.test(e.name)) continue;
    const p = join(e.parentPath, e.name);
    // Only what this build produced; leftovers from older builds are not this build's artifacts.
    if ((await stat(p)).mtimeMs >= since - 2000) out.push(p);
  }
  return out.sort();
}

export async function describeArtifact(path: string): Promise<BuildArtifact> {
  const info = await readApkInfo(path).catch(() => undefined);
  return { path, sizeBytes: (await stat(path)).size, packageName: info?.packageName, versionName: info?.versionName, versionCode: info?.versionCode, signature: await apkSignature(path) };
}

/** Turn build output into a category, the lines that matter, and what to do next. */
export function classifyBuildFailure(output: string): { category: BuildErrorCategory; hints: string[]; excerpt: string[] } {
  const lines = output.split(/\r?\n/);
  const pick = (re: RegExp, n = 12) => [...new Set(lines.filter((l) => re.test(l)).map((l) => l.trim()))].slice(0, n);
  const wrong = lines.findIndex((l) => /What went wrong:/.test(l));
  const summary = wrong >= 0 ? lines.slice(wrong + 1, wrong + 8).map((l) => l.trim()).filter((l) => l && !/^\* /.test(l)) : [];
  if (/SDK location not found|ANDROID_HOME|sdk\.dir/.test(output) && /not found|Define a valid/.test(output))
    return { category: "toolchain_missing", hints: ["No Android SDK was found. Run `tethertrace doctor`, then `tethertrace build --yes` to let it fetch a minimal one."], excerpt: summary };
  if (/licen[cs]e.*not (been )?accepted|Failed to install the following Android SDK packages/i.test(output))
    return { category: "license_not_accepted", hints: ["The Android SDK licenses are not accepted. Run `tethertrace build --yes` to accept them, or `sdkmanager --licenses` yourself."], excerpt: summary };
  if (/Unsupported class file major version|incompatible with the Java|requires Java \d+|Android Gradle plugin requires Java/i.test(output))
    return { category: "jdk_incompatible", hints: ["The JDK does not fit this project's Gradle or Android Gradle Plugin version. Run `tethertrace doctor` to see which JDK it needs."], excerpt: summary };
  if (/insufficient memory for the Java Runtime|OutOfMemoryError|Gradle build daemon disappeared unexpectedly|GC overhead limit exceeded/i.test(output))
    return {
      category: "out_of_memory",
      hints: ["The build ran out of memory (or its Gradle daemon was killed). Close other programs and build again; if it repeats, lower -Xmx in the org.gradle.jvmargs line of gradle.properties to fit this computer's free RAM."],
      excerpt: [...pick(/insufficient memory|OutOfMemoryError|daemon disappeared|GC overhead/, 3)],
    };
    if (/No space left on device|There is not enough space on the disk/i.test(output)) return { category: "out_of_disk", hints: ["Free some disk space; `tethertrace toolchain clean` removes toolchains tethertrace downloaded."], excerpt: summary };
  if (/Could not resolve|Could not GET|Could not download|Unknown host|No cached version .* available for offline mode|Connection (timed out|refused)/i.test(output))
    return { category: "dependency_download_failed", hints: [/offline mode/.test(output) ? "A dependency is not in the cache; build once without --offline." : "A dependency could not be downloaded. Check the network (and any proxy), then build again."], excerpt: [...summary, ...pick(/Could not (resolve|GET|download)/, 5)] };
  const compile = pick(/^(e: |.*\.(kt|java|dart):\d+.*(error|Error))|: error: |^lib\/.*\.dart:\d+:\d+: Error/);
  if (compile.length || /Compilation (error|failed)|compileDebug(Kotlin|JavaWithJavac).*FAILED|Compilation failed/i.test(output))
    return { category: "compile_error", hints: ["The app's own code does not compile. Fix the errors below and build again."], excerpt: compile.length ? compile : summary };
  return { category: "build_failed", hints: ["Open the build log for the full output."], excerpt: summary.length ? summary : lines.filter((l) => l.trim()).slice(-8) };
}

async function findFlutter(root: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const bin = process.platform === "win32" ? "flutter.bat" : "flutter";
  const fromProps = parseLocalProperties(await readFile(join(root, "android", "local.properties"), "utf8").catch(() => ""))["flutter.sdk"];
  const dirs = [fromProps && join(fromProps, "bin"), env.FLUTTER_ROOT && join(env.FLUTTER_ROOT, "bin"), ...(env.PATH ?? env.Path ?? "").split(delimiter), join(homedir(), "flutter", "bin"), join(homedir(), "development", "flutter", "bin"), join(homedir(), "fvm", "default", "bin")];
  for (const d of dirs) if (d && (await pathExists(join(d, bin)))) return join(d, bin);
  return undefined;
}

function chooseModule(p: DetectedProject, want?: string): AndroidModule {
  const mods = p.android?.modules ?? [];
  if (want) {
    const m = mods.find((x) => x.path === want || x.path === `:${want}`);
    if (!m) throw new BuildError("ambiguous_project", `No app module ${want} in ${p.root}`, [`Modules: ${mods.map((x) => x.path).join(", ")}`]);
    return m;
  }
  if (mods.length !== 1) throw new BuildError("ambiguous_project", `${p.name} has ${mods.length} app modules`, [`Pick one with --module: ${mods.map((x) => x.path).join(", ")}`]);
  return mods[0]!;
}

function chooseVariant(m: AndroidModule, want: string): string {
  const hit = m.variants.find((v) => v.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  // Flavored project asked for plain "debug": only unambiguous when there is one flavor.
  const byType = m.variants.filter((v) => v.toLowerCase().endsWith(want.toLowerCase()));
  if (byType.length === 1) return byType[0]!;
  if (byType.length > 1) throw new BuildError("ambiguous_project", `"${want}" matches several variants of ${m.path}`, [`Pick one with --variant: ${byType.join(", ")}`]);
  // Not in the list read from the build file: the script may create variants in ways pattern
  // matching cannot see. Let Gradle be the judge.
  return want;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Pick the one project to build, or say exactly why that is not possible. */
export async function selectProject(dir: string, platform?: Platform): Promise<DetectedProject> {
  const all = (await detectProjects(dir)).filter((p) => p.kind !== "apk" && p.kind !== "ipa");
  const fits = all.filter((p) => !platform || p.platforms.includes(platform));
  if (!fits.length) throw new BuildError("no_project", all.length ? `No ${platform} project in ${dir}` : `No app project found in ${dir}`, ["Run this inside a native Android, Flutter, React Native or SwiftPM iOS project, or pass its folder."]);
  if (fits.length > 1) throw new BuildError("ambiguous_project", `Found ${fits.length} projects in ${dir}`, [...fits.map((p) => `${p.kind}: ${p.root}`), "Run the build inside one of them, or pass its folder."]);
  return fits[0]!;
}

export async function build(o: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const log = o.log ?? (() => undefined);
  const result: BuildResult = { tool: "tethertrace", schemaVersion: "0.1", kind: "build", ok: false, durationMs: 0, artifacts: [] };
  const fail = (category: BuildErrorCategory, message: string, hints: string[] = [], excerpt: string[] = []) => {
    result.error = { category, message, hints, excerpt };
    result.durationMs = Date.now() - started;
    return result;
  };
  try {
    const project = await selectProject(resolve(o.dir ?? "."), o.platform);
    result.project = { kind: project.kind, root: project.root, name: project.name };
    result.adapter = project.build.adapter;
    const platform = o.platform ?? (project.platforms.includes("android") ? "android" : project.platforms[0]);
    if (platform === "ios") {
      if (project.kind === "ios-swiftpm") return fail("unsupported", "Building SwiftPM iOS apps goes through xtool, which tethertrace does not drive yet.", ["Build it with `xtool dev build`, then install the result."]);
      return fail("unsupported", `${project.buildSystem} can only be compiled on a Mac with Xcode.`, ["Build a signed .ipa on a Mac (or a Mac build worker) and install that."]);
    }
    if (project.build.supported !== "local" || !project.android) return fail("unsupported", `${project.name} cannot be built here: ${project.build.reason ?? "unsupported project"}`, project.notes);

    const module = chooseModule(project, o.module);
    const variant = chooseVariant(module, o.variant ?? "debug");
    result.module = module.path;
    result.variant = variant;

    log(`Project: ${project.kind} ${project.name}, module ${module.path}, variant ${variant}`);
    let tc: AndroidToolchain;
    try {
      tc = await resolveAndroidToolchain(project.android, { install: o.install, consent: o.consent, signal: o.signal, log });
    } catch (e) {
      if (e instanceof ToolchainError) return fail(e.code === "CONSENT" ? "consent_declined" : e.code === "CANCELLED" ? "cancelled" : e.code === "DISK_SPACE" ? "out_of_disk" : "toolchain_missing", e.message);
      throw e;
    }
    result.toolchain = { jdk: tc.jdk?.home, jdkVersion: tc.jdk?.version, sdk: tc.sdk?.root };
    const blocking = tc.missing.filter((m) => m.what === "jdk" || m.what === "sdk");
    if (blocking.length)
      return fail("toolchain_missing", blocking.map((m) => m.detail).join("; "), [
        `Run \`tethertrace build --yes\` to download what is missing (about ${blocking.reduce((n, m) => n + (m.downloadMb ?? 0), 0)} MB) into tethertrace's own folder, or install it yourself.`,
      ]);
    if (tc.missing.some((m) => m.what === "licenses")) return fail("license_not_accepted", tc.missing.find((m) => m.what === "licenses")!.detail, ["Run `tethertrace build --yes` to accept the Android SDK licenses."]);
    log(`JDK ${tc.jdk!.version} (${tc.jdk!.source}), Android SDK ${tc.sdk!.root} (${tc.sdk!.source})`);

    const logDir = o.logDir ?? join(project.root, "build", "tethertrace");
    await mkdir(logDir, { recursive: true });
    result.logFile = join(logDir, "build.log");
    const timeoutMs = o.timeoutMs ?? 30 * 60_000;
    const onLine = (l: string) => {
      if (/^> Task .*(FAILED)|^BUILD |^e: |error:|warning: \[|Running Gradle task|Built build|✓|Downloading /i.test(l)) log(`  ${l.trim()}`);
    };
    let cmd: string;
    let args: string[];
    let cwd: string;
    let outputs: string[];
    const env = { ...tc.env };

    if (project.kind === "flutter") {
      const flutter = await findFlutter(project.root, env);
      if (!flutter)
        return fail("toolchain_missing", "The Flutter SDK was not found (looked at android/local.properties, FLUTTER_ROOT, PATH and ~/flutter).", [
          "Install Flutter from https://docs.flutter.dev/get-started/install and make sure `flutter` is on PATH. tethertrace does not download Flutter itself yet.",
        ]);
      result.toolchain.flutter = flutter;
      const mode = /release$/i.test(variant) ? "--release" : /profile$/i.test(variant) ? "--profile" : "--debug";
      const flavor = module.flavors.find((f) => variant.toLowerCase().startsWith(f.toLowerCase()));
      cmd = flutter;
      args = ["build", "apk", mode, ...(flavor ? ["--flavor", flavor] : []), ...(o.offline ? ["--offline"] : [])];
      cwd = project.root;
      // Flutter copies the Gradle output here; listing both folders would show every APK twice.
      outputs = [join(project.root, "build", "app", "outputs", "flutter-apk")];
    } else {
      if (project.kind === "react-native" && !(await pathExists(join(project.root, "node_modules"))))
        return fail("toolchain_missing", "node_modules is missing, so the React Native Gradle plugin cannot be loaded.", ["Install the project's dependencies first (npm install, yarn or pnpm install), then build again. tethertrace does not run package installs for you."]);
      const root = project.android.gradleRoot;
      const wrapper = process.platform === "win32" ? join(root, "gradlew.bat") : join(root, "gradlew");
      if (!(await pathExists(wrapper))) return fail("unsupported", `No Gradle wrapper at ${wrapper}`, ["Add one with `gradle wrapper` so the project pins its Gradle version."]);
      const task = `${module.path === ":" ? "" : module.path}:assemble${cap(variant)}`;
      const gradleArgs = [task, "--console=plain", ...(o.offline ? ["--offline"] : [])];
      // `sh gradlew` works even when the executable bit was lost (zip downloads, Windows checkouts).
      [cmd, args] = process.platform === "win32" ? [wrapper, gradleArgs] : ["sh", [wrapper, ...gradleArgs]];
      cwd = root;
      outputs = [join(module.dir, "build", "outputs", "apk")];
    }
    result.command = `${cmd} ${args.join(" ")}`;
    log(`Running: ${result.command}`);
    const r = await run(cmd, args, { cwd, env, timeoutMs, signal: o.signal, onLine, logFile: result.logFile });
    if (r.cancelled) return fail("cancelled", "The build was cancelled.");
    if (r.timedOut) return fail("timeout", `The build did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`, ["Raise --timeout, or check the log for a step that hangs."]);
    if (r.code !== 0) {
      const c = classifyBuildFailure(r.output);
      return fail(c.category, `The build failed (exit ${r.code}).`, c.hints, c.excerpt);
    }
    const apks = (await Promise.all(outputs.map((d) => findApks(d, started)))).flat();
    if (!apks.length) return fail("no_artifact", "The build finished but produced no APK.", [`Looked in ${outputs.join(", ")}`]);
    result.artifacts = await Promise.all(apks.map(describeArtifact));
    const unsigned = result.artifacts.filter((a) => !a.signature.v1 && !a.signature.v2plus);
    if (unsigned.length === result.artifacts.length) return fail("no_artifact", "The build produced only unsigned APKs, which cannot be installed.", ["Configure a signingConfig for this variant, or build the debug variant."]);
    result.ok = true;
    result.durationMs = Date.now() - started;
    return result;
  } catch (e) {
    if (e instanceof BuildError) return fail(e.category, e.message, e.hints);
    throw e;
  }
}

/** The artifact to install when a build produced several: a universal APK if there is one, else the phone's ABI. */
export function pickArtifact(artifacts: BuildArtifact[], abi?: string): BuildArtifact | undefined {
  const signed = artifacts.filter((a) => a.signature.v1 || a.signature.v2plus);
  const name = (a: BuildArtifact) => a.path.toLowerCase().replace(/^.*[\/]/, "");
  const abiOf = (a: BuildArtifact) => /(arm64-v8a|armeabi-v7a|x86_64|x86)/.exec(name(a))?.[1];
  return signed.find((a) => /universal/.test(name(a))) ?? signed.find((a) => !abiOf(a)) ?? (abi ? signed.find((a) => abiOf(a) === abi.toLowerCase()) : undefined) ?? signed[0];
}
