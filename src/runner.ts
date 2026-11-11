import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { AdbError } from "./adb/connection.js";
import { assertPackage, describe, SelectorError, visibleLabels, type Device, type Selector } from "./device.js";
import { classify, filterAppLog, formatNodes } from "./smoke.js";

/**
 * Deterministic flow runner. A flow is YAML:
 *
 *   app: com.example.app
 *   name: login
 *   steps:
 *     - launch                      # cold start (force-stop first)
 *     - tap: "Sign in"              # visible text / description
 *     - tap: { id: email, index: 0 }
 *     - type: "user@example.com"    # ASCII only; use ${ENV_VAR} for secrets
 *     - key: enter
 *     - waitFor: "Home"             # optional timeoutMs on the step
 *     - assertVisible: "Welcome"
 *     - assertHidden: "Loading"
 *     - scroll: down
 *     - sleep: 1000
 *     - screenshot: home
 *     - back
 */

export type FailureCategory = "element_not_found" | "assertion_failed" | "ambiguous_selector" | "app_crash" | "anr" | "app_exited" | "device_disconnected" | "timeout" | "unsupported_step" | "unknown";

export interface StepRecord {
  index: number;
  step: string;
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface RunSummary {
  tool: "tethertrace";
  schemaVersion: "0.1";
  kind: "flow";
  name: string;
  package: string;
  startedAt: string;
  status: "passed" | "failed";
  failure?: { step: number; category: FailureCategory; message: string; evidence: string[]; visibleOnScreen?: string[] };
  device: { manufacturer: string; model: string; androidVersion: string; sdk?: number };
  launchTimeMs?: number;
  steps: StepRecord[];
  files: string[];
  privacy: string;
}

type Step = Record<string, unknown> | string;

export interface Flow {
  app: string;
  name: string;
  steps: Step[];
}

export async function loadFlow(path: string): Promise<Flow> {
  const doc = YAML.parse(await readFile(path, "utf8")) as Partial<Flow> | null;
  if (!doc || typeof doc.app !== "string") throw new Error(`${path}: missing "app: <package>"`);
  assertPackage(doc.app);
  if (!Array.isArray(doc.steps) || !doc.steps.length) throw new Error(`${path}: "steps" must be a non-empty list`);
  return { app: doc.app, name: String(doc.name ?? path.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/, "")), steps: doc.steps as Step[] };
}

function stepName(step: Step) {
  if (typeof step === "string") return step;
  const [k, v] = Object.entries(step)[0] ?? ["?", ""];
  return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
}

function redactedStepName(step: Step) {
  // Never write typed values into reports; they may be passwords.
  if (typeof step === "object" && "type" in step) return "type: <redacted>";
  return stepName(step);
}

function expandEnv(s: string) {
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}

function asSelector(v: unknown): Selector {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const sel: Record<string, unknown> = {};
    for (const k of ["text", "desc", "id", "contains"]) if (typeof o[k] === "string") sel[k] = o[k];
    if (typeof o.index === "number") sel.index = o.index;
    if (Object.keys(sel).length && !(Object.keys(sel).length === 1 && "index" in sel)) return sel as Selector;
  }
  throw new Error(`Invalid selector ${JSON.stringify(v)}`);
}

const timeoutOf = (step: Step) => (typeof step === "object" && typeof step.timeoutMs === "number" ? step.timeoutMs : undefined);

async function execStep(d: Device, flow: Flow, step: Step, ctx: { outDir: string; files: string[]; launchTimeMs?: number }): Promise<string | undefined> {
  if (step === "launch" || (typeof step === "object" && "launch" in step)) {
    await d.forceStop(flow.app);
    const l = await d.launch(flow.app);
    ctx.launchTimeMs ??= l.totalTimeMs;
    return l.totalTimeMs !== undefined ? `cold start ${l.totalTimeMs} ms` : undefined;
  }
  if (step === "back" || step === "home") {
    await d.key(step);
    return undefined;
  }
  if (typeof step !== "object" || step === null) throw new SelectorError("UNSUPPORTED_TEXT", `Unknown step "${String(step)}"`, []);
  const [kind, value] = Object.entries(step)[0]!;
  const t = timeoutOf(step);
  switch (kind) {
    case "tap": {
      const r = await d.tap(asSelector(value), t);
      return `at ${Math.round(r.x)},${Math.round(r.y)}`;
    }
    case "longPress":
      await d.longPress(asSelector(value));
      return undefined;
    case "type":
      await d.type(expandEnv(String(value)));
      return undefined;
    case "key":
      await d.key(String(value));
      return undefined;
    case "waitFor":
    case "assertVisible":
      await d.waitFor(asSelector(value), { timeoutMs: t ?? (kind === "assertVisible" ? 5000 : 10_000) });
      return undefined;
    case "assertHidden":
      await d.waitFor(asSelector(value), { timeoutMs: t ?? 5000, hidden: true });
      return undefined;
    case "scroll": {
      const dir = String(value);
      if (!["up", "down", "left", "right"].includes(dir)) throw new Error(`scroll must be up/down/left/right`);
      await d.scroll(dir as "up");
      await new Promise((r) => setTimeout(r, 500));
      return undefined;
    }
    case "sleep":
      await new Promise((r) => setTimeout(r, Math.min(Number(value) || 0, 60_000)));
      return undefined;
    case "screenshot": {
      const name = `${String(value).replace(/[^\w-]/g, "_") || "shot"}.png`;
      await writeFile(join(ctx.outDir, name), await d.screenshotPng());
      ctx.files.push(name);
      return name;
    }
    default:
      throw new SelectorError("UNSUPPORTED_TEXT", `Unknown step "${kind}"`, []);
  }
}

function categorize(e: unknown, kind: string): FailureCategory {
  if (e instanceof SelectorError) {
    if (e.code === "AMBIGUOUS") return "ambiguous_selector";
    if (e.code === "UNSUPPORTED_TEXT") return "unsupported_step";
    return kind.startsWith("assert") ? "assertion_failed" : "element_not_found";
  }
  if (e instanceof AdbError) return e.code === "CLOSED" ? "device_disconnected" : e.code === "TIMEOUT" ? "timeout" : "unknown";
  return "unknown";
}

/** Steps that act on whatever is on screen (as opposed to waiting, asserting or capturing). */
const ACTING_STEPS = new Set(["tap", "longPress", "type", "key", "back", "home", "scroll"]);

export interface RunFlowOptions {
  outDir: string;
  log?: (m: string) => void;
  /**
   * Called before every step that acts on the screen. Throw to stop the run. The MCP server uses
   * this to keep a package-scoped session inside its app; `key` is set for key presses.
   */
  beforeAction?: (action: { kind: string; key?: string }) => Promise<void>;
}

export async function runFlow(d: Device, flow: Flow, opts: RunFlowOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => undefined);
  await mkdir(opts.outDir, { recursive: true });
  const files: string[] = [];
  const save = async (name: string, data: string | Buffer) => {
    await writeFile(join(opts.outDir, name), data);
    files.push(name);
  };
  const info = await d.info();
  const summary: RunSummary = {
    tool: "tethertrace",
    schemaVersion: "0.1",
    kind: "flow",
    name: flow.name,
    package: flow.app,
    startedAt: new Date().toISOString(),
    status: "passed",
    device: { manufacturer: info.manufacturer, model: info.model, androidVersion: info.androidVersion, sdk: info.sdk },
    steps: [],
    files,
    privacy: "Typed text is never recorded. Screenshots, on-screen text and app logs can still contain personal data. Review before sharing.",
  };
  const mark = await d.logMark();
  const ctx = { outDir: opts.outDir, files, launchTimeMs: undefined as number | undefined };
  const pids = new Set<number>();

  for (const [i, step] of flow.steps.entries()) {
    const rec: StepRecord = { index: i + 1, step: redactedStepName(step), status: "passed", startedAt: new Date().toISOString(), durationMs: 0 };
    const t0 = Date.now();
    log(`${String(i + 1).padStart(2)}. ${rec.step}`);
    try {
      const kind = typeof step === "string" ? step : (Object.keys(step ?? {})[0] ?? "");
      if (opts.beforeAction && ACTING_STEPS.has(kind))
        await opts.beforeAction({ kind, key: kind === "back" || kind === "home" ? kind : kind === "key" ? String((step as Record<string, unknown>).key) : undefined });
      rec.detail = await execStep(d, flow, step, ctx);
      const pid = await d.pidOf(flow.app).catch(() => undefined);
      if (pid) pids.add(pid);
    } catch (e) {
      rec.status = "failed";
      rec.error = (e as Error).message;
      rec.durationMs = Date.now() - t0;
      summary.steps.push(rec);
      await appendFile(join(opts.outDir, "steps.jsonl"), `${JSON.stringify(rec)}\n`);
      const kind = typeof step === "string" ? step : (Object.keys(step)[0] ?? "");
      summary.status = "failed";
      summary.failure = { step: i + 1, category: categorize(e, kind), message: rec.error, evidence: [], visibleOnScreen: e instanceof SelectorError && e.visible.length ? e.visible : undefined };
      log(`    ✖ ${rec.error}`);
      break;
    }
    rec.durationMs = Date.now() - t0;
    summary.steps.push(rec);
    await appendFile(join(opts.outDir, "steps.jsonl"), `${JSON.stringify(rec)}\n`);
  }
  if (!files.includes("steps.jsonl")) files.push("steps.jsonl");
  summary.launchTimeMs = ctx.launchTimeMs;

  // Evidence (always for failures; logs for passes too, they are cheap and useful).
  try {
    if (summary.status === "failed") {
      try {
        await save("failure.png", await d.screenshotPng());
      } catch {
        /* screen unavailable */
      }
      try {
        const nodes = await d.uiNodes();
        await save("ui.txt", formatNodes(nodes));
        summary.failure!.visibleOnScreen ??= visibleLabels(nodes);
      } catch {
        /* secure screen or app gone */
      }
    }
    const pid = await d.pidOf(flow.app);
    if (pid) pids.add(pid);
    const mainLog = await d.logsSince(mark);
    const crashLog = await d.logsSince(mark, "crash");
    const appLog = filterAppLog(mainLog, flow.app, [...pids]);
    await save("logcat.txt", appLog);
    if (crashLog.trim()) await save("crash.txt", crashLog);
    // A crash outranks the symptom ("button not found" because the app died).
    const c = classify({ pkg: flow.app, pid, appLog, crashLog });
    if (c.verdict === "app_crash" || c.verdict === "anr") {
      summary.status = "failed";
      summary.failure = { step: summary.failure?.step ?? summary.steps.length, category: c.verdict, message: c.reason, evidence: c.evidence, visibleOnScreen: summary.failure?.visibleOnScreen };
    } else if (summary.failure && !pid && summary.failure.category !== "device_disconnected") {
      summary.failure.category = "app_exited";
      summary.failure.message = `${summary.failure.message} (the app process is gone; no crash report was logged)`;
    }
  } catch (e) {
    if (summary.status === "passed") throw e;
    summary.failure!.category = e instanceof AdbError && e.code === "CLOSED" ? "device_disconnected" : summary.failure!.category;
  }

  await save("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  await save("report.html", renderRunHtml(summary));
  return summary;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderRunHtml(s: RunSummary) {
  const ok = s.status === "passed";
  const shots = s.files.filter((f) => f.endsWith(".png"));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tethertrace · ${esc(s.name)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
.v{display:inline-block;padding:4px 10px;border-radius:6px;font-weight:600;color:#fff;background:${ok ? "#2e7d32" : "#c62828"}}
table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
.f{background:#fdecea}pre{background:#fff;border:1px solid #ddd;padding:12px;overflow:auto;font-size:12px}.shots{display:flex;gap:12px;flex-wrap:wrap}.shots img{width:240px;border:1px solid #ccc;border-radius:8px}</style>
<h1>${esc(s.name)} <small style="color:#666">${esc(s.package)}</small></h1>
<p><span class="v">${ok ? "passed" : esc(s.failure?.category ?? "failed")}</span> ${esc(s.device.manufacturer)} ${esc(s.device.model)} · Android ${esc(s.device.androidVersion)}${s.launchTimeMs !== undefined ? ` · cold start ${s.launchTimeMs} ms` : ""}</p>
${s.failure ? `<p><b>Step ${s.failure.step}:</b> ${esc(s.failure.message)}</p>` : ""}
<table><tr><th>#</th><th>Step</th><th>Result</th><th>ms</th></tr>${s.steps
    .map((r) => `<tr class="${r.status === "failed" ? "f" : ""}"><td>${r.index}</td><td>${esc(r.step)}</td><td>${r.status === "failed" ? `✖ ${esc(r.error ?? "")}` : `✔ ${esc(r.detail ?? "")}`}</td><td>${r.durationMs}</td></tr>`)
    .join("")}</table>
${s.failure?.evidence.length ? `<h2>Crash evidence</h2><pre>${esc(s.failure.evidence.join("\n"))}</pre>` : ""}
${s.failure?.visibleOnScreen?.length ? `<h2>What was on screen instead</h2><pre>${esc(s.failure.visibleOnScreen.join("\n"))}</pre>` : ""}
${shots.length ? `<h2>Screens</h2><div class="shots">${shots.map((f) => `<figure><img src="${esc(f)}" alt="${esc(f)}"><figcaption>${esc(f)}</figcaption></figure>`).join("")}</div>` : ""}
<p style="color:#666;font-size:13px">${esc(s.privacy)}</p>`;
}

export { describe };
