import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { readApkInfo } from "./apk.js";
import { AdbError } from "./adb/connection.js";
import { loadOrCreateKey, type AdbKey } from "./adb/keys.js";
import { discover, SERVICE_CONNECT, SERVICE_PAIRING } from "./adb/mdns.js";
import { pair } from "./adb/pairing.js";
import { assertPackage, Device, SelectorError, type Selector } from "./device.js";
import { fileApprover, Policy, PolicyError, TOOL_CLASSES, type Approver, type PermissionClass } from "./policy.js";
import { build } from "./build.js";
import { explainLocally, loadReport } from "./explain.js";
import { detectProjects } from "./project/detect.js";
import { resolveAndroidToolchain } from "./toolchain/android.js";
import { explore } from "./explore.js";
import { Recording, attachRecording, recordWhile } from "./record.js";
import { runFlow, type Flow } from "./runner.js";
import { formatNodes, smoke } from "./smoke.js";
import { listMemories, loadMemory } from "./memory.js";
import { describeVerify, findFlows, verify } from "./verify.js";
import { VERSION } from "./version.js";

export interface McpOptions {
  /** host:port; auto-discovered over mDNS when omitted. */
  device?: string;
  /** Hide every tool that changes the phone (tap, type, install, launch…). */
  readOnly?: boolean;
  /** Expose a raw `shell` tool. Off by default. */
  allowShell?: boolean;
  /** Expose `build_project`, which runs a project build (Gradle, Flutter) on this computer. Off by default. */
  allowBuild?: boolean;
  /** Let `build_project` download a missing JDK / Android SDK and accept the SDK licenses. Off by default. */
  allowDownloads?: boolean;
  /** Restrict app-level tools to these packages. */
  packages?: string[];
  reportsDir?: string;
  /** Permission classes that need a person's approval on every call. */
  confirm?: PermissionClass[];
  /** Classes approved in advance for an unattended session; removes them from `confirm`. */
  preauthorize?: PermissionClass[];
  /** How to ask a person. Default: MCP elicitation when the client supports it, else `tethertrace approve`. */
  approver?: Approver;
  /** Audit log file (JSONL). Default: <tethertrace home>/audit.jsonl; `false` disables it. */
  auditFile?: string | false;
}

/** Keeps one live connection and reconnects transparently if the phone drops. */
class Session {
  private device?: Device;
  private connecting?: Promise<Device>;
  constructor(
    private readonly key: AdbKey,
    private target?: string,
  ) {}

  close() {
    this.device?.close();
    this.device = undefined;
  }

  setTarget(t: string | undefined) {
    this.target = t;
    this.device?.close();
    this.device = undefined;
  }

  async get(): Promise<Device> {
    if (this.device) return this.device;
    this.connecting ??= (async () => {
      let host: string;
      let port: number;
      if (this.target) {
        const m = /^(.+):(\d+)$/.exec(this.target);
        if (!m) throw new Error(`Bad device address ${this.target}`);
        [host, port] = [m[1]!, Number(m[2])];
      } else {
        const found = (await discover({ services: [SERVICE_CONNECT] })).filter((s) => s.service === SERVICE_CONNECT);
        if (found.length !== 1)
          throw new Error(found.length ? `Several phones found (${found.map((f) => `${f.host}:${f.port}`).join(", ")}); call select_device.` : "No phone found. Turn on Wireless debugging (same Wi-Fi), pair once with pair_device, then retry.");
        ({ host, port } = found[0]!);
      }
      const d = await Device.connect({ host, port, key: this.key });
      d.adb.onClose(() => {
        if (this.device === d) this.device = undefined;
      });
      this.device = d;
      return d;
    })().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  /** Run `fn`, retrying once on a fresh connection if the old one died. */
  async with<T>(fn: (d: Device) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.get());
    } catch (e) {
      if (e instanceof AdbError && e.code === "CLOSED") {
        this.device = undefined;
        return fn(await this.get());
      }
      throw e;
    }
  }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => {
  const err = e as Error & { code?: string; visible?: string[] };
  let msg = `${err.code ? `${err.code}: ` : ""}${err.message}`;
  if (e instanceof SelectorError && e.visible.length) msg += `\nOn screen instead:\n${e.visible.slice(0, 40).join("\n")}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
};

const selectorShape = {
  text: z.string().optional().describe("Visible text or accessibility label (any line of a multi-line label)"),
  desc: z.string().optional().describe("Content description"),
  id: z.string().optional().describe("Resource id, e.g. 'login' or 'com.app:id/login'"),
  contains: z.string().optional().describe("Case-insensitive substring of text or description"),
  index: z.number().int().min(0).optional().describe("Pick the n-th match when several match"),
};

function toSelector(a: { text?: string; desc?: string; id?: string; contains?: string; index?: number }): Selector {
  const s: Record<string, unknown> = {};
  for (const k of ["desc", "id", "contains", "index"] as const) if (a[k] !== undefined) s[k] = a[k];
  if (a.text !== undefined) {
    if (!Object.keys(s).length) return a.text;
    s.text = a.text;
  }
  if (!Object.keys(s).filter((k) => k !== "index").length) throw new Error("Give text, desc, id or contains");
  return s as Selector;
}

export function createMcpServer(key: AdbKey, o: McpOptions = {}) {
  const session = new Session(key, o.device);
  const reportsDir = resolve(o.reportsDir ?? "reports");
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
  const server = new McpServer({ name: "tethertrace", version: VERSION });
  // Drop the phone connection when the client goes away, so nothing lingers.
  server.server.onclose = () => session.close();

  // Ask the person through the client when it supports that, otherwise through a local file that
  // they approve from a terminal (`tethertrace approve <id>`).
  const files = fileApprover();
  const approver: Approver =
    o.approver ??
    (async (req) => {
      if (server.server.getClientCapabilities()?.elicitation) {
        const r = await server.server.elicitInput({
          message: `tethertrace wants to: ${req.summary} (${req.classes.join(", ")}). Allow it?`,
          requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Allow this action" } }, required: ["approve"] },
        });
        return r.action === "accept" && r.content?.approve === true;
      }
      return files(req);
    });
  const policy = new Policy({ readOnly: o.readOnly, allowShell: o.allowShell, allowBuild: o.allowBuild, packages: o.packages, pinnedDevice: o.device, confirm: o.confirm, preauthorize: o.preauthorize, auditFile: o.auditFile, approver });

  // MCP annotations are hints for clients only. Authorization happens in `policy`, below.
  const ro = { readOnlyHint: true, openWorldHint: false };
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
  interface Gate<A> {
    /** The app this call is about, if it names one. Checked against --package. */
    pkg?: (a: A) => string | undefined | Promise<string | undefined>;
    /** Extra permission classes this particular call needs (e.g. installing an APK first). */
    also?: (a: A) => PermissionClass[];
    /** What to show a person asked to approve it. Never include typed text. */
    summary?: (a: A) => string;
    detail?: (a: A) => string | undefined;
  }

  /**
   * The only way a tool gets registered. A tool whose permission classes this session does not
   * grant is not listed at all; one that is listed is authorized again on every call.
   */
  function tool<S extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: S; annotations: Record<string, boolean> },
    gate: Gate<z.infer<z.ZodObject<S>>>,
    handler: (a: z.infer<z.ZodObject<S>>, pkg: string | undefined) => Promise<Result>,
  ) {
    const classes = TOOL_CLASSES[name];
    if (!classes) throw new Error(`Tool ${name} has no permission class in TOOL_CLASSES`);
    if (policy.unavailable(name)) return;
    const run = async (a: z.infer<z.ZodObject<S>>): Promise<Result> => {
      try {
        const pkg = await gate.pkg?.(a);
        if (pkg !== undefined) assertPackage(pkg);
        await policy.authorize({ tool: name, classes: [...classes, ...(gate.also?.(a) ?? [])], pkg, device: o.device, summary: gate.summary?.(a), detail: gate.detail?.(a) });
        return await handler(a, pkg);
      } catch (e) {
        return fail(e);
      }
    };
    (server.registerTool as (n: string, c: unknown, h: unknown) => void)(name, config, run);
  }

  /** In a package-scoped session: the app must be in front before the screen is read or touched. */
  const inScope = (name: string, d: Device, point?: { x: number; y: number }) => policy.assertInScope(name, { focusedPackage: () => d.focusedPackage(), packageAt: (x, y) => d.packageAt(x, y) }, point);

  /** Package of an APK, and proof that it is the app the caller named. */
  const apkPackage = async (apkPath: string | undefined, named: string | undefined) => {
    if (!apkPath) return named;
    const fromApk = (await readApkInfo(apkPath)).packageName;
    if (named !== undefined && named !== fromApk) throw new PolicyError(`${apkPath} contains ${fromApk}, not ${named}; refusing to install a different app than the one named`);
    return fromApk;
  };

  tool("discover_devices", { description: "Find Android phones with Wireless debugging on this Wi-Fi (mDNS). Shows connect and pairing addresses.", inputSchema: {}, annotations: ro }, {}, async () => {
    const found = await discover();
    return text(found.length ? found.map((f) => `${f.service === SERVICE_PAIRING ? "pairing" : "connect"}  ${f.host}:${f.port}  ${f.name}`).join("\n") : "No phones found. Wireless debugging must be on and the phone on the same (non-guest) Wi-Fi.");
  });

  // Pairing adds a trusted key on the phone: the "sensitive" class, never available in --read-only.
  tool(
    "pair_device",
    {
      description: "Pair this computer with a phone, once. The user opens Wireless debugging → 'Pair device with pairing code' and tells you the 6-digit code. Address is auto-discovered if omitted.",
      inputSchema: { code: z.string().regex(/^\d{6}$/), address: z.string().optional().describe("host:port shown next to the code") },
      annotations: act,
    },
    { summary: (a) => `pair this computer with the phone${a.address ? ` at ${a.address}` : ""}` },
    async ({ code, address }) => {
      let host: string, port: number;
      if (address) {
        const m = /^(.+):(\d+)$/.exec(address);
        if (!m) throw new Error("address must be host:port");
        [host, port] = [m[1]!, Number(m[2])];
      } else {
        const f = (await discover({ services: [SERVICE_PAIRING] })).filter((s) => s.service === SERVICE_PAIRING);
        if (f.length !== 1) throw new Error(f.length ? "Several pairing dialogs open; pass address." : "No pairing dialog found; ask the user to open 'Pair device with pairing code'.");
        ({ host, port } = f[0]!);
      }
      const r = await pair({ host, port, code, key });
      return text(`Paired with ${r.deviceGuid}. You can now use the other tools.`);
    },
  );

  tool("select_device", { description: "Use a specific phone (host:port of its connect service). Omit to auto-discover.", inputSchema: { address: z.string().optional() }, annotations: act }, { detail: (a) => a.address }, async ({ address }) => {
    // A server started with --device stays on that device. Every other rule applies to whichever
    // phone is selected, because the policy is checked per call, not per connection.
    policy.assertDevice(address);
    session.setTarget(address);
    const d = await session.get();
    return text(`Connected to ${d.model ?? "device"}`);
  });

  tool("device_info", { description: "Manufacturer, model, Android version, SDK level and ABI of the connected phone.", inputSchema: {}, annotations: ro }, {}, async () => text(JSON.stringify(await session.with((d) => d.info()), null, 2)));

  tool(
    "list_apps",
    { description: "List installed app package names (third-party by default).", inputSchema: { filter: z.string().optional(), includeSystem: z.boolean().optional() }, annotations: ro },
    {},
    async ({ filter, includeSystem }) => {
      const pkgs = await session.with((d) => d.listPackages({ system: includeSystem || policy.scoped, filter }));
      // A package-scoped session only learns about its own apps.
      return text(pkgs.filter((p) => !policy.scope || policy.scope.has(p)).join("\n") || "(none)");
    },
  );

  tool("apk_info", { description: "Read package name, version and SDK levels from a local APK file (no Android SDK needed).", inputSchema: { path: z.string() }, annotations: ro }, {}, async ({ path }) =>
    text(JSON.stringify(await readApkInfo(path), null, 2)),
  );

  tool(
    "screenshot",
    { description: "Capture the phone screen as a PNG. scale 0.5 (default) keeps it small; use 1 for full resolution.", inputSchema: { scale: z.number().min(0.1).max(1).optional() }, annotations: ro },
    {},
    async ({ scale }) => {
      const png = await session.with(async (d) => {
        await inScope("screenshot", d);
        return d.screenshotScaled(scale ?? 0.5);
      });
      return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
    },
  );

  tool(
    "record_screen",
    {
      description: "Record the phone screen for a number of seconds (while the user or another tool uses the phone). Returns where the video was saved. Uses the phone's recorder, or continuous screenshots if it is unavailable.",
      inputSchema: { seconds: z.number().min(1).max(600) },
      annotations: ro,
    },
    { detail: (a) => `${a.seconds}s` },
    async ({ seconds }) => {
      // A recording shows whatever comes on screen for its whole length, which cannot be held to
      // one app. So it is not available in a package-scoped session; record a test run instead.
      if (policy.scoped) throw new PolicyError("record_screen is not available while --package is set, because a recording cannot be limited to one app. Use record: true on run_flow, explore_app or smoke_test.");
      const outDir = join(reportsDir, `recording-${stamp()}`);
      const names = await session.with(async (d) => {
        const r = await Recording.start(d, { maxSeconds: seconds });
        await r.finished();
        return attachRecording(outDir, await r.stop());
      });
      return text(names.map((n) => join(outDir, n)).join("\n"));
    },
  );

  tool(
    "ui_tree",
    { description: "List what is on screen: one line per visible text/button with [tap] markers, resource ids and pixel bounds. Use this to choose tap targets.", inputSchema: {}, annotations: ro },
    {},
    async () => {
      const nodes = await session.with(async (d) => {
        await inScope("ui_tree", d);
        return d.uiNodes();
      });
      return text(formatNodes(nodes) || "(no labelled elements; secure screen or custom rendering)");
    },
  );

  tool(
    "wait_for",
    { description: "Wait until an element appears (or disappears with hidden=true).", inputSchema: { ...selectorShape, hidden: z.boolean().optional(), timeoutMs: z.number().int().min(100).max(120_000).optional() }, annotations: ro },
    {},
    async (a) => {
      await session.with(async (d) => {
        await inScope("wait_for", d);
        await d.waitFor(toSelector(a), { timeoutMs: a.timeoutMs, hidden: a.hidden });
      });
      return text(a.hidden ? "Gone." : "Visible.");
    },
  );

  tool(
    "app_logs",
    {
      description: "Recent logcat lines for one app (its process only; crash buffer included). Good after a failure.",
      inputSchema: { package: z.string(), lines: z.number().int().min(10).max(5000).optional() },
      annotations: ro,
    },
    { pkg: (a) => a.package },
    async ({ lines }, pkg) => {
      const out = await session.with(async (d) => {
        const pid = await d.pidOf(pkg!);
        const main = await d.logcat({ pid, lines: lines ?? 300 });
        const crash = (await d.shell(`logcat -d -b crash -t 200`)).text.split("\n").filter((l) => l.includes(pkg!)).join("\n");
        return `${pid ? `pid ${pid}` : "app not running; showing lines that mention it"}\n${pid ? main : main.split("\n").filter((l) => l.includes(pkg!)).join("\n")}${crash ? `\n--- crash buffer ---\n${crash}` : ""}`;
      });
      return text(out.slice(-60_000));
    },
  );

  tool("explain_report", { description: "Summarise a tethertrace report folder (verdict, failing step, evidence, what was on screen, next check).", inputSchema: { dir: z.string() }, annotations: ro }, {}, async ({ dir }) =>
    text(explainLocally(await loadReport(dir))),
  );

  tool(
    "tap",
    {
      description: "Tap an element by text/desc/id/contains (waits up to timeoutMs for it), or tap raw x,y pixels. Fails with the list of on-screen labels if not found.",
      inputSchema: { ...selectorShape, x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(100).max(60_000).optional() },
      annotations: act,
    },
    {},
    async (a) => {
      if (a.x !== undefined && a.y !== undefined) {
        await session.with(async (d) => {
          await inScope("tap", d, { x: a.x!, y: a.y! });
          await d.tapXY(a.x!, a.y!);
        });
        return text(`Tapped ${a.x},${a.y}`);
      }
      const r = await session.with(async (d) => {
        if (!policy.scoped) return d.tap(toSelector(a), a.timeoutMs);
        // Scoped: find the element first and make sure it belongs to the app before touching it.
        await inScope("tap", d);
        const node = (await d.waitFor(toSelector(a), { timeoutMs: a.timeoutMs, pick: true }))!;
        if (!policy.scope!.has(node.pkg)) throw new PolicyError(`tap blocked: that element belongs to ${node.pkg || "an unknown app"}, not to ${[...policy.scope!].join(", ")}`);
        const [x, y] = [(node.bounds[0] + node.bounds[2]) / 2, (node.bounds[1] + node.bounds[3]) / 2];
        await d.tapXY(x, y);
        return { x, y, node };
      });
      return text(`Tapped "${r.node.text || r.node.desc || r.node.id}" at ${Math.round(r.x)},${Math.round(r.y)}`);
    },
  );

  tool("type_text", { description: "Type ASCII text into the focused field (tap the field first).", inputSchema: { text: z.string().max(2000) }, annotations: act }, {}, async ({ text: t }) => {
    await session.with(async (d) => {
      await inScope("type_text", d);
      await d.type(t);
    });
    return text("Typed.");
  });

  tool(
    "press_key",
    { description: "Press a hardware/navigation key.", inputSchema: { key: z.enum(["back", "home", "enter", "tab", "delete", "menu", "recents"]) }, annotations: act },
    { detail: (a) => a.key },
    async ({ key: k }) => {
      policy.assertKeyInScope("press_key", k);
      await session.with(async (d) => {
        await inScope("press_key", d);
        await d.key(k);
      });
      return text(`Pressed ${k}.`);
    },
  );

  tool("scroll", { description: "Scroll the content. 'down' reveals content further down.", inputSchema: { direction: z.enum(["up", "down", "left", "right"]) }, annotations: act }, {}, async ({ direction }) => {
    await session.with(async (d) => {
      await inScope("scroll", d);
      await d.scroll(direction);
    });
    return text(`Scrolled ${direction}.`);
  });

  tool(
    "swipe",
    { description: "Swipe between two pixel coordinates.", inputSchema: { x1: z.number().int().min(0), y1: z.number().int().min(0), x2: z.number().int().min(0), y2: z.number().int().min(0), durationMs: z.number().int().min(50).max(5000).optional() }, annotations: act },
    {},
    async (a) => {
      await session.with(async (d) => {
        // Both ends must be inside the app: a swipe that starts on the status bar opens the shade.
        await inScope("swipe", d, { x: a.x1, y: a.y1 });
        await inScope("swipe", d, { x: a.x2, y: a.y2 });
        await d.swipeXY(a.x1, a.y1, a.x2, a.y2, a.durationMs);
      });
      return text("Swiped.");
    },
  );

  tool("launch_app", { description: "Cold-start an app (force-stops it first) and report Android's launch time.", inputSchema: { package: z.string() }, annotations: act }, { pkg: (a) => a.package }, async (_a, pkg) => {
    const r = await session.with(async (d) => {
      await d.forceStop(pkg!);
      return d.launch(pkg!);
    });
    return text(`Launched ${r.activity}${r.totalTimeMs !== undefined ? ` in ${r.totalTimeMs} ms` : ""}.`);
  });

  tool("stop_app", { description: "Force-stop an app.", inputSchema: { package: z.string() }, annotations: act }, { pkg: (a) => a.package }, async (_a, pkg) => {
    await session.with((d) => d.forceStop(pkg!));
    return text(`Stopped ${pkg}.`);
  });

  tool(
    "install_apk",
    { description: "Install (or update) a local APK on the phone over Wi-Fi. Returns its package name.", inputSchema: { path: z.string() }, annotations: act },
    { pkg: (a) => apkPackage(a.path, undefined), summary: (a) => `install ${a.path} on the phone`, detail: (a) => a.path },
    async ({ path }, pkg) => {
      const info = await readApkInfo(path);
      await session.with((d) => d.install(path));
      return text(`Installed ${pkg} ${info.versionName ?? ""}`.trim());
    },
  );

  tool(
    "smoke_test",
    {
      description: "Optionally install an APK, cold-start the app, watch it, and save evidence (screenshot, UI, app logs, memory, launch time) with an honest verdict. Package is read from the APK if omitted.",
      inputSchema: { package: z.string().optional(), apkPath: z.string().optional(), waitSeconds: z.number().min(1).max(120).optional(), record: z.boolean().optional().describe("Also record the phone screen into the report") },
      annotations: act,
    },
    { pkg: (a) => apkPackage(a.apkPath, a.package), also: (a) => (a.apkPath ? ["install"] : []), summary: (a) => (a.apkPath ? `install ${a.apkPath} and smoke-test it` : `smoke-test ${a.package}`), detail: (a) => a.apkPath },
    async (a, pkg) => {
      if (!pkg) throw new Error("Give package or apkPath");
      const outDir = join(reportsDir, `smoke-${pkg}-${stamp()}`);
      const s = await session.with((d) => recordWhile(d, a.record, outDir, () => smoke(d, { pkg, apk: a.apkPath, waitMs: (a.waitSeconds ?? 8) * 1000, outDir, screenshot: true })));
      return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}`);
    },
  );

  tool(
    "explore_app",
    {
      description:
        'Zero-config test of any app: optionally install an APK, then walk its screens by tapping visible controls (skipping anything destructive or outward-facing, never typing), watch for crashes, and save screenshots, a report and generated YAML flows (repro.yaml when it crashes). Read coverage next to the verdict: level "none" means nothing could be tapped (canvas, game, secure screen), so no_crash_observed only covers launching.',
      inputSchema: {
        package: z.string().optional(),
        apkPath: z.string().optional(),
        maxActions: z.number().int().min(1).max(300).optional(),
        minutes: z.number().min(0.5).max(30).optional(),
        record: z.boolean().optional().describe("Also record the phone screen into the report"),
      },
      annotations: act,
    },
    { pkg: (a) => apkPackage(a.apkPath, a.package), also: (a) => (a.apkPath ? ["install"] : []), summary: (a) => (a.apkPath ? `install ${a.apkPath} and explore it` : `explore ${a.package}`), detail: (a) => a.apkPath },
    async (a, pkg) => {
      if (!pkg) throw new Error("Give package or apkPath");
      const outDir = join(reportsDir, `test-${pkg}-${stamp()}`);
      const s = await session.with(async (d) => {
        if (a.apkPath) await d.install(a.apkPath);
        // The explorer only ever acts on elements of `pkg` and returns to it when anything else comes up.
        return recordWhile(d, a.record, outDir, () => explore(d, { pkg, outDir, maxActions: a.maxActions, timeBudgetMs: (a.minutes ?? 4) * 60_000 }));
      });
      return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}\nGenerated flow: ${join(outDir, "explored-flow.yaml")}`);
    },
  );

  const parseFlow = async (a: { path?: string; yaml?: string }): Promise<Flow> => {
    const src = a.yaml ?? (a.path ? await readFile(a.path, "utf8") : undefined);
    if (!src) throw new Error("Give path or yaml");
    const doc = YAML.parse(src) as Partial<Flow>;
    if (!doc?.app || typeof doc.app !== "string" || !Array.isArray(doc.steps)) throw new Error('Flow needs "app" and "steps"');
    return { app: doc.app, name: String(doc.name ?? "flow"), steps: doc.steps };
  };

  tool(
    "run_flow",
    {
      description:
        "Run a YAML test flow (file path or inline YAML) and return the result with the failing step, category and evidence. Steps: launch, tap, longPress, type, key, back, home, waitFor, assertVisible, assertHidden, scroll, sleep, screenshot.",
      inputSchema: { path: z.string().optional(), yaml: z.string().optional(), record: z.boolean().optional().describe("Also record the phone screen into the report") },
      annotations: act,
    },
    { pkg: async (a) => (await parseFlow(a)).app, detail: (a) => a.path },
    async (a) => {
      const flow = await parseFlow(a);
      const outDir = join(reportsDir, `${flow.name.replace(/[^\w-]/g, "_")}-${stamp()}`);
      const s = await session.with((d) =>
        recordWhile(d, a.record, outDir, () =>
          runFlow(d, flow, {
            outDir,
            // A flow names its app, but its steps act on whatever is on screen. In a scoped session
            // every acting step is checked, so a flow cannot walk out of the app and keep going.
            beforeAction: policy.scoped
              ? async ({ key: k }) => {
                  if (k) policy.assertKeyInScope("run_flow", k);
                  await inScope("run_flow", d);
                }
              : undefined,
          }),
        ),
      );
      return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}`);
    },
  );

  tool(
    "verify_app",
    {
      description:
        'Check the installed build of an app against what tethertrace remembers about it. mode "changed" (default) re-runs only the flows that could be affected (never run, flow file changed, failed last time, or new build and the source the flow covers changed) and explores when the build is new; "full" runs every flow and explores; "discover" only explores, to record the screens. Flows that are not run are reported as not_run, never as passed. A reached screen only shows it opens without a crash.',
      inputSchema: {
        package: z.string(),
        flows: z.array(z.string()).optional().describe("Flow files or folders; default ./flows when it exists"),
        mode: z.enum(["changed", "full", "discover"]).optional(),
        projectDir: z.string().optional().describe("Git checkout the build was made from, to see which source changed"),
        explore: z.boolean().optional().describe("false: never explore"),
        maxActions: z.number().int().min(1).max(300).optional(),
      },
      annotations: act,
    },
    { pkg: (a) => a.package, summary: (a) => `verify ${a.package} (${a.mode ?? "changed"})`, detail: (a) => a.mode ?? "changed" },
    async (a, pkg) => {
      const where = a.flows ?? ((await stat("flows").then((s) => s.isDirectory(), () => false)) ? ["flows"] : []);
      const { flows, problems } = await findFlows(where);
      if (problems.length) throw new Error(`Some flow files could not be read: ${problems.join("; ")}`);
      const outDir = join(reportsDir, `verify-${pkg}-${stamp()}`);
      const s = await session.with((d) =>
        verify(d, {
          pkg: pkg!,
          mode: a.mode ?? "changed",
          flows,
          outDir,
          projectDir: a.projectDir ? resolve(a.projectDir) : undefined,
          explore: a.explore === false ? false : undefined,
          maxActions: a.maxActions,
          beforeAction: policy.scoped
            ? async ({ key: k }) => {
                if (k) policy.assertKeyInScope("verify_app", k);
                await inScope("verify_app", d);
              }
            : undefined,
        }),
      );
      return text(`${describeVerify(s)}\n\n${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "verify.json")}`);
    },
  );

  tool(
    "app_memory",
    {
      description: "What tethertrace remembers about an app from earlier runs: builds seen, screens the explorer reached, and how each flow went on each build. Read-only. Without a package, lists the apps it remembers.",
      inputSchema: { package: z.string().optional() },
      annotations: ro,
    },
    { pkg: (a) => a.package, detail: (a) => a.package },
    async (a, pkg) => {
      if (!pkg) return text(JSON.stringify((await listMemories()).filter((p) => !policy.scope || policy.scope.has(p)), null, 2));
      return text(JSON.stringify(await loadMemory(pkg), null, 2));
    },
  );

  tool(
    "shell",
    { description: "Run an adb shell command on the phone (enabled with --allow-shell).", inputSchema: { command: z.string().max(4000) }, annotations: { ...act, destructiveHint: true } },
    { summary: (a) => `run a shell command on the phone: ${a.command.slice(0, 200)}`, detail: (a) => a.command.slice(0, 200) },
    async ({ command }) => {
      const r = await session.with((d) => d.shell(command));
      return text(`exit ${r.exitCode}\n${r.text}${r.stderr.length ? `\nstderr:\n${r.stderr.toString("utf8")}` : ""}`.slice(0, 60_000));
    },
  );

  tool(
    "inspect_project",
    {
      description: "Find the app projects in a folder (native Android, Flutter, React Native, SwiftPM/Xcode iOS, prebuilt APK/IPA) and say how each is built, its modules, variants and whether it can be built on this computer. Read-only.",
      inputSchema: { dir: z.string().optional().describe("Folder to look in; default is the working directory of the server") },
      annotations: ro,
    },
    { detail: (a) => a.dir },
    async ({ dir }) => text(JSON.stringify(await detectProjects(resolve(dir ?? ".")), null, 2)),
  );

  tool(
    "toolchain_status",
    { description: "For the Android project in a folder: which JDK and Android SDK a build would use, and exactly what is missing. Read-only; downloads nothing.", inputSchema: { dir: z.string().optional() }, annotations: ro },
    { detail: (a) => a.dir },
    async ({ dir }) => {
      const projects = (await detectProjects(resolve(dir ?? "."))).filter((p) => p.android && p.build.supported === "local");
      if (!projects.length) return text("No buildable Android project found here. Use inspect_project to see what is in the folder.");
      const out = [];
      for (const p of projects) {
        const tc = await resolveAndroidToolchain(p.android!);
        out.push({ project: p.root, kind: p.kind, jdk: tc.jdk, sdk: tc.sdk, missing: tc.missing, ready: tc.missing.length === 0 });
      }
      return text(JSON.stringify(out, null, 2));
    },
  );

  tool(
    "build_project",
    {
      description:
        "Build the app in a folder with its own build system (Gradle wrapper, or Flutter) and return the APKs it produced, or a categorized failure with the lines that matter. Enabled with --allow-build, because it runs the build scripts of the project on this computer. Then use install_apk or explore_app with the returned path.",
      inputSchema: {
        dir: z.string().optional(),
        module: z.string().optional().describe('Gradle app module such as ":app", when there are several'),
        variant: z.string().optional().describe("debug (default), release, or a flavor variant"),
        offline: z.boolean().optional(),
        timeoutMinutes: z.number().min(1).max(120).optional(),
      },
      annotations: { ...act, openWorldHint: true },
    },
    { summary: (a) => `build the project in ${resolve(a.dir ?? ".")} (runs its build scripts on this computer)`, detail: (a) => resolve(a.dir ?? ".") },
    async (a) => {
      const r = await build({
        dir: a.dir,
        platform: "android",
        module: a.module,
        variant: a.variant,
        offline: a.offline,
        timeoutMs: (a.timeoutMinutes ?? 30) * 60_000,
        // Downloads and license acceptance are decided by whoever started the server, never by the agent.
        install: o.allowDownloads === true,
        consent: async () => o.allowDownloads === true,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }], isError: !r.ok };
    },
  );

  // A ready-made prompt so any MCP client can ask its model to write a flow for the app being built.
  server.registerPrompt(
    "write_test",
    {
      title: "Write a tethertrace test for my app",
      description: "Walk the app on the phone, write a YAML flow for a goal, run it and fix it until it passes.",
      argsSchema: {
        package: z.string().describe("Application id of the app under test, e.g. com.example.app"),
        goal: z.string().describe('What the test should prove, e.g. "a user can log in with the test account"'),
      },
    },
    ({ package: pkg, goal }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: writeTestPrompt(pkg, goal) } }],
    }),
  );

  return server;
}

export function writeTestPrompt(pkg: string, goal: string) {
  return `Write a tethertrace YAML test for the Android app ${pkg} that proves: ${goal}

How to work:
1. If the app's source code is in this workspace, read it first to learn the screens, labels and resource ids.
2. Use launch_app, then ui_tree (and screenshot when the tree is unclear) on each screen to find the real labels and ids. Never guess a label you have not seen.
3. Write the flow to flows/<short-name>.yaml using this format:

app: ${pkg}
name: <short-name>
steps:
  - launch
  - tap: "Visible text"            # or { id: x }, { desc: x }, { contains: x }, add index when several match
  - type: "\${TEST_EMAIL}"          # ASCII only; secrets always from environment variables
  - key: enter                      # back, home, enter, tab, delete
  - waitFor: "Next screen text"     # optional timeoutMs: 15000
  - assertVisible: { contains: "expected" }
  - assertHidden: "Loading"
  - scroll: down
  - screenshot: <name>

Prefer { id: ... } selectors for stability, and waitFor over sleep. End with an assertion that proves the goal.
4. Run it with run_flow. If it fails, read the failure category, "On screen instead" and app_logs, fix the flow (not the app) and run again until it passes, or explain why the app itself is broken.
5. Do not add steps that pay, send messages, share, delete data or sign out unless the goal explicitly needs them.
6. Finish with the final YAML, the run result and the report path.`;
}

export async function startMcpServer(o: McpOptions = {}) {
  const server = createMcpServer(await loadOrCreateKey(), o);
  await server.connect(new StdioServerTransport());
}
