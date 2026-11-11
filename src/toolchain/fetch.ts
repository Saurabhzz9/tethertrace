import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

/** Download, verify and unpack helpers for managed toolchains. No dependencies beyond Node. */

export class ToolchainError extends Error {
  constructor(
    readonly code: "DOWNLOAD" | "CHECKSUM" | "EXTRACT" | "DISK_SPACE" | "CONSENT" | "CANCELLED" | "UNSUPPORTED" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ToolchainError";
  }
}

export interface DownloadOptions {
  /** Expected digest; the file is deleted and the call fails when it does not match. */
  checksum: { algorithm: "sha1" | "sha256"; hex: string };
  retries?: number;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

/** Download `url` to `dest`, retrying on network errors, and verify its checksum. Leaves no partial file behind. */
export async function download(url: string, dest: string, o: DownloadOptions): Promise<void> {
  const f = o.fetchImpl ?? fetch;
  const tmp = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const attempts = (o.retries ?? 3) + 1;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    if (o.signal?.aborted) throw new ToolchainError("CANCELLED", "Download cancelled");
    try {
      const res = await f(url, { signal: o.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash(o.checksum.algorithm);
      const total = Number(res.headers.get("content-length")) || 0;
      let got = 0;
      let lastPct = -10;
      const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
      body.on("data", (c: Buffer) => {
        hash.update(c);
        got += c.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (total && pct >= lastPct + 10) {
          lastPct = pct;
          o.log?.(`  ${pct}% of ${(total / 1e6).toFixed(0)} MB`);
        }
      });
      await pipeline(body, createWriteStream(tmp));
      const hex = hash.digest("hex");
      if (hex.toLowerCase() !== o.checksum.hex.toLowerCase()) {
        await rm(tmp, { force: true });
        // A wrong checksum is not a network blip: do not retry, do not keep the file.
        throw new ToolchainError("CHECKSUM", `Checksum mismatch for ${url}: expected ${o.checksum.algorithm} ${o.checksum.hex}, got ${hex}`);
      }
      await rename(tmp, dest);
      return;
    } catch (e) {
      await rm(tmp, { force: true });
      if (e instanceof ToolchainError) throw e;
      if (o.signal?.aborted) throw new ToolchainError("CANCELLED", "Download cancelled");
      last = e;
      if (i < attempts) {
        o.log?.(`  download failed (${(e as Error).message}); retry ${i} of ${attempts - 1}`);
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }
  throw new ToolchainError("DOWNLOAD", `Could not download ${url}: ${(last as Error)?.message ?? last}`);
}

/** Free bytes on the volume that holds `dir` (or its nearest existing parent). */
export async function freeBytes(dir: string): Promise<number | undefined> {
  let d = resolve(dir);
  for (;;) {
    try {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(d);
      if (up === d) return undefined;
      d = up;
    }
  }
}

export async function requireSpace(dir: string, bytes: number, what: string) {
  const free = await freeBytes(dir);
  if (free !== undefined && free < bytes)
    throw new ToolchainError("DISK_SPACE", `${what} needs about ${(bytes / 1e9).toFixed(1)} GB free in ${dir}, but only ${(free / 1e9).toFixed(1)} GB is available`);
}

/**
 * Unpack a ZIP into `dest`. `strip` drops that many leading path components. Entries that would
 * land outside `dest` are refused. On Linux/macOS the executable bits stored in the archive are kept.
 */
export async function extractZip(file: string, dest: string, strip = 0): Promise<number> {
  const fh = await open(file, "r");
  let count = 0;
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ToolchainError("EXTRACT", `${file} is not a ZIP file`);
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || entries === 0xffff) throw new ToolchainError("EXTRACT", "ZIP64 archives are not supported");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const root = resolve(dest);
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ToolchainError("EXTRACT", "Corrupt ZIP central directory");
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const mode = (cd.readUInt32LE(p + 38) >>> 16) & 0o777;
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      const parts = name.split("/").filter(Boolean).slice(strip);
      if (!parts.length) continue;
      const target = resolve(root, ...parts);
      if (target !== root && !target.startsWith(root + sep)) throw new ToolchainError("EXTRACT", `Refusing to unpack ${name} outside ${dest}`);
      if (name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ToolchainError("EXTRACT", "Corrupt ZIP local header");
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
      if (method !== 0 && method !== 8) throw new ToolchainError("EXTRACT", `Unsupported ZIP compression method ${method} for ${name}`);
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, "w");
      try {
        await out.write(method === 0 ? data : inflateRawSync(data));
      } finally {
        await out.close();
      }
      if (process.platform !== "win32" && mode & 0o111) await chmod(target, mode);
      count++;
    }
  } finally {
    await fh.close();
  }
  return count;
}

/** Unpack a .tar.gz with the system `tar` (present on Linux, macOS and Windows 10+). */
export async function extractTarGz(file: string, dest: string, strip = 0, signal?: AbortSignal): Promise<void> {
  await mkdir(dest, { recursive: true });
  const r = await run("tar", ["-xzf", file, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])], { signal });
  if (r.code !== 0) throw new ToolchainError("EXTRACT", `tar failed (${r.code}): ${r.output.slice(-400)}`);
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** Run a program and collect its output. Kills it on timeout or abort. Never uses a shell for non-.bat programs. */
export function run(
  cmd: string,
  args: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; input?: string; onLine?: (line: string) => void; logFile?: string } = {},
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    // .bat/.cmd files can only be started through cmd.exe on Windows.
    const viaShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(cmd);
    const child = viaShell
      ? spawn(`"${cmd}" ${args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`, { cwd: o.cwd, env: o.env, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true });
    let output = "";
    let pending = "";
    let timedOut = false;
    let cancelled = false;
    const log = o.logFile ? createWriteStream(o.logFile) : undefined;
    const kill = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    };
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : undefined;
    const onAbort = () => { cancelled = true; kill(); };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const onData = (c: Buffer) => {
      const s = c.toString("utf8");
      log?.write(s);
      output = (output + s).slice(-200_000);
      pending += s;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) o.onLine?.(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      log?.end();
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (pending) o.onLine?.(pending);
      log?.end();
      resolveRun({ code, output, timedOut, cancelled });
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

export const pathExists = async (p: string) => !!(await stat(p).catch(() => undefined));
