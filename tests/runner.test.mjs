import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdbKey, Device, findNodes, pickOne, parseUiNodes, runFlow, loadFlow } from "../dist/index.js";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

const PKG = "com.example.notes";
const key = AdbKey.generate("test@host");

// Shape of a real Flutter onboarding screen (Flutter merges labels with \n).
const WELCOME = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
<node text="" content-desc="नोट्स" resource-id="" class="android.view.View" clickable="false" bounds="[72,96][1008,139]" />
<node text="" content-desc="हिन्दी&#10;नमस्ते" resource-id="" class="android.view.View" clickable="true" bounds="[72,1674][522,1884]" />
<node text="" content-desc="English&#10;Namaste" resource-id="" class="android.view.View" clickable="true" bounds="[558,1674][1008,1884]" />
<node text="" content-desc="शुरू करें" resource-id="" class="android.widget.Button" clickable="true" bounds="[72,1956][1008,2112]">
  <node text="" content-desc="शुरू करें" resource-id="" class="android.view.View" clickable="false" bounds="[400,2000][680,2060]" />
</node>
<node text="" content-desc="Hidden" resource-id="" class="android.view.View" clickable="false" bounds="[0,0][0,0]" />
</node></hierarchy>`;
const HOME = WELCOME.replace(/शुरू करें/g, "आज का पंचांग").replace(/हिन्दी&#10;नमस्ते/, "खोजें");

function app() {
  const state = { screen: "welcome", taps: [], typed: [] };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.MainActivity\n`;
    if (cmd.startsWith("am start -W")) {
      state.screen = "welcome";
      return "Status: ok\nTotalTime: 1100\n";
    }
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("wm size")) return "Physical size: 1080x2400\n";
    if (cmd.startsWith("uiautomator dump")) return state.screen === "welcome" ? WELCOME : HOME;
    if (cmd.startsWith("input tap ")) {
      const [x, y] = cmd.slice(10).split(" ").map(Number);
      state.taps.push([x, y]);
      if (state.screen === "welcome" && y > 1956 && y < 2112) state.screen = "home";
      return "";
    }
    if (cmd.startsWith("input text ")) {
      state.typed.push(cmd);
      return "";
    }
    if (cmd.startsWith("input ")) return "";
    return undefined;
  };
  return { state, handler };
}

test("selectors match multi-line Flutter labels and ignore zero-size nodes", () => {
  const nodes = parseUiNodes(WELCOME);
  assert.equal(findNodes(nodes, "हिन्दी").length, 1);
  assert.equal(findNodes(nodes, "Namaste").length, 1);
  assert.equal(findNodes(nodes, "Hidden").length, 0);
  assert.equal(findNodes(nodes, { contains: "english" }).length, 1);
});

test("pickOne prefers the clickable button over its own inner label, refuses real ambiguity", () => {
  const nodes = parseUiNodes(WELCOME);
  const m = findNodes(nodes, "शुरू करें");
  assert.equal(m.length, 2);
  assert.equal(pickOne(m, "शुरू करें").clickable, true);
  const twoButtons = parseUiNodes(WELCOME.replace("English&#10;Namaste", "हिन्दी&#10;Again"));
  assert.throws(() => pickOne(findNodes(twoButtons, "हिन्दी"), "हिन्दी"), (e) => e.code === "AMBIGUOUS");
  assert.equal(pickOne(findNodes(twoButtons, "हिन्दी"), { text: "हिन्दी", index: 1 }).bounds[0], 558);
});

test("flow passes: launch, tap Hindi button text, wait for next screen, redact typed text", async () => {
  const { state, handler } = app();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-run-"));
  const flowFile = join(out, "onboarding.yaml");
  await writeFile(flowFile, `app: ${PKG}\nsteps:\n  - launch\n  - tap: "शुरू करें"\n  - waitFor: "आज का पंचांग"\n  - type: "\${TT_SECRET}"\n  - screenshot: home\n`);
  process.env.TT_SECRET = "hunter2 pass";
  try {
    const flow = await loadFlow(flowFile);
    assert.equal(flow.name, "onboarding");
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await runFlow(d, flow, { outDir: join(out, "r") });
    d.close();
    assert.equal(s.status, "passed", JSON.stringify(s.failure));
    assert.equal(s.launchTimeMs, 1100);
    assert.deepEqual(state.taps[0], [540, 2034]);
    assert.equal(state.typed[0], "input text 'hunter2%spass'");
    const report = await readFile(join(out, "r", "summary.json"), "utf8");
    assert.doesNotMatch(report, /hunter2/);
    assert.match(report, /type: <redacted>/);
    assert.ok((await readdir(join(out, "r"))).includes("home.png"));
  } finally {
    delete process.env.TT_SECRET;
    await dev.close();
  }
});

test("flow fails honestly: element_not_found lists what was on screen instead", async () => {
  const { handler } = app();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-run-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const s = await runFlow(d, { app: PKG, name: "x", steps: ["launch", { tap: "Login", timeoutMs: 600 }, { tap: "never reached" }] }, { outDir: out });
    d.close();
    assert.equal(s.status, "failed");
    assert.equal(s.failure.step, 2);
    assert.equal(s.failure.category, "element_not_found");
    assert.ok(s.failure.visibleOnScreen.includes("[tap] शुरू करें"));
    assert.equal(s.steps.length, 2);
    const files = await readdir(out);
    for (const f of ["failure.png", "ui.txt", "report.html", "summary.json"]) assert.ok(files.includes(f), f);
  } finally {
    await dev.close();
  }
});

test("typing refuses non-ASCII instead of sending garbage", async () => {
  const { handler } = app();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    await assert.rejects(d.type("नमस्ते"), (e) => e.code === "UNSUPPORTED_TEXT");
    d.close();
  } finally {
    await dev.close();
  }
});

test("assertions accept a label that appears twice; taps on it still refuse to guess", async () => {
  // Found on a real calculator: the typed formula and the result can share text.
  const twice = WELCOME.replace("English&#10;Namaste", "हिन्दी&#10;Again");
  const handler = (cmd, kind) => {
    if (kind === "exec") return "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("uiautomator dump")) return twice;
    return "";
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const out = await mkdtemp(join(tmpdir(), "tt-run-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const ok = await runFlow(d, { app: PKG, name: "dup", steps: [{ assertVisible: "हिन्दी" }, { waitFor: "हिन्दी" }] }, { outDir: join(out, "a") });
    assert.equal(ok.status, "passed", JSON.stringify(ok.failure));
    const bad = await runFlow(d, { app: PKG, name: "dup2", steps: [{ tap: "हिन्दी", timeoutMs: 500 }] }, { outDir: join(out, "b") });
    d.close();
    assert.equal(bad.failure.category, "ambiguous_selector");
  } finally {
    await dev.close();
  }
});
