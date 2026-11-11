import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homeDir } from "./adb/keys.js";

/**
 * One authorization policy for everything that touches a device.
 *
 * Every MCP tool is registered with a permission class and goes through {@link Policy.authorize}
 * before it runs. MCP annotations (readOnlyHint…) are only hints for clients; nothing here relies
 * on them. The policy knows nothing about Android: a future platform adapter gets the same rules by
 * giving it a {@link ScopeProbe}.
 */

export type PermissionClass = "read" | "interact" | "install" | "execute" | "sensitive";
export const PERMISSION_CLASSES: readonly PermissionClass[] = ["read", "interact", "install", "execute", "sensitive"];

/**
 * - read: screenshots, UI inspection, logs, diagnostics
 * - interact: tap, swipe, type, keys, launching/stopping an app, running tests
 * - install: installing or updating an app
 * - execute: raw shell on the device (and, later, running builds)
 * - sensitive: changes to who may control the device (pairing)
 */
export const TOOL_CLASSES: Readonly<Record<string, readonly PermissionClass[]>> = {
  discover_devices: ["read"],
  select_device: ["read"],
  device_info: ["read"],
  list_apps: ["read"],
  apk_info: ["read"],
  screenshot: ["read"],
  record_screen: ["read"],
  ui_tree: ["read"],
  wait_for: ["read"],
  app_logs: ["read"],
  explain_report: ["read"],
  tap: ["interact"],
  type_text: ["interact"],
  press_key: ["interact"],
  scroll: ["interact"],
  swipe: ["interact"],
  launch_app: ["interact"],
  stop_app: ["interact"],
  run_flow: ["interact"],
  smoke_test: ["interact"],
  explore_app: ["interact"],
  install_apk: ["install"],
  shell: ["execute"],
  pair_device: ["sensitive"],
};

export class PolicyError extends Error {
  readonly code = "POLICY_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface ApprovalRequest {
  tool: string;
  classes: PermissionClass[];
  /** Short, human-readable description of what will happen. Never contains typed text. */
  summary: string;
}

/** Ask a human. Return true to allow. Throwing or returning false denies. */
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/** What the policy needs from a device to check where an action would land. */
export interface ScopeProbe {
  /** Package of the window that has input focus, or undefined when it cannot be determined. */
  focusedPackage(): Promise<string | undefined>;
  /** Package of the element drawn at a pixel, or undefined when it cannot be determined. */
  packageAt?(x: number, y: number): Promise<string | undefined>;
}

export interface PolicyOptions {
  readOnly?: boolean;
  allowShell?: boolean;
  /** Restrict everything app-related to these packages. */
  packages?: string[];
  /** The device this server was started for. When set, switching to another one is refused. */
  pinnedDevice?: string;
  /** Classes that need a human's approval for each call. */
  confirm?: PermissionClass[];
  /** Classes approved in advance for an unattended session; removes them from `confirm`. */
  preauthorize?: PermissionClass[];
  approver?: Approver;
  /** JSONL file for the audit log. Default: <tethertrace home>/audit.jsonl. `false` turns it off. */
  auditFile?: string | false;
}

export interface AuditEntry {
  t: string;
  tool: string;
  classes: PermissionClass[];
  decision: "allowed" | "denied" | "approved" | "preauthorized" | "approval_pending";
  reason?: string;
  package?: string;
  device?: string;
  detail?: string;
}

export function parseClasses(list: string | string[] | undefined, flag: string): PermissionClass[] {
  const items = (Array.isArray(list) ? list : (list ?? "").split(",")).flatMap((s) => s.split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const i of items) if (!PERMISSION_CLASSES.includes(i as PermissionClass)) throw new Error(`${flag}: unknown permission class "${i}" (use ${PERMISSION_CLASSES.join(", ")})`);
  return [...new Set(items)] as PermissionClass[];
}

export class Policy {
  readonly scope?: ReadonlySet<string>;
  private readonly granted: ReadonlySet<PermissionClass>;
  private readonly confirm: ReadonlySet<PermissionClass>;
  private readonly preauthorized: ReadonlySet<PermissionClass>;
  private readonly auditFile: string | false;
  private auditReady?: Promise<unknown>;

  constructor(private readonly o: PolicyOptions = {}) {
    this.scope = o.packages?.length ? new Set(o.packages) : undefined;
    const g = new Set<PermissionClass>(["read"]);
    // Read-only wins over everything else, including --allow-shell.
    if (!o.readOnly) {
      g.add("interact").add("install").add("sensitive");
      if (o.allowShell) g.add("execute");
    }
    this.granted = g;
    this.preauthorized = new Set(o.preauthorize ?? []);
    this.confirm = new Set((o.confirm ?? []).filter((c) => !this.preauthorized.has(c)));
    this.auditFile = o.auditFile === false ? false : (o.auditFile ?? join(homeDir(), "audit.jsonl"));
  }

  /** Whether a class is available at all in this session (used to decide which tools to list). */
  grants(cls: PermissionClass) {
    return this.granted.has(cls);
  }

  get scoped() {
    return this.scope !== undefined;
  }

  /**
   * The single gate. Throws {@link PolicyError} when the call is not allowed; resolves when it is.
   * `pkg` is the app the call is about, when it names one.
   */
  async authorize(req: { tool: string; classes?: PermissionClass[]; pkg?: string; device?: string; summary?: string; detail?: string }): Promise<void> {
    const classes = req.classes ?? [...(TOOL_CLASSES[req.tool] ?? [])];
    const base = { tool: req.tool, classes, package: req.pkg, device: req.device, detail: req.detail };
    const deny = async (reason: string): Promise<never> => {
      await this.audit({ ...base, decision: "denied", reason });
      throw new PolicyError(reason);
    };
    // Unknown tools have no class, so they can never run: fail closed.
    if (!classes.length) return deny(`${req.tool} has no permission class; refusing to run it`);
    for (const c of classes) {
      if (!this.granted.has(c))
        return deny(
          this.o.readOnly ? `${req.tool} needs "${c}" permission, but this server is read-only` : c === "execute" ? `${req.tool} needs "execute" permission; start the server with --allow-shell` : `${req.tool} needs "${c}" permission, which this server does not grant`,
        );
    }
    if (req.pkg !== undefined) {
      const why = this.packageDenial(req.pkg);
      if (why) return deny(why);
    }
    // Raw shell cannot be confined to an app, so it is never available in a package-scoped session.
    if (classes.includes("execute") && this.scope) return deny(`${req.tool} cannot be limited to ${[...this.scope].join(", ")}; it is disabled while --package is set`);

    const needs = classes.filter((c) => this.confirm.has(c));
    if (needs.length) {
      const summary = req.summary ?? req.tool;
      let ok = false;
      let reason = "no approver is available";
      if (this.o.approver) {
        try {
          ok = await this.o.approver({ tool: req.tool, classes: needs, summary });
          if (!ok) reason = "the user declined";
        } catch (e) {
          reason = (e as Error).message;
        }
      }
      if (!ok) {
        const pending = e_isPending(reason);
        await this.audit({ ...base, decision: pending ? "approval_pending" : "denied", reason });
        throw new PolicyError(pending ? reason : `${req.tool} needs approval (${needs.join(", ")}) and was not approved: ${reason}`);
      }
      await this.audit({ ...base, decision: "approved" });
      return;
    }
    await this.audit({ ...base, decision: classes.some((c) => this.preauthorized.has(c)) ? "preauthorized" : "allowed" });
  }

  private packageDenial(pkg: string): string | undefined {
    if (this.scope && !this.scope.has(pkg)) return `${pkg} is outside this server's --package scope (${[...this.scope].join(", ")})`;
    return undefined;
  }

  /** Throws unless `pkg` is in scope (or there is no scope). */
  checkPackage(pkg: string) {
    const why = this.packageDenial(pkg);
    if (why) throw new PolicyError(why);
  }

  /**
   * In a package-scoped session, make sure the screen (and, for raw coordinates, the exact spot)
   * belongs to an authorized app before reading it or acting on it. When that cannot be
   * established, the answer is no.
   */
  async assertInScope(tool: string, probe: ScopeProbe, point?: { x: number; y: number }): Promise<void> {
    if (!this.scope) return;
    const deny = async (reason: string): Promise<never> => {
      await this.audit({ tool, classes: [...(TOOL_CLASSES[tool] ?? [])], decision: "denied", reason });
      throw new PolicyError(reason);
    };
    let focused: string | undefined;
    try {
      focused = await probe.focusedPackage();
    } catch {
      focused = undefined;
    }
    const names = [...this.scope].join(", ");
    if (!focused) return deny(`${tool} blocked: could not tell which app is in front, and this server is limited to ${names}`);
    if (!this.scope.has(focused)) return deny(`${tool} blocked: ${focused} is in front, and this server is limited to ${names}. Use launch_app to bring the app back.`);
    if (point) {
      let at: string | undefined;
      try {
        at = await probe.packageAt?.(point.x, point.y);
      } catch {
        at = undefined;
      }
      if (!at) return deny(`${tool} blocked: could not tell which app owns ${point.x},${point.y}, and this server is limited to ${names}`);
      if (!this.scope.has(at)) return deny(`${tool} blocked: ${point.x},${point.y} belongs to ${at}, not to ${names}`);
    }
  }

  /** Keys that leave the app by definition; refused in a package-scoped session. */
  assertKeyInScope(tool: string, key: string) {
    if (this.scope && /^(home|recents|menu|power|app_switch)$/i.test(key)) throw new PolicyError(`${tool} blocked: the "${key}" key leaves the app, and this server is limited to ${[...this.scope].join(", ")}`);
  }

  /** Refuse to move to another device than the one the server was started for. */
  assertDevice(address: string | undefined) {
    const pin = this.o.pinnedDevice;
    if (pin && address !== undefined && address !== pin) throw new PolicyError(`This server was started for ${pin}; switching to ${address} is not allowed. Restart it without --device to choose phones freely.`);
    if (pin && address === undefined) throw new PolicyError(`This server was started for ${pin}; auto-discovering another phone is not allowed.`);
  }

  async audit(entry: Omit<AuditEntry, "t">): Promise<void> {
    if (this.auditFile === false) return;
    const file = this.auditFile;
    try {
      this.auditReady ??= mkdir(dirname(file), { recursive: true });
      await this.auditReady;
      const clean = Object.fromEntries(Object.entries({ t: new Date().toISOString(), ...entry }).filter(([, v]) => v !== undefined));
      await appendFile(file, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    } catch {
      // An unwritable audit log must not take the tools down with it.
    }
  }
}

const PENDING_PREFIX = "Approval needed";
const e_isPending = (reason: string) => reason.startsWith(PENDING_PREFIX);

// ---------------------------------------------------------------------------------------------
// Out-of-band approvals: the request is written to a local file and a person approves it from a
// terminal with `tethertrace approve <id>`. This works with any MCP client, including ones that
// auto-approve tool calls. It does not protect against an agent that can run shell commands on the
// same computer as the same user; nothing running locally can.

export interface PendingApproval {
  id: string;
  tool: string;
  classes: PermissionClass[];
  summary: string;
  createdAt: string;
  approved?: boolean;
}

const APPROVAL_TTL_MS = 10 * 60_000;
export const approvalsDir = () => join(homeDir(), "approvals");

async function readApproval(file: string): Promise<PendingApproval | undefined> {
  try {
    const a = JSON.parse(await readFile(file, "utf8")) as PendingApproval;
    if (Date.now() - Date.parse(a.createdAt) > APPROVAL_TTL_MS) {
      await rm(file, { force: true });
      return undefined;
    }
    return a;
  } catch {
    return undefined;
  }
}

export async function listApprovals(dir = approvalsDir()): Promise<PendingApproval[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: PendingApproval[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const a = await readApproval(join(dir, n));
    if (a) out.push(a);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function approve(id: string, dir = approvalsDir()): Promise<PendingApproval> {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new Error("Approval ids are 8 hex characters");
  const file = join(dir, `${id}.json`);
  const a = await readApproval(file);
  if (!a) throw new Error(`No pending approval ${id} (they expire after 10 minutes)`);
  a.approved = true;
  await writeFile(file, JSON.stringify(a), { mode: 0o600 });
  return a;
}

/**
 * An approver backed by local files. The first call for a request creates it and is refused with
 * instructions; after a person runs `tethertrace approve <id>`, the same request passes once.
 */
export function fileApprover(dir = approvalsDir()): Approver {
  return async (req) => {
    await mkdir(dir, { recursive: true });
    const same = (a: PendingApproval) => a.tool === req.tool && a.summary === req.summary && a.classes.join() === req.classes.join();
    const existing = (await listApprovals(dir)).filter(same);
    const ok = existing.find((a) => a.approved);
    if (ok) {
      await rm(join(dir, `${ok.id}.json`), { force: true }); // one approval, one call
      return true;
    }
    const pending = existing[0] ?? { id: randomBytes(4).toString("hex"), tool: req.tool, classes: req.classes, summary: req.summary, createdAt: new Date().toISOString() };
    if (!existing.length) await writeFile(join(dir, `${pending.id}.json`), JSON.stringify(pending), { mode: 0o600 });
    throw new Error(`${PENDING_PREFIX}: ${req.summary}. Ask the user to run \`tethertrace approve ${pending.id}\` in a terminal, then call ${req.tool} again with the same arguments.`);
  };
}
