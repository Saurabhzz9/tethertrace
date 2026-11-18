import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homeDir } from "../adb/keys.js";
import { build as runBuild, pickArtifact, selectProject, type BuildOptions, type BuildResult } from "../build.js";
import { assertPackage, type Device } from "../device.js";
import { sha256 } from "../memory.js";
import type { DetectedProject } from "../project/detect.js";
import { classify, filterAppLog, type SmokeVerdict } from "../smoke.js";
import { describeVerify, findFlows, verify, type VerifySummary } from "../verify.js";
import { flutterDevices, FlutterRunSession, matchFlutterDevice } from "./flutter.js";
import { httpText, which } from "./proc.js";
import { ProjectWatcher, type FileChange } from "./watch.js";

/**
 * `tethertrace dev`: watch a project, apply each batch of edits to the phone with the fastest
 * mechanism that really works for it, then check the running app.
 *
 * Mechanisms, and what each one proves:
 *  - hot-reload / hot-restart: Flutter's own `flutter run --machine` answered code 0.
 *  - metro: Metro is serving the project and pushes the change; tethertrace does not see whether
 *    the app accepted it, and reports it as unconfirmed.
 *  - reinstall: the project's own build ran, the APK was installed and the app restarted.
 */

export type Mechanism = "hot-reload" | "hot-restart" | "metro" | "reinstall" | "none";
export type VerifyLevel = "off" | "smoke" | "changed" | "full";
export type CycleVerdict = "passed" | "failed" | "blocked" | "inconclusive" | "not_run";
export type DevMode = "flutter-daemon" | "metro" | "rebuild";

export interface UpdatePlan {
  mechanism: Mechanism;
  reason: string;
}

/** Which mechanism a batch of changes needs. Pure, so it can be tested without a phone. */
export function planUpdate(mode: DevMode, changes: FileChange[]): UpdatePlan {
  const heavy = changes.filter((c) => c.kind !== "source");
  const isCode = (c: FileChange) => /\.(dart|[cm]?[jt]sx?)$/.test(c.path);
  if (mode === "flutter-daemon") {
    if (heavy.length) return { mechanism: "reinstall", reason: `${heavy[0]!.path} (${heavy[0]!.kind}) is not applied by hot reload; rebuilding` };
    if (changes.some((c) => c.event !== "modified" && isCode(c))) return { mechanism: "hot-restart", reason: "files were added or removed; hot restart reloads the whole Dart program" };
    return { mechanism: "hot-reload", reason: "Dart/asset change; Flutter hot reload keeps app state" };
  }
  if (mode === "metro") {
    if (heavy.length) return { mechanism: "reinstall", reason: `${heavy[0]!.path} (${heavy[0]!.kind}) changes the native app; Metro cannot apply it` };
    if (changes.every(isCode)) return { mechanism: "metro", reason: "JavaScript change; Metro serves it to the app (Fast Refresh)" };
    return { mechanism: "metro", reason: "asset change; Metro serves it" };
  }
  return { mechanism: "reinstall", reason: "rebuild with the project's own build, reinstall, restart" };
}

/**
 * Runs one job at a time. Items pushed while a job runs are merged and run once afterwards, so a
 * burst of saves never starts overlapping builds that would write the same output.
 */
export class CoalescingQueue<T> {
  private pending: T[] = [];
  private running?: Promise<void>;
  private stopped = false;

  constructor(private readonly job: (items: T[]) => Promise<void>, private readonly key: (t: T) => string = (t) => JSON.stringify(t)) {}

  push(items: T[]) {
    if (this.stopped) return;
    const seen = new Map(this.pending.map((p) => [this.key(p), p] as const));
    for (const i of items) seen.set(this.key(i), i);
    this.pending = [...seen.values()];
    if (!this.running) this.running = this.drain();
  }

  private async drain() {
    while (this.pending.length && !this.stopped) {
      const batch = this.pending;
      this.pending = [];
      await this.job(batch).catch(() => undefined);
    }
    this.running = undefined;
  }

  get busy() {
    return Boolean(this.running);
  }

  get queued() {
    return this.pending.length;
  }

  /** Resolves when nothing is running or queued. */
  async idle() {
    while (this.running) await this.running;
  }

  stop() {
    this.stopped = true;
    this.pending = [];
  }
}

export interface CycleRecord {
  n: number;
  startedAt: string;
  durationMs: number;
  changes: { count: number; files: string[]; kinds: Record<string, number> };
  plan: UpdatePlan;
  /** What actually happened, which can differ from the plan (fallbacks). */
  mechanism: Mechanism;
  update: { ok: boolean; confirmed: boolean; message: string };
  build?: { ok: boolean; durationMs: number; artifact?: string; sha256?: string; packageName?: string; versionName?: string; error?: BuildResult["error"]; logFile?: string };
  health?: { verdict: SmokeVerdict | "device_disconnected"; reason: string; evidence: string[] };
  verification?: { mode: string; passed: number; failed: number; notRun: number; flows: { file: string; status: string; reason?: string }[]; report: string };
  evidence: string[];
  verdict: CycleVerdict;
  summary: string;
  nextAction?: string;
}

export interface DevSnapshot {
  pid: number;
  root: string;
  project?: { name: string; kind: string };
  device?: string;
  mode?: DevMode;
  pkg?: string;
  verify: VerifyLevel;
  state: "starting" | "idle" | "updating" | "stopped" | "failed";
  startedAt: string;
  cycles: number;
  queued: number;
  last?: CycleRecord;
  notes: string[];
}

/** The parts of a phone the dev session uses; a real `Device` has them all. */
export type DevDevice = Pick<Device, "logMark" | "logsSince" | "pidOf" | "install" | "forceStop" | "launch" | "screenshotPng" | "shell" | "close">;

export interface DevOptions {
  dir: string;
  /** Opens a connection to the phone. Called again after a disconnect. */
  connect: () => Promise<DevDevice>;
  deviceAddress?: string;
  pkg?: string;
  module?: string;
  variant?: string;
  verify?: VerifyLevel;
  flows?: string[];
  /** How long to watch the app after an update before judging it. */
  healthWaitMs?: number;
  screenshot?: boolean;
  debounceMs?: number;
  /** Try `flutter run --machine` for Flutter projects (default true). */
  flutterDaemon?: boolean;
  /** Build/install once at start (default true). */
  initialDeploy?: boolean;
  home?: string;
  log?: (m: string) => void;
  onCycle?: (c: CycleRecord) => void;
  /** Replaces the project build; tests use it. */
  buildFn?: (o: BuildOptions) => Promise<BuildResult>;
  metroUrl?: string;
}

/** Folder for one project's session state: lock, stop request, history. */
export function sessionDir(root: string, home = homeDir()) {
  return join(home, "dev", sha256(resolve(root).toLowerCase()).slice(0, 16));
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readSnapshot(root: string, home?: string): Promise<(DevSnapshot & { stale: boolean }) | undefined> {
  try {
    const s = JSON.parse(await readFile(join(sessionDir(root, home), "state.json"), "utf8")) as DevSnapshot;
    return { ...s, stale: s.state !== "stopped" && !pidAlive(s.pid) };
  } catch {
    return undefined;
  }
}

export async function readHistory(root: string, limit = 20, home?: string): Promise<CycleRecord[]> {
  try {
    const lines = (await readFile(join(sessionDir(root, home), "history.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as CycleRecord);
  } catch {
    return [];
  }
}

/** Ask a running session (any process) to stop. It checks for the request every second. */
export async function requestStop(root: string, home?: string): Promise<(DevSnapshot & { stale: boolean }) | undefined> {
  const s = await readSnapshot(root, home);
  if (!s || s.stale || s.state === "stopped") return s;
  await writeFile(join(sessionDir(root, home), "stop"), String(Date.now()));
  return s;
}

/** Verdict for a cycle from its parts. Never "passed" unless something on the phone was checked. */
export function cycleVerdict(c: Pick<CycleRecord, "update" | "health" | "verification">): CycleVerdict {
  if (!c.update.ok) return c.health?.verdict === "device_disconnected" ? "blocked" : "failed";
  if (c.health?.verdict === "device_disconnected") return "blocked";
  if (c.health && (c.health.verdict === "app_crash" || c.health.verdict === "anr" || c.health.verdict === "launch_failed" || c.health.verdict === "install_failed")) return "failed";
  if (c.verification?.failed) return "failed";
  if (c.health?.verdict === "app_exited") return "inconclusive";
  if (!c.health && !c.verification) return "not_run";
  if (!c.update.confirmed) return "inconclusive";
  return "passed";
}

export function describeCycle(c: CycleRecord): string {
  const L = [c.changes.count ? `#${c.n} ${c.changes.count} change(s): ${c.changes.files.slice(0, 3).join(", ")}${c.changes.count > 3 ? ", …" : ""}` : `#${c.n} first deploy`];
  L.push(`  Update: ${c.mechanism}${c.mechanism !== c.plan.mechanism ? ` (planned ${c.plan.mechanism})` : ""} — ${c.update.ok ? (c.update.confirmed ? "applied" : "sent, not confirmed") : "FAILED"}: ${c.update.message}`);
  if (c.build?.error) for (const l of c.build.error.excerpt.slice(0, 8)) L.push(`    ${l}`);
  if (c.health) L.push(`  App health: ${c.health.verdict} — ${c.health.reason}`);
  for (const e of c.health?.evidence.slice(0, 5) ?? []) L.push(`    ${e}`);
  if (c.verification) {
    L.push(`  Verification (${c.verification.mode}): ${c.verification.passed} passed, ${c.verification.failed} failed, ${c.verification.notRun} not run`);
    for (const f of c.verification.flows.filter((f) => f.status !== "passed").slice(0, 6)) L.push(`    ${f.status.toUpperCase()} ${f.file}${f.reason ? `: ${f.reason}` : ""}`);
  }
  for (const e of c.evidence.slice(0, 4)) L.push(`  Evidence: ${e}`);
  L.push(`  Verdict: ${c.verdict.toUpperCase()} (${(c.durationMs / 1000).toFixed(1)} s)`);
  if (c.nextAction) L.push(`  Next: ${c.nextAction}`);
  return L.join("\n");
}

export class DevSession {
  readonly root: string;
  readonly dir: string;
  private project?: DetectedProject;
  private watcher?: ProjectWatcher;
  private queue: CoalescingQueue<FileChange>;
  private device?: DevDevice;
  private flutter?: FlutterRunSession;
  private flutterBin?: string;
  private abort = new AbortController();
  private stopTimer?: NodeJS.Timeout;
  private n = 0;
  private done!: Promise<void>;
  private finish!: () => void;
  readonly snap: DevSnapshot;
  readonly history: CycleRecord[] = [];
  private readonly log: (m: string) => void;

  constructor(private readonly o: DevOptions) {
    this.root = resolve(o.dir);
    this.dir = sessionDir(this.root, o.home);
    this.log = o.log ?? (() => undefined);
    this.queue = new CoalescingQueue<FileChange>((b) => this.cycle(b), (c) => c.path);
    this.snap = { pid: process.pid, root: this.root, verify: o.verify ?? "smoke", state: "starting", startedAt: new Date().toISOString(), cycles: 0, queued: 0, notes: [], device: o.deviceAddress };
    this.done = new Promise((r) => (this.finish = r));
  }

  private async save() {
    this.snap.queued = this.queue.queued;
    await writeFile(join(this.dir, "state.json"), JSON.stringify(this.snap, null, 2)).catch(() => undefined);
  }

  private note(m: string) {
    this.snap.notes.push(m);
    this.log(m);
  }

  /** Detect, deploy once, then watch. Resolves after the first deploy; `wait()` resolves on stop. */
  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const prev = await readSnapshot(this.root, this.o.home);
    if (prev && !prev.stale && prev.state !== "stopped") throw new Error(`A dev session is already running for ${this.root} (pid ${prev.pid}). Stop it with: tethertrace dev stop --project "${this.root}"`);
    if (prev?.stale) this.log(`Recovered from an interrupted session (pid ${prev.pid} is gone).`);
    await rm(join(this.dir, "stop"), { force: true });
    await this.save();

    this.project = await selectProject(this.root, "android");
    this.snap.project = { name: this.project.name, kind: this.project.kind };
    this.o.pkg ??= this.project.android?.modules.find((m) => m.applicationId && (!this.o.module || m.path === this.o.module))?.applicationId;
    if (this.o.pkg) assertPackage(this.o.pkg);
    this.snap.pkg = this.o.pkg;
    this.snap.mode = await this.chooseMode();
    await this.save();

    this.stopTimer = setInterval(() => {
      readFile(join(this.dir, "stop")).then(() => void this.stop("stop requested"), () => undefined);
    }, 1_000);

    if (this.o.initialDeploy !== false) await this.cycle([], true);
    this.watcher = new ProjectWatcher(this.root, { debounceMs: this.o.debounceMs, onBatch: (c) => this.queue.push(c), onError: (e) => this.note(`watcher: ${e.message}`) });
    await this.watcher.start();
    this.snap.state = "idle";
    await this.save();
  }

  private async chooseMode(): Promise<DevMode> {
    const kind = this.project!.kind;
    if (kind === "flutter" && this.o.flutterDaemon !== false) {
      this.flutterBin = process.env.FLUTTER_ROOT ? join(process.env.FLUTTER_ROOT, "bin", process.platform === "win32" ? "flutter.bat" : "flutter") : await which("flutter");
      if (!this.flutterBin) {
        this.note("Flutter SDK not on PATH: hot reload is off; each change rebuilds and reinstalls the APK.");
        return "rebuild";
      }
      const serial = await this.dev()
        .then((d) => d.shell("getprop ro.serialno"))
        .then((s) => s.text.trim(), () => undefined);
      const fd = matchFlutterDevice(await flutterDevices(this.flutterBin, this.root), this.o.deviceAddress, serial);
      if (!fd) {
        this.note("Flutter does not see this phone (Flutter uses its own adb; run `adb connect <phone>` if you have platform-tools). Hot reload is off; each change rebuilds and reinstalls.");
        return "rebuild";
      }
      this.flutter = new FlutterRunSession(this.flutterBin, this.root, fd.id, (m) => this.log(`flutter: ${m}`));
      this.note(`Hot reload through flutter run on ${fd.name} (${fd.id}).`);
      return "flutter-daemon";
    }
    if (kind === "react-native") {
      const status = await httpText(`${this.o.metroUrl ?? "http://127.0.0.1:8081"}/status`);
      if (status?.includes("packager-status:running")) {
        this.note("Metro is running: JavaScript changes go through Fast Refresh. The phone must reach Metro (dev menu → Change bundle location → <this computer's LAN IP>:8081). tethertrace cannot confirm the app applied a refresh; it checks the app is still healthy.");
        return "metro";
      }
      this.note("Metro is not running on :8081, so Fast Refresh is off and each change rebuilds and reinstalls. Debug builds load JavaScript from Metro; start it with `npx react-native start` (or `npx expo start`).");
    }
    return "rebuild";
  }

  private async dev(): Promise<DevDevice> {
    if (!this.device) this.device = await this.o.connect();
    return this.device;
  }

  private dropDevice() {
    try {
      this.device?.close();
    } catch {
      /* already gone */
    }
    this.device = undefined;
  }

  private async cycle(changes: FileChange[], initial = false) {
    const n = ++this.n;
    const t0 = Date.now();
    this.snap.state = "updating";
    await this.save();
    const mode = this.snap.mode!;
    const plan: UpdatePlan = initial
      ? { mechanism: mode === "flutter-daemon" ? "hot-restart" : "reinstall", reason: "first deploy of this session" }
      : planUpdate(mode, changes);
    const kinds: Record<string, number> = {};
    for (const c of changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    const out = join(this.root, "build", "tethertrace", "dev", `${new Date().toISOString().replace(/[:.]/g, "-")}-${n}`);
    await mkdir(out, { recursive: true });
    const rec: CycleRecord = {
      n,
      startedAt: new Date(t0).toISOString(),
      durationMs: 0,
      changes: { count: changes.length, files: changes.map((c) => `${c.event === "modified" ? "" : `${c.event} `}${c.path}`), kinds },
      plan,
      mechanism: plan.mechanism,
      update: { ok: false, confirmed: false, message: "" },
      evidence: [],
      verdict: "not_run",
      summary: "",
    };
    this.log(`\n${initial ? "Deploying" : `Change #${n}`}: ${plan.reason}`);
    let mark: string | undefined;
    try {
      const d = await this.dev().catch((e: Error) => {
        throw Object.assign(e, { disconnected: true });
      });
      mark = await d.logMark();
      await this.apply(rec, initial);
      if (rec.update.ok && this.snap.verify !== "off") await this.check(rec, mark, out);
    } catch (e) {
      const err = e as Error & { disconnected?: boolean };
      const disconnected = err.disconnected || /closed|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|offline|not connected/i.test(err.message);
      if (disconnected) {
        this.dropDevice();
        rec.health = { verdict: "device_disconnected", reason: `Lost the phone: ${err.message}. Will reconnect on the next change.`, evidence: [] };
        rec.nextAction = "Unlock the phone and check Wireless debugging is on and the phone is on the same Wi-Fi; save a file to retry.";
      }
      if (!rec.update.message) rec.update.message = err.message;
      else if (!disconnected) rec.update = { ...rec.update, ok: false, message: `${rec.update.message}; then: ${err.message}` };
      if (!rec.health || rec.health.verdict !== "device_disconnected") rec.update.ok = false;
    }
    rec.durationMs = Date.now() - t0;
    rec.verdict = cycleVerdict(rec);
    rec.nextAction ??= nextAction(rec);
    rec.summary = `${rec.mechanism} ${rec.update.ok ? "ok" : "failed"}; ${rec.verdict}`;
    this.history.push(rec);
    if (this.history.length > 50) this.history.shift();
    this.snap.cycles = n;
    this.snap.last = rec;
    this.snap.state = (this.snap.state as DevSnapshot["state"]) === "stopped" ? "stopped" : "idle";
    await appendFile(join(this.dir, "history.jsonl"), `${JSON.stringify(rec)}\n`).catch(() => undefined);
    await writeFile(join(out, "cycle.json"), JSON.stringify(rec, null, 2)).catch(() => undefined);
    await this.save();
    this.o.onCycle?.(rec);
  }

  /** Apply the change with the planned mechanism, falling back where that is safe. */
  private async apply(rec: CycleRecord, initial: boolean) {
    if (this.flutter) {
      if (initial || !this.flutter.running || rec.plan.mechanism === "reinstall") {
        if (this.flutter.running) await this.flutter.stop();
        if (!initial) this.flutter = new FlutterRunSession(this.flutterBin!, this.root, this.flutter.deviceId, (m) => this.log(`flutter: ${m}`));
        rec.mechanism = "reinstall";
        try {
          await this.flutter.start();
          rec.update = { ok: true, confirmed: true, message: "flutter run built, installed and started the app" };
        } catch (e) {
          rec.update = { ok: false, confirmed: false, message: (e as Error).message };
        }
        return;
      }
      let r = await this.flutter.restart(rec.plan.mechanism === "hot-restart");
      rec.mechanism = rec.plan.mechanism;
      if (!r.ok && rec.plan.mechanism === "hot-reload" && r.restartRecommended) {
        this.log(`Hot reload not possible (${r.message}); trying hot restart.`);
        r = await this.flutter.restart(true);
        rec.mechanism = "hot-restart";
      }
      rec.update = { ok: r.ok, confirmed: r.ok, message: r.ok ? `Flutter: ${r.message}` : `Flutter rejected the update: ${r.message}\n${this.flutter.tail.slice(-10).join("\n")}` };
      return;
    }
    if (rec.plan.mechanism === "metro") {
      rec.update = { ok: true, confirmed: false, message: "Metro serves the new bundle; whether the app applied it is not visible to tethertrace" };
      return;
    }
    // Rebuild and reinstall.
    const b = await (this.o.buildFn ?? runBuild)({ dir: this.root, platform: "android", module: this.o.module, variant: this.o.variant, signal: this.abort.signal, log: (m) => this.log(m) });
    const art = pickArtifact(b.artifacts);
    rec.build = { ok: b.ok, durationMs: b.durationMs, error: b.error, logFile: b.logFile, artifact: art?.path, packageName: art?.packageName, versionName: art?.versionName };
    if (!b.ok || !art) {
      rec.update = { ok: false, confirmed: false, message: b.error ? `${b.error.category}: ${b.error.message}` : "the build produced no APK" };
      return;
    }
    rec.build.sha256 = sha256(await readFile(art.path));
    if (!this.o.pkg && art.packageName) {
      assertPackage(art.packageName);
      this.o.pkg = this.snap.pkg = art.packageName;
    }
    if (art.packageName && this.o.pkg && art.packageName !== this.o.pkg) throw new Error(`The build produced ${art.packageName}, not ${this.o.pkg}; refusing to install a different app`);
    const d = await this.dev();
    this.log(`Installing ${art.path}…`);
    await d.install(art.path);
    await d.forceStop(this.o.pkg!);
    await d.launch(this.o.pkg!);
    rec.update = { ok: true, confirmed: true, message: `built in ${(b.durationMs / 1000).toFixed(0)} s, installed and restarted ${this.o.pkg}` };
  }

  /** Is the app alive and crash-free after the update; then the selected flows. */
  private async check(rec: CycleRecord, mark: string, out: string) {
    const pkg = this.o.pkg;
    if (!pkg) {
      rec.health = undefined;
      rec.update.message += " (app id unknown, so the app was not checked; pass --package)";
      return;
    }
    const d = await this.dev();
    await new Promise((r) => setTimeout(r, this.o.healthWaitMs ?? 4_000));
    const pid = await d.pidOf(pkg);
    const appLog = filterAppLog(await d.logsSince(mark, "main"), pkg, pid ? [pid] : []);
    const crashLog = await d.logsSince(mark, "crash");
    const h = classify({ pkg, pid, appLog, crashLog });
    rec.health = h;
    if (h.evidence.length || h.verdict !== "no_crash_observed") {
      await writeFile(join(out, "app.log"), appLog + (crashLog ? `\n--- crash buffer ---\n${crashLog}` : ""));
      rec.evidence.push(join(out, "app.log"));
    }
    if (this.o.screenshot || h.verdict !== "no_crash_observed") {
      try {
        await writeFile(join(out, "screen.png"), await d.screenshotPng());
        rec.evidence.push(join(out, "screen.png"));
      } catch {
        /* screen may be locked */
      }
    }
    const level = this.snap.verify;
    if ((level === "changed" || level === "full") && h.verdict === "no_crash_observed") {
      const where = this.o.flows?.length ? this.o.flows : [join(this.root, "flows")];
      const { flows } = await findFlows(where).catch(() => ({ flows: [] }));
      if (!flows.length) {
        rec.verification = { mode: level, passed: 0, failed: 0, notRun: 0, flows: [], report: "" };
        rec.update.message += "; no flow files found, so no flows ran (add flows/*.yaml)";
        return;
      }
      const s: VerifySummary = await verify(d as Device, { pkg, mode: level, flows, outDir: join(out, "verify"), projectDir: this.root, explore: false, log: (m) => this.log(m) });
      const results = s.flows ?? [];
      rec.verification = {
        mode: level,
        passed: results.filter((f) => f.status === "passed").length,
        failed: results.filter((f) => f.status === "failed").length,
        notRun: results.filter((f) => f.status === "not_run").length,
        flows: results.map((f) => ({ file: f.file, status: f.status, reason: f.reason })),
        report: join(out, "verify"),
      };
      this.log(describeVerify(s));
    }
  }

  async stop(reason = "stopped") {
    if (this.snap.state === "stopped") return;
    this.log(`Stopping dev session (${reason})…`);
    this.snap.state = "stopped";
    clearInterval(this.stopTimer);
    this.watcher?.close();
    this.queue.stop();
    this.abort.abort();
    await this.queue.idle().catch(() => undefined);
    await this.flutter?.stop().catch(() => undefined);
    this.dropDevice();
    await rm(join(this.dir, "stop"), { force: true });
    await this.save();
    this.finish();
  }

  /** Resolves when the session stops. */
  wait() {
    return this.done;
  }
}

function nextAction(c: CycleRecord): string | undefined {
  if (c.build?.error) return c.build.error.hints[0] ?? `Fix the ${c.build.error.category} error above, then save again.`;
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/.test(c.update.message)) return "The phone has a newer version of this app (higher versionCode). Raise versionCode in the build, or uninstall the app on the phone yourself (this deletes its data); tethertrace never uninstalls on its own.";
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(c.update.message)) return "The installed app is signed with a different key (e.g. a Play Store build). Uninstall it on the phone yourself (this deletes its data) to install this build.";
  if (!c.update.ok) return "Fix the error above and save again; the session keeps watching.";
  if (c.health?.verdict === "app_crash") return "Open the crash lines in app.log; the first 'Caused by' names the failing code.";
  if (c.health?.verdict === "anr") return "The main thread is blocked; look for slow work on the UI thread in the changed files.";
  if (c.verification?.failed) return "Open the failing flow's report (screenshot and UI tree at the failed step).";
  return undefined;
}
