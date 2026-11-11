import { chmod, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { homeDir } from "../adb/keys.js";
import type { AndroidProjectInfo } from "../project/detect.js";
import { download, extractTarGz, extractZip, pathExists, requireSpace, run, ToolchainError } from "./fetch.js";

/**
 * Finds, or downloads, the parts an Android build genuinely needs: a JDK and an Android SDK with
 * accepted licenses. It reuses what is already on the machine first. Downloads come only from the
 * official sources (Eclipse Adoptium for the JDK, dl.google.com for the SDK command-line tools),
 * are checksum-verified, and go into tethertrace's own folder so nothing global is changed.
 *
 * It never downloads Android Studio, emulator images, adb or SDK platforms a project does not use.
 */

export const toolchainsDir = () => join(homeDir(), "toolchains");

export interface Jdk {
  home: string;
  version: number;
  source: string;
}

export interface AndroidSdk {
  root: string;
  source: string;
  licensesAccepted: boolean;
  hasCmdlineTools: boolean;
  platforms: number[];
  buildTools: string[];
}

export interface AndroidToolchain {
  jdk?: Jdk;
  sdk?: AndroidSdk;
  /** What is missing, in the words to show a user. Empty when a build can start. */
  missing: { what: "jdk" | "sdk" | "licenses" | "platform"; detail: string; downloadMb?: number }[];
  /** Environment for the build process. */
  env: NodeJS.ProcessEnv;
}

/** Ask before something large or licensed is fetched. Return false to stop. */
export type Consent = (q: { what: string; detail: string; downloadMb?: number; license?: string }) => Promise<boolean>;

export interface ResolveOptions {
  /** Allow downloading what is missing (after asking `consent`). Default false: only report. */
  install?: boolean;
  consent?: Consent;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** For tests. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Extra folders to look for JDKs in, for tests. */
  extraJdkDirs?: string[];
  /** Skip the machine-wide search and use only env + extraJdkDirs + managed (tests). */
  hermetic?: boolean;
}

/**
 * TETHERTRACE_MANAGED_ONLY=1 ignores every JDK and SDK already on the computer and uses only what
 * tethertrace downloaded. For reproducible builds, and for testing the from-nothing path on a
 * machine that already has tools.
 */
const managedOnly = (env: NodeJS.ProcessEnv) => env.TETHERTRACE_MANAGED_ONLY === "1";

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

// ---------------------------------------------------------------- JDK

export function parseJavaVersion(release: string): number | undefined {
  const m = /JAVA_VERSION="?(\d+)(?:\.(\d+))?/.exec(release);
  if (!m) return undefined;
  return Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
}

async function jdkAt(home: string, source: string): Promise<Jdk | undefined> {
  // macOS bundles keep the real home one level down.
  for (const h of [home, join(home, "Contents", "Home")]) {
    if (!(await pathExists(join(h, "bin", exe("javac"))))) continue;
    const version = parseJavaVersion(await readFile(join(h, "release"), "utf8").catch(() => ""));
    if (version) return { home: h, version, source };
  }
  return undefined;
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function findJdks(o: ResolveOptions = {}): Promise<Jdk[]> {
  const env = o.env ?? process.env;
  const out: Jdk[] = [];
  const add = async (home: string | undefined, source: string) => {
    if (!home) return;
    const j = await jdkAt(home, source);
    if (j && !out.some((x) => x.home === j.home)) out.push(j);
  };
  for (const d of await childDirs(join(toolchainsDir(), "jdk"))) await add(d, "tethertrace (managed)");
  if (managedOnly(env)) return out;
  await add(env.JAVA_HOME, "JAVA_HOME");
  for (const dir of o.extraJdkDirs ?? []) for (const d of await childDirs(dir)) await add(d, dir);
  if (o.hermetic) return out;
  const home = homedir();
  const pf = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter((x): x is string => !!x);
  const parents = [
    join(home, ".jdks"), // IntelliJ / Android Studio downloads
    join(home, ".sdkman", "candidates", "java"),
    join(home, ".gradle", "jdks"), // Gradle toolchain downloads
    "/usr/lib/jvm",
    "/Library/Java/JavaVirtualMachines",
    join(home, "Library", "Java", "JavaVirtualMachines"),
    ...pf.flatMap((p) => ["Java", "Eclipse Adoptium", "Amazon Corretto", "Microsoft", "Zulu", "BellSoft"].map((v) => join(p, v))),
  ];
  for (const p of parents) for (const d of await childDirs(p)) await add(d, p);
  // The JDK bundled with Android Studio, if it happens to be installed.
  for (const s of [...pf.map((p) => join(p, "Android", "Android Studio", "jbr")), "/Applications/Android Studio.app/Contents/jbr", "/opt/android-studio/jbr", join(home, "android-studio", "jbr")]) await add(s, "Android Studio");
  // Whatever `java` is on PATH.
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) if (await pathExists(join(dir, exe("javac")))) await add(dirname(dir), "PATH");
  return out;
}

const LTS = new Set([8, 11, 17, 21, 25]);

/**
 * Choose a JDK the build can run on. Long-term-support releases come first (Gradle and the Android
 * Gradle Plugin are tested against those), then the lowest version that fits.
 */
export function pickJdk(jdks: Jdk[], min = 17, max?: number): Jdk | undefined {
  const rank = (j: Jdk) => (LTS.has(j.version) ? 0 : 1) * 1000 + j.version + (j.source === "JAVA_HOME" ? -0.5 : 0);
  return jdks.filter((j) => j.version >= min && (max === undefined || j.version <= max)).sort((a, b) => rank(a) - rank(b))[0];
}

const ADOPTIUM_OS: Record<string, string> = { win32: "windows", linux: "linux", darwin: "mac" };
const ADOPTIUM_ARCH: Record<string, string> = { x64: "x64", arm64: "aarch64" };

/** Download a Temurin JDK from Eclipse Adoptium into the managed folder. */
export async function installJdk(feature: number, o: ResolveOptions): Promise<Jdk> {
  const os = ADOPTIUM_OS[process.platform];
  const arch = ADOPTIUM_ARCH[process.arch];
  if (!os || !arch) throw new ToolchainError("UNSUPPORTED", `No managed JDK for ${process.platform}/${process.arch}; install JDK ${feature} yourself and set JAVA_HOME`);
  const f = o.fetchImpl ?? fetch;
  const api = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`;
  const res = await f(api, { signal: o.signal });
  if (!res.ok) throw new ToolchainError("DOWNLOAD", `Adoptium API answered ${res.status} for JDK ${feature}`);
  const assets = (await res.json()) as { binary: { package: { link: string; checksum: string; size: number; name: string } }; release_name: string }[];
  const pkg = assets[0]?.binary.package;
  if (!pkg?.link || !/^[a-f0-9]{64}$/i.test(pkg.checksum ?? "")) throw new ToolchainError("DOWNLOAD", `Adoptium has no verifiable JDK ${feature} for ${os}/${arch}`);
  if (!/^https:\/\/github\.com\/adoptium\//.test(pkg.link)) throw new ToolchainError("DOWNLOAD", `Unexpected JDK download host: ${pkg.link}`);
  const mb = Math.round(pkg.size / 1e6);
  if (!(await (o.consent?.({ what: `JDK ${feature} (Eclipse Temurin)`, detail: `${assets[0]!.release_name} from adoptium.net`, downloadMb: mb, license: "GPLv2 with Classpath Exception" }) ?? false)))
    throw new ToolchainError("CONSENT", `JDK ${feature} is needed and was not approved for download (${mb} MB). Re-run with --yes, or install a JDK ${feature} and set JAVA_HOME.`);
  const dir = join(toolchainsDir(), "jdk", `temurin-${feature}`);
  await requireSpace(toolchainsDir(), pkg.size * 3, `JDK ${feature}`);
  const archive = join(toolchainsDir(), "downloads", pkg.name);
  o.log?.(`Downloading ${pkg.name} (${mb} MB)…`);
  await download(pkg.link, archive, { checksum: { algorithm: "sha256", hex: pkg.checksum }, signal: o.signal, log: o.log, fetchImpl: o.fetchImpl });
  await rm(dir, { recursive: true, force: true });
  o.log?.("Unpacking…");
  if (pkg.name.endsWith(".zip")) await extractZip(archive, dir, 1);
  else await extractTarGz(archive, dir, 1, o.signal);
  await rm(archive, { force: true });
  const jdk = await jdkAt(dir, "tethertrace (managed)");
  if (!jdk) throw new ToolchainError("EXTRACT", `The downloaded JDK did not unpack into a usable JDK at ${dir}`);
  return jdk;
}

// ---------------------------------------------------------------- Android SDK

async function sdkAt(root: string, source: string): Promise<AndroidSdk | undefined> {
  if (!(await pathExists(root))) return undefined;
  const platforms = (await childDirs(join(root, "platforms"))).map((d) => Number(/android-(\d+)$/.exec(d)?.[1])).filter((n) => Number.isInteger(n));
  const buildTools = (await childDirs(join(root, "build-tools"))).map((d) => d.split(/[\\/]/).pop()!);
  const hasCmdlineTools = await pathExists(sdkmanagerPath(root));
  const licensesAccepted = await pathExists(join(root, "licenses", "android-sdk-license"));
  if (!platforms.length && !buildTools.length && !hasCmdlineTools && !licensesAccepted) return undefined;
  return { root, source, licensesAccepted, hasCmdlineTools, platforms: platforms.sort((a, b) => a - b), buildTools };
}

const sdkmanagerPath = (root: string) => join(root, "cmdline-tools", "latest", "bin", process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager");
export const managedSdkDir = () => join(toolchainsDir(), "android-sdk");

export function parseLocalProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/\\\\/g, "\\").replace(/\\:/g, ":").trim();
  }
  return out;
}

export async function findSdk(gradleRoot: string | undefined, o: ResolveOptions = {}): Promise<AndroidSdk | undefined> {
  const env = o.env ?? process.env;
  const home = homedir();
  if (managedOnly(env)) return sdkAt(managedSdkDir(), "tethertrace (managed)");
  const candidates: [string | undefined, string][] = [
    [gradleRoot ? parseLocalProperties(await readFile(join(gradleRoot, "local.properties"), "utf8").catch(() => ""))["sdk.dir"] : undefined, "local.properties"],
    [env.ANDROID_HOME, "ANDROID_HOME"],
    [env.ANDROID_SDK_ROOT, "ANDROID_SDK_ROOT"],
    [managedSdkDir(), "tethertrace (managed)"],
  ];
  if (!o.hermetic)
    candidates.push(
      [env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : undefined, "default location"],
      [join(home, "Android", "Sdk"), "default location"],
      [join(home, "Library", "Android", "sdk"), "default location"],
    );
  for (const [root, source] of candidates) {
    if (!root) continue;
    const sdk = await sdkAt(root, source);
    if (sdk) return sdk;
  }
  return undefined;
}

const SDK_REPO = "https://dl.google.com/android/repository/";
const SDK_HOST: Record<string, string> = { win32: "windows", linux: "linux", darwin: "macosx" };

/** Find the latest stable command-line tools archive for this OS in Google's repository index. */
export function parseCmdlineTools(xml: string, hostOs: string): { url: string; sha1: string; size: number } | undefined {
  const pkgs = [...xml.matchAll(/<remotePackage path="cmdline-tools;([\d.]+)">([\s\S]*?)<\/remotePackage>/g)]
    .filter((m) => !/<channelRef ref="channel-[1-9]"/.test(m[2]!)) // stable channel only
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const p of pkgs) {
    for (const a of p[2]!.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const body = a[1]!;
      if (/<host-os>(\w+)<\/host-os>/.exec(body)?.[1] !== hostOs) continue;
      const url = /<url>([^<]+)<\/url>/.exec(body)?.[1];
      const sha1 = /<checksum[^>]*>([a-f0-9]{40})<\/checksum>/i.exec(body)?.[1];
      const size = Number(/<size>(\d+)<\/size>/.exec(body)?.[1]);
      if (url && sha1 && /^[\w.-]+\.zip$/.test(url)) return { url, sha1, size };
    }
  }
  return undefined;
}

/** Download Google's SDK command-line tools into the managed SDK folder. */
export async function installCmdlineTools(o: ResolveOptions): Promise<AndroidSdk> {
  const host = SDK_HOST[process.platform];
  if (!host) throw new ToolchainError("UNSUPPORTED", `No Android SDK command-line tools for ${process.platform}`);
  const f = o.fetchImpl ?? fetch;
  const res = await f(`${SDK_REPO}repository2-3.xml`, { signal: o.signal });
  if (!res.ok) throw new ToolchainError("DOWNLOAD", `Google's SDK index answered ${res.status}`);
  const pkg = parseCmdlineTools(await res.text(), host);
  if (!pkg) throw new ToolchainError("DOWNLOAD", "Could not find the Android command-line tools in Google's SDK index");
  const mb = Math.round(pkg.size / 1e6);
  if (!(await (o.consent?.({ what: "Android SDK command-line tools", detail: `${pkg.url} from dl.google.com`, downloadMb: mb, license: "Android Software Development Kit License" }) ?? false)))
    throw new ToolchainError("CONSENT", `The Android SDK command-line tools are needed and were not approved for download (${mb} MB). Re-run with --yes, or point ANDROID_HOME at an existing SDK.`);
  const root = managedSdkDir();
  await requireSpace(toolchainsDir(), 3e9, "A minimal Android SDK");
  const archive = join(toolchainsDir(), "downloads", pkg.url);
  o.log?.(`Downloading ${pkg.url} (${mb} MB)…`);
  await download(SDK_REPO + pkg.url, archive, { checksum: { algorithm: "sha1", hex: pkg.sha1 }, signal: o.signal, log: o.log, fetchImpl: o.fetchImpl });
  const dest = join(root, "cmdline-tools", "latest");
  await rm(dest, { recursive: true, force: true });
  await extractZip(archive, dest, 1); // the archive has one top folder, "cmdline-tools"
  // Make sure the launch scripts can run, whatever permissions the archive recorded.
  if (process.platform !== "win32") for (const f of await readdir(join(dest, "bin")).catch(() => [])) await chmod(join(dest, "bin", f), 0o755);
  await rm(archive, { force: true });
  const sdk = await sdkAt(root, "tethertrace (managed)");
  if (!sdk?.hasCmdlineTools) throw new ToolchainError("EXTRACT", `The command-line tools did not unpack correctly into ${dest}`);
  return sdk;
}

/** Accept the SDK licenses (after consent) and install exactly the platform a project compiles against. */
export async function prepareSdk(sdk: AndroidSdk, jdk: Jdk, compileSdk: number | undefined, o: ResolveOptions): Promise<AndroidSdk> {
  const needLicense = !sdk.licensesAccepted;
  const needPlatform = compileSdk !== undefined && !sdk.platforms.includes(compileSdk);
  if (!needLicense && !needPlatform) return sdk;
  if (!sdk.hasCmdlineTools) throw new ToolchainError("NOT_FOUND", `The SDK at ${sdk.root} has no command-line tools, so tethertrace cannot add ${needLicense ? "licenses" : `platform ${compileSdk}`} to it. Install them with its SDK manager, or unset ANDROID_HOME to use a managed SDK.`);
  const env = { ...(o.env ?? process.env), JAVA_HOME: jdk.home, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root };
  if (needLicense) {
    if (!(await (o.consent?.({ what: "Android SDK licenses", detail: "Google's license terms for the Android SDK (https://developer.android.com/studio/terms). Accepting them is required to download SDK packages.", license: "Android Software Development Kit License" }) ?? false)))
      throw new ToolchainError("CONSENT", "The Android SDK licenses were not accepted, so SDK packages cannot be downloaded. Re-run with --yes to accept them.");
    const r = await run(sdkmanagerPath(sdk.root), ["--licenses", `--sdk_root=${sdk.root}`], { env, input: "y\n".repeat(40), timeoutMs: 5 * 60_000, signal: o.signal });
    if (r.code !== 0) throw new ToolchainError("DOWNLOAD", `sdkmanager --licenses failed: ${r.output.slice(-600)}`);
  }
  if (needPlatform) {
    o.log?.(`Installing Android platform ${compileSdk} (the one this project compiles against)…`);
    const r = await run(sdkmanagerPath(sdk.root), [`--sdk_root=${sdk.root}`, `platforms;android-${compileSdk}`], { env, input: "y\n".repeat(10), timeoutMs: 20 * 60_000, signal: o.signal, onLine: (l) => /\d+%/.test(l) || o.log?.(`  ${l}`) });
    if (r.cancelled) throw new ToolchainError("CANCELLED", "Cancelled");
    if (r.code !== 0) throw new ToolchainError("DOWNLOAD", `sdkmanager could not install platforms;android-${compileSdk}: ${r.output.slice(-600)}`);
  }
  return (await sdkAt(sdk.root, sdk.source))!;
}

// ---------------------------------------------------------------- resolve

/**
 * Work out what an Android project needs, find it on this machine, and (with `install`) fetch what
 * is missing. Build-tools are left to the Android Gradle Plugin, which downloads the exact version
 * it wants once the licenses are accepted.
 */
export async function resolveAndroidToolchain(project: AndroidProjectInfo, o: ResolveOptions = {}): Promise<AndroidToolchain> {
  const min = project.requiredJdk ?? 17;
  const max = project.maxJdk;
  const compileSdk = project.modules.map((m) => m.compileSdk).find((v) => v !== undefined);
  const missing: AndroidToolchain["missing"] = [];
  const jdks = await findJdks(o);
  let jdk = pickJdk(jdks, min, max);
  if (!jdk && o.install) jdk = await installJdk(min, o);
  if (!jdk) {
    const have = jdks.map((j) => j.version).sort((a, b) => a - b);
    missing.push({ what: "jdk", detail: `A JDK ${min}${max ? ` to ${max}` : " or newer"} is needed${have.length ? `; found only ${[...new Set(have)].join(", ")}` : "; none found"}`, downloadMb: 190 });
  }
  let sdk = await findSdk(project.gradleRoot, o);
  if (!sdk && o.install && jdk) sdk = await installCmdlineTools(o);
  if (!sdk) missing.push({ what: "sdk", detail: "No Android SDK found (looked at local.properties, ANDROID_HOME and the default locations)", downloadMb: 150 });
  if (sdk && jdk && o.install) sdk = await prepareSdk(sdk, jdk, compileSdk, o);
  if (sdk && !sdk.licensesAccepted) missing.push({ what: "licenses", detail: `The Android SDK licenses are not accepted in ${sdk.root}` });
  if (sdk && compileSdk !== undefined && !sdk.platforms.includes(compileSdk)) missing.push({ what: "platform", detail: `Android platform ${compileSdk} is not installed in ${sdk.root}`, downloadMb: 80 });
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  if (jdk) {
    env.JAVA_HOME = jdk.home;
    env.PATH = `${join(jdk.home, "bin")}${delimiter}${env.PATH ?? env.Path ?? ""}`;
  }
  if (sdk) {
    env.ANDROID_HOME = sdk.root;
    env.ANDROID_SDK_ROOT = sdk.root;
  }
  return { jdk, sdk, missing, env };
}

// ---------------------------------------------------------------- housekeeping

export interface ManagedItem {
  name: string;
  path: string;
  bytes: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const { stat } = await import("node:fs/promises");
    total += (await stat(join(e.parentPath, e.name)).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** What tethertrace itself downloaded. */
export async function listManaged(): Promise<ManagedItem[]> {
  const out: ManagedItem[] = [];
  for (const d of await childDirs(join(toolchainsDir(), "jdk"))) out.push({ name: `jdk/${d.split(/[\\/]/).pop()}`, path: d, bytes: await dirSize(d) });
  if (await pathExists(managedSdkDir())) out.push({ name: "android-sdk", path: managedSdkDir(), bytes: await dirSize(managedSdkDir()) });
  return out;
}

/** Remove managed toolchains. Only ever touches tethertrace's own folder. */
export async function cleanManaged(names?: string[]): Promise<ManagedItem[]> {
  const items = (await listManaged()).filter((i) => !names?.length || names.includes(i.name));
  for (const i of items) await rm(i.path, { recursive: true, force: true });
  await rm(join(toolchainsDir(), "downloads"), { recursive: true, force: true });
  return items;
}

