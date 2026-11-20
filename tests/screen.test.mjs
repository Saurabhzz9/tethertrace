import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdbKey, Device, parseScreenState, runFlow, loadFlow, explainLocally, loadReport } from "../dist/index.js";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

const PKG = "com.example.notes";
const key = AdbKey.generate("test@host");
const SCREEN = (label) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" content-desc="" class="android.widget.FrameLayout" package="${PKG}" bounds="[0,0][1080,2400]"><node text="${label}" content-desc="" class="android.widget.Button" package="${PKG}" clickable="true" bounds="[100,100][500,200]" /></node></hierarchy>`;
const LOCK = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][1080,2400]"><node text="Swipe up to unlock" class="android.widget.TextView" package="com.android.systemui" bounds="[100,2000][900,2100]" /></node></hierarchy>`;

/** A phone whose screen can be off, on a lock screen with or without a PIN, or showing a video. */
function phone(o = {}) {
  const st = { awake: o.awake ?? true, locked: o.locked ?? false, secure: o.secure ?? false, video: o.video ?? false, wakes: 0, dismisses: 0, taps: [] };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("dumpsys power")) return `  mWakefulness=${st.awake ? "Awake" : "Asleep"}\n  mScreenOn=${st.awake}\n  mScreenLocked=${st.locked}\n`;
    if (cmd === "input keyevent KEYCODE_WAKEUP") return (st.wakes++, (st.awake = true), "");
    if (cmd === "wm dismiss-keyguard") return (st.dismisses++, st.secure || (st.locked = false), "");
    if (cmd.startsWith("uiautomator dump")) {
      if (st.video) return "ERROR: could not get idle state.\n";
      return st.locked || !st.awake ? LOCK : SCREEN("Save");
    }
    if (cmd.startsWith("echo ok")) return "ok\n";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("input tap ")) return (st.taps.push(cmd), "");
    if (cmd.startsWith("dumpsys input") || cmd.startsWith("dumpsys window")) return "";
    if (cmd.startsWith("logcat")) return "";
    return "";
  };
  return { st, handler };
}

async function withPhone(o, fn) {
  const p = phone(o);
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: p.handler });
  const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
  try {
    return await fn(d, p.st);
  } finally {
    d.close();
    await dev.close();
  }
}

test("screen state is read from power, deviceidle and window flags; unknown stays unknown", () => {
  assert.deepEqual(parseScreenState("  mWakefulness=Awake\n  mScreenLocked=false\n"), { awake: true, locked: false });
  assert.deepEqual(parseScreenState("  mWakefulness=Asleep\n  mScreenLocked=true\n"), { awake: false, locked: true });
  assert.deepEqual(parseScreenState("mScreenOn=true\nisKeyguardShowing=true"), { awake: true, locked: true });
  assert.deepEqual(parseScreenState("mWakefulness=Dozing\nmDreamingLockscreen=false mShowingLockscreen=true"), { awake: false, locked: true });
  assert.deepEqual(parseScreenState(""), {});
});

test("a run wakes a dark screen and dismisses a lock screen without a PIN, then carries on", async () => {
  await withPhone({ awake: false, locked: true }, async (d, st) => {
    const out = await mkdtemp(join(tmpdir(), "tt-screen-"));
    const f = join(out, "f.yaml");
    await writeFile(f, `app: ${PKG}\nsteps:\n  - tap: Save\n`);
    const s = await runFlow(d, await loadFlow(f), { outDir: join(out, "r") });
    assert.equal(s.status, "passed", JSON.stringify(s.failure));
    assert.equal(st.wakes, 1);
    assert.equal(st.dismisses, 1);
    assert.equal(st.taps.length, 1);
    assert.equal(d.wakeOnDemand, false, "the run gives back the setting it found");
  });
});

test("a lock with a PIN fails fast as screen_locked; tethertrace never types anything into it", async () => {
  await withPhone({ locked: true, secure: true }, async (d, st) => {
    const out = await mkdtemp(join(tmpdir(), "tt-screen-"));
    const f = join(out, "f.yaml");
    await writeFile(f, `app: ${PKG}\nsteps:\n  - tap: { text: Save, timeoutMs: 20000 }\n`);
    const t0 = Date.now();
    const s = await runFlow(d, await loadFlow(f), { outDir: join(out, "r") });
    assert.equal(s.status, "failed");
    assert.equal(s.failure.category, "screen_locked");
    assert.match(s.failure.message, /never enters your lock code/);
    assert.ok(Date.now() - t0 < 10_000, "does not wait out the 20 s step timeout");
    assert.equal(st.taps.length, 0);
    assert.match(explainLocally(await loadReport(join(out, "r"))), /never enters a PIN/);
  });
});

test("the screen locking mid-run is noticed when the next element is not found", async () => {
  await withPhone({}, async (d, st) => {
    assert.ok(await d.waitFor("Save", { timeoutMs: 2000 }));
    st.locked = true;
    st.secure = true;
    await assert.rejects(d.waitFor("Save", { timeoutMs: 8000 }), (e) => e.code === "SCREEN_LOCKED");
  });
});

test("'element gone' is never concluded from a lock screen", async () => {
  await withPhone({ locked: true, secure: true }, async (d) => {
    await assert.rejects(d.waitFor("Save", { hidden: true, timeoutMs: 3000 }), (e) => e.code === "SCREEN_LOCKED");
  });
});

test("reading the screen does not wake or unlock it unless a run allows it", async () => {
  await withPhone({ awake: false, locked: true }, async (d, st) => {
    await assert.rejects(d.waitFor("Save", { timeoutMs: 3000 }), (e) => e.code === "SCREEN_LOCKED");
    assert.equal(st.wakes, 0);
    assert.equal(st.dismisses, 0);
  });
});

test("a screen uiautomator cannot read (video) is reported as ui_unavailable with the reason", async () => {
  await withPhone({ video: true }, async (d) => {
    await assert.rejects(d.uiNodes(), (e) => e.code === "UI_UNAVAILABLE" && /never stopped changing/.test(e.message) && /could not get idle state/.test(e.message));
    const out = await mkdtemp(join(tmpdir(), "tt-screen-"));
    const f = join(out, "f.yaml");
    await writeFile(f, `app: ${PKG}\nsteps:\n  - tap: { text: Save, timeoutMs: 1500 }\n`);
    const s = await runFlow(d, await loadFlow(f), { outDir: join(out, "r") });
    assert.equal(s.failure.category, "ui_unavailable");
  });
});
