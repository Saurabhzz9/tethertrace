import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { assertPackage, type Device } from "./device.js";
import { explore, type ExploreSummary } from "./explore.js";
import {
  describeBuild,
  flowRecord,
  loadMemory,
  parseBuildIdentity,
  previousBuild,
  rememberBuild,
  rememberExploration,
  rememberFlowRun,
  saveMemory,
  sha256,
  type AppMemory,
  type BuildIdentity,
  type ScreenChanges,
} from "./memory.js";
import { loadFlow, runFlow, type Flow, type RunFlowOptions, type RunSummary } from "./runner.js";

/**
 * `verify`: check a build against what is remembered about the app.
 *
 *   changed   (default) run the flows that could be affected, explore when the build is new
 *   full      run every flow and explore
 *   discover  explore only, to record the app's screens the first time
 *
 * Everything here is decided from files and recorded facts; no model is involved, so the same
 * inputs always pick the same flows.
 */

export type VerifyMode = "changed" | "full" | "discover";

export interface FlowFile {
  file: string;
  flow: Flow;
  sha256: string;
  covers?: string[];
}

export interface FlowDecision {
  file: string;
  name: string;
  run: boolean;
  reason: string;
}

export interface VerifyFlowResult extends FlowDecision {
  status: "passed" | "failed" | "not_run";
  /** Passed on the previous build with the same flow file, fails now. */
  regression?: boolean;
  failure?: RunSummary["failure"];
  report?: string;
}

export interface VerifySummary {
  tool: "tethertrace";
  schemaVersion: "0.1";
  kind: "verify";
  package: string;
  mode: VerifyMode;
  startedAt: string;
  status: "passed" | "failed" | "nothing_checked";
  build: BuildIdentity & { new: boolean; previous?: string };
  /** What "changed" was measured against, when a git checkout was available. */
  source?: { commit?: string; since?: string; changedFiles?: number; note?: string };
  flows: VerifyFlowResult[];
  exploration?: { verdict: ExploreSummary["verdict"]; reason: string; coverage: ExploreSummary["coverage"]; screens: number; changes: ScreenChanges; report: string };
  notes: string[];
  memoryFile: string;
}

/** Read every flow under a folder (two levels deep) or the given files. Unreadable files are reported, not skipped silently. */
export async function findFlows(inputs: string[]): Promise<{ flows: FlowFile[]; problems: string[] }> {
  const files: string[] = [];
  const problems: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith(".")) await walk(p, depth + 1);
      else if (e.isFile() && /\.ya?ml$/i.test(e.name)) files.push(p);
    }
  };
  for (const input of inputs) {
    const p = resolve(input);
    try {
      if ((await stat(p)).isDirectory()) await walk(p, 0);
      else files.push(p);
    } catch {
      problems.push(`${input}: not found`);
    }
  }
  const flows: FlowFile[] = [];
  for (const file of [...new Set(files)].sort()) {
    try {
      const raw = await readFile(file, "utf8");
      const flow = await loadFlow(file);
      const covers = (YAML.parse(raw) as { covers?: unknown } | null)?.covers;
      flows.push({
        file: file.replace(/\\/g, "/"),
        flow,
        sha256: sha256(raw),
        covers: Array.isArray(covers) ? covers.filter((c): c is string => typeof c === "string" && c.length > 0) : typeof covers === "string" ? [covers] : undefined,
      });
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return { flows, problems };
}

/** A small glob: `**` any folders, `*` within one name, `?` one character. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  // A pattern that names a folder covers everything inside it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function coveredChange(covers: string[], changed: string[]): string | undefined {
  const res = covers.map(globToRegExp);
  return changed.find((f) => res.some((r) => r.test(f.replace(/\\/g, "/"))));
}

/** Decide, for each flow, whether it has to run. Skipping needs a recorded reason; anything unknown runs. */
export function selectFlows(o: { mode: VerifyMode; flows: FlowFile[]; memory: AppMemory; build: string; changedFiles?: string[] }): FlowDecision[] {
  return o.flows.map(({ file, flow, sha256: hash, covers }) => {
    const d = (run: boolean, reason: string): FlowDecision => ({ file, name: flow.name, run, reason });
    if (o.mode === "discover") return d(false, "discover mode only explores");
    if (o.mode === "full") return d(true, "full run");
    const last = flowRecord(o.memory, file)?.runs.at(-1);
    if (!last) return d(true, "never run before");
    if (last.sha256 !== hash) return d(true, "the flow file changed since its last run");
    if (last.status === "failed") return d(true, "failed last time");
    if (o.build === "unknown") return d(true, "the installed build could not be identified");
    if (last.build === o.build) return d(false, "already passed on this build");
    if (!covers?.length) return d(true, "new build, and the flow does not say which source it covers");
    if (!o.changedFiles) return d(true, "new build, and what changed in the source is not known");
    const hit = coveredChange(covers, o.changedFiles);
    return hit ? d(true, `${hit} changed, which this flow covers`) : d(false, "new build, but nothing this flow covers changed");
  });
}

const git = (cwd: string, args: string[]) =>
  new Promise<string | undefined>((res) => {
    execFile("git", args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => res(err ? undefined : stdout));
  });

/** Current commit, and the files that differ from `since` (committed or not). Undefined parts mean "not known". */
export async function sourceChanges(dir: string, since?: string): Promise<{ commit?: string; changedFiles?: string[]; note?: string }> {
  const commit = (await git(dir, ["rev-parse", "HEAD"]))?.trim();
  if (!commit) return { note: "not a git checkout, so source changes are not known" };
  if (!since) return { commit, note: "no earlier verified commit to compare with" };
  const [committed, working] = await Promise.all([git(dir, ["diff", "--name-only", `${since}..HEAD`]), git(dir, ["status", "--porcelain", "--untracked-files=all"])]);
  if (committed === undefined || working === undefined) return { commit, note: `commit ${since.slice(0, 7)} is not in this checkout, so source changes are not known` };
  const files = new Set(committed.split("\n").map((l) => l.trim()).filter(Boolean));
  for (const l of working.split("\n")) {
    const f = l.slice(3).split(" -> ").pop()?.trim().replace(/^"|"$/g, "");
    if (f) files.add(f);
  }
  return { commit, changedFiles: [...files] };
}

/** Ask the phone which build of the app is installed. */
export async function appBuild(d: Device, pkg: string): Promise<BuildIdentity> {
  assertPackage(pkg);
  return parseBuildIdentity((await d.shell(`dumpsys package ${pkg} | grep -E 'versionName=|versionCode=|lastUpdateTime='`)).text);
}

export interface VerifyOptions {
  pkg: string;
  mode: VerifyMode;
  flows: FlowFile[];
  outDir: string;
  /** Project checkout used to work out what changed; omit to skip that. */
  projectDir?: string;
  /** false: never explore. Default: explore in full and discover mode, and in changed mode when the build is new. */
  explore?: boolean;
  maxActions?: number;
  timeBudgetMs?: number;
  home?: string;
  log?: (m: string) => void;
  /** Passed to every flow run; see RunFlowOptions.beforeAction. */
  beforeAction?: RunFlowOptions["beforeAction"];
}

export async function verify(d: Device, o: VerifyOptions): Promise<VerifySummary> {
  const log = o.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const memory = await loadMemory(o.pkg, o.home);
  if (!(await d.isInstalled(o.pkg))) throw new Error(`${o.pkg} is not installed on the phone`);
  const build = await appBuild(d, o.pkg);
  const isNew = build.id === "unknown" || !memory.builds.some((b) => b.id === build.id);
  const previous = previousBuild(memory, build.id);
  const notes: string[] = [];
  if (build.id === "unknown") notes.push("The phone did not report a version or install time for this app, so it is treated as a new build every time.");
  log(`Build: ${describeBuild(build)}${isNew ? " (not seen before)" : ""}`);

  let source: VerifySummary["source"];
  let changedFiles: string[] | undefined;
  if (o.projectDir) {
    const s = await sourceChanges(o.projectDir, previous?.commit);
    changedFiles = s.changedFiles;
    source = { commit: s.commit, since: previous?.commit, changedFiles: s.changedFiles?.length, note: s.note };
    if (s.changedFiles) notes.push("Source changes are taken from this checkout. That is only right if the installed build was made from it.");
  }

  const mine = o.flows.filter((f) => f.flow.app === o.pkg);
  for (const f of o.flows) if (f.flow.app !== o.pkg) notes.push(`${f.file} is for ${f.flow.app}; left out.`);
  const decisions = selectFlows({ mode: o.mode, flows: mine, memory, build: build.id, changedFiles });
  await mkdir(o.outDir, { recursive: true });

  const results: VerifyFlowResult[] = [];
  for (const dec of decisions) {
    if (!dec.run) {
      results.push({ ...dec, status: "not_run" });
      continue;
    }
    const f = mine.find((x) => x.file === dec.file)!;
    log(`\nFlow ${f.flow.name}: ${dec.reason}`);
    const report = join(o.outDir, `flow-${results.length + 1}-${f.flow.name.replace(/[^\w-]/g, "_")}`);
    const before = flowRecord(memory, f.file)?.runs.findLast((r) => r.build !== build.id);
    const s = await runFlow(d, f.flow, { outDir: report, log, beforeAction: o.beforeAction });
    rememberFlowRun(memory, { file: f.file, name: f.flow.name, covers: f.covers, sha256: f.sha256 }, build.id, s, report);
    results.push({
      ...dec,
      status: s.status,
      regression: s.status === "failed" && before?.status === "passed" && before.sha256 === f.sha256 ? true : undefined,
      failure: s.failure,
      report,
    });
    await saveMemory(memory, o.home); // keep what is known even if a later step dies
  }

  let exploration: VerifySummary["exploration"];
  const wantExplore = o.explore ?? (o.mode !== "changed" || isNew || memory.explorations.length === 0);
  if (wantExplore) {
    const report = join(o.outDir, "explore");
    log(`\nExploring ${o.pkg}…`);
    const s = await explore(d, { pkg: o.pkg, outDir: report, maxActions: o.maxActions ?? (o.mode === "changed" ? 25 : 40), timeBudgetMs: o.timeBudgetMs, log });
    const changes = rememberExploration(memory, build.id, s, report);
    exploration = { verdict: s.verdict, reason: s.reason, coverage: s.coverage, screens: s.screens.length, changes, report };
    notes.push("Reaching a screen shows it opens without a crash. It does not show that what the screen does is correct; flows with assertions do that.");
  } else if (o.explore === false) notes.push("Not explored, as asked. New or changed screens were not looked for.");
  else notes.push("Not explored again: this build was already explored. Use --full to explore anyway.");

  rememberBuild(memory, build, startedAt, source?.commit);
  const memoryPath = await saveMemory(memory, o.home);

  const ran = results.filter((r) => r.status !== "not_run");
  const failed = ran.some((r) => r.status === "failed") || (exploration !== undefined && exploration.verdict !== "no_crash_observed");
  const summary: VerifySummary = {
    tool: "tethertrace",
    schemaVersion: "0.1",
    kind: "verify",
    package: o.pkg,
    mode: o.mode,
    startedAt,
    status: failed ? "failed" : ran.length || exploration ? "passed" : "nothing_checked",
    build: { ...build, new: isNew, previous: previous?.id },
    source,
    flows: results,
    exploration,
    notes,
    memoryFile: memoryPath,
  };
  await writeFile(join(o.outDir, "verify.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** The short text printed after a verify run. */
export function describeVerify(s: VerifySummary): string {
  const out: string[] = [];
  const ran = s.flows.filter((f) => f.status !== "not_run");
  const mark = s.status === "passed" ? "✔" : s.status === "failed" ? "✖" : "•";
  out.push(`${mark} verify ${s.package} (${s.mode}): ${s.status === "nothing_checked" ? "nothing needed checking" : s.status}`);
  out.push(`Build: ${describeBuild(s.build)}${s.build.new ? ", new" : ", seen before"}`);
  if (s.source?.changedFiles !== undefined) out.push(`Source: ${s.source.changedFiles} file${s.source.changedFiles === 1 ? "" : "s"} changed since ${s.source.since?.slice(0, 7)}`);
  else if (s.source?.note) out.push(`Source: ${s.source.note}`);
  if (s.flows.length) out.push(`Flows: ${ran.filter((f) => f.status === "passed").length} passed, ${ran.filter((f) => f.status === "failed").length} failed, ${s.flows.length - ran.length} not run`);
  for (const f of s.flows) {
    if (f.status === "not_run") out.push(`  - ${f.name}: not run (${f.reason})`);
    else if (f.status === "passed") out.push(`  ✔ ${f.name} (${f.reason})`);
    else {
      out.push(`  ✖ ${f.name}${f.regression ? " — REGRESSION: passed on the previous build" : ""}`);
      out.push(`      step ${f.failure?.step}: ${f.failure?.category}: ${f.failure?.message}`);
      if (f.failure?.visibleOnScreen?.length) out.push(`      on screen instead: ${f.failure.visibleOnScreen.slice(0, 6).join(" | ")}`);
      out.push(`      report: ${f.report}/report.html`);
    }
  }
  const e = s.exploration;
  if (e) {
    out.push(`Explore: ${e.verdict} (${e.reason}); ${e.screens} screen${e.screens === 1 ? "" : "s"}, coverage ${e.coverage.level}, ${e.coverage.tapped} tapped`);
    if (e.changes.first) out.push(`  First exploration: ${e.screens} screen${e.screens === 1 ? "" : "s"} recorded.`);
    else {
      if (e.changes.added.length) out.push(`  New or changed screens: ${e.changes.added.map((x) => x.title).slice(0, 8).join(" | ")}`);
      if (e.changes.notReached.length) out.push(`  Known screens not reached this time: ${e.changes.notReached.map((x) => x.title).slice(0, 8).join(" | ")}`);
      if (!e.changes.added.length && !e.changes.notReached.length) out.push("  Same screens as before.");
    }
  }
  for (const n of s.notes) out.push(`note: ${n}`);
  out.push(`Memory: ${s.memoryFile}`);
  return out.join("\n");
}
