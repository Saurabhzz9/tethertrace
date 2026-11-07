import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdbError } from "./adb/connection.js";
import { assertPackage, type Device, type UiNode } from "./device.js";

/**
 * Smoke check: (install) → cold launch → wait → collect evidence → honest verdict.
 * Verdicts only claim what the evidence shows; "no_crash_observed" is not "app works".
 */

export type SmokeVerdict = "no_crash_observed" | "app_crash" | "anr" | "app_exited" | "launch_failed" | "install_failed" | "device_disconnected";

export interface SmokeOptions {
  pkg: string;
  apk?: string;
  waitMs: number;
  outDir: string;
  screenshot: boolean;
  log?: (msg: string) => void;
}

export interface SmokeSummary {
  tool: "tethertrace";
  schemaVersion: "0.1";
  package: string;
  startedAt: string;
  verdict: SmokeVerdict;
  reason: string;
  evidence: string[];
  device: { manufacturer: string; model: string; androidVersion: string; sdk?: number };
  launch?: { activity?: string; totalTimeMs?: number; status?: string };
  memoryPssKb?: number;
  pidAfterWait?: number;
  files: string[];
  privacy: string;
}

export function classify(input: { pkg: string; pid?: number; appLog: string; crashLog: string }): { verdict: SmokeVerdict; reason: string; evidence: string[] } {
  const lines = (s: string) => s.split(/\r?\n/);
  const crashLines = lines(input.crashLog).filter((l) => l.includes(input.pkg) || /FATAL EXCEPTION|Fatal signal|\*\*\* \*\*\* \*\*\*/.test(l));
  const fatalInMain = lines(input.appLog).filter((l) => /FATAL EXCEPTION|Fatal signal \d+|AndroidRuntime: Process: /.test(l) && (l.includes(input.pkg) || /FATAL EXCEPTION|Fatal signal/.test(l)));
  if (crashLines.length || fatalInMain.length) return { verdict: "app_crash", reason: "Crash report found in the device logs after launch.", evidence: [...crashLines, ...fatalInMain].slice(0, 20) };
  const anr = lines(input.appLog).filter((l) => l.includes(`ANR in ${input.pkg}`));
  if (anr.length) return { verdict: "anr", reason: "Android reported the app as not responding.", evidence: anr.slice(0, 5) };
  if (!input.pid) return { verdict: "app_exited", reason: "The app process was gone after the wait, but no crash report was found. Cause unknown.", evidence: [] };
  return { verdict: "no_crash_observed", reason: "The app stayed running during the wait and no crash or ANR was logged. This does not prove the screens work.", evidence: [] };
}

/** Only keep log lines from the app's own process or that name the package (keeps other apps' data out). */
export function filterAppLog(log: string, pkg: string, pids: number[]) {
  const pidSet = new Set(pids.map(String));
  return log
    .split(/\r?\n/)
    .filter((l) => {
      const m = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+/.exec(l);
      return (m && pidSet.has(m[1]!)) || l.includes(pkg) || /FATAL EXCEPTION|Fatal signal|AndroidRuntime/.test(l);
    })
    .join("\n");
}

export async function smoke(d: Device, o: SmokeOptions): Promise<SmokeSummary> {
  assertPackage(o.pkg);
  const log = o.log ?? (() => undefined);
  await mkdir(o.outDir, { recursive: true });
  const files: string[] = [];
  const save = async (name: string, data: string | Buffer) => {
    await writeFile(join(o.outDir, name), data);
    files.push(name);
  };
  const step = async (action: string, extra: Record<string, unknown> = {}) => {
    await appendFile(join(o.outDir, "steps.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), action, ...extra })}\n`);
    if (!files.includes("steps.jsonl")) files.push("steps.jsonl");
  };

  const info = await d.info();
  const summary: SmokeSummary = {
    tool: "tethertrace",
    schemaVersion: "0.1",
    package: o.pkg,
    startedAt: new Date().toISOString(),
    verdict: "no_crash_observed",
    reason: "",
    evidence: [],
    device: { manufacturer: info.manufacturer, model: info.model, androidVersion: info.androidVersion, sdk: info.sdk },
    files,
    privacy: "Logs are limited to the app's process, but screenshots, UI text and app logs can still contain personal data. Review before sharing.",
  };
  const finish = async (verdict: SmokeVerdict, reason: string, evidence: string[] = []) => {
    Object.assign(summary, { verdict, reason, evidence });
    await step("verdict", { verdict });
    await save("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    await save("report.html", renderHtml(summary));
    return summary;
  };

  try {
    if (o.apk) {
      const mb = ((await stat(o.apk)).size / 1e6).toFixed(1);
      log(`Installing ${o.apk} (${mb} MB) over Wi-Fi…`);
      await step("install", { sizeMb: Number(mb) });
      try {
        await d.install(o.apk);
      } catch (e) {
        return finish("install_failed", (e as Error).message);
      }
    } else if (!(await d.isInstalled(o.pkg))) return finish("install_failed", `${o.pkg} is not installed and no APK was given.`);

    await d.forceStop(o.pkg);
    const mark = await d.logMark();
    log("Cold-launching…");
    await step("launch");
    let launch;
    try {
      launch = await d.launch(o.pkg);
    } catch (e) {
      return finish("launch_failed", (e as Error).message);
    }
    summary.launch = { activity: launch.activity, totalTimeMs: launch.totalTimeMs, status: launch.status };
    await step("launched", summary.launch);
    const pidEarly = await d.pidOf(o.pkg);

    log(`Waiting ${o.waitMs / 1000}s while the app runs…`);
    await new Promise((r) => setTimeout(r, o.waitMs));
    const pid = await d.pidOf(o.pkg);
    summary.pidAfterWait = pid;
    await step("observed", { running: Boolean(pid) });

    if (o.screenshot) {
      try {
        await save("screenshot.png", await d.screenshotPng());
      } catch {
        await step("screenshot_unavailable");
      }
    }
    try {
      const nodes = await d.uiNodes();
      await save("ui.txt", formatNodes(nodes));
    } catch {
      await step("ui_unavailable");
    }
    if (pid) {
      const mem = await d.meminfo(o.pkg);
      summary.memoryPssKb = mem.totalPssKb;
      await save("meminfo.txt", mem.raw);
    }
    const mainLog = await d.logsSince(mark);
    const crashLog = await d.logsSince(mark, "crash");
    const appLog = filterAppLog(mainLog, o.pkg, [pidEarly, pid].filter((p): p is number => Boolean(p)));
    await save("logcat.txt", appLog);
    if (crashLog.trim()) await save("crash.txt", crashLog);

    const c = classify({ pkg: o.pkg, pid, appLog, crashLog });
    return finish(c.verdict, c.reason, c.evidence);
  } catch (e) {
    if (e instanceof AdbError && (e.code === "CLOSED" || e.code === "TIMEOUT")) return finish("device_disconnected", `Lost the phone mid-run: ${e.message}`);
    throw e;
  }
}

/** One line per visible/tappable element; multi-line labels are joined with " / ". */
export function formatNodes(nodes: UiNode[]) {
  return nodes
    .filter((n) => n.text || n.desc || n.clickable)
    .map((n) => {
      const label = (n.text || n.desc || "(no label)").split(/\s*\n\s*/).filter(Boolean).join(" / ");
      return `${n.clickable ? "[tap] " : "      "}${label}${n.id ? `  #${n.id}` : ""}  @${n.bounds.join(",")}`;
    })
    .join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderHtml(s: SmokeSummary) {
  const ok = s.verdict === "no_crash_observed";
  const rows: [string, string][] = [
    ["Device", `${s.device.manufacturer} ${s.device.model} · Android ${s.device.androidVersion}`],
    ["Launch time", s.launch?.totalTimeMs !== undefined ? `${s.launch.totalTimeMs} ms (Android TotalTime, cold start)` : "not reported"],
    ["Memory (PSS)", s.memoryPssKb ? `${(s.memoryPssKb / 1024).toFixed(1)} MB` : "n/a"],
    ["Files", s.files.join(", ")],
  ];
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tethertrace · ${esc(s.package)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
.v{display:inline-block;padding:4px 10px;border-radius:6px;font-weight:600;color:#fff;background:${ok ? "#2e7d32" : "#c62828"}}
table{border-collapse:collapse;width:100%;margin:16px 0}td{border-bottom:1px solid #ddd;padding:6px 8px;vertical-align:top}td:first-child{color:#666;width:160px}
pre{background:#fff;border:1px solid #ddd;padding:12px;overflow:auto;font-size:12px}img{max-width:320px;border:1px solid #ccc;border-radius:8px}</style>
<h1>${esc(s.package)}</h1><p><span class="v">${esc(s.verdict)}</span> ${esc(s.reason)}</p>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
${s.evidence.length ? `<h2>Evidence</h2><pre>${esc(s.evidence.join("\n"))}</pre>` : ""}
${s.files.includes("screenshot.png") ? `<h2>Screen after launch</h2><img src="screenshot.png" alt="screenshot">` : ""}
<p style="color:#666;font-size:13px">${esc(s.privacy)}</p>`;
}
