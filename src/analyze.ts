import { open, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Static analysis of an APK: what it is made of, and which of those parts could ever be carried
 * to another operating system. Nothing here runs the app. The compatibility report is a
 * classification with reasons, never a claim that something works.
 */

// ---------------------------------------------------------------- ZIP

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Every entry in a ZIP/APK, from its central directory. */
export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${path} is not an APK/ZIP file`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("ZIP64 archives are not supported");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
      const nameLen = cd.readUInt16LE(p + 28);
      out.push({ name: cd.toString("utf8", p + 46, p + 46 + nameLen), method: cd.readUInt16LE(p + 10), compressedSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) });
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Read one entry's bytes (optionally only the first `limit` bytes of a stored or deflated entry). */
export async function readZipEntryData(path: string, e: ZipEntry): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, e.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("Corrupt ZIP local header");
    const data = Buffer.alloc(e.compressedSize);
    await fh.read(data, 0, e.compressedSize, e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${e.method} in ${e.name}`);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- binary XML

export interface XmlElement {
  name: string;
  depth: number;
  attrs: Record<string, string | number | boolean>;
}

// Attribute names are sometimes stripped from the string pool; the resource id still identifies them.
const ATTR_BY_ID: Record<number, string> = {
  0x01010003: "name", 0x0101000f: "debuggable", 0x0101020c: "minSdkVersion", 0x01010270: "targetSdkVersion", 0x0101021b: "versionCode",
  0x0101021c: "versionName", 0x0101028e: "required", 0x01010281: "glEsVersion", 0x01010010: "exported", 0x010104ea: "extractNativeLibs",
  0x01010599: "foregroundServiceType", 0x01010006: "permission", 0x01010001: "label", 0x010104ec: "usesCleartextTraffic",
};

function stringPool(buf: Buffer, start: number): string[] {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const utf8 = (buf.readUInt32LE(start + 16) & 0x100) !== 0;
  const base = start + buf.readUInt32LE(start + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = base + buf.readUInt32LE(start + headerSize + i * 4);
    if (p >= buf.length) { out.push(""); continue; }
    if (utf8) {
      p += buf[p]! & 0x80 ? 2 : 1;
      let len = buf[p]!;
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p + 1]!; p += 2; } else p += 1;
      out.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
      out.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

/** Decode Android binary XML into a flat list of elements with their depth and attributes. */
export function parseBinaryXml(buf: Buffer): XmlElement[] {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new Error("Not Android binary XML");
  let strings: string[] = [];
  let resIds: number[] = [];
  const out: XmlElement[] = [];
  let depth = 0;
  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    if (type === 0x0001) strings = stringPool(buf, p);
    else if (type === 0x0180) {
      resIds = [];
      for (let q = p + buf.readUInt16LE(p + 2); q + 4 <= p + size; q += 4) resIds.push(buf.readUInt32LE(q));
    } else if (type === 0x0102) {
      const attrStart = buf.readUInt16LE(p + 24);
      const attrSize = buf.readUInt16LE(p + 26);
      const attrCount = buf.readUInt16LE(p + 28);
      const attrs: XmlElement["attrs"] = {};
      for (let i = 0; i < attrCount; i++) {
        const a = p + 16 + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const name = strings[nameIdx] || ATTR_BY_ID[resIds[nameIdx] ?? -1] || `attr_${nameIdx}`;
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15]!;
        const data = buf.readUInt32LE(a + 16);
        if (raw !== 0xffffffff) attrs[name] = strings[raw] ?? "";
        else if (dataType === 0x03) attrs[name] = strings[data] ?? "";
        else if (dataType === 0x12) attrs[name] = data !== 0;
        else if (dataType === 0x10 || dataType === 0x11) attrs[name] = data;
        else attrs[name] = `@0x${data.toString(16)}`;
      }
      out.push({ name: strings[buf.readUInt32LE(p + 20)] ?? "?", depth, attrs });
      depth++;
    } else if (type === 0x0103) depth = Math.max(0, depth - 1);
    p += size;
  }
  return out;
}

// ---------------------------------------------------------------- DEX

export interface DexSummary {
  version: string;
  classes: number;
  methods: number;
  /** Type descriptors referenced or defined, e.g. "Lcom/example/Main;". */
  types: string[];
}

function uleb(buf: Buffer, p: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[p++]!;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result >>> 0, p];
    shift += 7;
  }
}

/** Read a DEX file's header and its table of type descriptors (enough to see what it depends on). */
export function parseDex(buf: Buffer): DexSummary {
  if (buf.length < 0x70 || buf.toString("latin1", 0, 4) !== "dex\n") throw new Error("Not a DEX file");
  const stringIdsSize = buf.readUInt32LE(0x38);
  const stringIdsOff = buf.readUInt32LE(0x3c);
  const typeIdsSize = buf.readUInt32LE(0x40);
  const typeIdsOff = buf.readUInt32LE(0x44);
  const types: string[] = [];
  for (let i = 0; i < typeIdsSize; i++) {
    const s = buf.readUInt32LE(typeIdsOff + i * 4);
    if (s >= stringIdsSize) continue;
    const off = buf.readUInt32LE(stringIdsOff + s * 4);
    if (off >= buf.length) continue;
    const [, start] = uleb(buf, off);
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    types.push(buf.toString("latin1", start, end)); // descriptors are ASCII in practice
  }
  return { version: buf.toString("latin1", 4, 7), classes: buf.readUInt32LE(0x60), methods: buf.readUInt32LE(0x58), types };
}

// ---------------------------------------------------------------- analysis

export type AppFramework = "flutter" | "react-native" | "unity" | "unreal" | "godot" | "cordova" | "capacitor" | "xamarin-maui" | "kotlin-compose" | "native-android" | "unknown";

export interface ApkAnalysis {
  tool: "tethertrace";
  schemaVersion: "analysis.1";
  file: string;
  sizeBytes: number;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
  debuggable: boolean;
  framework: { kind: AppFramework; evidence: string[] };
  dex: { files: number; bytes: number; classes: number; methods: number };
  native: { abis: Record<string, string[]>; bytes: number };
  /** A self-contained web application inside the APK, if there is one. */
  webLayer?: { root: string; entry: string; files: number; bytes: number };
  assets: { files: number; bytes: number; wasmFiles: number };
  resources: { files: number; bytes: number };
  manifest: { permissions: string[]; features: string[]; activities: number; services: number; receivers: number; providers: number; glEsVersion?: string };
  /** Things the app needs that only exist on Android devices with Google's software. */
  dependencies: { id: string; label: string; evidence: string }[];
  loadsCodeAtRuntime: boolean;
  notes: string[];
}

const DEPENDENCY_PREFIXES: [string, string, string][] = [
  ["google-play-services", "Google Play Services", "Lcom/google/android/gms/"],
  ["firebase", "Firebase", "Lcom/google/firebase/"],
  ["play-billing", "Google Play Billing", "Lcom/android/billingclient/"],
  ["play-integrity", "Play Integrity / SafetyNet", "Lcom/google/android/play/core/integrity/"],
  ["safetynet", "Play Integrity / SafetyNet", "Lcom/google/android/gms/safetynet/"],
  ["play-core", "Play Core (in-app updates, feature delivery)", "Lcom/google/android/play/core/"],
  ["widevine-drm", "Android MediaDrm (DRM playback)", "Landroid/media/MediaDrm"],
  ["android-keystore", "Android Keystore (hardware-backed keys)", "Landroid/security/keystore/"],
];

const NATIVE_FRAMEWORKS: [RegExp, AppFramework][] = [
  [/^libflutter\.so$/, "flutter"],
  [/^lib(reactnativejni|hermes|jsc|reactnative)\.so$/, "react-native"],
  [/^lib(unity|il2cpp)\.so$/, "unity"],
  [/^lib(UE4|Unreal)\.so$/, "unreal"],
  [/^libgodot_android\.so$/, "godot"],
  [/^lib(monodroid|monosgen-2\.0|mono-native)\.so$/, "xamarin-maui"],
];

export async function analyzeApk(path: string): Promise<ApkAnalysis> {
  const entries = await listZipEntries(path);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get("AndroidManifest.xml");
  if (!manifestEntry) throw new Error(`${path} has no AndroidManifest.xml, so it is not an APK`);
  const xml = parseBinaryXml(await readZipEntryData(path, manifestEntry));
  const root = xml.find((e) => e.name === "manifest");
  const sdk = xml.find((e) => e.name === "uses-sdk");
  const app = xml.find((e) => e.name === "application");
  const named = (el: string) => xml.filter((e) => e.name === el).map((e) => String(e.attrs.name ?? "")).filter(Boolean);
  const count = (el: string) => xml.filter((e) => e.name === el).length;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
  const notes: string[] = [];

  // Code
  const dexEntries = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  const dex = { files: dexEntries.length, bytes: 0, classes: 0, methods: 0 };
  const seen = new Map<string, string>(); // dependency id -> evidence
  let loadsCode = false;
  let compose = false;
  let cordova = false;
  let capacitor = false;
  let rnJava = false;
  for (const e of dexEntries) {
    dex.bytes += e.size;
    let d: DexSummary;
    try {
      d = parseDex(await readZipEntryData(path, e));
    } catch (err) {
      notes.push(`${e.name} could not be read: ${(err as Error).message}`);
      continue;
    }
    dex.classes += d.classes;
    dex.methods += d.methods;
    for (const t of d.types) {
      for (const [id, , prefix] of DEPENDENCY_PREFIXES) if (!seen.has(id) && t.startsWith(prefix)) seen.set(id, `${t} in ${e.name}`);
      if (t === "Ldalvik/system/DexClassLoader;" || t === "Ldalvik/system/InMemoryDexClassLoader;") loadsCode = true;
      if (t.startsWith("Landroidx/compose/ui/")) compose = true;
      if (t.startsWith("Lorg/apache/cordova/")) cordova = true;
      if (t.startsWith("Lcom/getcapacitor/")) capacitor = true;
      if (t.startsWith("Lcom/facebook/react/")) rnJava = true;
    }
  }

  // Native libraries
  const abis: Record<string, string[]> = {};
  let nativeBytes = 0;
  const frameworkEvidence: string[] = [];
  let framework: AppFramework | undefined;
  for (const e of entries) {
    const m = /^lib\/([^/]+)\/([^/]+\.so)$/.exec(e.name);
    if (!m) continue;
    (abis[m[1]!] ??= []).push(m[2]!);
    nativeBytes += e.size;
    for (const [re, kind] of NATIVE_FRAMEWORKS) {
      if (re.test(m[2]!) && !frameworkEvidence.includes(m[2]!)) {
        framework ??= kind;
        frameworkEvidence.push(m[2]!);
      }
    }
  }

  // Assets and a possible web layer
  const assets = entries.filter((e) => e.name.startsWith("assets/") && !e.name.endsWith("/"));
  let webLayer: ApkAnalysis["webLayer"];
  for (const rootDir of ["assets/public/", "assets/www/"]) {
    if (!byName.has(`${rootDir}index.html`)) continue;
    const inside = assets.filter((e) => e.name.startsWith(rootDir));
    webLayer = { root: rootDir.slice(0, -1), entry: "index.html", files: inside.length, bytes: inside.reduce((n, e) => n + e.size, 0) };
    break;
  }
  if (!framework) {
    if (capacitor && webLayer) { framework = "capacitor"; frameworkEvidence.push("com.getcapacitor classes", `${webLayer.root}/index.html`); }
    else if (cordova && webLayer) { framework = "cordova"; frameworkEvidence.push("org.apache.cordova classes", `${webLayer.root}/index.html`); }
    else if (rnJava || byName.has("assets/index.android.bundle")) { framework = "react-native"; frameworkEvidence.push(rnJava ? "com.facebook.react classes" : "assets/index.android.bundle"); }
    else if (compose) { framework = "kotlin-compose"; frameworkEvidence.push("androidx.compose.ui classes"); }
    else if (dex.classes > 0) { framework = "native-android"; frameworkEvidence.push("DEX code and no cross-platform framework found"); }
    else framework = "unknown";
  }
  if (!dex.files) notes.push("No classes.dex found. This may be a split APK that only carries resources or native code.");
  if (Object.keys(abis).length && !abis["arm64-v8a"]) notes.push(`Native code is built only for ${Object.keys(abis).join(", ")}, not arm64-v8a.`);

  const resources = entries.filter((e) => e.name.startsWith("res/") || e.name === "resources.arsc");
  return {
    tool: "tethertrace",
    schemaVersion: "analysis.1",
    file: path,
    sizeBytes: (await stat(path)).size,
    packageName: typeof root?.attrs.package === "string" ? root.attrs.package : undefined,
    versionName: root?.attrs.versionName !== undefined ? String(root.attrs.versionName) : undefined,
    versionCode: num(root?.attrs.versionCode),
    minSdk: num(sdk?.attrs.minSdkVersion),
    targetSdk: num(sdk?.attrs.targetSdkVersion),
    debuggable: app?.attrs.debuggable === true,
    framework: { kind: framework, evidence: frameworkEvidence },
    dex,
    native: { abis, bytes: nativeBytes },
    webLayer,
    assets: { files: assets.length, bytes: assets.reduce((n, e) => n + e.size, 0), wasmFiles: assets.filter((e) => e.name.endsWith(".wasm")).length },
    resources: { files: resources.length, bytes: resources.reduce((n, e) => n + e.size, 0) },
    manifest: {
      permissions: [...new Set(named("uses-permission"))].sort(),
      features: [...new Set(named("uses-feature"))].sort(),
      activities: count("activity") + count("activity-alias"),
      services: count("service"),
      receivers: count("receiver"),
      providers: count("provider"),
      glEsVersion: (() => {
        const v = num(xml.find((e) => e.name === "uses-feature" && e.attrs.glEsVersion !== undefined)?.attrs.glEsVersion);
        return v !== undefined ? `${v >> 16}.${v & 0xffff}` : undefined;
      })(),
    },
    dependencies: [...seen.entries()].map(([id, evidence]) => ({ id, label: DEPENDENCY_PREFIXES.find((d) => d[0] === id)![1], evidence })),
    loadsCodeAtRuntime: loadsCode,
    notes,
  };
}

// ---------------------------------------------------------------- compatibility

export type CompatibilityTarget = "ios";
export type PortabilityRoute = "repackage_web_layer" | "rebuild_from_source" | "none";

export interface CompatibilityReport {
  tool: "tethertrace";
  schemaVersion: "compatibility.1";
  target: CompatibilityTarget;
  packageName?: string;
  /** Always false for iOS: no part of this report means the APK was run there. */
  runsUnmodified: false;
  route: PortabilityRoute;
  routeSummary: string;
  portable: { part: string; detail: string }[];
  notPortable: { part: string; why: string }[];
  blockers: { id: string; detail: string }[];
  disclaimer: string;
}

/** What each part of an APK is, and why it does or does not carry over to iOS. Used in reports and docs. */
export const IOS_COMPONENT_MATRIX: { part: string; portable: "yes" | "with a runtime" | "no"; why: string }[] = [
  { part: "Web assets (HTML, CSS, JS, images)", portable: "yes", why: "Run in any web engine, including WKWebView. Calls into the Android side of a hybrid app are not carried over." },
  { part: "WebAssembly modules", portable: "yes", why: "Run in the web engine. Outside it, iOS allows only an interpreter." },
  { part: "Images, fonts, media, data files", portable: "yes", why: "Plain data." },
  { part: "DEX bytecode (Java/Kotlin code)", portable: "with a runtime", why: "DEX can be interpreted, so the code is not tied to a CPU. It still needs an Android runtime and the whole Android framework underneath, and no such runtime exists for iOS." },
  { part: "Android resources (resources.arsc, binary XML layouts)", portable: "with a runtime", why: "Only meaningful to Android's resource system and view classes." },
  { part: "Native libraries (lib/*/*.so)", portable: "no", why: "ELF files linked against Android's C library and linker, using Linux system calls. iOS loads only signed Mach-O code. The same CPU is not enough." },
  { part: "AndroidManifest components (activities, services, receivers, providers)", portable: "no", why: "They are started by Android's system server over Binder. iOS has no equivalent service." },
  { part: "Google Play Services, Firebase, Play Billing, Play Integrity", portable: "no", why: "Proprietary Google software that is not part of the APK and is not available on iOS in this form." },
  { part: "DRM and hardware-backed keys", portable: "no", why: "Bound to the Android device's secure hardware and to the app's signature." },
];

const FRAMEWORK_IOS: Partial<Record<AppFramework, string>> = {
  flutter: "Flutter builds for iOS from the same Dart source. The APK holds Dart compiled ahead of time for Android (libapp.so), which cannot be converted.",
  "react-native": "React Native builds for iOS from the same JavaScript and native modules. The JS bundle inside the APK is portable in itself, but the native modules it calls are not.",
  unity: "Unity exports an iOS project from the same Unity project. The APK holds compiled engine and game code for Android.",
  unreal: "Unreal packages for iOS from the same project. The APK holds compiled engine and game code for Android.",
  godot: "Godot exports for iOS from the same project.",
  "xamarin-maui": ".NET MAUI builds for iOS from the same C# source.",
  "kotlin-compose": "Compose Multiplatform can target iOS if the code is moved to a Kotlin Multiplatform module. Android-only APIs must be replaced.",
};

export function checkCompatibility(a: ApkAnalysis, target: CompatibilityTarget): CompatibilityReport {
  if (target !== "ios") throw new Error(`Unknown target "${target}". Only "ios" is analysed.`);
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const portable: CompatibilityReport["portable"] = [];
  const notPortable: CompatibilityReport["notPortable"] = [];
  const blockers: CompatibilityReport["blockers"] = [];

  if (a.webLayer) portable.push({ part: "Web layer", detail: `${a.webLayer.files} files (${mb(a.webLayer.bytes)}) under ${a.webLayer.root}, entry ${a.webLayer.entry}` });
  if (a.assets.wasmFiles) portable.push({ part: "WebAssembly", detail: `${a.assets.wasmFiles} .wasm file(s) in assets` });
  const otherAssets = a.assets.bytes - (a.webLayer?.bytes ?? 0);
  if (otherAssets > 0) portable.push({ part: "Other assets", detail: `${mb(otherAssets)} of data files (meaningful only to code that knows how to read them)` });

  if (a.dex.files) notPortable.push({ part: `DEX code (${a.dex.classes} classes, ${a.dex.methods} methods)`, why: "Needs an Android runtime and the Android framework. None exists for iOS." });
  const libs = Object.values(a.native.abis).flat();
  if (libs.length) notPortable.push({ part: `Native libraries (${new Set(libs).size} libraries, ${mb(a.native.bytes)})`, why: "Android ELF code. iOS only loads signed Mach-O code, and these call Linux and Android APIs." });
  const comps = a.manifest.activities + a.manifest.services + a.manifest.receivers + a.manifest.providers;
  if (comps) notPortable.push({ part: `${comps} manifest components`, why: "Started and connected by Android's system services, which iOS does not have." });
  if (a.resources.files) notPortable.push({ part: `Android resources (${a.resources.files} files)`, why: "Read by Android's resource system and view classes only." });

  blockers.push({ id: "no-android-runtime", detail: "There is no Android runtime for iOS. Running DEX there would need an interpreter (iOS does not let an app generate machine code) plus a reimplementation of the Android framework." });
  if (libs.length) blockers.push({ id: "native-code", detail: "The app ships native Android libraries. They cannot be loaded on iOS, and translating them would still leave every Android and Linux call unanswered." });
  for (const d of a.dependencies) blockers.push({ id: d.id, detail: `Uses ${d.label} (${d.evidence}). It is not part of the APK and has no drop-in equivalent on iOS.` });
  if (a.loadsCodeAtRuntime) blockers.push({ id: "runtime-code-loading", detail: "Loads more DEX code at run time, so the APK does not contain everything the app executes." });

  let route: PortabilityRoute = "none";
  let routeSummary: string;
  const kind = a.framework.kind;
  if ((kind === "cordova" || kind === "capacitor") && a.webLayer) {
    route = "repackage_web_layer";
    routeSummary = `This is a ${kind === "cordova" ? "Cordova" : "Capacitor"} app: its screens are a web application inside the APK. That web layer can be packed and run in a web runtime. Calls it makes to native plugins will not work until each plugin has an equivalent on the other side. This is not running the Android app.`;
  } else if (FRAMEWORK_IOS[kind]) {
    route = "rebuild_from_source";
    routeSummary = `${FRAMEWORK_IOS[kind]} With the source code this is a rebuild, not a conversion. Without the source there is no route.`;
  } else if (kind === "native-android") {
    routeSummary = "A native Android app. Its code is written against the Android framework, so reaching iOS means rewriting the UI and platform code, or sharing logic through Kotlin Multiplatform. There is no route from the APK alone.";
  } else routeSummary = "No cross-platform framework was recognised, and no part of this APK can run on iOS as it is.";

  return {
    tool: "tethertrace",
    schemaVersion: "compatibility.1",
    target,
    packageName: a.packageName,
    runsUnmodified: false,
    route,
    routeSummary,
    portable,
    notPortable,
    blockers,
    disclaimer: "This is a static analysis of the file. Nothing was executed, and nothing here has been tested on an iOS device.",
  };
}

export function describeAnalysis(a: ApkAnalysis): string {
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const out = [
    `${a.packageName ?? "?"} ${a.versionName ?? ""} (${mb(a.sizeBytes)})`.replace(/\s+\(/, " ("),
    `Built with: ${a.framework.kind}${a.framework.evidence.length ? ` (${a.framework.evidence.slice(0, 3).join(", ")})` : ""}`,
    `Android: minSdk ${a.minSdk ?? "?"}, targetSdk ${a.targetSdk ?? "?"}${a.debuggable ? ", debuggable" : ""}`,
    `Code: ${a.dex.files} DEX file(s), ${a.dex.classes} classes, ${a.dex.methods} methods (${mb(a.dex.bytes)})`,
  ];
  const abis = Object.entries(a.native.abis);
  out.push(abis.length ? `Native code: ${abis.map(([abi, libs]) => `${abi} (${libs.length})`).join(", ")}, ${mb(a.native.bytes)}` : "Native code: none");
  if (a.webLayer) out.push(`Web layer: ${a.webLayer.root}/${a.webLayer.entry}, ${a.webLayer.files} files, ${mb(a.webLayer.bytes)}`);
  out.push(`Assets: ${a.assets.files} files, ${mb(a.assets.bytes)}${a.assets.wasmFiles ? `, ${a.assets.wasmFiles} WebAssembly` : ""}`);
  out.push(`Components: ${a.manifest.activities} activities, ${a.manifest.services} services, ${a.manifest.receivers} receivers, ${a.manifest.providers} providers`);
  out.push(`Permissions (${a.manifest.permissions.length}): ${a.manifest.permissions.map((p) => p.replace(/^android\.permission\./, "")).slice(0, 12).join(", ") || "none"}${a.manifest.permissions.length > 12 ? ", …" : ""}`);
  out.push(`Depends on: ${a.dependencies.map((d) => d.label).filter((v, i, all) => all.indexOf(v) === i).join(", ") || "nothing outside the APK was detected"}`);
  if (a.loadsCodeAtRuntime) out.push("Loads more code at run time (DexClassLoader).");
  for (const n of a.notes) out.push(`note: ${n}`);
  return out.join("\n");
}

export function describeCompatibility(r: CompatibilityReport): string {
  const out = [`Target: iOS`, `Runs unmodified: no`, `Route: ${r.route === "none" ? "none from the APK alone" : r.route.replace(/_/g, " ")}`, r.routeSummary, ""];
  if (r.portable.length) {
    out.push("Could be carried over:");
    for (const p of r.portable) out.push(`  + ${p.part}: ${p.detail}`);
  } else out.push("Could be carried over: nothing");
  out.push("Cannot be carried over:");
  for (const p of r.notPortable) out.push(`  - ${p.part}: ${p.why}`);
  out.push("Blockers:");
  for (const b of r.blockers) out.push(`  ! ${b.detail}`);
  out.push("", r.disclaimer);
  return out.join("\n");
}
