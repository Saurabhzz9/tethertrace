import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { AdbError } from "./adb/connection.js";
import { assertPackage, type Device, type UiNode } from "./device.js";
import { classify, filterAppLog, formatNodes } from "./smoke.js";

/**
 * Zero-config exploration: give it an app, it walks the screens by tapping what it can see,
 * watches for crashes, and writes a report plus ready-to-run YAML flows. No test code needed.
 *
 * Safety: it only taps elements that belong to the app, skips anything that looks destructive or
 * outward-facing (delete, pay, send, share, log out…) and every switch/checkbox, never types, and
 * declines permission prompts.
 */

export const DEFAULT_DENY =
  /\b(delete|remove|erase|wipe|reset|clear (all|data)|log ?out|sign ?out|uninstall|pay|payment|purchase|buy|subscribe|checkout|place order|order now|send|share|call|dial|sms|report|block|unsubscribe|deactivate|close account|exit|quit|rate (us|app)|upgrade|premium|restore purchases?)\b|हटाएँ|हटाए|हटाना|मिटाएँ|डिलीट|खरीद|भुगतान|सदस्यता|लॉग ?आउट|साइन ?आउट|भेजें|शेयर|कॉल|रिपोर्ट|ब्लॉक/i;

const PERMISSION_DENY = /^(don.?t allow|deny|never|no thanks|not now|cancel|अनुमति न दें|अनुमति नहीं दें|अस्वीकार करें|अभी नहीं)$/i;

export interface ExploreOptions {
  pkg: string;
  outDir: string;
  maxActions?: number;
  timeBudgetMs?: number;
  /** Extra labels to never tap, in addition to {@link DEFAULT_DENY}. */
  deny?: RegExp;
  settleMs?: number;
  log?: (m: string) => void;
}

export interface ExploreScreen {
  id: number;
  signature: string;
  title: string;
  screenshot?: string;
  elements: number;
}

export interface ExploreAction {
  t: string;
  screen: number;
  action: "launch" | "tap" | "back" | "relaunch" | "deny_permission";
  label?: string;
  selector?: Record<string, unknown> | string;
  at?: [number, number];
  ledTo?: number;
}

export interface ExploreSummary {
  tool: "tethertrace";
  schemaVersion: "0.1";
  kind: "explore";
  package: string;
  startedAt: string;
  verdict: "no_crash_observed" | "app_crash" | "anr" | "app_exited" | "launch_failed" | "device_disconnected";
  reason: string;
  evidence: string[];
  crashAfter?: { screen: number; label?: string };
  device: { manufacturer: string; model: string; androidVersion: string; sdk?: number };
  launchTimeMs?: number;
  screens: ExploreScreen[];
  actions: number;
  skippedAsRisky: string[];
  files: string[];
  privacy: string;
}

const label = (n: UiNode) => (n.text || n.desc).split(/\s*\n\s*/).filter(Boolean).join(" / ");
const area = (n: UiNode) => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);

function foreground(nodes: UiNode[]) {
  const counts = new Map<string, number>();
  for (const n of nodes) if (n.pkg) counts.set(n.pkg, (counts.get(n.pkg) ?? 0) + area(n));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Screen identity from its structure and labels, ignoring positions (so scrolling doesn't create "new" screens). */
export function screenSignature(nodes: UiNode[]) {
  const parts = nodes.map((n) => `${n.cls}|${n.id}|${n.clickable ? 1 : 0}|${label(n).replace(/\d+/g, "#")}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
}

function selectorFor(n: UiNode, nodes: UiNode[]): Record<string, unknown> | string | undefined {
  const l = label(n);
  if (n.id) {
    const short = n.id.replace(/^.*:id\//, "");
    if (nodes.filter((m) => m.id === n.id).length === 1) return { id: short };
  }
  if (!l) return undefined;
  const first = l.split(" / ")[0]!;
  const same = nodes.filter((m) => m.clickable && label(m).split(" / ").includes(first));
  return same.length <= 1 ? first : { text: first, index: Math.max(0, same.indexOf(n)) };
}

export async function explore(d: Device, o: ExploreOptions): Promise<ExploreSummary> {
  assertPackage(o.pkg);
  const log = o.log ?? (() => undefined);
  const maxActions = o.maxActions ?? 40;
  const deadline = Date.now() + (o.timeBudgetMs ?? 4 * 60_000);
  const settle = o.settleMs ?? 1200;
  await mkdir(o.outDir, { recursive: true });
  const files: string[] = [];
  const save = async (name: string, data: string | Buffer) => {
    await writeFile(join(o.outDir, name), data);
    if (!files.includes(name)) files.push(name);
  };
  const info = await d.info();
  const summary: ExploreSummary = {
    tool: "tethertrace",
    schemaVersion: "0.1",
    kind: "explore",
    package: o.pkg,
    startedAt: new Date().toISOString(),
    verdict: "no_crash_observed",
    reason: "",
    evidence: [],
    device: { manufacturer: info.manufacturer, model: info.model, androidVersion: info.androidVersion, sdk: info.sdk },
    screens: [],
    actions: 0,
    skippedAsRisky: [],
    files,
    privacy: "Explorer never types. Screenshots, on-screen text and app logs can still contain personal data. Review before sharing.",
  };
  const actions: ExploreAction[] = [];
  const record = async (a: Omit<ExploreAction, "t">) => {
    const full = { t: new Date().toISOString(), ...a };
    actions.push(full);
    await appendFile(join(o.outDir, "actions.jsonl"), `${JSON.stringify(full)}\n`);
    if (!files.includes("actions.jsonl")) files.push("actions.jsonl");
  };
  const bySig = new Map<string, ExploreScreen>();
  const tried = new Set<string>();
  const risky = new Set<string>();
  const pids = new Set<number>();
  const pathFromLaunch: ExploreAction[] = [];
  let current = 0;
  let lastTap: { screen: number; label?: string } | undefined;

  const mark = await d.logMark();
  const launch = async (kind: "launch" | "relaunch") => {
    await d.forceStop(o.pkg);
    const l = await d.launch(o.pkg);
    summary.launchTimeMs ??= l.totalTimeMs;
    pathFromLaunch.length = 0;
    await record({ screen: current, action: kind });
    await new Promise((r) => setTimeout(r, settle + 800));
  };

  let crashed = false;
  try {
    try {
      await launch("launch");
    } catch (e) {
      summary.verdict = "launch_failed";
      summary.reason = (e as Error).message;
      throw e;
    }
    let stuck = 0;
    while (summary.actions < maxActions && Date.now() < deadline) {
      const pid = await d.pidOf(o.pkg);
      if (pid) pids.add(pid);
      else {
        crashed = true;
        break;
      }
      let nodes: UiNode[];
      try {
        nodes = await d.uiNodes();
      } catch {
        await new Promise((r) => setTimeout(r, 600));
        if (++stuck > 3) break;
        continue;
      }
      const fg = foreground(nodes);
      if (fg && fg !== o.pkg) {
        // Left the app: decline a permission prompt, otherwise go back.
        const decline = nodes.find((n) => n.clickable && PERMISSION_DENY.test(label(n)));
        if (decline && /permissioncontroller|packageinstaller/.test(fg)) {
          await d.tapXY((decline.bounds[0] + decline.bounds[2]) / 2, (decline.bounds[1] + decline.bounds[3]) / 2);
          await record({ screen: current, action: "deny_permission", label: label(decline) });
        } else {
          await d.key("back");
          await record({ screen: current, action: "back", label: `left app (${fg})` });
          await new Promise((r) => setTimeout(r, settle));
          const again = await d.uiNodes().catch(() => [] as UiNode[]);
          if (foreground(again) !== o.pkg) await launch("relaunch");
        }
        summary.actions++;
        continue;
      }
      const sig = screenSignature(nodes);
      let screen = bySig.get(sig);
      if (!screen) {
        const titleNode = nodes.filter((n) => label(n) && !n.clickable).sort((a, b) => a.bounds[1] - b.bounds[1])[0];
        screen = { id: bySig.size + 1, signature: sig, title: titleNode ? label(titleNode).slice(0, 60) : `screen ${bySig.size + 1}`, elements: nodes.length };
        bySig.set(sig, screen);
        summary.screens.push(screen);
        log(`  new screen ${screen.id}: ${screen.title}`);
        try {
          screen.screenshot = `screen-${screen.id}.png`;
          await save(screen.screenshot, await d.screenshotScaled(0.5));
          await save(`screen-${screen.id}.txt`, formatNodes(nodes));
        } catch {
          screen.screenshot = undefined;
        }
      }
      const last = actions[actions.length - 1];
      if (last && last.action === "tap" && last.ledTo === undefined) last.ledTo = screen.id;
      current = screen.id;

      const deny = (l: string) => DEFAULT_DENY.test(l) || (o.deny?.test(l) ?? false);
      const candidates = nodes.filter((n) => {
        if (!n.clickable || area(n) < 400 || n.pkg !== o.pkg) return false;
        if (/EditText|AutoCompleteTextView/.test(n.cls)) return false;
        const l = label(n) || n.id.replace(/^.*:id\//, "");
        if (!l) return false; // unlabeled controls could be anything; skip them
        if (deny(l)) {
          risky.add(l);
          return false;
        }
        // Switches/checkboxes change the app's settings; exploring must not.
        if (n.checkable || /Switch|CheckBox|RadioButton|ToggleButton/.test(n.cls)) {
          risky.add(`${l} (toggle)`);
          return false;
        }
        return !tried.has(`${sig}|${l}|${n.id}`);
      });
      if (!candidates.length) {
        if (current === 1 || !pathFromLaunch.length) break; // home screen fully explored
        await d.key("back");
        await record({ screen: current, action: "back" });
        pathFromLaunch.pop();
        summary.actions++;
        await new Promise((r) => setTimeout(r, settle));
        continue;
      }
      // Top-to-bottom, so navigation bars and headers come before list items.
      const n = candidates.sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])[0]!;
      const l = label(n) || n.id.replace(/^.*:id\//, "");
      tried.add(`${sig}|${l}|${n.id}`);
      const at: [number, number] = [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];
      log(`  tap "${l}" on screen ${current}`);
      await d.tapXY(at[0], at[1]);
      await record({ screen: current, action: "tap", label: l, selector: selectorFor(n, nodes), at });
      pathFromLaunch.push(actions[actions.length - 1]!);
      lastTap = { screen: current, label: l };
      summary.actions++;
      await new Promise((r) => setTimeout(r, settle));
    }
  } catch (e) {
    if (e instanceof AdbError && (e.code === "CLOSED" || e.code === "TIMEOUT")) {
      summary.verdict = "device_disconnected";
      summary.reason = `Lost the phone mid-run: ${e.message}`;
    } else if (summary.verdict !== "launch_failed") throw e;
  }

  summary.skippedAsRisky = [...risky].slice(0, 50);
  if (summary.verdict === "no_crash_observed") {
    const pid = await d.pidOf(o.pkg);
    if (pid) pids.add(pid);
    const mainLog = await d.logsSince(mark);
    const crashLog = await d.logsSince(mark, "crash");
    const appLog = filterAppLog(mainLog, o.pkg, [...pids]);
    await save("logcat.txt", appLog);
    if (crashLog.trim()) await save("crash.txt", crashLog);
    const c = classify({ pkg: o.pkg, pid: crashed ? undefined : pid, appLog, crashLog });
    summary.verdict = c.verdict === "no_crash_observed" || c.verdict === "app_crash" || c.verdict === "anr" || c.verdict === "app_exited" ? c.verdict : "no_crash_observed";
    summary.reason =
      c.verdict === "no_crash_observed"
        ? `Visited ${summary.screens.length} screen(s) with ${summary.actions} action(s); no crash or ANR was logged. Risky-looking buttons were skipped.`
        : c.reason;
    summary.evidence = c.evidence;
    if (c.verdict !== "no_crash_observed") {
      summary.crashAfter = lastTap;
      if (crashed || c.verdict === "app_crash") {
        try {
          await save("failure.png", await d.screenshotScaled(0.5));
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Turn what happened into flows a developer can keep and re-run.
  // Replayable: taps, the explorer's own backs, and relaunches, in order.
  const steps = (path: ExploreAction[]) => [
    "launch",
    ...path.flatMap((a): unknown[] => {
      if (a.action === "tap" && a.selector !== undefined) return [{ tap: a.selector }];
      if (a.action === "back" && a.label === undefined) return ["back"];
      if (a.action === "relaunch") return ["launch"];
      return [];
    }),
  ];
  await save("explored-flow.yaml", YAML.stringify({ app: o.pkg, name: `explored-${o.pkg.split(".").pop()}`, steps: steps(actions.filter((a) => a.action !== "launch")) }));
  if (summary.verdict !== "no_crash_observed" && summary.verdict !== "device_disconnected" && summary.verdict !== "launch_failed")
    await save("repro.yaml", YAML.stringify({ app: o.pkg, name: "crash-repro", steps: steps(pathFromLaunch) }));
  await save("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  await save("report.html", renderExploreHtml(summary));
  return summary;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderExploreHtml(s: ExploreSummary) {
  const ok = s.verdict === "no_crash_observed";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tethertrace · explore ${esc(s.package)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
.v{display:inline-block;padding:4px 10px;border-radius:6px;font-weight:600;color:#fff;background:${ok ? "#2e7d32" : "#c62828"}}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.g figure{margin:0}.g img{width:100%;border:1px solid #ccc;border-radius:8px}
figcaption{font-size:12px;color:#555}pre{background:#fff;border:1px solid #ddd;padding:12px;overflow:auto;font-size:12px}</style>
<h1>${esc(s.package)}</h1>
<p><span class="v">${esc(s.verdict)}</span> ${esc(s.reason)}</p>
<p>${esc(s.device.manufacturer)} ${esc(s.device.model)} · Android ${esc(s.device.androidVersion)}${s.launchTimeMs !== undefined ? ` · cold start ${s.launchTimeMs} ms` : ""} · ${s.screens.length} screens · ${s.actions} actions</p>
${s.crashAfter ? `<p><b>Crashed after:</b> tapping "${esc(s.crashAfter.label ?? "?")}" on screen ${s.crashAfter.screen}. Re-run it with <code>tethertrace run repro.yaml</code>.</p>` : ""}
${s.evidence.length ? `<h2>Crash evidence</h2><pre>${esc(s.evidence.join("\n"))}</pre>` : ""}
<h2>Screens</h2><div class="g">${s.screens.map((sc) => `<figure>${sc.screenshot ? `<img src="${esc(sc.screenshot)}" alt="">` : ""}<figcaption>${sc.id}. ${esc(sc.title)}</figcaption></figure>`).join("")}</div>
${s.skippedAsRisky.length ? `<h2>Skipped as risky</h2><p>${s.skippedAsRisky.map(esc).join(" · ")}</p>` : ""}
<p style="color:#666;font-size:13px">${esc(s.privacy)} Generated flows: explored-flow.yaml${s.files.includes("repro.yaml") ? ", repro.yaml" : ""}.</p>`;
}
