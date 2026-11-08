import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdbKey, Device, smoke, classify, filterAppLog, parseUiNodes } from "../dist/index.js";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

const PKG = "com.example.notes";
const key = AdbKey.generate("test@host");

const UI = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" bounds="[0,0][1080,2400]"><node index="1" text="नमस्ते &amp; स्वागत" resource-id="" class="android.view.View" content-desc="" clickable="false" bounds="[40,200][1040,320]" /><node index="2" text="" resource-id="" class="android.widget.Button" content-desc="खोजें" clickable="true" bounds="[40,900][520,1100]" /></node></hierarchy>`;

function phone({ crash = false, alive = true } = {}) {
  return (cmd, kind) => {
    if (kind === "exec") {
      if (cmd.startsWith("screencap")) return TINY_PNG;
      if (cmd.includes("-b crash")) return crash ? `11-07 20:00:01.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main\n11-07 20:00:01.000  4321  4321 E AndroidRuntime: Process: ${PKG}, PID: 4321\n` : "";
      if (cmd.startsWith("logcat")) return `11-07 20:00:00.500  4321  4321 I flutter: home ready\n11-07 20:00:00.600  999  999 I OtherApp: secret user@example.com\n`;
      return "";
    }
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("pm path")) return `package:/data/app/${PKG}/base.apk\n`;
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `priority=0 preferredOrder=0\n${PKG}/.MainActivity\n`;
    if (cmd.startsWith("am start -W")) return "Starting: Intent\nStatus: ok\nLaunchState: COLD\nActivity: x\nTotalTime: 1234\nWaitTime: 1250\nComplete\n";
    if (cmd.startsWith("pidof")) return alive ? "4321\n" : "";
    if (cmd.startsWith("dumpsys meminfo")) return "Applications Memory Usage\n        TOTAL PSS:   187654            TOTAL RSS:   250000\n";
    if (cmd.startsWith("uiautomator dump")) return UI;
    return undefined;
  };
}

test("parseUiNodes reads text, descriptions, clickability and bounds", () => {
  const nodes = parseUiNodes(UI);
  assert.equal(nodes[1].text, "नमस्ते & स्वागत");
  assert.equal(nodes[2].desc, "खोजें");
  assert.equal(nodes[2].clickable, true);
  assert.deepEqual(nodes[2].bounds, [40, 900, 520, 1100]);
});

test("classify is honest: crash, ANR, silent exit, and no-crash-observed", () => {
  assert.equal(classify({ pkg: PKG, pid: 1, appLog: "", crashLog: `E AndroidRuntime: Process: ${PKG}, PID: 1` }).verdict, "app_crash");
  assert.equal(classify({ pkg: PKG, pid: 1, appLog: `E ActivityManager: ANR in ${PKG}`, crashLog: "" }).verdict, "anr");
  assert.equal(classify({ pkg: PKG, pid: undefined, appLog: "", crashLog: "" }).verdict, "app_exited");
  const ok = classify({ pkg: PKG, pid: 1, appLog: "I flutter: ok", crashLog: "" });
  assert.equal(ok.verdict, "no_crash_observed");
  assert.match(ok.reason, /does not prove/);
});

test("filterAppLog keeps the app's own lines and drops other apps", () => {
  const out = filterAppLog("11-07 20:00:00.500  4321  4321 I flutter: hi\n11-07 20:00:00.600  999  999 I OtherApp: secret", PKG, [4321]);
  assert.match(out, /flutter: hi/);
  assert.doesNotMatch(out, /OtherApp/);
});

test("smoke on a healthy app: launch time, memory, screenshot, UI, filtered logs", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone() });
  const out = await mkdtemp(join(tmpdir(), "tt-smoke-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await smoke(d, { pkg: PKG, waitMs: 50, outDir: out, screenshot: true });
    d.close();
    assert.equal(s.verdict, "no_crash_observed");
    assert.equal(s.launch.totalTimeMs, 1234);
    assert.equal(s.memoryPssKb, 187654);
    assert.equal(s.device.model, "MockPhone");
    const files = await readdir(out);
    for (const f of ["summary.json", "report.html", "steps.jsonl", "screenshot.png", "ui.txt", "logcat.txt", "meminfo.txt"]) assert.ok(files.includes(f), f);
    const log = await readFile(join(out, "logcat.txt"), "utf8");
    assert.match(log, /home ready/);
    assert.doesNotMatch(log, /user@example\.com/);
    assert.match(await readFile(join(out, "ui.txt"), "utf8"), /\[tap\] खोजें/);
  } finally {
    await dev.close();
  }
});

test("smoke on a crashing app reports app_crash with the crash lines", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone({ crash: true, alive: false }) });
  const out = await mkdtemp(join(tmpdir(), "tt-smoke-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await smoke(d, { pkg: PKG, waitMs: 10, outDir: out, screenshot: false });
    d.close();
    assert.equal(s.verdict, "app_crash");
    assert.ok(s.evidence.some((l) => l.includes("FATAL EXCEPTION")));
    assert.ok(!(await readdir(out)).includes("screenshot.png"));
  } finally {
    await dev.close();
  }
});

test("install streams a large APK in chunks and checks for Success", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone() });
  const dir = await mkdtemp(join(tmpdir(), "tt-apk-"));
  const apk = join(dir, "app.apk");
  await writeFile(apk, Buffer.alloc(3 * 1024 * 1024 + 7, 1));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    assert.match(await d.install(apk), /Success/);
    d.close();
    assert.ok(dev.log.some((l) => l.open && /^exec:cmd package install -r -S 3145735$/.test(l.open)));
  } finally {
    await dev.close();
  }
});
