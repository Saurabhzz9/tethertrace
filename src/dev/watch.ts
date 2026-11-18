import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { globToRegExp } from "../verify.js";

/**
 * Watches a project folder for source edits and hands them over in batches.
 *
 * One recursive `fs.watch` (native on Windows and macOS, built into Node on Linux), so there is
 * no polling. Events are debounced, generated folders are ignored, and a file whose content did
 * not change (an editor touching it, a build rewriting the same bytes) is dropped, which is what
 * keeps a build from triggering itself.
 */

export type ChangeKind = "source" | "dependency" | "native" | "config";

export interface FileChange {
  /** Path relative to the watched root, always with forward slashes. */
  path: string;
  event: "added" | "modified" | "deleted";
  kind: ChangeKind;
}

/** Folder names that are never source, at any depth. */
export const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "build", "dist", "out", "reports", ".gradle", ".idea", ".vscode", ".dart_tool",
  ".expo", ".cxx", ".externalNativeBuild", ".kotlin", "Pods", "DerivedData", ".next", "coverage", ".tethertrace", "tmp", ".fvm",
]);

const IGNORED_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|\.#.*|#.*#|.*~|.*\.(sw[po]|tmp|temp|log|lock\.tmp|crdownload|apk|aab|ipa|class|dex|iml))$/i;

const DEPENDENCY = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pubspec\.(yaml|lock)|.*\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml|gradle-wrapper\.properties|Podfile(\.lock)?)$/;
const CONFIG = /(^|\/)(AndroidManifest\.xml|app\.json|app\.config\.(js|ts)|metro\.config\.(js|cjs|ts)|babel\.config\.(js|cjs)|react-native\.config\.js|analysis_options\.yaml|local\.properties|proguard-rules\.pro|tethertrace\.json)$/;

/** What sort of change this is; adapters use it to choose reload vs rebuild. */
export function classifyChange(path: string): ChangeKind {
  if (DEPENDENCY.test(path)) return "dependency";
  if (CONFIG.test(path)) return "config";
  if (/^(android|ios)\//.test(path) && !/\.(dart|[jt]sx?)$/.test(path)) return "native";
  return "source";
}

/** Patterns from a .gitignore, as matchers on root-relative paths. Negations are not supported and are skipped. */
export function parseGitignore(text: string): RegExp[] {
  const out: RegExp[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    line = line.replace(/^\//, "").replace(/\/$/, "");
    const body = globToRegExp(anchored ? line : `**/${line}`).source.replace(/\$$/, "");
    out.push(new RegExp(`${body}(/.*)?$`));
  }
  return out;
}

export function isIgnored(rel: string, extra: RegExp[] = []): boolean {
  if (!rel || IGNORED_FILE.test(rel)) return true;
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p))) return true;
  if (IGNORED_DIRS.has(parts[parts.length - 1]!) && !parts[parts.length - 1]!.includes(".")) return true;
  return extra.some((r) => r.test(rel));
}

export interface WatchOptions {
  debounceMs?: number;
  /** Extra ignore patterns (glob, root-relative). */
  ignore?: string[];
  onBatch: (changes: FileChange[]) => void;
  onError?: (e: Error) => void;
}

const MAX_HASH_BYTES = 4 * 1024 * 1024;

export class ProjectWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private pending = new Set<string>();
  private hashes = new Map<string, string>();
  private extra: RegExp[] = [];
  private closed = false;
  private startedAt = Date.now();

  constructor(readonly root: string, private readonly o: WatchOptions) {}

  async start() {
    this.startedAt = Date.now();
    try {
      this.extra.push(...parseGitignore(await readFile(join(this.root, ".gitignore"), "utf8")));
    } catch {
      /* no .gitignore */
    }
    for (const g of this.o.ignore ?? []) this.extra.push(globToRegExp(g));
    this.watcher = fsWatch(this.root, { recursive: true, persistent: true }, (_ev, name) => {
      if (!name || this.closed) return;
      const rel = name.toString().split(sep).join("/");
      if (isIgnored(rel, this.extra)) return;
      this.pending.add(rel);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.o.debounceMs ?? 250);
    });
    this.watcher.on("error", (e) => this.o.onError?.(e));
  }

  /** Remember a file's current content so an unchanged rewrite is not reported. */
  private async digest(abs: string): Promise<{ h: string; born: number } | undefined | null> {
    try {
      const s = await stat(abs);
      if (!s.isFile()) return null;
      if (s.size > MAX_HASH_BYTES) return { h: `${s.size}:${s.mtimeMs}`, born: s.birthtimeMs };
      return { h: createHash("sha1").update(await readFile(abs)).digest("hex"), born: s.birthtimeMs };
    } catch {
      return undefined; // gone
    }
  }

  private async flush() {
    const names = [...this.pending];
    this.pending.clear();
    const changes: FileChange[] = [];
    for (const rel of names) {
      const d = await this.digest(join(this.root, rel));
      if (d === null) continue; // a folder
      const before = this.hashes.get(rel);
      if (d === undefined) {
        this.hashes.delete(rel);
        changes.push({ path: rel, event: "deleted", kind: classifyChange(rel) });
      } else if (d.h !== before) {
        this.hashes.set(rel, d.h);
        // First sight of a file: it is new if it was created after the watch began (birth time is 0 where the file system does not keep it).
        const event = before !== undefined || !(d.born >= this.startedAt) ? "modified" : "added";
        changes.push({ path: rel, event, kind: classifyChange(rel) });
      }
    }
    if (changes.length && !this.closed) this.o.onBatch(changes);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.watcher?.close();
  }
}

export const relPath = (root: string, abs: string) => relative(root, abs).split(sep).join("/");
