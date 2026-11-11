import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homeDir } from "./adb/keys.js";
import { assertPackage } from "./device.js";
import type { ExploreSummary } from "./explore.js";
import type { RunSummary } from "./runner.js";

/**
 * What tethertrace remembers about an app between runs: the builds it has seen, the screens the
 * explorer reached, and how each flow went on each build. One plain JSON file per app under
 * ~/.tethertrace/memory, so a person can read it, correct it or delete it.
 *
 * It only holds what was observed. A screen that was reached is not proof that it works, and a
 * flow that was skipped is never recorded as passed.
 */

export const MEMORY_SCHEMA = "memory.1";
const KEEP_RUNS = 20;

/** Identifies one installed build. Rebuilding the same version still changes `installedAt`. */
export interface BuildIdentity {
  id: string;
  versionName?: string;
  versionCode?: number;
  installedAt?: string;
}

export interface BuildRecord extends BuildIdentity {
  firstSeen: string;
  lastSeen: string;
  /** Git commit of the project when this build was verified, if `verify` ran inside a checkout. */
  commit?: string;
}

export interface ScreenRecord {
  signature: string;
  title: string;
  elements: number;
  firstSeenBuild: string;
  lastSeenBuild: string;
  lastSeen: string;
  /** Set this by hand for a screen whose content always differs (a feed, a clock); it is then left out of comparisons. */
  ignore?: boolean;
}

export interface FlowRunRecord {
  build: string;
  at: string;
  status: "passed" | "failed";
  /** Hash of the flow file at the time of the run. */
  sha256: string;
  failure?: { step: number; category: string; message: string };
  report?: string;
  device?: string;
}

export interface FlowRecord {
  file: string;
  name: string;
  covers?: string[];
  runs: FlowRunRecord[];
}

export interface ExplorationRecord {
  build: string;
  at: string;
  verdict: string;
  coverage: string;
  tapped: number;
  screens: number;
  report?: string;
}

export interface AppMemory {
  tool: "tethertrace";
  schemaVersion: typeof MEMORY_SCHEMA;
  platform: "android";
  package: string;
  /** Free text for people; tethertrace never changes it. */
  notes?: string;
  builds: BuildRecord[];
  screens: ScreenRecord[];
  flows: FlowRecord[];
  explorations: ExplorationRecord[];
}

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export const memoryDir = (home = homeDir()) => join(home, "memory");
export function memoryFile(pkg: string, home = homeDir()) {
  assertPackage(pkg); // also keeps the name safe to use as a file name
  return join(memoryDir(home), `android-${pkg}.json`);
}

export function emptyMemory(pkg: string): AppMemory {
  return { tool: "tethertrace", schemaVersion: MEMORY_SCHEMA, platform: "android", package: pkg, builds: [], screens: [], flows: [], explorations: [] };
}

/**
 * Read an app's memory. A missing file is an empty memory. A file that cannot be understood is an
 * error, never silently replaced: it may hold corrections a person made.
 */
export async function loadMemory(pkg: string, home = homeDir()): Promise<AppMemory> {
  const file = memoryFile(pkg, home);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory(pkg);
    throw e;
  }
  let m: Partial<AppMemory>;
  try {
    m = JSON.parse(raw) as Partial<AppMemory>;
  } catch (e) {
    throw new MemoryError(`${file} is not valid JSON (${(e as Error).message}). Fix it, or delete it to start again.`, file);
  }
  if (m?.schemaVersion !== MEMORY_SCHEMA) throw new MemoryError(`${file} has schemaVersion ${JSON.stringify(m?.schemaVersion)}; this version reads ${MEMORY_SCHEMA}. Delete it to start again.`, file);
  if (m.package !== pkg) throw new MemoryError(`${file} is about ${JSON.stringify(m.package)}, not ${pkg}.`, file);
  for (const k of ["builds", "screens", "flows", "explorations"] as const) if (!Array.isArray(m[k])) throw new MemoryError(`${file}: "${k}" must be a list.`, file);
  return m as AppMemory;
}

export async function saveMemory(m: AppMemory, home = homeDir()): Promise<string> {
  const file = memoryFile(m.package, home);
  await mkdir(memoryDir(home), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`);
  await rename(tmp, file);
  return file;
}

export async function listMemories(home = homeDir()): Promise<string[]> {
  try {
    return (await readdir(memoryDir(home))).filter((f) => /^android-.+\.json$/.test(f)).map((f) => f.slice("android-".length, -".json".length)).sort();
  } catch {
    return [];
  }
}

export async function forgetMemory(pkg: string, home = homeDir()): Promise<boolean> {
  const file = memoryFile(pkg, home);
  try {
    await rm(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Parse `dumpsys package <pkg>` into a build identity. */
export function parseBuildIdentity(dumpsys: string): BuildIdentity {
  const versionName = /^\s*versionName=(\S+)/m.exec(dumpsys)?.[1];
  const code = /^\s*versionCode=(\d+)/m.exec(dumpsys)?.[1];
  const installedAt = /^\s*lastUpdateTime=(.+?)\s*$/m.exec(dumpsys)?.[1];
  const versionCode = code ? Number(code) : undefined;
  // Without an install time two builds of the same version cannot be told apart, so the id says so.
  const id = versionCode === undefined && !installedAt ? "unknown" : `${versionCode ?? "?"}@${installedAt ?? "?"}`;
  return { id, versionName, versionCode, installedAt };
}

export const describeBuild = (b: BuildIdentity) => `${b.versionName ?? "?"} (${b.versionCode ?? "?"})${b.installedAt ? `, installed ${b.installedAt}` : ""}`;

/** The build verified before `current`, if any. */
export function previousBuild(m: AppMemory, current: string): BuildRecord | undefined {
  return [...m.builds].filter((b) => b.id !== current).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
}

/** Note that a build was seen. An unknown build is never stored as known. */
export function rememberBuild(m: AppMemory, b: BuildIdentity, at: string, commit?: string): boolean {
  if (b.id === "unknown") return false;
  const known = m.builds.find((x) => x.id === b.id);
  if (known) {
    known.lastSeen = at;
    if (commit) known.commit = commit;
    return false;
  }
  m.builds.push({ ...b, firstSeen: at, lastSeen: at, commit });
  return true;
}

export function flowRecord(m: AppMemory, file: string): FlowRecord | undefined {
  return m.flows.find((f) => f.file === file);
}

export function rememberFlowRun(m: AppMemory, flow: { file: string; name: string; covers?: string[]; sha256: string }, build: string, s: RunSummary, report?: string): FlowRunRecord {
  let rec = flowRecord(m, flow.file);
  if (!rec) m.flows.push((rec = { file: flow.file, name: flow.name, runs: [] }));
  rec.name = flow.name;
  rec.covers = flow.covers?.length ? flow.covers : undefined;
  const run: FlowRunRecord = {
    build,
    at: s.startedAt,
    status: s.status,
    sha256: flow.sha256,
    failure: s.failure ? { step: s.failure.step, category: s.failure.category, message: s.failure.message.slice(0, 300) } : undefined,
    report,
    device: `${s.device.manufacturer} ${s.device.model}`.trim(),
  };
  rec.runs.push(run);
  if (rec.runs.length > KEEP_RUNS) rec.runs.splice(0, rec.runs.length - KEEP_RUNS);
  return run;
}

export interface ScreenChanges {
  /** True when nothing was known before, so "new" would be meaningless. */
  first: boolean;
  added: { signature: string; title: string }[];
  /** Known screens this run did not reach. Not reaching a screen does not mean it was removed. */
  notReached: { signature: string; title: string }[];
}

/** Compare what the explorer reached with what is remembered, then remember it. */
export function rememberExploration(m: AppMemory, build: string, s: ExploreSummary, report?: string): ScreenChanges {
  const first = m.screens.length === 0;
  const seen = new Set(s.screens.map((sc) => sc.signature));
  const known = new Map(m.screens.map((sc) => [sc.signature, sc]));
  const added: ScreenChanges["added"] = [];
  for (const sc of s.screens) {
    const k = known.get(sc.signature);
    if (k) {
      k.lastSeenBuild = build;
      k.lastSeen = s.startedAt;
      k.elements = sc.elements;
    } else {
      m.screens.push({ signature: sc.signature, title: sc.title, elements: sc.elements, firstSeenBuild: build, lastSeenBuild: build, lastSeen: s.startedAt });
      added.push({ signature: sc.signature, title: sc.title });
    }
  }
  const notReached = first ? [] : [...known.values()].filter((k) => !k.ignore && !seen.has(k.signature)).map((k) => ({ signature: k.signature, title: k.title }));
  m.explorations.push({ build, at: s.startedAt, verdict: s.verdict, coverage: s.coverage.level, tapped: s.coverage.tapped, screens: s.screens.length, report });
  if (m.explorations.length > KEEP_RUNS) m.explorations.splice(0, m.explorations.length - KEEP_RUNS);
  return { first, added: first ? [] : added, notReached };
}
