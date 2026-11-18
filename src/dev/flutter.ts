import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree, runCapture, spawnTool } from "./proc.js";

/**
 * Talks to `flutter run --machine`, the JSON-RPC mode Flutter's own IDE plugins use, to hot
 * reload and hot restart. Flutter drives the phone through its own adb, so this only works when
 * `flutter devices` lists the phone (for example after `adb connect`). When it does not, the dev
 * session falls back to rebuilding and reinstalling, and says so.
 *
 * Protocol: https://github.com/flutter/flutter/blob/master/packages/flutter_tools/doc/daemon.md
 */

export interface FlutterDevice {
  id: string;
  name: string;
  targetPlatform: string;
}

/** Android devices from `flutter devices --machine` (output can have log lines before the JSON). */
export function parseFlutterDevices(stdout: string): FlutterDevice[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  try {
    const list = JSON.parse(stdout.slice(start)) as FlutterDevice[];
    return list.filter((d) => typeof d.id === "string" && String(d.targetPlatform ?? "").startsWith("android"));
  } catch {
    return [];
  }
}

/** The Flutter device that is the phone tethertrace is connected to: same address, else the only Android device. */
export function matchFlutterDevice(devices: FlutterDevice[], address: string | undefined, serialNo?: string): FlutterDevice | undefined {
  const exact = devices.find((d) => d.id === address || (serialNo && d.id === serialNo) || (address && d.id.startsWith(`adb-${serialNo ?? "\0"}`)));
  if (exact) return exact;
  return devices.length === 1 ? devices[0] : undefined;
}

export async function flutterDevices(flutter: string, cwd: string): Promise<FlutterDevice[]> {
  const r = await runCapture(flutter, ["devices", "--machine"], { cwd, timeoutMs: 60_000 });
  return r.code === 0 ? parseFlutterDevices(r.stdout) : [];
}

export interface ReloadResult {
  ok: boolean;
  message: string;
  /** Flutter said a hot restart is needed for this change. */
  restartRecommended?: boolean;
}

type Pending = { resolve: (v: { code?: number; message?: string; error?: unknown }) => void; timer: NodeJS.Timeout };

/** One `flutter run --machine` process for one app on one device. */
export class FlutterRunSession {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  appId?: string;
  /** Last lines of Flutter's own output, for error reports. */
  readonly tail: string[] = [];
  exited?: { code: number | null };
  private started?: Promise<void>;

  constructor(
    private readonly flutter: string,
    private readonly cwd: string,
    readonly deviceId: string,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  /** Builds, installs and launches through Flutter; resolves once the app is running. */
  start(timeoutMs = 15 * 60_000): Promise<void> {
    if (this.started) return this.started;
    this.started = new Promise<void>((resolve, reject) => {
      if (!/^[\w.:@\-]+$/.test(this.deviceId)) return reject(new Error(`Unexpected Flutter device id ${JSON.stringify(this.deviceId)}`));
      const child = spawnTool(this.flutter, ["run", "--machine", "-d", this.deviceId], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      const timer = setTimeout(() => reject(new Error(`flutter run did not start the app within ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
      const keep = (l: string) => {
        this.tail.push(l);
        if (this.tail.length > 80) this.tail.shift();
      };
      createInterface({ input: child.stderr! }).on("line", keep);
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const msgs = parseDaemonLine(line);
        if (!msgs) return keep(line);
        for (const m of msgs) {
          if (typeof m.id === "number" && this.pending.has(m.id)) {
            const p = this.pending.get(m.id)!;
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            const res = (m.result ?? {}) as { code?: number; message?: string };
            p.resolve({ code: res.code, message: res.message, error: m.error });
          } else if (m.event === "app.start") {
            this.appId = (m.params as { appId?: string })?.appId;
          } else if (m.event === "app.started") {
            clearTimeout(timer);
            resolve();
          } else if (m.event === "app.progress" || m.event === "daemon.logMessage") {
            const msg = (m.params as { message?: string })?.message;
            if (msg) {
              keep(msg);
              this.log(msg);
            }
          } else if (m.event === "app.log") {
            const msg = (m.params as { log?: string })?.log;
            if (msg) keep(msg);
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        this.exited = { code };
        clearTimeout(timer);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ error: "flutter run exited" });
        }
        this.pending.clear();
        reject(new Error(`flutter run exited (code ${code}) before the app started:\n${this.tail.slice(-15).join("\n")}`));
      });
    });
    return this.started;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 120_000) {
    return new Promise<{ code?: number; message?: string; error?: unknown }>((resolve) => {
      if (!this.child?.stdin || this.exited) return resolve({ error: "flutter run is not running" });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: `no answer to ${method} within ${timeoutMs / 1000} s` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify([{ id, method, params }])}\n`);
    });
  }

  /** Hot reload (fullRestart false) or hot restart (true). Success only when Flutter answers code 0. */
  async restart(fullRestart: boolean): Promise<ReloadResult> {
    if (!this.appId) return { ok: false, message: "Flutter has not reported the app id yet" };
    const r = await this.request("app.restart", { appId: this.appId, fullRestart, pause: false, reason: "manual" });
    if (r.error !== undefined) return { ok: false, message: typeof r.error === "string" ? r.error : JSON.stringify(r.error) };
    const message = r.message ?? (r.code === 0 ? "done" : `code ${r.code}`);
    return { ok: r.code === 0, message, restartRecommended: r.code !== 0 && /restart/i.test(message) };
  }

  get running() {
    return Boolean(this.child) && !this.exited;
  }

  async stop() {
    if (!this.child || this.exited) return;
    if (this.appId) await this.request("app.stop", { appId: this.appId }, 5_000);
    if (!this.exited) await killTree(this.child);
  }
}

/** A daemon line is a JSON array wrapped in [ ]; anything else is plain output. */
export function parseDaemonLine(line: string): Record<string, unknown>[] | undefined {
  const t = line.trim();
  if (!t.startsWith("[{") || !t.endsWith("}]")) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>[];
  } catch {
    return undefined;
  }
}
