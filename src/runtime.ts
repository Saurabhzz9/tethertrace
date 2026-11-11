import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "./adb/keys.js";
import { AdbError } from "./adb/connection.js";
import { build, type BuildResult } from "./build.js";
import type { Device } from "./device.js";
import type { Consent } from "./toolchain/android.js";
import { TappError, verifyTapp, type TappManifest, type VerifiedTapp } from "./tapp.js";

/**
 * Runtimes for .tapp packages. Each platform has one adapter with the same job: take a verified
 * package, give it an origin of its own, serve only its files, enforce its network list, and put
 * the runtime API (`window.tapp`) in front of the page.
 *
 *   desktop  a local preview in any browser. Implemented, tested.
 *   android  a host app with a WebView, driven over tethertrace's own ADB. Implemented.
 *   ios      not implemented. See docs/universal-runtime/README.md for what it needs.
 */

export type RuntimePlatform = "desktop" | "android" | "ios";
export const RUNTIME_API = 1;
export const ANDROID_HOST_PACKAGE = "dev.tethertrace.host";
export const ANDROID_HOST_VERSION = "0.1.0";

/** The repository's `runtime/` folder (shipped inside the npm package). */
export const runtimeDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");

export function contentSecurityPolicy(m: TappManifest): string {
  const connect = ["'self'", ...(m.permissions.includes("network") ? m.network : [])].join(" ");
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
}

export function bootScript(m: TappManifest, platform: RuntimePlatform, runtime: string): string {
  return `window.__tappBoot=${JSON.stringify({ id: m.id, name: m.name, version: m.version, platform, runtime, permissions: m.permissions })};`;
}

/** Put the runtime's two scripts in front of the page's own scripts. */
export function injectRuntime(html: string): string {
  const tags = `<script src="/__tapp/boot.js"></script><script src="/__tapp/bridge.js"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length) : tags + html;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
  txt: "text/plain; charset=utf-8", xml: "text/xml; charset=utf-8",
};
export const mimeOf = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

// ---------------------------------------------------------------- desktop

export interface DesktopRuntime {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serve a verified package on 127.0.0.1 for a browser. Only files in the manifest are served, with
 * the same Content-Security-Policy the phone runtime uses, so a page that works here is not relying
 * on anything a package cannot have.
 */
export async function startDesktopRuntime(pkg: VerifiedTapp, opts: { port?: number } = {}): Promise<DesktopRuntime> {
  const m = pkg.manifest;
  const bridge = await readFile(join(runtimeDir(), "shared", "bridge.js"));
  const boot = Buffer.from(bootScript(m, "desktop", "preview"));
  const csp = contentSecurityPolicy(m);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, type: string, body: Buffer | string, html = false) => {
        res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store", ...(html ? { "content-security-policy": csp } : {}) });
        res.end(body);
      };
      try {
        if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "Only GET is supported");
        let path: string;
        try {
          path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).slice(1);
        } catch {
          return send(400, "text/plain", "Bad request");
        }
        if (path === "") path = m.entry;
        if (path === "__tapp/boot.js") return send(200, MIME.js!, boot);
        if (path === "__tapp/bridge.js") return send(200, MIME.js!, bridge);
        // Only names that are in the manifest exist. Nothing is read from disk by path.
        if (!Object.hasOwn(m.files, path)) return send(404, "text/plain", `${path} is not in this package`);
        const data = await pkg.read(path);
        const type = mimeOf(path);
        if (type.startsWith("text/html")) return send(200, type, injectRuntime(data.toString("utf8")), true);
        send(200, type, data);
      } catch (e) {
        send(500, "text/plain", (e as Error).message);
      }
    })();
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port ?? 0, "127.0.0.1", () => res());
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------------------------------------------------------------- android

export interface HostBuildOptions {
  consent?: Consent;
  install?: boolean;
  log?: (m: string) => void;
  signal?: AbortSignal;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Copy the host project somewhere writable (the installed package may be read-only) and build it. */
async function buildHost(workDir: string, gradleProps: Record<string, string>, o: HostBuildOptions): Promise<BuildResult> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(dirname(workDir), { recursive: true });
  await cp(join(runtimeDir(), "android"), workDir, { recursive: true, filter: (src) => !/[\\/](build|\.gradle)([\\/]|$)/.test(src.slice(runtimeDir().length)) });
  await cp(join(runtimeDir(), "shared"), join(dirname(workDir), "shared"), { recursive: true });
  const props = Object.entries(gradleProps).map(([k, v]) => `${k}=${v.replace(/\\/g, "/")}`).join("\n");
  if (props) await writeFile(join(workDir, "gradle.properties"), `${await readFile(join(workDir, "gradle.properties"), "utf8")}\n${props}\n`);
  return build({ dir: workDir, install: o.install, consent: o.consent, log: o.log, signal: o.signal });
}

function hostBuildError(r: BuildResult): TappError {
  return new TappError("UNSUPPORTED", `The Android runtime could not be built: ${r.error?.category}: ${r.error?.message}${r.error?.hints.length ? ` (${r.error.hints[0]})` : ""}`);
}

/** The runtime APK, built once and kept in ~/.tethertrace/runtime. */
export async function ensureAndroidHost(o: HostBuildOptions = {}): Promise<string> {
  const dir = join(homeDir(), "runtime");
  const apk = join(dir, `tapp-host-${ANDROID_HOST_VERSION}.apk`);
  if (await exists(apk)) return apk;
  o.log?.("Building the Android runtime (once)…");
  const work = join(dir, "build", "android");
  const r = await buildHost(work, {}, o);
  if (!r.ok || !r.artifacts[0]) throw hostBuildError(r);
  await cp(r.artifacts[0].path, apk);
  return apk;
}

export interface AndroidRunResult {
  package: string;
  hostInstalled: boolean;
  launchTimeMs?: number;
}

/**
 * Run a package on a phone: install the runtime if it is not there, hand the package to it, and
 * start it. The runtime verifies the package again on the phone before showing anything.
 */
export async function runOnAndroid(d: Device, pkg: VerifiedTapp, o: HostBuildOptions & { hostApk?: string } = {}): Promise<AndroidRunResult> {
  let hostInstalled = false;
  const current = (await d.shell(`dumpsys package ${ANDROID_HOST_PACKAGE} | grep versionName`)).text;
  if (!current.includes(`versionName=${ANDROID_HOST_VERSION}`)) {
    const apk = o.hostApk ?? (await ensureAndroidHost(o));
    o.log?.("Installing the tapp runtime on the phone…");
    await d.install(apk);
    hostInstalled = true;
  }
  const name = `${pkg.manifest.id}.tapp`;
  const data = await readFile(pkg.file);
  o.log?.(`Sending ${basename(pkg.file)} (${Math.max(1, Math.round(data.length / 1024))} KB)…`);
  await d.forceStop(ANDROID_HOST_PACKAGE);
  // The runtime's private folder is only reachable as the runtime itself; run-as allows that for a
  // debuggable build. `head -c` ends after exactly the bytes we announce, then reports back.
  const out = await d.pushAs(ANDROID_HOST_PACKAGE, `files/incoming/${name}`, data);
  if (!out.includes("TAPP_SENT")) throw new AdbError("PROTOCOL", `The phone did not accept the package: ${out.trim().slice(0, 300) || "no answer"}`);
  const started = (await d.shell(`am start -W -n ${ANDROID_HOST_PACKAGE}/.MainActivity --activity-clear-task --es tapp incoming/${name}`)).text;
  if (/Error|Exception/.test(started)) throw new AdbError("PROTOCOL", `The runtime did not start: ${started.trim().slice(0, 300)}`);
  const t = /TotalTime:\s*(\d+)/.exec(started)?.[1];
  return { package: ANDROID_HOST_PACKAGE, hostInstalled, launchTimeMs: t ? Number(t) : undefined };
}

/**
 * Turn a package into a standalone Android app: the same runtime with the package inside it, under
 * the package's own id and name. This is a normal Gradle build of the host project.
 */
export async function convertToApk(pkg: VerifiedTapp, outFile: string, o: HostBuildOptions = {}): Promise<{ file: string; applicationId: string }> {
  const work = await mkdtemp(join(tmpdir(), "tapp-apk-"));
  try {
    const embed = join(work, "embed");
    await mkdir(embed, { recursive: true });
    await cp(pkg.file, join(embed, "app.tapp"));
    const m = pkg.manifest;
    const r = await buildHost(join(work, "android"), { tappId: m.id, tappName: m.name.replace(/[\r\n]/g, " "), tappVersion: m.version, tappEmbed: embed }, o);
    if (!r.ok || !r.artifacts[0]) throw hostBuildError(r);
    await mkdir(dirname(outFile), { recursive: true });
    await cp(r.artifacts[0].path, outFile);
    return { file: outFile, applicationId: m.id };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Why a package cannot be run on iOS by this version, and what would be needed. Never a success. */
export const IOS_NOT_IMPLEMENTED = [
  "Running on iOS is not implemented, and nothing here has been tested on an iPhone.",
  "What it needs: an iOS host app (WKWebView, the same checks and the same window.tapp API), built and signed with an Apple-issued certificate.",
  "Signing needs an Apple developer account; installing needs a Mac with Xcode, or a tool such as xtool with that account.",
  "Apple's review rules allow HTML5 and JavaScript mini apps but limit which native features a host may expose to them.",
  "Until then the same package runs in Safari as a web app if you host its files, without the tapp API.",
].join("\n");
