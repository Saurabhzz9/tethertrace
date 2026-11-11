import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

/**
 * Finds the apps in a folder and says how each one is built. Read-only: it never runs a build
 * tool and never changes the project.
 *
 * Each framework is one {@link ProjectAdapter}. Adapters are versioned so results stay comparable
 * when detection rules change.
 */

export const ADAPTER_API_VERSION = 1;

export type Platform = "android" | "ios";
export type ProjectKind = "android-native" | "flutter" | "react-native" | "ios-swiftpm" | "ios-xcode" | "apk" | "ipa";

export interface DetectedProject {
  kind: ProjectKind;
  platforms: Platform[];
  /** Folder that identifies the project (where its manifest lives). */
  root: string;
  name: string;
  /** How it gets built, in one phrase. */
  buildSystem: string;
  /** Can tethertrace build it on this kind of machine, and with what. */
  build: { supported: "local" | "remote-mac" | "none"; adapter?: string; reason?: string };
  android?: AndroidProjectInfo;
  ios?: { xtoolConfig: boolean; packageSwift: boolean; xcodeProjects: string[] };
  /** Prebuilt artifact (for kind apk/ipa). */
  artifact?: string;
  notes: string[];
}

export interface AndroidModule {
  /** Gradle path, e.g. ":app". */
  path: string;
  dir: string;
  applicationId?: string;
  namespace?: string;
  compileSdk?: number;
  minSdk?: number;
  targetSdk?: number;
  buildToolsVersion?: string;
  language: "kotlin" | "java" | "unknown";
  buildTypes: string[];
  flavors: string[];
  /** Variant names Gradle will accept for assemble<Variant>. */
  variants: string[];
}

export interface AndroidProjectInfo {
  /** Folder with settings.gradle(.kts) and the Gradle wrapper. */
  gradleRoot: string;
  hasWrapper: boolean;
  gradleVersion?: string;
  agpVersion?: string;
  kotlinVersion?: string;
  /** Java version the build needs to run on (from AGP/Gradle), when it can be derived. */
  requiredJdk?: number;
  /** Highest Java version this Gradle can run on. */
  maxJdk?: number;
  modules: AndroidModule[];
}

export interface ProjectAdapter {
  readonly id: ProjectKind;
  readonly apiVersion: number;
  /** Return a project if `dir` is the root of one this adapter understands. */
  detect(dir: string, files: string[]): Promise<DetectedProject | undefined>;
}

const exists = async (p: string) => !!(await stat(p).catch(() => undefined));
const read = async (p: string) => readFile(p, "utf8").catch(() => "");
const firstExisting = async (dir: string, names: string[]) => {
  for (const n of names) if (await exists(join(dir, n))) return join(dir, n);
  return undefined;
};

// ---------------------------------------------------------------- Gradle parsing (best effort)

/** Strip comments so commented-out settings are not read as real ones. */
export function stripGradleComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

const num = (re: RegExp, s: string) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : undefined;
};
const str = (re: RegExp, s: string) => re.exec(s)?.[1];

/** Body of `name { ... }` with balanced braces, or "" when absent. */
export function gradleBlock(src: string, name: string): string {
  const m = new RegExp(`(^|[\\s;])${name}\\s*\\{`).exec(src);
  if (!m) return "";
  let depth = 0;
  const start = m.index + m[0].length;
  for (let i = start - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i);
  }
  return "";
}

/** Names declared directly inside a Gradle container block: `debug { }`, `create("free") { }`, `getByName("release") { }`. */
export function gradleBlockNames(body: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let token = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "{") {
      if (depth === 0) {
        const head = token.trim();
        const named = /(?:create|register|getByName|named|maybeCreate)\s*\(\s*["']([\w-]+)["']/.exec(head) ?? /^([A-Za-z_][\w-]*)$/.exec(head.split(/\s+/).pop() ?? "");
        if (named && !["if", "else", "all", "configureEach", "forEach", "each"].includes(named[1]!)) names.add(named[1]!);
      }
      depth++;
      token = "";
    } else if (c === "}") {
      depth--;
      token = "";
    } else if (depth === 0) {
      token = c === "\n" || c === ";" ? "" : token + c;
    }
  }
  return [...names];
}

export function parseGradleWrapper(props: string) {
  return str(/distributionUrl=.*?gradle-([\d.]+(?:-rc-\d+)?)-(?:bin|all)\.zip/, props);
}

/** Java versions a Gradle release can run on (upper bound), from Gradle's compatibility matrix. */
export function maxJdkForGradle(gradle: string | undefined): number | undefined {
  if (!gradle) return undefined;
  const [maj = 0, min = 0] = gradle.split(".").map(Number);
  const v = maj * 100 + min;
  if (v >= 814) return 24;
  if (v >= 810) return 23;
  if (v >= 808) return 22;
  if (v >= 805) return 21;
  if (v >= 803) return 20;
  if (v >= 706) return 19;
  if (v >= 705) return 18;
  if (v >= 703) return 17;
  if (v >= 700) return 16;
  return 15;
}

/** Minimum Java the Android Gradle Plugin itself needs. */
export function minJdkForAgp(agp: string | undefined): number | undefined {
  if (!agp) return undefined;
  const maj = Number(agp.split(".")[0]);
  if (maj >= 8) return 17;
  if (maj === 7) return 11;
  return 8;
}

async function findVersion(gradleRoot: string, files: string[], pluginId: string, catalogHint: RegExp): Promise<string | undefined> {
  const id = pluginId.replace(/\./g, "\\.");
  for (const f of files) {
    const s = stripGradleComments(await read(f));
    const direct = str(new RegExp(`id\\s*\\(?\\s*["']${id}["']\\s*\\)?\\s*version\\s*\\(?\\s*["']([\\w.+-]+)["']`), s);
    if (direct) return direct;
  }
  const catalog = await read(join(gradleRoot, "gradle", "libs.versions.toml"));
  if (catalog) {
    const plug = new RegExp(`id\\s*=\\s*["']${id}["'][^\\n}]*version(?:\\.ref)?\\s*=\\s*["']([\\w.+-]+)["']`).exec(catalog)?.[1];
    if (plug) return /^\d/.test(plug) ? plug : str(new RegExp(`^\\s*${plug}\\s*=\\s*["']([\\w.+-]+)["']`, "m"), catalog);
    const hinted = catalogHint.exec(catalog)?.[1];
    if (hinted) return hinted;
  }
  return undefined;
}

async function gradleModules(gradleRoot: string, settings: string): Promise<{ path: string; dir: string }[]> {
  const s = stripGradleComments(settings);
  const paths = new Set<string>();
  for (const m of s.matchAll(/include\s*\(?([^)\n]+)\)?/g)) for (const q of m[1]!.matchAll(/["'](:[\w:.-]+)["']/g)) paths.add(q[1]!);
  const custom = new Map<string, string>();
  for (const m of s.matchAll(/project\s*\(\s*["'](:[\w:.-]+)["']\s*\)\.projectDir\s*=\s*(?:new\s+)?[Ff]ile\s*\(\s*(?:\w+\s*,\s*)?["']([^"']+)["']/g)) custom.set(m[1]!, m[2]!);
  const out = [...paths].map((p) => ({ path: p, dir: resolve(gradleRoot, custom.get(p) ?? p.replace(/^:/, "").replace(/:/g, "/")) }));
  // A single-module project can apply the plugin in the root build file.
  out.push({ path: ":", dir: gradleRoot });
  return out;
}

/**
 * An SDK level written as a number, or as a name defined elsewhere: `rootProject.ext.compileSdkVersion`,
 * `project.compileSdk`, a bare variable. Names are looked up in `shared` (the root build file and
 * gradle.properties), which is how React Native and many older projects keep their versions.
 */
export function sdkLevel(key: string, android: string, shared: string): number | undefined {
  const direct = num(new RegExp(`${key}(?:Version)?\\s*=?\\s*\\(?\\s*(\\d+)`), android);
  if (direct !== undefined) return direct;
  const ref = str(new RegExp(`${key}(?:Version)?\\s*=?\\s*\\(?\\s*(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`), android);
  if (!ref) return undefined;
  return num(new RegExp(`(?:^|[\\s.{;])${ref}\\s*=\\s*["']?(\\d+)`, "m"), shared);
}

async function readAndroidModule(path: string, dir: string, shared = ""): Promise<AndroidModule | undefined> {
  const file = await firstExisting(dir, ["build.gradle.kts", "build.gradle"]);
  if (!file) return undefined;
  const src = stripGradleComments(await read(file));
  if (!/com\.android\.application|libs\.plugins\.android\.application|alias\s*\(\s*libs\.plugins\.[\w.]*application/.test(src)) return undefined;
  const android = gradleBlock(src, "android");
  const buildTypes = new Set(["debug", "release", ...gradleBlockNames(gradleBlock(android, "buildTypes"))]);
  const flavors = gradleBlockNames(gradleBlock(android, "productFlavors"));
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  const variants = flavors.length ? flavors.flatMap((f) => [...buildTypes].map((b) => f + cap(b))) : [...buildTypes];
  const hasKotlin = /kotlin/.test(src) || (await exists(join(dir, "src", "main", "kotlin")));
  const hasJava = await exists(join(dir, "src", "main", "java"));
  return {
    path,
    dir,
    applicationId: str(/applicationId\s*=?\s*["']([\w.]+)["']/, android),
    namespace: str(/namespace\s*=?\s*["']([\w.]+)["']/, android),
    compileSdk: sdkLevel("compileSdk", android, shared),
    minSdk: sdkLevel("minSdk", android, shared),
    targetSdk: sdkLevel("targetSdk", android, shared),
    buildToolsVersion: str(/buildToolsVersion\s*=?\s*\(?\s*["']([\d.]+)["']/, android),
    language: hasKotlin ? "kotlin" : hasJava ? "java" : "unknown",
    buildTypes: [...buildTypes],
    flavors,
    variants,
  };
}

/** Read everything the builder needs from a Gradle Android project. `gradleRoot` holds settings.gradle(.kts). */
export async function inspectGradleAndroid(gradleRoot: string): Promise<AndroidProjectInfo | undefined> {
  const settingsFile = await firstExisting(gradleRoot, ["settings.gradle.kts", "settings.gradle"]);
  const rootBuild = await firstExisting(gradleRoot, ["build.gradle.kts", "build.gradle"]);
  if (!settingsFile && !rootBuild) return undefined;
  const settings = settingsFile ? await read(settingsFile) : "";
  const candidates = await gradleModules(gradleRoot, settings);
  const modules: AndroidModule[] = [];
  const shared = `${rootBuild ? stripGradleComments(await read(rootBuild)) : ""}\n${await read(join(gradleRoot, "gradle.properties"))}`;
  for (const c of candidates) {
    const m = await readAndroidModule(c.path, c.dir, shared);
    if (m && !modules.some((x) => x.dir === m.dir)) modules.push(m);
  }
  if (!modules.length) return undefined;
  const versionFiles = [settingsFile, rootBuild].filter((f): f is string => !!f);
  const gradleVersion = parseGradleWrapper(await read(join(gradleRoot, "gradle", "wrapper", "gradle-wrapper.properties")));
  let agpVersion = await findVersion(gradleRoot, versionFiles, "com.android.application", /^\s*(?:agp|androidGradlePlugin|android-gradle-plugin)\s*=\s*["']([\w.+-]+)["']/m);
  if (!agpVersion && rootBuild) agpVersion = str(/com\.android\.tools\.build:gradle:([\w.+-]+)/, stripGradleComments(await read(rootBuild)));
  const kotlinVersion = await findVersion(gradleRoot, versionFiles, "org.jetbrains.kotlin.android", /^\s*kotlin\s*=\s*["']([\w.+-]+)["']/m);
  return {
    gradleRoot,
    hasWrapper: (await exists(join(gradleRoot, "gradlew"))) || (await exists(join(gradleRoot, "gradlew.bat"))),
    gradleVersion,
    agpVersion,
    kotlinVersion,
    requiredJdk: minJdkForAgp(agpVersion),
    maxJdk: maxJdkForGradle(gradleVersion),
    modules,
  };
}

// ---------------------------------------------------------------- adapters

const nativeAndroid: ProjectAdapter = {
  id: "android-native",
  apiVersion: ADAPTER_API_VERSION,
  async detect(dir, files) {
    if (!files.some((f) => /^settings\.gradle(\.kts)?$/.test(f)) && !files.some((f) => /^build\.gradle(\.kts)?$/.test(f))) return undefined;
    // Flutter and React Native keep their Gradle project in android/; those adapters own it.
    if (basename(dir) === "android" && ((await exists(join(dir, "..", "pubspec.yaml"))) || (await exists(join(dir, "..", "package.json"))))) return undefined;
    const android = await inspectGradleAndroid(dir);
    if (!android) return undefined;
    const notes: string[] = [];
    if (!android.hasWrapper) notes.push("No Gradle wrapper (gradlew) in the project. Add one with `gradle wrapper`, or tethertrace cannot know which Gradle to use.");
    if (android.modules.length > 1) notes.push(`Several app modules: ${android.modules.map((m) => m.path).join(", ")}. Pick one with --module.`);
    return {
      kind: "android-native",
      platforms: ["android"],
      root: dir,
      name: basename(dir),
      buildSystem: `Gradle${android.gradleVersion ? ` ${android.gradleVersion}` : ""}${android.agpVersion ? `, Android Gradle Plugin ${android.agpVersion}` : ""}`,
      build: android.hasWrapper ? { supported: "local", adapter: "gradle" } : { supported: "none", reason: "no Gradle wrapper" },
      android,
      notes,
    };
  },
};

const flutter: ProjectAdapter = {
  id: "flutter",
  apiVersion: ADAPTER_API_VERSION,
  async detect(dir, files) {
    if (!files.includes("pubspec.yaml")) return undefined;
    const pubspec = await read(join(dir, "pubspec.yaml"));
    if (!/^\s*flutter\s*:\s*$/m.test(pubspec) || !/sdk\s*:\s*flutter/.test(pubspec)) return undefined;
    const platforms: Platform[] = [];
    const android = (await exists(join(dir, "android"))) ? await inspectGradleAndroid(join(dir, "android")) : undefined;
    if (android) platforms.push("android");
    const hasIos = await exists(join(dir, "ios"));
    if (hasIos) platforms.push("ios");
    const notes: string[] = [];
    if (!android) notes.push("No android/ folder with an app module; run `flutter create --platforms android .` to add one.");
    if (hasIos) notes.push("The iOS side of a Flutter app needs Xcode on a Mac; tethertrace can only build its Android side locally.");
    return {
      kind: "flutter",
      platforms,
      root: dir,
      name: str(/^name\s*:\s*([\w-]+)/m, pubspec) ?? basename(dir),
      buildSystem: "Flutter (flutter build apk), which drives Gradle",
      build: android ? { supported: "local", adapter: "flutter" } : { supported: "none", reason: "no Android module" },
      android,
      notes,
    };
  },
};

const reactNative: ProjectAdapter = {
  id: "react-native",
  apiVersion: ADAPTER_API_VERSION,
  async detect(dir, files) {
    if (!files.includes("package.json")) return undefined;
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(await read(join(dir, "package.json")));
    } catch {
      return undefined;
    }
    const rn = pkg.dependencies?.["react-native"];
    if (!rn) return undefined;
    const expo = pkg.dependencies?.expo;
    const android = (await exists(join(dir, "android"))) ? await inspectGradleAndroid(join(dir, "android")) : undefined;
    const platforms: Platform[] = [];
    if (android) platforms.push("android");
    if (await exists(join(dir, "ios"))) platforms.push("ios");
    const notes: string[] = [`React Native ${rn}${expo ? `, Expo ${expo}` : ""}`];
    if (!android) notes.push(expo ? "No android/ folder. This is a managed Expo project; run `npx expo prebuild --platform android` to generate it (this changes the project, so tethertrace will not do it for you)." : "No android/ folder with an app module.");
    if (!(await exists(join(dir, "node_modules")))) notes.push("node_modules is missing; dependencies must be installed before a build.");
    return {
      kind: "react-native",
      platforms,
      root: dir,
      name: pkg.name ?? basename(dir),
      buildSystem: "React Native: Node dependencies, then Gradle in android/",
      build: android ? { supported: "local", adapter: "react-native" } : { supported: "none", reason: expo ? "managed Expo project without android/" : "no Android module" },
      android,
      notes,
    };
  },
};

const ios: ProjectAdapter = {
  id: "ios-swiftpm",
  apiVersion: ADAPTER_API_VERSION,
  async detect(dir, files) {
    const xcode = files.filter((f) => /\.(xcodeproj|xcworkspace)$/.test(f));
    const packageSwift = files.includes("Package.swift");
    const xtoolConfig = files.includes("xtool.yml");
    // Flutter and React Native own their ios/ folders.
    if (basename(dir) === "ios" && ((await exists(join(dir, "..", "pubspec.yaml"))) || (await exists(join(dir, "..", "package.json"))))) return undefined;
    if (packageSwift && xtoolConfig) {
      return {
        kind: "ios-swiftpm",
        platforms: ["ios"],
        root: dir,
        name: basename(dir),
        buildSystem: "SwiftPM app built with xtool (needs a Swift toolchain and an iOS SDK taken from Xcode.xip)",
        build: { supported: "local", adapter: "xtool", reason: "Linux, macOS, or Windows through WSL" },
        ios: { xtoolConfig, packageSwift, xcodeProjects: xcode },
        notes: [],
      };
    }
    if (xcode.length) {
      return {
        kind: "ios-xcode",
        platforms: ["ios"],
        root: dir,
        name: basename(xcode[0]!).replace(/\.\w+$/, ""),
        buildSystem: "Xcode project",
        build: { supported: "remote-mac", reason: "Xcode projects can only be compiled by Xcode on macOS" },
        ios: { xtoolConfig, packageSwift, xcodeProjects: xcode },
        notes: ["Building this needs a Mac with Xcode. A signed .ipa built elsewhere can still be installed."],
      };
    }
    return undefined;
  },
};

export const ADAPTERS: readonly ProjectAdapter[] = [flutter, reactNative, nativeAndroid, ios];

const SKIP = new Set(["node_modules", "build", "dist", ".git", ".gradle", ".idea", ".dart_tool", "Pods", "DerivedData", ".build", "vendor", "__pycache__", ".next", "out", "target", "reports"]);

export interface DetectOptions {
  /** How many folder levels below `dir` to look into. Default 3 (enough for monorepos like apps/mobile/android). */
  depth?: number;
  /** Also list prebuilt .apk / .ipa files at the top level. Default true. */
  artifacts?: boolean;
}

/** Find every app project in and below `dir`. A folder claimed by one adapter is not searched further. */
export async function detectProjects(dir: string, opts: DetectOptions = {}): Promise<DetectedProject[]> {
  const root = resolve(dir);
  const found: DetectedProject[] = [];
  const walk = async (d: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name);
    let claimed = false;
    for (const a of ADAPTERS) {
      const p = await a.detect(d, names);
      if (p) {
        found.push(p);
        claimed = true;
        break;
      }
    }
    if ((opts.artifacts ?? true) && d === root) {
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (/\.apk$/i.test(e.name)) found.push({ kind: "apk", platforms: ["android"], root: d, name: e.name, buildSystem: "prebuilt APK", build: { supported: "none", reason: "already built" }, artifact: join(d, e.name), notes: [] });
        if (/\.ipa$/i.test(e.name)) found.push({ kind: "ipa", platforms: ["ios"], root: d, name: e.name, buildSystem: "prebuilt IPA", build: { supported: "none", reason: "already built" }, artifact: join(d, e.name), notes: ["An .ipa must already be signed for the target iPhone."] });
      }
    }
    if (claimed || depth <= 0) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) await walk(join(d, e.name), depth - 1);
  };
  await walk(root, opts.depth ?? 3);
  return found;
}

/** One line per project, for the CLI. */
export function describeProject(p: DetectedProject, from = process.cwd()): string {
  const where = relative(from, p.root) || ".";
  const lines = [`${p.kind}  ${p.name}  (${where})`, `  build: ${p.buildSystem}`];
  lines.push(`  can build here: ${p.build.supported === "local" ? `yes, with ${p.build.adapter}` : p.build.supported === "remote-mac" ? "no, needs a Mac build worker" : `no (${p.build.reason})`}`);
  if (p.android) {
    if (p.android.requiredJdk) lines.push(`  Java: ${p.android.requiredJdk}${p.android.maxJdk ? ` to ${p.android.maxJdk}` : " or newer"}`);
    for (const m of p.android.modules)
      lines.push(`  module ${m.path}  ${m.applicationId ?? m.namespace ?? "?"}  compileSdk ${m.compileSdk ?? "?"}  ${m.language}  variants: ${m.variants.join(", ")}`);
  }
  for (const n of p.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

