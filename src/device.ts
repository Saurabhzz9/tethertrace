import { open } from "node:fs/promises";
import { AdbConnection, AdbError, withTimeout, type AdbStream, type ConnectOptions } from "./adb/connection.js";
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

  /**
   * Package of the window that has input focus, or undefined when Android does not name one
   * (notification shade, lock screen) or the answer cannot be read. Used to keep a package-scoped
   * session inside its app.
   */
  async focusedPackage(): Promise<string | undefined> {
    const t = (await this.shell("dumpsys window | grep -E 'mCurrentFocus'")).text;
    const line = t.split(/\r?\n/).find((l) => l.includes("mCurrentFocus"));
    const m = line && /mCurrentFocus=Window\{[^}]*?\s([A-Za-z][\w]*(?:\.[\w]+)+)\/[^}\s]*\}/.exec(line);
    return m ? m[1] : undefined;
  }

  /**
   * Screen areas that belong to the system even when an app draws underneath them: the status bar,
   * the navigation bar and the gesture strips. A touch that starts there opens the notification
   * shade or goes home, whatever app is in front.
   */
  async systemAreas(): Promise<[number, number, number, number][]> {
    const t = (await this.shell("dumpsys window displays | grep -E 'InsetsSource'").catch(() => ({ text: "" }))).text;
    const areas: [number, number, number, number][] = [];
    for (const m of t.matchAll(/type=(statusBars|navigationBars|mandatorySystemGestures)\s+frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]\s+visible=true/g)) {
      const r: [number, number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
      if (r[2] > r[0] && r[3] > r[1] && !areas.some((a) => a.join() === r.join())) areas.push(r);
    }
    if (areas.length) return areas;
    // Android did not say (older versions, unusual builds): assume a bar at the top and bottom edge.
    const { w, h } = await this.screenSize();
    return [
      [0, 0, w, Math.round(h * 0.04)],
      [0, Math.round(h * 0.95), w, h],
    ];
  }

  /**
   * Package that owns a pixel: "com.android.systemui" inside a system bar or gesture strip,
   * otherwise the smallest on-screen element that contains it, or undefined if none does.
   */
  async packageAt(x: number, y: number): Promise<string | undefined> {
    if ((await this.systemAreas()).some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) return "com.android.systemui";
    const hit = (await this.uiNodes())
      .filter((n) => n.pkg && x >= n.bounds[0] && x <= n.bounds[2] && y >= n.bounds[1] && y <= n.bounds[3])
      .sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))[0];
    return hit?.pkg || undefined;
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
  /**
   * Start the app's launcher activity in a clean task. Pass `resume: true` to bring an existing task to
   * the front as it is instead. A clean task matters after a force-stop: activities from other apps that
   * the app opened (a photo picker, a share sheet) survive in its task, and a plain start would only
   * show them again without starting the app.
   */
  async launch(pkg: string, { resume = false }: { resume?: boolean } = {}) {
    assertPackage(pkg);
    const resolved = (await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`)).text.trim().split("\n").pop()!.trim();
    if (!/^[\w.]+\/[\w.$]+$/.test(resolved)) throw new AdbError("PROTOCOL", `No launcher activity found for ${pkg}`);
    const r = await this.shell(`am start -W${resume ? "" : " --activity-clear-task"} -n ${resolved}`, 60_000);
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
    let nodes = parseUiNodes(await this.uiXml());
    // A WebView builds its accessibility tree only after something first asks for it, so the first
    // read of a web screen shows an empty WebView. Ask again before believing it is empty.
    for (let i = 0; i < 2 && hasEmptyWebView(nodes); i++) {
      await new Promise((r) => setTimeout(r, 700));
      nodes = parseUiNodes(await this.uiXml());
    }
    return nodes;
  }

  /** Stream an APK to `cmd package install` — no temp file on the phone. */
  /**
   * Install an APK. The file is read and sent one chunk at a time (never loaded whole), and each
   * chunk waits for the phone before the next, so memory stays flat for any APK size. If the link
   * stops moving for `stallTimeoutMs` the install fails with how far it got, instead of hanging.
   */
  async install(apkPath: string, opts: { onProgress?: (sentBytes: number, totalBytes: number) => void; stallTimeoutMs?: number } = {}) {
    const fh = await open(apkPath, "r");
    let s: AdbStream | undefined;
    let sent = 0;
    let size = 0;
    try {
      size = (await fh.stat()).size;
      s = await this.adb.open(`exec:cmd package install -r -S ${size}`);
      const buf = Buffer.allocUnsafe(Math.min(this.adb.maxPayload, Math.max(size, 1)));
      while (sent < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - sent), sent);
        if (!bytesRead) throw new AdbError("PROTOCOL", `${apkPath} changed while it was being sent`);
        // The chunk is reused for the next read only after this write has been flushed and acknowledged.
        await s.write(buf.subarray(0, bytesRead), { stallTimeoutMs: opts.stallTimeoutMs });
        sent += bytesRead;
        opts.onProgress?.(sent, size);
      }
    } catch (e) {
      s?.close();
      const mb = (n: number) => (n / 1e6).toFixed(1);
      if (e instanceof AdbError && e.code === "TIMEOUT" && s)
        throw new AdbError("TIMEOUT", `Install stalled after ${mb(sent)} of ${mb(size)} MB: ${e.message.replace(/^The device/, "the phone")}. The Wi-Fi link is probably dropping; move closer to the router and try again.`);
      throw e;
    } finally {
      await fh.close();
    }
    const out = (await withTimeout(s.readAll(), 180_000, () => s.close(), new AdbError("TIMEOUT", "Install timed out"))).toString("utf8").trim();
    if (!/^Success/m.test(out)) throw new AdbError("PROTOCOL", `Install failed: ${out.slice(0, 300)}`);
    return out;
  }

  /**
   * Write a file into a debuggable app's private folder, as that app (`run-as`). Returns what the
   * phone printed; it ends with TAPP_SENT when every byte arrived. Works only for apps built
   * debuggable, which is how Android lets a developer reach an app's own storage.
   */
  async pushAs(pkg: string, relPath: string, data: Buffer) {
    assertPackage(pkg);
    if (!/^[\w./-]+$/.test(relPath) || relPath.startsWith("/") || relPath.split("/").includes("..")) throw new Error(`Unsafe path "${relPath}"`);
    const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
    const s = await this.adb.open(`exec:run-as ${pkg} sh -c 'mkdir -p ${dir} && head -c ${data.length} > ${relPath} && echo TAPP_SENT'`);
    try {
      if (data.length) await s.write(data);
      return (await withTimeout(s.readAll(), 60_000, () => s.close(), new AdbError("TIMEOUT", "The phone did not confirm the file"))).toString("utf8");
    } finally {
      s.close();
    }
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
    await this.waitUntilUncovered(x, y);
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  /**
   * Where System UI is taking touches right now: a notification that popped up over the app, or the
   * pulled-down shade. Read from the input system, so it is what a tap would actually hit.
   * Android shows such a notification each time a computer connects over Wireless debugging, so a
   * tap right after connecting can land on it instead of the app.
   */
  async systemOverlays(): Promise<[number, number, number, number][]> {
    const out = (await this.shell(`dumpsys input | grep -E "name='[^']*(NotificationShade|HeadsUp)"`)).text;
    const rects: [number, number, number, number][] = [];
    for (const line of out.split("\n")) {
      if (/NOT_TOUCHABLE/.test(line)) continue;
      const region = /touchableRegion=((?:\[-?\d+,-?\d+\]\[-?\d+,-?\d+\])+)/.exec(line)?.[1];
      for (const m of region?.matchAll(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g) ?? []) {
        const r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
        if (r[2] > r[0] && r[3] > r[1] && !rects.some((o) => o.join() === r.join())) rects.push(r);
      }
    }
    return rects;
  }

  /**
   * Before touching (x, y), wait for a notification over that spot to go away (they hide after a
   * few seconds). If something still covers it, close the shade once, then give up rather than
   * tap whatever System UI is showing.
   */
  async waitUntilUncovered(x: number, y: number, timeoutMs = 8000) {
    const covered = async () => (await this.systemOverlays()).some(([l, t, r, b]) => x >= l && x < r && y >= t && y < b);
    const deadline = Date.now() + timeoutMs;
    let collapsed = false;
    while (await covered()) {
      if (Date.now() >= deadline) {
        if (collapsed) throw new AdbError("PROTOCOL", `A notification or the notification shade is covering ${Math.round(x)},${Math.round(y)}; not tapping through it`);
        await this.shell("cmd statusbar collapse");
        collapsed = true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async longPress(selector: Selector, durationMs = 800) {
    const n = (await this.waitFor(selector, { pick: true }))!;
    const [x, y] = center(n);
    await this.swipeXY(x, y, x, y, durationMs);
  }

  async swipeXY(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    const v = [x1, y1, x2, y2, durationMs].map((n) => Math.round(n));
    if (v.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid swipe coordinates");
    await this.waitUntilUncovered(v[0]!, v[1]!);
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

/** True when the screen has a WebView with nothing reported inside it. */
export function hasEmptyWebView(nodes: UiNode[]): boolean {
  return nodes.some(
    (w) =>
      w.cls === "android.webkit.WebView" &&
      w.bounds[2] > w.bounds[0] &&
      !nodes.some((n) => n !== w && n.cls !== "android.webkit.WebView" && n.bounds[0] >= w.bounds[0] && n.bounds[1] >= w.bounds[1] && n.bounds[2] <= w.bounds[2] && n.bounds[3] <= w.bounds[3] && (n.text || n.desc)),
  );
}

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    // Android writes an attribute in single quotes when its value contains a double quote.
    for (const a of m[1]!.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = unescape(a[2] ?? a[3]!);
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
