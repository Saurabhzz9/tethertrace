import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { readApkInfo } from "./apk.js";
import { AdbError } from "./adb/connection.js";
import { loadOrCreateKey, type AdbKey } from "./adb/keys.js";
import { discover, SERVICE_CONNECT, SERVICE_PAIRING } from "./adb/mdns.js";
import { pair } from "./adb/pairing.js";
import { assertPackage, Device, SelectorError, type Selector } from "./device.js";
import { explainLocally, loadReport } from "./explain.js";
import { explore } from "./explore.js";
import { Recording, attachRecording, recordWhile } from "./record.js";
import { runFlow, type Flow } from "./runner.js";
import { formatNodes, smoke } from "./smoke.js";
import { VERSION } from "./version.js";

export interface McpOptions {
  /** host:port; auto-discovered over mDNS when omitted. */
  device?: string;
  /** Hide every tool that changes the phone (tap, type, install, launch…). */
  readOnly?: boolean;
  /** Expose a raw `shell` tool. Off by default. */
  allowShell?: boolean;
  /** Restrict app-level tools to these packages. */
  packages?: string[];
  reportsDir?: string;
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
  const allowed = o.packages?.length ? new Set(o.packages) : undefined;
  const checkPkg = (pkg: string) => {
    assertPackage(pkg);
    if (allowed && !allowed.has(pkg)) throw new Error(`${pkg} is outside this server's --package scope (${[...allowed].join(", ")})`);
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
  const server = new McpServer({ name: "tethertrace", version: VERSION });
  // Drop the phone connection when the client goes away, so nothing lingers.
  server.server.onclose = () => session.close();
  const control = !o.readOnly;
  const ro = { readOnlyHint: true, openWorldHint: false };
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("discover_devices", { description: "Find Android phones with Wireless debugging on this Wi-Fi (mDNS). Shows connect and pairing addresses.", inputSchema: {}, annotations: ro }, async () => {
    try {
      const found = await discover();
      return text(found.length ? found.map((f) => `${f.service === SERVICE_PAIRING ? "pairing" : "connect"}  ${f.host}:${f.port}  ${f.name}`).join("\n") : "No phones found. Wireless debugging must be on and the phone on the same (non-guest) Wi-Fi.");
    } catch (e) {
      return fail(e);
    }
  });

  // Pairing adds a trusted key on the phone, so it counts as a change: hidden in --read-only.
  if (control) server.registerTool(
    "pair_device",
    {
      description: "Pair this computer with a phone, once. The user opens Wireless debugging → 'Pair device with pairing code' and tells you the 6-digit code. Address is auto-discovered if omitted.",
      inputSchema: { code: z.string().regex(/^\d{6}$/), address: z.string().optional().describe("host:port shown next to the code") },
      annotations: act,
    },
    async ({ code, address }) => {
      try {
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
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool("select_device", { description: "Use a specific phone (host:port of its connect service). Omit to auto-discover.", inputSchema: { address: z.string().optional() }, annotations: ro }, async ({ address }) => {
    session.setTarget(address);
    try {
      const d = await session.get();
      return text(`Connected to ${d.model ?? "device"}`);
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("device_info", { description: "Manufacturer, model, Android version, SDK level and ABI of the connected phone.", inputSchema: {}, annotations: ro }, async () => {
    try {
      return text(JSON.stringify(await session.with((d) => d.info()), null, 2));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "list_apps",
    { description: "List installed app package names (third-party by default).", inputSchema: { filter: z.string().optional(), includeSystem: z.boolean().optional() }, annotations: ro },
    async ({ filter, includeSystem }) => {
      try {
        const pkgs = await session.with((d) => d.listPackages({ system: includeSystem, filter }));
        return text(pkgs.join("\n") || "(none)");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool("apk_info", { description: "Read package name, version and SDK levels from a local APK file (no Android SDK needed).", inputSchema: { path: z.string() }, annotations: ro }, async ({ path }) => {
    try {
      return text(JSON.stringify(await readApkInfo(path), null, 2));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "screenshot",
    { description: "Capture the phone screen as a PNG. scale 0.5 (default) keeps it small; use 1 for full resolution.", inputSchema: { scale: z.number().min(0.1).max(1).optional() }, annotations: ro },
    async ({ scale }) => {
      try {
        const png = await session.with((d) => d.screenshotScaled(scale ?? 0.5));
        return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "record_screen",
    {
      description: "Record the phone screen for a number of seconds (while the user or another tool uses the phone). Returns where the video was saved. Uses the phone's recorder, or continuous screenshots if it is unavailable.",
      inputSchema: { seconds: z.number().min(1).max(600) },
      annotations: ro,
    },
    async ({ seconds }) => {
      try {
        const outDir = join(reportsDir, `recording-${stamp()}`);
        const names = await session.with(async (d) => {
          const r = await Recording.start(d, { maxSeconds: seconds });
          await r.finished();
          return attachRecording(outDir, await r.stop());
        });
        return text(names.map((n) => join(outDir, n)).join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "ui_tree",
    { description: "List what is on screen: one line per visible text/button with [tap] markers, resource ids and pixel bounds. Use this to choose tap targets.", inputSchema: {}, annotations: ro },
    async () => {
      try {
        return text((await session.with((d) => d.uiNodes()).then(formatNodes)) || "(no labelled elements; secure screen or custom rendering)");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_for",
    { description: "Wait until an element appears (or disappears with hidden=true).", inputSchema: { ...selectorShape, hidden: z.boolean().optional(), timeoutMs: z.number().int().min(100).max(120_000).optional() }, annotations: ro },
    async (a) => {
      try {
        await session.with((d) => d.waitFor(toSelector(a), { timeoutMs: a.timeoutMs, hidden: a.hidden }));
        return text(a.hidden ? "Gone." : "Visible.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "app_logs",
    {
      description: "Recent logcat lines for one app (its process only; crash buffer included). Good after a failure.",
      inputSchema: { package: z.string(), lines: z.number().int().min(10).max(5000).optional() },
      annotations: ro,
    },
    async ({ package: pkg, lines }) => {
      try {
        checkPkg(pkg);
        const out = await session.with(async (d) => {
          const pid = await d.pidOf(pkg);
          const main = await d.logcat({ pid, lines: lines ?? 300 });
          const crash = (await d.shell(`logcat -d -b crash -t 200`)).text.split("\n").filter((l) => l.includes(pkg)).join("\n");
          return `${pid ? `pid ${pid}` : "app not running; showing lines that mention it"}\n${pid ? main : main.split("\n").filter((l) => l.includes(pkg)).join("\n")}${crash ? `\n--- crash buffer ---\n${crash}` : ""}`;
        });
        return text(out.slice(-60_000));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool("explain_report", { description: "Summarise a tethertrace report folder (verdict, failing step, evidence, what was on screen, next check).", inputSchema: { dir: z.string() }, annotations: ro }, async ({ dir }) => {
    try {
      return text(explainLocally(await loadReport(dir)));
    } catch (e) {
      return fail(e);
    }
  });

  if (control) {
    server.registerTool(
      "tap",
      {
        description: "Tap an element by text/desc/id/contains (waits up to timeoutMs for it), or tap raw x,y pixels. Fails with the list of on-screen labels if not found.",
        inputSchema: { ...selectorShape, x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(100).max(60_000).optional() },
        annotations: act,
      },
      async (a) => {
        try {
          if (a.x !== undefined && a.y !== undefined) {
            await session.with((d) => d.tapXY(a.x!, a.y!));
            return text(`Tapped ${a.x},${a.y}`);
          }
          const r = await session.with((d) => d.tap(toSelector(a), a.timeoutMs));
          return text(`Tapped "${r.node.text || r.node.desc || r.node.id}" at ${Math.round(r.x)},${Math.round(r.y)}`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool("type_text", { description: "Type ASCII text into the focused field (tap the field first).", inputSchema: { text: z.string().max(2000) }, annotations: act }, async ({ text: t }) => {
      try {
        await session.with((d) => d.type(t));
        return text("Typed.");
      } catch (e) {
        return fail(e);
      }
    });

    server.registerTool(
      "press_key",
      { description: "Press a hardware/navigation key.", inputSchema: { key: z.enum(["back", "home", "enter", "tab", "delete", "menu", "recents"]) }, annotations: act },
      async ({ key: k }) => {
        try {
          await session.with((d) => d.key(k));
          return text(`Pressed ${k}.`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool("scroll", { description: "Scroll the content. 'down' reveals content further down.", inputSchema: { direction: z.enum(["up", "down", "left", "right"]) }, annotations: act }, async ({ direction }) => {
      try {
        await session.with((d) => d.scroll(direction));
        return text(`Scrolled ${direction}.`);
      } catch (e) {
        return fail(e);
      }
    });

    server.registerTool(
      "swipe",
      { description: "Swipe between two pixel coordinates.", inputSchema: { x1: z.number().int().min(0), y1: z.number().int().min(0), x2: z.number().int().min(0), y2: z.number().int().min(0), durationMs: z.number().int().min(50).max(5000).optional() }, annotations: act },
      async (a) => {
        try {
          await session.with((d) => d.swipeXY(a.x1, a.y1, a.x2, a.y2, a.durationMs));
          return text("Swiped.");
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool("launch_app", { description: "Cold-start an app (force-stops it first) and report Android's launch time.", inputSchema: { package: z.string() }, annotations: act }, async ({ package: pkg }) => {
      try {
        checkPkg(pkg);
        const r = await session.with(async (d) => {
          await d.forceStop(pkg);
          return d.launch(pkg);
        });
        return text(`Launched ${r.activity}${r.totalTimeMs !== undefined ? ` in ${r.totalTimeMs} ms` : ""}.`);
      } catch (e) {
        return fail(e);
      }
    });

    server.registerTool("stop_app", { description: "Force-stop an app.", inputSchema: { package: z.string() }, annotations: act }, async ({ package: pkg }) => {
      try {
        checkPkg(pkg);
        await session.with((d) => d.forceStop(pkg));
        return text(`Stopped ${pkg}.`);
      } catch (e) {
        return fail(e);
      }
    });

    server.registerTool("install_apk", { description: "Install (or update) a local APK on the phone over Wi-Fi. Returns its package name.", inputSchema: { path: z.string() }, annotations: act }, async ({ path }) => {
      try {
        const info = await readApkInfo(path);
        checkPkg(info.packageName);
        await session.with((d) => d.install(path));
        return text(`Installed ${info.packageName} ${info.versionName ?? ""}`.trim());
      } catch (e) {
        return fail(e);
      }
    });

    server.registerTool(
      "smoke_test",
      {
        description: "Optionally install an APK, cold-start the app, watch it, and save evidence (screenshot, UI, app logs, memory, launch time) with an honest verdict. Package is read from the APK if omitted.",
        inputSchema: { package: z.string().optional(), apkPath: z.string().optional(), waitSeconds: z.number().min(1).max(120).optional(), record: z.boolean().optional().describe("Also record the phone screen into the report") },
        annotations: act,
      },
      async (a) => {
        try {
          const pkg = a.package ?? (a.apkPath ? (await readApkInfo(a.apkPath)).packageName : undefined);
          if (!pkg) throw new Error("Give package or apkPath");
          checkPkg(pkg);
          const outDir = join(reportsDir, `smoke-${pkg}-${stamp()}`);
          const s = await session.with((d) => recordWhile(d, a.record, outDir, () => smoke(d, { pkg, apk: a.apkPath, waitMs: (a.waitSeconds ?? 8) * 1000, outDir, screenshot: true })));
          return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "explore_app",
      {
        description:
          "Zero-config test of any app: optionally install an APK, then walk its screens by tapping visible controls (skipping anything destructive or outward-facing, never typing), watch for crashes, and save screenshots, a report and generated YAML flows (repro.yaml when it crashes).",
        inputSchema: {
          package: z.string().optional(),
          apkPath: z.string().optional(),
          maxActions: z.number().int().min(1).max(300).optional(),
          minutes: z.number().min(0.5).max(30).optional(),
          record: z.boolean().optional().describe("Also record the phone screen into the report"),
        },
        annotations: act,
      },
      async (a) => {
        try {
          const pkg = a.package ?? (a.apkPath ? (await readApkInfo(a.apkPath)).packageName : undefined);
          if (!pkg) throw new Error("Give package or apkPath");
          checkPkg(pkg);
          const outDir = join(reportsDir, `test-${pkg}-${stamp()}`);
          const s = await session.with(async (d) => {
            if (a.apkPath) await d.install(a.apkPath);
            return recordWhile(d, a.record, outDir, () => explore(d, { pkg, outDir, maxActions: a.maxActions, timeBudgetMs: (a.minutes ?? 4) * 60_000 }));
          });
          return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}\nGenerated flow: ${join(outDir, "explored-flow.yaml")}`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "run_flow",
      {
        description:
          "Run a YAML test flow (file path or inline YAML) and return the result with the failing step, category and evidence. Steps: launch, tap, longPress, type, key, back, home, waitFor, assertVisible, assertHidden, scroll, sleep, screenshot.",
        inputSchema: { path: z.string().optional(), yaml: z.string().optional(), record: z.boolean().optional().describe("Also record the phone screen into the report") },
        annotations: act,
      },
      async (a) => {
        try {
          const src = a.yaml ?? (a.path ? await readFile(a.path, "utf8") : undefined);
          if (!src) throw new Error("Give path or yaml");
          const doc = YAML.parse(src) as Partial<Flow>;
          if (!doc?.app || !Array.isArray(doc.steps)) throw new Error('Flow needs "app" and "steps"');
          checkPkg(doc.app);
          const flow: Flow = { app: doc.app, name: String(doc.name ?? "flow"), steps: doc.steps };
          const outDir = join(reportsDir, `${flow.name.replace(/[^\w-]/g, "_")}-${stamp()}`);
          const s = await session.with((d) => recordWhile(d, a.record, outDir, () => runFlow(d, flow, { outDir })));
          return text(`${JSON.stringify(s, null, 2)}\n\nReport: ${join(outDir, "report.html")}`);
        } catch (e) {
          return fail(e);
        }
      },
    );
  }

  if (o.allowShell) {
    server.registerTool("shell", { description: "Run an adb shell command on the phone (enabled with --allow-shell).", inputSchema: { command: z.string().max(4000) }, annotations: { ...act, destructiveHint: true } }, async ({ command }) => {
      try {
        const r = await session.with((d) => d.shell(command));
        return text(`exit ${r.exitCode}\n${r.text}${r.stderr.length ? `\nstderr:\n${r.stderr.toString("utf8")}` : ""}`.slice(0, 60_000));
      } catch (e) {
        return fail(e);
      }
    });
  }

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
