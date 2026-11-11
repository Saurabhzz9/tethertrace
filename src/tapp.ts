import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { listZipEntries, readZipEntryData } from "./analyze.js";

/**
 * .tapp: a portable application package (experimental, format version 1).
 *
 * A .tapp is a ZIP file holding a web application (HTML, CSS, JavaScript, WebAssembly, data) and
 * one manifest, `tapp.json`, that names every file with its SHA-256. A runtime on each platform
 * verifies the package, serves it from an origin of its own, and exposes device features through
 * one small API that the manifest has to ask for.
 *
 * The package never contains code a platform would have to trust as native. `targets` is reserved
 * for a later version that may carry per-platform artifacts next to the portable part.
 */

export const TAPP_FORMAT = 1;
export const TAPP_MANIFEST = "tapp.json";
export const TAPP_SIGNATURE = "tapp.sig";

/** Capabilities a package can ask for. A runtime grants only what it implements and the user allows. */
export const TAPP_PERMISSIONS = ["network", "storage", "vibrate", "clipboard", "geolocation", "camera", "microphone", "notifications"] as const;
export type TappPermission = (typeof TAPP_PERMISSIONS)[number];

export interface TappManifest {
  tapp: typeof TAPP_FORMAT;
  /** Reverse-DNS identity, e.g. "com.example.notes". Decides the package's origin and storage. */
  id: string;
  name: string;
  version: string;
  /** The HTML file a runtime opens first. */
  entry: string;
  runtime: { kind: "web"; api: number };
  permissions: TappPermission[];
  /** Origins the app may contact. Used only with the "network" permission. Empty means none. */
  network: string[];
  /** Reserved: per-platform artifacts. Always empty in format 1. */
  targets: Record<string, never>;
  files: Record<string, { size: number; sha256: string }>;
}

export class TappError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "INTEGRITY" | "SIGNATURE" | "UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "TappError";
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** A path inside a package: forward slashes, no "..", no leading slash, no drive, no control characters. */
export function isSafePackagePath(p: string): boolean {
  if (!p || p.length > 512 || p.startsWith("/") || p.includes("\\") || /[\x00-\x1f:]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function validateManifest(m: unknown): TappManifest {
  const bad = (why: string): never => {
    throw new TappError("INVALID", `tapp.json: ${why}`);
  };
  if (!m || typeof m !== "object") bad("not an object");
  const o = m as Record<string, unknown>;
  if (o.tapp !== TAPP_FORMAT) throw new TappError("UNSUPPORTED", `tapp.json: format ${JSON.stringify(o.tapp)} is not supported (this version reads format ${TAPP_FORMAT})`);
  if (typeof o.id !== "string" || !ID_RE.test(o.id) || o.id.length > 128) bad(`"id" must look like com.example.app`);
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 80) bad(`"name" is required (at most 80 characters)`);
  if (typeof o.version !== "string" || !VERSION_RE.test(o.version)) bad(`"version" must look like 1.2.3`);
  if (typeof o.entry !== "string" || !isSafePackagePath(o.entry) || !/\.html?$/i.test(o.entry)) bad(`"entry" must be an HTML file inside the package`);
  const rt = o.runtime as { kind?: unknown; api?: unknown } | undefined;
  if (!rt || rt.kind !== "web" || typeof rt.api !== "number") bad(`"runtime" must be { "kind": "web", "api": <number> }`);
  if (!Array.isArray(o.permissions) || o.permissions.some((p) => !(TAPP_PERMISSIONS as readonly unknown[]).includes(p))) bad(`"permissions" may only contain: ${TAPP_PERMISSIONS.join(", ")}`);
  if (!Array.isArray(o.network) || o.network.some((n) => typeof n !== "string" || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(n))) bad(`"network" must be a list of https origins such as https://api.example.com`);
  if ((o.network as string[]).length && !(o.permissions as string[]).includes("network")) bad(`"network" lists origins but the "network" permission is not requested`);
  if (!o.targets || typeof o.targets !== "object" || Object.keys(o.targets).length) bad(`"targets" must be an empty object in format ${TAPP_FORMAT}`);
  if (!o.files || typeof o.files !== "object") bad(`"files" is required`);
  const files = o.files as Record<string, { size?: unknown; sha256?: unknown }>;
  const names = Object.keys(files);
  if (!names.length || names.length > MAX_FILES) bad(`"files" must list between 1 and ${MAX_FILES} files`);
  for (const n of names) {
    if (!isSafePackagePath(n) || n === TAPP_MANIFEST || n === TAPP_SIGNATURE) bad(`"${n}" is not an allowed file path`);
    const f = files[n]!;
    if (typeof f.size !== "number" || f.size < 0 || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) bad(`"${n}" needs a size and a sha256`);
  }
  if (!files[o.entry as string]) bad(`entry "${String(o.entry)}" is not in "files"`);
  return o as unknown as TappManifest;
}

// ---------------------------------------------------------------- writing

function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // A fixed timestamp, so the same input always gives the same bytes: 1980-01-01 00:00.
  const dosTime = 0;
  const dosDate = 0x21;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // names are UTF-8
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, payload);
    centrals.push(ch, n);
    offset += 30 + n.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const IGNORED = /(^|\/)(\.git|\.DS_Store|Thumbs\.db|node_modules|\.env(\..*)?)(\/|$)|\.map$|\.tapp$/;

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (IGNORED.test(rel)) continue;
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export interface PackConfig {
  id?: string;
  name?: string;
  version?: string;
  entry?: string;
  /** Folder with the built web app, relative to the project. */
  dir?: string;
  permissions?: TappPermission[];
  network?: string[];
}

export interface PackResult {
  file: string;
  manifest: TappManifest;
  sizeBytes: number;
  sha256: string;
  signedBy?: string;
  notes: string[];
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const readJson = async <T>(p: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TappError("INVALID", `${p} is not valid JSON: ${(e as Error).message}`);
  }
};

/**
 * Find the folder that holds the built web app. Looks at `tapp.config.json`, then the project folder
 * itself, then the usual output folders of web build tools. It never runs a build for you.
 */
export async function findWebRoot(project: string, config: PackConfig): Promise<{ root: string; notes: string[] }> {
  const notes: string[] = [];
  const entry = config.entry ?? "index.html";
  const candidates = config.dir ? [config.dir] : [".", "dist", "build", "out", "www", "public", "dist/browser"];
  for (const c of candidates) {
    const root = resolve(project, c);
    if (await exists(join(root, entry))) {
      if (c === "." && (await exists(join(project, "package.json"))) && !config.dir) {
        const built = (await Promise.all(["dist", "build", "out"].map(async (d) => ((await exists(join(project, d, entry))) ? d : undefined)))).find(Boolean);
        if (built) return { root: resolve(project, built), notes: [`Packing the built app in ${built}/, not the project folder.`] };
      }
      return { root, notes };
    }
  }
  const pkg = await readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(project, "package.json"));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  let hint = `No ${entry} found in ${config.dir ?? "the project folder or dist/, build/, out/, www/, public/"}.`;
  if (deps.next) hint += ` This looks like a Next.js project: set output: "export" in next.config and run the build, then pack the out/ folder. Pages that need a server (SSR, API routes) cannot be packed.`;
  else if (pkg?.scripts?.build) hint += ` Run the project's build first (npm run build), then pack again. tethertrace does not run package scripts for you.`;
  else hint += ` Point "dir" in tapp.config.json at the folder that holds your built web app.`;
  throw new TappError("NOT_FOUND", hint);
}

export interface PackOptions {
  out?: string;
  /** PEM file with an Ed25519 private key. When given, the manifest is signed. */
  keyFile?: string;
}

export async function pack(projectDir: string, o: PackOptions = {}): Promise<PackResult> {
  const project = resolve(projectDir);
  const config = (await readJson<PackConfig>(join(project, "tapp.config.json"))) ?? {};
  const pkg = await readJson<{ name?: string; version?: string; dependencies?: Record<string, string> }>(join(project, "package.json"));
  const { root, notes } = await findWebRoot(project, config);
  const entry = config.entry ?? "index.html";
  const slug = (pkg?.name ?? project.split(/[\\/]/).pop() ?? "app").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
  const names = (await walk(root)).filter((n) => n !== TAPP_MANIFEST && n !== TAPP_SIGNATURE && n !== "tapp.config.json").sort();
  const files: TappManifest["files"] = {};
  const data = new Map<string, Buffer>();
  let total = 0;
  for (const n of names) {
    if (!isSafePackagePath(n)) throw new TappError("INVALID", `"${n}" cannot be packed: file names may not contain backslashes, colons or control characters`);
    const b = await readFile(join(root, n));
    total += b.length;
    if (total > MAX_TOTAL_BYTES) throw new TappError("INVALID", "The app is larger than 2 GB");
    files[n] = { size: b.length, sha256: sha256(b) };
    data.set(n, b);
  }
  const manifest = validateManifest({
    tapp: TAPP_FORMAT,
    id: config.id ?? `app.tapp.${slug}`,
    name: config.name ?? pkg?.name ?? slug,
    version: config.version ?? pkg?.version ?? "0.1.0",
    entry,
    runtime: { kind: "web", api: 1 },
    permissions: config.permissions ?? [],
    network: config.network ?? [],
    targets: {},
    files,
  });
  if (!config.id) notes.push(`No "id" in tapp.config.json, so the package is called ${manifest.id}. Set your own before sharing it.`);
  for (const dep of ["express", "fastify", "koa", "@nestjs/core"]) if (pkg?.dependencies?.[dep]) notes.push(`The project depends on ${dep}. Server code is not part of a package; the app has to reach that server over the network.`);
  const html = data.get(entry)!.toString("utf8");
  if (/<script[^>]+src=["']https?:\/\//i.test(html) && !manifest.permissions.includes("network")) notes.push(`${entry} loads a script from the network, but the package does not ask for the "network" permission, so a runtime will block it. Bundle the script, or add the permission and the origin.`);

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries: { name: string; data: Buffer }[] = [{ name: TAPP_MANIFEST, data: manifestBytes }];
  let signedBy: string | undefined;
  if (o.keyFile) {
    const key = createPrivateKey(await readFile(o.keyFile));
    if (key.asymmetricKeyType !== "ed25519") throw new TappError("SIGNATURE", `${o.keyFile} is not an Ed25519 private key`);
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
    const sig = { algorithm: "ed25519", publicKey: publicKey.toString("base64"), signature: edSign(null, manifestBytes, key).toString("base64") };
    entries.push({ name: TAPP_SIGNATURE, data: Buffer.from(`${JSON.stringify(sig, null, 2)}\n`) });
    signedBy = keyFingerprint(publicKey);
  }
  for (const n of names) entries.push({ name: n, data: data.get(n)! });
  const zip = zipStore(entries);
  const file = resolve(o.out ?? join(project, `${manifest.id.split(".").pop()}-${manifest.version}.tapp`));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, zip);
  return { file, manifest, sizeBytes: zip.length, sha256: sha256(zip), signedBy, notes };
}

// ---------------------------------------------------------------- reading

export const keyFingerprint = (spkiDer: Buffer) => sha256(spkiDer).slice(0, 16).replace(/(.{4})(?=.)/g, "$1-");

export interface VerifiedTapp {
  file: string;
  manifest: TappManifest;
  /** Who signed it, as a short fingerprint of the public key. Undefined for an unsigned package. */
  signedBy?: string;
  /** Read one of the package's files (already checked against the manifest). */
  read(name: string): Promise<Buffer>;
}

/**
 * Open a package and check everything a runtime relies on: the manifest is valid, every listed file
 * is present with the stated size and SHA-256, nothing unlisted is inside, and the signature (when
 * there is one) matches the manifest. Throws {@link TappError} on the first problem.
 */
export async function verifyTapp(file: string): Promise<VerifiedTapp> {
  let entries;
  try {
    entries = await listZipEntries(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new TappError("NOT_FOUND", `${file} does not exist`);
    throw new TappError("INVALID", (e as Error).message);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (byName.size !== entries.length) throw new TappError("INVALID", "The package lists the same file name twice");
  const manifestEntry = byName.get(TAPP_MANIFEST);
  if (!manifestEntry) throw new TappError("INVALID", `No ${TAPP_MANIFEST} inside; this is not a .tapp package`);
  const manifestBytes = await readZipEntryData(file, manifestEntry);
  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new TappError("INVALID", `${TAPP_MANIFEST} is not valid JSON`);
  }
  const manifest = validateManifest(raw);
  for (const e of entries) {
    if (e.name === TAPP_MANIFEST || e.name === TAPP_SIGNATURE) continue;
    if (!manifest.files[e.name]) throw new TappError("INTEGRITY", `"${e.name}" is in the package but not in the manifest`);
  }
  const cache = new Map<string, Buffer>();
  for (const [name, f] of Object.entries(manifest.files)) {
    const e = byName.get(name);
    if (!e) throw new TappError("INTEGRITY", `"${name}" is listed in the manifest but missing from the package`);
    if (e.size !== f.size) throw new TappError("INTEGRITY", `"${name}" has a different size than the manifest says`);
    const b = await readZipEntryData(file, e);
    if (b.length !== f.size || sha256(b) !== f.sha256) throw new TappError("INTEGRITY", `"${name}" does not match its SHA-256 in the manifest; the package was changed after it was packed`);
    if (b.length <= 4 * 1024 * 1024) cache.set(name, b);
  }
  let signedBy: string | undefined;
  const sigEntry = byName.get(TAPP_SIGNATURE);
  if (sigEntry) {
    let sig: { algorithm?: string; publicKey?: string; signature?: string };
    try {
      sig = JSON.parse((await readZipEntryData(file, sigEntry)).toString("utf8")) as typeof sig;
    } catch {
      throw new TappError("SIGNATURE", `${TAPP_SIGNATURE} is not valid JSON`);
    }
    if (sig.algorithm !== "ed25519" || !sig.publicKey || !sig.signature) throw new TappError("SIGNATURE", `${TAPP_SIGNATURE} is incomplete`);
    const der = Buffer.from(sig.publicKey, "base64");
    let ok = false;
    try {
      ok = edVerify(null, manifestBytes, createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(sig.signature, "base64"));
    } catch {
      ok = false;
    }
    if (!ok) throw new TappError("SIGNATURE", "The signature does not match the manifest");
    signedBy = keyFingerprint(der);
  }
  return {
    file,
    manifest,
    signedBy,
    async read(name: string) {
      const f = manifest.files[name];
      if (!f) throw new TappError("NOT_FOUND", `"${name}" is not in the package`);
      return cache.get(name) ?? (await readZipEntryData(file, byName.get(name)!));
    },
  };
}

/** Make an Ed25519 key pair for signing packages. Returns PEM text. */
export function generateSigningKey(): { privateKeyPem: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fingerprint: keyFingerprint(publicKey.export({ type: "spki", format: "der" })) };
}

export function describeTapp(v: VerifiedTapp): string {
  const m = v.manifest;
  const bytes = Object.values(m.files).reduce((n, f) => n + f.size, 0);
  return [
    `${m.name} ${m.version}  (${m.id})`,
    `Format: .tapp ${m.tapp}, web runtime api ${m.runtime.api}`,
    `Entry: ${m.entry}`,
    `Files: ${Object.keys(m.files).length}, ${bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`} unpacked`,
    `Permissions: ${m.permissions.join(", ") || "none"}`,
    `Network: ${m.permissions.includes("network") ? m.network.join(", ") || "no origins listed, so nothing is reachable" : "blocked"}`,
    `Signed: ${v.signedBy ? `yes, key ${v.signedBy}` : "no"}`,
    `Integrity: every file matches the manifest`,
  ].join("\n");
}
