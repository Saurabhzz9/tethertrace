import { readFile, stat } from "node:fs/promises";
import { AdbConnection, AdbError, withTimeout, type ConnectOptions } from "./adb/connection.js";
import { downscalePng, rawScreencapToPng } from "./image.js";

/** High-level device operations built on the raw ADB connection. */
export class Device {
  private constructor(readonly adb: AdbConnection) {}

  static async connect(opts: ConnectOptions) {
    return new Device(await AdbConnection.connect(opts));
  }

  get model() {
    return this.adb.banner.properties["ro.product.model"];
  }

  async shell(command: string, timeoutMs?: number) {
    const r = await this.adb.exec(command, { timeoutMs });
    return { ...r, text: r.stdout.toString("utf8") };
  }

  async info() {
    const keys = ["ro.product.manufacturer", "ro.product.model", "ro.build.version.release", "ro.build.version.sdk", "ro.product.cpu.abi"];
    const out = (await this.shell(keys.map((k) => `getprop ${k}`).join("; echo __TT_SEP__; "))).text.split("__TT_SEP__").map((s) => s.trim());
    return {
      manufacturer: out[0] ?? "",
      model: out[1] ?? "",
      androidVersion: out[2] ?? "",
      sdk: Number(out[3]) || undefined,
      abi: out[4] ?? "",
      tls: this.adb.usedTls,
      features: [...this.adb.features].sort(),
    };
  }

  /** Raw bytes of a service that writes binary to stdout (exec: avoids PTY newline mangling). */
  private async execRaw(command: string, timeoutMs = 30_000) {
    const s = await this.adb.open(`exec:${command}`);
    return withTimeout(s.readAll(), timeoutMs, () => s.close(), new AdbError("TIMEOUT", `${command.split(" ")[0]} timed out`));
  }

  /** Full-resolution PNG. screencap sometimes returns nothing mid-transition, so retry a couple of times. */
  async screenshotPng() {
    for (let attempt = 0; ; attempt++) {
      const png = await this.execRaw("screencap -p");
      if (isCompletePng(png)) return png;
      if (attempt >= 2) throw new AdbError("PROTOCOL", "Screenshot unavailable (empty or partial image from the phone)");
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Downscaled PNG (scale 0.5 ≈ ¼ the bytes) for AI agents; falls back to full size if the raw format is unknown. */
  async screenshotScaled(scale = 0.5) {
    if (scale >= 1) return this.screenshotPng();
    // Pull the compressed PNG (fast over Wi-Fi) and shrink it here; fall back to the raw framebuffer.
    try {
      return downscalePng(await this.screenshotPng(), scale);
    } catch {
      return rawScreencapToPng(await this.execRaw("screencap"), scale);
    }
  }

  /** Installed third-party packages (or all with `system: true`), optionally filtered. */
  async listPackages(opts: { system?: boolean; filter?: string } = {}) {
    const text = (await this.shell(`pm list packages${opts.system ? "" : " -3"}`)).text;
    const all = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^package:/, "").trim())
      .filter(Boolean)
      .sort();
    return opts.filter ? all.filter((p) => p.includes(opts.filter!)) : all;
  }

  /** Dump of the current UI hierarchy XML. */
  async uiXml() {
    const path = "/data/local/tmp/tethertrace-ui.xml";
    const r = await this.shell(`uiautomator dump ${path} >/dev/null && cat ${path}; rm -f ${path}`, 30_000);
    const start = r.text.indexOf("<?xml");
    if (start < 0) throw new AdbError("PROTOCOL", "UI hierarchy unavailable (secure screen or uiautomator busy)");
    return r.text.slice(start);
  }

  /** Recent logcat, optionally limited to one process. */
  async logcat(opts: { pid?: number; lines?: number } = {}) {
    const pid = opts.pid !== undefined ? ` --pid=${Math.trunc(opts.pid)}` : "";
    return (await this.execRaw(`logcat -d -v threadtime -t ${Math.trunc(opts.lines ?? 2000)}${pid}`)).toString("utf8");
  }

  async pidOf(pkg: string) {
    assertPackage(pkg);
    const r = await this.shell(`pidof ${pkg}`);
    const pid = Number(r.text.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  /** Device clock in logcat's `-T` format, so later log reads start here without clearing anything. */
  async logMark() {
    return (await this.shell("date +'%m-%d %H:%M:%S.000'")).text.trim();
  }

  /** Logs since a mark from {@link logMark}. buffer "crash" holds Java/native crash reports. */
  async logsSince(mark: string, buffer: "main" | "crash" = "main") {
    if (!/^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(mark)) throw new Error("Invalid log mark");
    const b = buffer === "crash" ? " -b crash" : "";
    return (await this.execRaw(`logcat -d -v threadtime${b} -T '${mark}'`)).toString("utf8");
  }

  async isInstalled(pkg: string) {
    assertPackage(pkg);
    return (await this.shell(`pm path ${pkg}`)).text.includes("package:");
  }

  async forceStop(pkg: string) {
    assertPackage(pkg);
    await this.shell(`am force-stop ${pkg}`);
  }

  /** Cold-launch the app's launcher activity; returns Android's own launch timing when reported. */
  async launch(pkg: string) {
    assertPackage(pkg);
    const resolved = (await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`)).text.trim().split("\n").pop()!.trim();
    if (!/^[\w.]+\/[\w.$]+$/.test(resolved)) throw new AdbError("PROTOCOL", `No launcher activity found for ${pkg}`);
    const r = await this.shell(`am start -W -n ${resolved}`, 60_000);
    const total = /TotalTime:\s*(\d+)/.exec(r.text);
    const status = /Status:\s*(\w+)/.exec(r.text);
    return { activity: resolved, totalTimeMs: total ? Number(total[1]) : undefined, status: status?.[1], raw: r.text.trim() };
  }

  async meminfo(pkg: string) {
    assertPackage(pkg);
    const text = (await this.shell(`dumpsys meminfo ${pkg}`)).text;
    const pss = /TOTAL PSS:\s*(\d+)/.exec(text) ?? /TOTAL\s+(\d+)/.exec(text);
    return { totalPssKb: pss ? Number(pss[1]) : undefined, raw: text };
  }

  /** Visible UI elements (text / description / id / bounds) from a hierarchy dump. */
  async uiNodes() {
    return parseUiNodes(await this.uiXml());
  }

  /** Stream an APK to `cmd package install` — no temp file on the phone. */
  async install(apkPath: string) {
    const size = (await stat(apkPath)).size;
    const data = await readFile(apkPath);
    const s = await this.adb.open(`exec:cmd package install -r -S ${size}`);
    await s.write(data);
    const out = (await withTimeout(s.readAll(), 180_000, () => s.close(), new AdbError("TIMEOUT", "Install timed out"))).toString("utf8").trim();
    if (!/^Success/m.test(out)) throw new AdbError("PROTOCOL", `Install failed: ${out.slice(0, 300)}`);
    return out;
  }

  // ---- Interaction -------------------------------------------------------

  private screen?: { w: number; h: number };

  async screenSize() {
    if (!this.screen) {
      const t = (await this.shell("wm size")).text;
      const m = /Override size:\s*(\d+)x(\d+)/.exec(t) ?? /Physical size:\s*(\d+)x(\d+)/.exec(t);
      if (!m) throw new AdbError("PROTOCOL", "Could not read screen size");
      this.screen = { w: Number(m[1]), h: Number(m[2]) };
    }
    return this.screen;
  }
  /** Poll the UI until `selector` appears (or, with `hidden`, is gone). With `pick`, it must resolve to one element. */
  /** Poll the UI until `selector` matches exactly one element (or `hidden`: until it is gone). */
  async waitFor(selector: Selector, opts: { timeoutMs?: number; hidden?: boolean; /** Require exactly one target (for taps). */ pick?: boolean } = {}): Promise<UiNode | undefined> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let last: UiNode[] = [];
    let lastErr: Error | undefined;
    for (;;) {
      try {
        last = await this.uiNodes();
        lastErr = undefined;
        const matches = findNodes(last, selector);
        if (opts.hidden) {
          if (!matches.length) return undefined;
        } else if (matches.length) return opts.pick ? pickOne(matches, selector) : matches[0];
      } catch (e) {
        if (e instanceof SelectorError) throw e;
        if (e instanceof AdbError && e.code === "CLOSED") throw e;
        lastErr = e as Error; // uiautomator can fail mid-animation; retry
      }
      if (Date.now() > deadline) {
        if (lastErr) throw lastErr;
        throw new SelectorError(
          opts.hidden ? "STILL_VISIBLE" : "NOT_FOUND",
          opts.hidden ? `${describe(selector)} is still on screen` : `${describe(selector)} not found on screen`,
          visibleLabels(last),
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** Tap the centre of the element matching `selector` (waits for it to appear). */
  async tap(selector: Selector, timeoutMs?: number) {
    const n = (await this.waitFor(selector, { timeoutMs, pick: true }))!;
    const [x, y] = center(n);
    await this.tapXY(x, y);
    return { x, y, node: n };
  }

  async tapXY(x: number, y: number) {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async longPress(selector: Selector, durationMs = 800) {
    const n = (await this.waitFor(selector, { pick: true }))!;
    const [x, y] = center(n);
    await this.swipeXY(x, y, x, y, durationMs);
  }

  async swipeXY(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    const v = [x1, y1, x2, y2, durationMs].map((n) => Math.round(n));
    if (v.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid swipe coordinates");
    await this.shell(`input swipe ${v.join(" ")}`);
  }

  /** Scroll content: "down" moves the page so lower content becomes visible. */
  async scroll(direction: "up" | "down" | "left" | "right") {
    const { w, h } = await this.screenSize();
    const [cx, cy] = [w / 2, h / 2];
    const dy = h * 0.3;
    const dx = w * 0.3;
    if (direction === "down") await this.swipeXY(cx, cy + dy, cx, cy - dy, 350);
    else if (direction === "up") await this.swipeXY(cx, cy - dy, cx, cy + dy, 350);
    else if (direction === "right") await this.swipeXY(cx + dx, cy, cx - dx, cy, 350);
    else await this.swipeXY(cx - dx, cy, cx + dx, cy, 350);
  }

  /** Type into the focused field. `input text` only supports ASCII. */
  async type(text: string) {
    if (!/^[\x20-\x7e]*$/.test(text)) throw new SelectorError("UNSUPPORTED_TEXT", "Only plain ASCII text can be typed (Android `input text` limitation)", []);
    if (/%s/.test(text)) throw new SelectorError("UNSUPPORTED_TEXT", "The sequence %s cannot be typed", []);
    const arg = text.replace(/ /g, "%s").replace(/'/g, `'\\''`);
    await this.shell(`input text '${arg}'`);
  }

  async key(name: string) {
    const k = KEYS[name.toLowerCase()];
    if (!k) throw new Error(`Unknown key "${name}". Use one of: ${Object.keys(KEYS).join(", ")}`);
    await this.shell(`input keyevent ${k}`);
  }

  close() {
    this.adb.close();
  }
}

const KEYS: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  delete: "KEYCODE_DEL",
  menu: "KEYCODE_MENU",
  recents: "KEYCODE_APP_SWITCH",
};

/** A string matches visible text or description (any line of a multi-line label). */
export type Selector = string | { text?: string; desc?: string; id?: string; contains?: string; index?: number };

export class SelectorError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "STILL_VISIBLE" | "AMBIGUOUS" | "UNSUPPORTED_TEXT",
    message: string,
    /** What *was* on screen — the most useful clue when a step fails. */
    readonly visible: string[],
  ) {
    super(message);
  }
}

const lines = (s: string) => s.split(/\s*\n\s*/).map((l) => l.trim()).filter(Boolean);
const area = (n: UiNode) => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
const center = (n: UiNode): [number, number] => [(n.bounds[0] + n.bounds[2]) / 2, (n.bounds[1] + n.bounds[3]) / 2];

export function describe(sel: Selector) {
  if (typeof sel === "string") return `"${sel}"`;
  return Object.entries(sel)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
}

export function findNodes(nodes: UiNode[], sel: Selector): UiNode[] {
  const s = typeof sel === "string" ? { label: sel } : sel;
  return nodes.filter((n) => {
    if (area(n) <= 0) return false;
    const textHit = (want: string, have: string) => have === want || lines(have).includes(want);
    if ("label" in s && s.label !== undefined && !(textHit(s.label, n.text) || textHit(s.label, n.desc))) return false;
    if ("text" in s && s.text !== undefined && !textHit(s.text, n.text)) return false;
    if ("desc" in s && s.desc !== undefined && !textHit(s.desc, n.desc)) return false;
    if ("id" in s && s.id !== undefined && !(n.id === s.id || n.id.endsWith(`:id/${s.id}`))) return false;
    if ("contains" in s && s.contains !== undefined && !`${n.text}\n${n.desc}`.toLowerCase().includes(s.contains.toLowerCase())) return false;
    return true;
  });
}

/** Choose one match: explicit index, else the single clickable one, else refuse to guess. */
export function pickOne(matches: UiNode[], sel: Selector): UiNode {
  if (typeof sel === "object" && sel.index !== undefined) {
    const n = matches[sel.index];
    if (!n) throw new SelectorError("NOT_FOUND", `${describe(sel)}: only ${matches.length} match(es)`, []);
    return n;
  }
  if (matches.length === 1) return matches[0]!;
  const clickable = matches.filter((m) => m.clickable);
  if (clickable.length === 1) return clickable[0]!;
  // A clickable container and its own label often both match: keep the innermost clickable.
  const pool = clickable.length ? clickable : matches;
  const innermost = pool.filter((a) => !pool.some((b) => b !== a && contains(a, b)));
  if (innermost.length === 1) return innermost[0]!;
  throw new SelectorError("AMBIGUOUS", `${describe(sel)} matches ${matches.length} elements; add "index" or a more specific selector`, matches.map((m) => `${m.text || m.desc} @${m.bounds.join(",")}`));
}

function contains(outer: UiNode, inner: UiNode) {
  const [a, b] = [outer.bounds, inner.bounds];
  return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3] && area(outer) > area(inner);
}

export function visibleLabels(nodes: UiNode[]) {
  return nodes.filter((n) => (n.text || n.desc) && area(n) > 0).map((n) => `${n.clickable ? "[tap] " : ""}${lines(n.text || n.desc).join(" / ")}`);
}

export interface UiNode {
  text: string;
  desc: string;
  id: string;
  cls: string;
  clickable: boolean;
  bounds: [number, number, number, number];
  /** Package that owns this element (tells whether the app is still in the foreground). */
  pkg: string;
  /** Switches, checkboxes and radio buttons: tapping them changes a setting. */
  checkable: boolean;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = unescape(a[2]!);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    nodes.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      id: attrs["resource-id"] ?? "",
      pkg: attrs.package ?? "",
      cls: attrs.class ?? "",
      clickable: attrs.clickable === "true",
      checkable: attrs.checkable === "true",
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
    });
  }
  return nodes;
}

export function isCompletePng(b: Buffer) {
  return b.length > 20 && b.readUInt32BE(0) === 0x89504e47 && b.subarray(b.length - 8, b.length - 4).toString("latin1") === "IEND";
}

export function assertPackage(pkg: string) {
  if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(pkg)) throw new Error(`Invalid package name: ${pkg}`);
}
