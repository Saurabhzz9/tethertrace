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

test("install on a link that goes dead fails with how far it got, instead of hanging", async () => {
  // The phone takes the first 600 KB, then never acknowledges again.
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone(), upload: { stallAfter: 600 * 1024 } });
  const dir = await mkdtemp(join(tmpdir(), "tt-apk-"));
  const apk = join(dir, "app.apk");
  await writeFile(apk, Buffer.alloc(2 * 1024 * 1024, 7));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const progress = [];
    const t0 = Date.now();
    await assert.rejects(
      d.install(apk, { stallTimeoutMs: 400, onProgress: (sent) => progress.push(sent) }),
      (e) => e.code === "TIMEOUT" && /Install stalled after 0\.5 of 2\.1 MB: the phone did not acknowledge data/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 5000, "fails soon after the stall, not after the full install timeout");
    assert.deepEqual(progress, [256 * 1024, 512 * 1024], "progress only counts acknowledged chunks");
    // Nothing was sent after the chunk that got no answer: one chunk in flight, never a queue.
    assert.equal(dev.log.filter((l) => l.uploadChunk).length, 3);
    d.close();
  } finally {
    await dev.close();
  }
});

test("install on a slow link still completes, one acknowledged chunk at a time", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone(), upload: { ackDelayMs: 40 } });
  const dir = await mkdtemp(join(tmpdir(), "tt-apk-"));
  const apk = join(dir, "app.apk");
  const size = 1024 * 1024 + 123;
  await writeFile(apk, Buffer.alloc(size, 3));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const progress = [];
    assert.match(await d.install(apk, { stallTimeoutMs: 2000, onProgress: (sent, total) => progress.push([sent, total]) }), /Success/);
    d.close();
    const chunks = dev.log.filter((l) => l.uploadChunk).map((l) => l.uploadChunk);
    assert.deepEqual(chunks, [262144, 262144, 262144, 262144, 123], "sent in chunks of the size the phone asked for");
    assert.deepEqual(progress.at(-1), [size, size]);
  } finally {
    await dev.close();
  }
});

test("parseUiNodes reads a label that contains double quotes (Android then uses single quotes)", () => {
  // Seen on a real phone: text='… "app.js" does not match …' made the element invisible.
  const xml = `<hierarchy><node index="0" text='Saved "notes.txt" to &quot;Docs&quot;&#10;Done' resource-id="com.x:id/msg" class="android.widget.TextView" package="com.x" content-desc="" clickable="false" bounds="[0,264][1080,400]" /><node text="it's fine" resource-id="" class="android.widget.Button" package="com.x" content-desc='say "hi"' clickable="true" bounds="[0,400][1080,500]" /></hierarchy>`;
  const nodes = parseUiNodes(xml);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, 'Saved "notes.txt" to "Docs"\nDone');
  assert.equal(nodes[0].id, "com.x:id/msg");
  assert.deepEqual(nodes[0].bounds, [0, 264, 1080, 400]);
  assert.equal(nodes[1].text, "it's fine");
  assert.equal(nodes[1].desc, 'say "hi"');
  assert.equal(nodes[1].clickable, true);
});

test("a WebView that reports nothing inside it yet is recognised, so the screen is read again", async () => {
  const { hasEmptyWebView } = await import("../dist/index.js");
  const web = '<node text="" resource-id="" class="android.webkit.WebView" package="com.x" content-desc="" clickable="true" bounds="[0,264][1080,2280]" />';
  const title = '<node text="My app" resource-id="" class="android.widget.TextView" package="com.x" content-desc="" clickable="false" bounds="[48,139][336,220]" />';
  const inside = '<node text="Add one" resource-id="add" class="android.widget.Button" package="com.x" content-desc="" clickable="true" bounds="[72,864][399,1023]" />';
  assert.equal(hasEmptyWebView(parseUiNodes(`<hierarchy>${title}${web}</hierarchy>`)), true, "only a title outside the WebView");
  assert.equal(hasEmptyWebView(parseUiNodes(`<hierarchy>${title}${web}${inside}</hierarchy>`)), false);
  assert.equal(hasEmptyWebView(parseUiNodes(`<hierarchy>${title}</hierarchy>`)), false, "no WebView at all");
});

test("a tap waits while a notification covers that spot, and taps once it has gone", async () => {
  // Seen on a real phone: right after connecting, Android shows "Wireless debugging connected" over
  // the top of the screen, and a tap on the app's menu button opened Developer options instead.
  const shade = (region) => `  2: name='46e6500 NotificationShade', id=234324, displayId=0, inputConfig=NOT_FOCUSABLE | TRUSTED_OVERLAY, alpha=1.00, frame=[0,0][1080,2412], touchableRegion=${region}, ownerPid=8730\n`;
  let reads = 0;
  const taps = [];
  const handler = (cmd) => {
    if (cmd.startsWith("dumpsys input")) return ++reads <= 2 ? shade("[48,0][1032,373]") : "";
    if (cmd.startsWith("input tap ")) return taps.push([cmd, reads]), "";
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    assert.deepEqual(await d.systemOverlays(), [[48, 0, 1032, 373]]);
    reads = 0;
    await d.tapXY(96, 192); // the menu button, under the notification
    assert.deepEqual(taps, [["input tap 96 192", 3]], "tapped only after the notification had gone");
    reads = 10;
    await d.tapXY(540, 1200); // nothing covers this spot
    assert.equal(taps.length, 2);
    d.close();
  } finally {
    await dev.close();
  }
});

test("a tap is refused when the shade stays open over that spot", async () => {
  const collapse = [];
  const handler = (cmd) => {
    if (cmd.startsWith("dumpsys input")) return "  2: name='46e6500 NotificationShade', inputConfig=TRUSTED_OVERLAY, touchableRegion=[0,0][1080,2412], ownerPid=1\n";
    if (cmd === "cmd statusbar collapse") return collapse.push(cmd), "";
    if (cmd.startsWith("input tap ")) throw new Error("must not tap");
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    await assert.rejects(d.waitUntilUncovered(500, 500, 300), /covering 500,500; not tapping through it/);
    assert.equal(collapse.length, 1, "tried closing the shade once");
    d.close();
  } finally {
    await dev.close();
  }
});
