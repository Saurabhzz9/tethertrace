import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { AdbKey, Device, explore, coverage, DEFAULT_DENY, WINDOW_MODE_DENY } from "../dist/index.js";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

const PKG = "com.example.shop";
const key = AdbKey.generate("test@host");

const node = (text, y, { pkg = PKG, clickable = true, id = "", checkable = false } = {}) =>
  `<node text="${text}" content-desc="" resource-id="${id}" class="android.widget.${checkable ? "Switch" : "Button"}" package="${pkg}" checkable="${checkable}" clickable="${clickable}" bounds="[40,${y}][1040,${y + 150}]" />`;
const screen = (title, buttons, pkg = PKG) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" clickable="false" bounds="[0,0][1080,2400]">${node(title, 100, { pkg, clickable: false })}${buttons.map((b, i) => node(b.replace(/^toggle:/, ""), 400 + i * 200, { pkg, checkable: b.startsWith("toggle:") })).join("")}</node></hierarchy>`;

/** A tiny fake app: Home → Catalog / Profile; Profile has a dangerous button; Catalog has one that crashes. */
function fakeApp({ crashOn } = {}) {
  const screens = {
    home: screen("Home", ["Catalog", "Profile", "Delete account"]),
    catalog: screen("Catalog", ["Item 1", ...(crashOn ? [crashOn] : [])]),
    item: screen("Item details", []),
    profile: screen("Profile", ["Log out", "Pay now", "toggle:Daily notifications"]),
  };
  const nav = { home: { Catalog: "catalog", Profile: "profile" }, catalog: { "Item 1": "item" } };
  const state = { stack: ["home"], alive: true, taps: [], crashed: false };
  const top = () => state.stack[state.stack.length - 1];
  const labelAt = (y) => {
    const xml = screens[top()];
    for (const m of xml.matchAll(/text="([^"]*)"[^>]*clickable="true" bounds="\[40,(\d+)\]\[1040,(\d+)\]"/g)) if (y >= Number(m[2]) && y <= Number(m[3])) return m[1];
  };
  const handler = (cmd, kind) => {
    if (kind === "exec") {
      if (cmd.startsWith("screencap")) return TINY_PNG;
      if (cmd.includes("-b crash")) return state.crashed ? `11-07 20:00:05.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main\n11-07 20:00:05.000  4321  4321 E AndroidRuntime: Process: ${PKG}, PID: 4321\n` : "";
      if (cmd.startsWith("logcat")) return "11-07 20:00:01.000  4321  4321 I shop: ready\n";
      return "";
    }
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) { state.alive = false; return ""; }
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.Main\n`;
    if (cmd.startsWith("am start -W")) { state.alive = true; state.stack = ["home"]; return "Status: ok\nTotalTime: 420\n"; }
    if (cmd.startsWith("pidof")) return state.alive ? "4321\n" : "";
    if (cmd.startsWith("uiautomator dump")) return state.alive ? screens[top()] : screen("Launcher", ["Clock"], "com.android.launcher");
    if (cmd.startsWith("input tap ")) {
      const y = Number(cmd.split(" ")[3]);
      const l = labelAt(y);
      state.taps.push(l);
      if (l && l === crashOn) { state.alive = false; state.crashed = true; }
      else if (l && nav[top()]?.[l]) state.stack.push(nav[top()][l]);
      return "";
    }
    if (cmd === "input keyevent KEYCODE_BACK") {
      if (state.stack.length > 1) state.stack.pop();
      else state.alive = false;
      return "";
    }
    return undefined;
  };
  return { state, handler };
}

test("the deny list catches destructive and outward-facing labels in English and Hindi", () => {
  for (const l of ["Delete account", "Log out", "Pay now", "Send", "Share", "Buy premium", "Subscribe", "खाता हटाएँ", "भेजें", "लॉग आउट"]) assert.ok(DEFAULT_DENY.test(l), l);
  for (const l of ["Catalog", "Profile", "Settings", "Home", "Displayed items", "Sender info"]) assert.ok(!DEFAULT_DENY.test(l), l);
});

test("explore walks every safe screen, never taps risky buttons, and writes a reusable flow", async () => {
  const { state, handler } = fakeApp();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 30 });
    d.close();
    assert.equal(s.verdict, "no_crash_observed", s.reason);
    assert.deepEqual(s.screens.map((x) => x.title).sort(), ["Catalog", "Home", "Item details", "Profile"]);
    assert.ok(!state.taps.includes("Daily notifications"), "toggled a setting");
    assert.ok(s.skippedAsRisky.includes("Daily notifications (toggle)"));
    for (const risky of ["Delete account", "Log out", "Pay now"]) {
      assert.ok(!state.taps.includes(risky), `tapped ${risky}`);
      assert.ok(s.skippedAsRisky.includes(risky), risky);
    }
    assert.equal(s.launchTimeMs, 420);
    assert.equal(s.coverage.level, "ok", s.coverage.warnings.join(" "));
    assert.equal(s.coverage.stoppedBy, "explored");
    assert.ok(s.coverage.tapped >= 3);
    const flow = YAML.parse(await readFile(join(out, "explored-flow.yaml"), "utf8"));
    assert.equal(flow.app, PKG);
    assert.deepEqual(flow.steps.slice(0, 5), ["launch", { tap: "Catalog" }, { tap: "Item 1" }, "back", "back"]);
    assert.ok(flow.steps.some((st) => st.tap === "Profile"), "flow continues to Profile after going back");
    const files = await readdir(out);
    for (const f of ["report.html", "summary.json", "actions.jsonl", "screen-1.png", "screen-1.txt", "logcat.txt"]) assert.ok(files.includes(f), f);
    assert.ok(!files.includes("repro.yaml"));
  } finally {
    await dev.close();
  }
});

test("explore catches a crash, names the tap that caused it, and writes repro.yaml", async () => {
  const { handler } = fakeApp({ crashOn: "Open reviews" });
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 30 });
    d.close();
    assert.equal(s.verdict, "app_crash", s.reason);
    assert.deepEqual(s.crashAfter, { screen: 2, label: "Open reviews" });
    assert.ok(s.evidence.some((l) => l.includes("FATAL EXCEPTION")));
    const repro = YAML.parse(await readFile(join(out, "repro.yaml"), "utf8"));
    assert.deepEqual(repro.steps, ["launch", { tap: "Catalog" }, { tap: "Open reviews" }]);
  } finally {
    await dev.close();
  }
});

test("the flow written by explore replays cleanly with `run`", async () => {
  const { runFlow } = await import("../dist/index.js");
  const { handler } = fakeApp();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    await explore(d, { pkg: PKG, outDir: join(out, "explore"), settleMs: 0, maxActions: 30 });
    const flow = YAML.parse(await readFile(join(out, "explore", "explored-flow.yaml"), "utf8"));
    const r = await runFlow(d, flow, { outDir: join(out, "replay") });
    d.close();
    assert.equal(r.status, "passed", JSON.stringify(r.failure));
    assert.equal(r.steps.length, flow.steps.length);
  } finally {
    await dev.close();
  }
});

test("explore says so when it could tap nothing (canvas UI), next to the verdict", async () => {
  const canvas = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" clickable="false" bounds="[0,0][1080,2400]"><node text="" content-desc="" resource-id="" class="android.view.SurfaceView" package="${PKG}" clickable="true" bounds="[0,0][1080,2400]" /></node></hierarchy>`;
  const taps = [];
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.Main\n`;
    if (cmd.startsWith("am start -W")) return "Status: ok\nTotalTime: 300\n";
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("uiautomator dump")) return canvas;
    if (cmd.startsWith("input tap ")) { taps.push(cmd); return ""; }
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 10 });
    d.close();
    assert.equal(taps.length, 0);
    assert.equal(s.verdict, "no_crash_observed");
    assert.equal(s.coverage.level, "none");
    assert.equal(s.coverage.unlabeledSkipped, 1);
    assert.deepEqual(s.coverage.screensWithoutElements, [1]);
    assert.match(s.reason, /Coverage none: nothing in the app could be tapped/);
    assert.match(await readFile(join(out, "report.html"), "utf8"), /coverage: none/);
    assert.equal(JSON.parse(await readFile(join(out, "summary.json"), "utf8")).coverage.level, "none");
  } finally {
    await dev.close();
  }
});

test("explore skips window-mode controls and full-screen backdrops (both seen on a real phone)", async () => {
  const head = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" clickable="false" bounds="[0,0][1080,2400]">`;
  const home = `${head}${node("Calculator", 100, { clickable: false })}${node("Display calculator in floating window", 400)}${node("Pick date", 600)}</node></hierarchy>`;
  // A date dialog: the "Dismiss" scrim covers the whole screen; its centre is a day in the calendar.
  const dialog = (day) => `${head}<node text="" content-desc="Dismiss" resource-id="" class="android.view.View" package="${PKG}" clickable="true" bounds="[0,0][1080,2400]" />${node(`Selected: ${day}`, 300, { clickable: false })}${node("Cancel", 1800)}</node></hierarchy>`;
  const state = { screen: "home", day: 1, taps: [] };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.Main\n`;
    if (cmd.startsWith("am start -W")) { state.screen = "home"; return "Status: ok\nTotalTime: 300\n"; }
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("uiautomator dump")) return state.screen === "home" ? home : dialog(state.day);
    if (cmd.startsWith("input tap ")) {
      const [x, y] = cmd.split(" ").slice(2).map(Number);
      state.taps.push(`${state.screen}@${x},${y}`);
      if (state.screen === "home" && y >= 600 && y <= 750) state.screen = "dialog";
      else if (state.screen === "dialog" && y >= 1800 && y <= 1950) state.screen = "home";
      else if (state.screen === "dialog" && y === 1200) state.day++; // the scrim's centre hits a calendar day
      return "";
    }
    if (cmd === "input keyevent KEYCODE_BACK") { state.screen = "home"; return ""; }
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 20 });
    d.close();
    assert.ok(!state.taps.some((t) => t.startsWith("home@") && t.endsWith(",475")), "tapped the floating-window button");
    assert.ok(s.skippedAsRisky.includes("Display calculator in floating window (window mode)"));
    assert.equal(state.day, 1, "tapped the full-screen Dismiss backdrop");
    assert.ok(state.taps.includes("dialog@540,1875"), "closed the dialog with Cancel");
    assert.equal(s.coverage.stoppedBy, "explored");
  } finally {
    await dev.close();
  }
});

test("explore leaves the phone in the app when its last tap opened something else", async () => {
  const home = screen("Palm reading", ["Gallery"]);
  const picker = screen("Photos", ["Recent", "Albums"], "com.google.android.photopicker");
  const state = { alive: true, stack: ["home"], taps: [], backs: 0 };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) { state.alive = false; return ""; }
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.Main\n`;
    if (cmd.startsWith("am start -W")) {
      // Like Android: after a force-stop the picker survives in the app's task. A plain start shows it
      // again without starting the app; only a clean task starts the app.
      if (cmd.includes("--activity-clear-task")) { state.alive = true; state.stack = ["home"]; }
      else if (state.stack.at(-1) !== "picker") state.alive = true;
      return "Status: ok\nTotalTime: 300\n";
    }
    if (cmd.startsWith("pidof")) return state.alive ? "4321\n" : "";
    if (cmd === "cmd statusbar collapse") return "";
    if (cmd === "input keyevent KEYCODE_BACK") { state.backs++; return ""; }
    if (cmd.startsWith("uiautomator dump")) return state.stack.at(-1) === "picker" ? picker : home;
    if (cmd.startsWith("input tap ")) {
      state.taps.push(cmd);
      if (state.stack.at(-1) === "home") state.stack.push("picker"); // the picker opens inside the app's task
      return "";
    }
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 1 });
    d.close();
    assert.equal(state.taps.length, 1);
    assert.equal(state.stack.at(-1), "home", "left the photo picker open");
    assert.equal(state.backs, 0, "pressed back outside the app");
    assert.equal(s.verdict, "no_crash_observed", s.reason);
  } finally {
    await dev.close();
  }
});

test("the window-mode list catches floating windows and picture-in-picture but not ordinary labels", () => {
  for (const l of ["Display calculator in floating window", "Picture-in-picture", "Minimize", "Split screen", "Pop-up view"]) assert.ok(WINDOW_MODE_DENY.test(l), l);
  for (const l of ["Float", "Windows", "Settings", "Mini games", "Screenshot"]) assert.ok(!WINDOW_MODE_DENY.test(l), l);
});

test("coverage is limited, not ok, when controls were unlabeled or the budget ran out", () => {
  const c = coverage(6, 2, [4], "limit");
  assert.equal(c.level, "limited");
  assert.equal(c.warnings.length, 3);
  assert.match(c.warnings.join(" "), /2 clickable controls had no text/);
  assert.match(c.warnings.join(" "), /screen 4 exposed no readable elements/);
  assert.match(c.warnings.join(" "), /--actions or --minutes/);
  assert.equal(coverage(6, 0, [], "explored").level, "ok");
  assert.equal(coverage(0, 0, [], "explored").level, "none");
});

/** An app plus the system around it: notification shade, launcher, permission dialog. */
function appWithSystem({ shadeStaysOpen = false } = {}) {
  const shade = screen("Notifications", ["Wi-Fi", "Naukri: companies are hiring", "Clear all"], "com.android.systemui");
  const permission = screen("Allow Shop to take pictures?", ["While using the app", "Only this time", "Don't allow"], "com.google.android.permissioncontroller");
  const screens = {
    home: screen("Home", ["Change language", "Take photo", "Open shade"]),
  };
  const state = { overlay: null, transient: 0, taps: [], backs: 0, collapses: 0, alive: true };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) { state.alive = false; return ""; }
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.Main\n`;
    if (cmd.startsWith("am start -W")) { state.alive = true; return "Status: ok\nTotalTime: 300\n"; }
    if (cmd.startsWith("pidof")) return state.alive ? "4321\n" : "";
    if (cmd === "cmd statusbar collapse") { state.collapses++; if (state.overlay === "shade") state.overlay = null; return ""; }
    if (cmd === "input keyevent KEYCODE_BACK") { state.backs++; return ""; }
    if (cmd.startsWith("uiautomator dump")) {
      if (state.transient > 0) { state.transient--; return shade; }
      if (state.overlay === "shade") return shade;
      if (state.overlay === "permission") return permission;
      return screens.home;
    }
    if (cmd.startsWith("input tap ")) {
      const y = Number(cmd.split(" ")[3]);
      const xml = state.transient > 0 || state.overlay === "shade" ? shade : state.overlay === "permission" ? permission : screens.home;
      let l;
      for (const m of xml.matchAll(/text="([^"]*)"[^>]*clickable="true" bounds="\[40,(\d+)\]\[1040,(\d+)\]"/g)) if (y >= Number(m[2]) && y <= Number(m[3])) l = m[1];
      state.taps.push(l);
      if (l === "Change language") state.transient = 2; // app recreates itself; system UI flashes
      else if (l === "Take photo") state.overlay = "permission";
      else if (l === "Don't allow") state.overlay = null;
      else if (l === "Open shade") state.overlay = shadeStaysOpen ? "shade" : null;
      return "";
    }
    return undefined;
  };
  return { state, handler };
}

test("explore never taps or presses back on system UI; it waits out transients and declines permissions", async () => {
  const { state, handler } = appWithSystem({ shadeStaysOpen: true });
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-explore-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await explore(d, { pkg: PKG, outDir: out, settleMs: 0, maxActions: 12 });
    d.close();
    for (const forbidden of ["Wi-Fi", "Naukri: companies are hiring", "Clear all", "While using the app", "Only this time"])
      assert.ok(!state.taps.includes(forbidden), `tapped "${forbidden}" outside the app`);
    assert.equal(state.backs, 0, "pressed back while outside the app");
    assert.ok(state.taps.includes("Don't allow"), "declined the permission prompt");
    assert.ok(state.collapses >= 1, "closed the notification shade");
    assert.equal(s.verdict, "no_crash_observed", s.reason);
    const actions = (await readFile(join(out, "actions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(actions.some((a) => a.action === "resume" && /systemui/.test(a.label)), "resumed the app after the shade");
  } finally {
    await dev.close();
  }
});
