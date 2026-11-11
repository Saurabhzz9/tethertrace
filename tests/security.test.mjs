import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdbKey, createMcpServer, Policy, PolicyError, TOOL_CLASSES, fileApprover, approve, listApprovals, parseClasses } from "../dist/index.js";
import { buildApk } from "./helpers/apk.mjs";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

// Negative tests: every one of these checks that something NOT allowed does NOT reach the phone.

const APP = "com.example.notes";
const OTHER = "org.other.bank";
const key = AdbKey.generate("test@host");

const node = (text, pkg, bounds, clickable = true) => `<node text="${text}" content-desc="" resource-id="" class="android.widget.Button" package="${pkg}" clickable="${clickable}" bounds="${bounds}" />`;
/** The app's screen with a system status bar on top, like a real phone. */
const screenOf = (pkg) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node("12:00", "com.android.systemui", "[0,0][1080,100]", false)}<node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" clickable="false" bounds="[0,100][1080,2400]">${node("Continue", pkg, "[100,2000][980,2150]")}${node("Open bank", pkg, "[100,1000][980,1150]")}</node></hierarchy>`;

async function phone(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tt-sec-"));
  const audit = join(dir, "audit.jsonl");
  // `front` is the app with input focus; `undefined` models the notification shade (no package named).
  const state = { front: APP };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("dumpsys window")) return state.front ? `  mCurrentFocus=Window{1a2b3c u0 ${state.front}/${state.front}.MainActivity}\n` : "  mCurrentFocus=Window{9f8e7d u0 NotificationShade}\n";
    if (cmd.startsWith("uiautomator dump")) return screenOf(state.front ?? "com.android.systemui");
    if (cmd.startsWith("wm size")) return "Physical size: 1080x2400\n";
    if (cmd.startsWith("input tap 540 1075")) { state.front = OTHER; return ""; } // "Open bank" hands over to another app
    if (cmd.startsWith("input ")) return "";
    if (cmd.startsWith("pm list packages")) return `package:${APP}\npackage:${OTHER}\n`;
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `${APP}/.Main\n`;
    if (cmd.startsWith("am start -W")) { state.front = APP; return "Status: ok\nTotalTime: 300\n"; }
    if (cmd.startsWith("pidof")) return "4321\n";
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const address = `127.0.0.1:${dev.port}`;
  const server = createMcpServer(key, { device: address, auditFile: audit, reportsDir: join(dir, "reports"), ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const sent = () => dev.log.map((l) => l.open).filter(Boolean);
  return {
    client, state, dir, address,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    /** Commands that changed the phone: input events, installs, starts, stops. */
    acted: () => sent().filter((s) => /raw:input |cmd package install|raw:am (start|force-stop)/.test(s)),
    sent,
    audit: async () => (await readFile(audit, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    close: async () => { await client.close(); await dev.close(); },
  };
}
const denied = (r, re) => { assert.equal(r.isError, true, JSON.stringify(r.content)); assert.match(r.content[0].text, re); };

test("every registered tool has a permission class, and nothing else is registered", async () => {
  const p = await phone({ allowShell: true });
  try {
    const names = (await p.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, Object.keys(TOOL_CLASSES).sort());
  } finally { await p.close(); }
});

test("read-only wins over allow-shell: no shell, install, pairing or interaction is offered or runs", async () => {
  const p = await phone({ readOnly: true, allowShell: true });
  try {
    const names = (await p.client.listTools()).tools.map((t) => t.name);
    for (const n of Object.keys(TOOL_CLASSES)) assert.equal(names.includes(n), TOOL_CLASSES[n].every((c) => c === "read"), n);
    for (const [n, args] of [["shell", { command: "id" }], ["tap", { x: 5, y: 5 }], ["install_apk", { path: "x.apk" }], ["pair_device", { code: "123456" }], ["press_key", { key: "home" }]])
      assert.equal((await p.call(n, args).catch(() => ({ isError: true }))).isError, true, n);
    assert.deepEqual(p.acted(), []);
    assert.ok(!p.sent().some((s) => /raw:id$/.test(s)), "shell command reached the phone");
  } finally { await p.close(); }
  // The policy says no by itself too, without relying on the tool being unlisted.
  const policy = new Policy({ readOnly: true, allowShell: true, auditFile: false });
  for (const tool of ["shell", "tap", "install_apk", "pair_device", "run_flow"]) await assert.rejects(policy.authorize({ tool }), PolicyError, tool);
  await policy.authorize({ tool: "screenshot" });
  await assert.rejects(new Policy({ auditFile: false }).authorize({ tool: "shell" }), /--allow-shell/);
  await assert.rejects(new Policy({ auditFile: false }).authorize({ tool: "made_up_tool" }), /no permission class/);
});

test("package scope: nothing is read or touched while another app is in front", async () => {
  const p = await phone({ packages: [APP] });
  try {
    p.state.front = OTHER;
    for (const [n, args] of [
      ["tap", { text: "Continue" }], ["tap", { x: 540, y: 2075 }], ["type_text", { text: "hunter2" }], ["press_key", { key: "back" }], ["scroll", { direction: "down" }],
      ["swipe", { x1: 500, y1: 1500, x2: 500, y2: 500 }], ["screenshot", {}], ["ui_tree", {}], ["wait_for", { text: "Continue" }],
    ])
      denied(await p.call(n, args), new RegExp(`blocked: ${OTHER.replaceAll(".", "\\.")} is in front`));
    assert.deepEqual(p.acted(), []);
    assert.ok(!p.sent().some((s) => /screencap|uiautomator/.test(s)), "the other app's screen was read");
    // App tools for other packages, and unscoped recordings, are refused as well.
    denied(await p.call("launch_app", { package: OTHER }), /outside this server's --package scope/);
    denied(await p.call("app_logs", { package: OTHER }), /outside this server's --package scope/);
    denied(await p.call("record_screen", { seconds: 1 }), /cannot be limited to one app/);
    assert.equal((await p.call("list_apps", {})).content[0].text, APP);
    assert.ok(!(await p.client.listTools()).tools.some((t) => t.name === "shell"));
  } finally { await p.close(); }
});

test("package scope fails closed when the app in front cannot be determined", async () => {
  const p = await phone({ packages: [APP] });
  try {
    p.state.front = undefined; // notification shade: Android names no package
    denied(await p.call("tap", { text: "12:00" }), /could not tell which app is in front/);
    denied(await p.call("screenshot", {}), /could not tell which app is in front/);
    assert.deepEqual(p.acted(), []);
  } finally { await p.close(); }
});

test("package scope cannot be bypassed with raw coordinates, system keys or elements of other apps", async () => {
  const p = await phone({ packages: [APP] });
  try {
    denied(await p.call("tap", { x: 540, y: 50 }), /540,50 belongs to com\.android\.systemui/); // status bar
    denied(await p.call("swipe", { x1: 540, y1: 50, x2: 540, y2: 1500 }), /belongs to com\.android\.systemui/); // pull the shade down
    denied(await p.call("swipe", { x1: 540, y1: 1500, x2: 540, y2: 50 }), /belongs to com\.android\.systemui/);
    denied(await p.call("tap", { text: "12:00" }), /element belongs to com\.android\.systemui/);
    for (const k of ["home", "recents", "menu"]) denied(await p.call("press_key", { key: k }), /leaves the app/);
    assert.deepEqual(p.acted(), []);
    // The same actions inside the app go through.
    assert.match((await p.call("tap", { x: 540, y: 2075 })).content[0].text, /Tapped 540,2075/);
    assert.match((await p.call("tap", { text: "Continue" })).content[0].text, /Tapped "Continue"/);
    assert.match((await p.call("press_key", { key: "back" })).content[0].text, /Pressed back/);
    assert.equal(p.acted().length, 3);
  } finally { await p.close(); }
});

test("package scope holds inside a YAML flow: it stops when the flow walks out of the app", async () => {
  const p = await phone({ packages: [APP] });
  try {
    const flow = `app: ${APP}\nname: escape\nsteps:\n  - launch\n  - tap: "Open bank"\n  - tap: "Continue"\n  - type: "4111111111111111"\n`;
    const s = JSON.parse((await p.call("run_flow", { yaml: flow })).content[0].text.split("\n\nReport:")[0]);
    assert.equal(s.status, "failed");
    assert.equal(s.failure.step, 3);
    assert.match(s.failure.message, /run_flow blocked: org\.other\.bank is in front/);
    assert.equal(p.acted().filter((c) => c.includes("raw:input")).length, 1, "only the first tap may reach the phone");
    assert.ok(!p.sent().some((c) => c.includes("input text")), "typed into another app");
    // A step that leaves the app by definition is refused before it runs.
    p.state.front = APP;
    const home = JSON.parse((await p.call("run_flow", { yaml: `app: ${APP}\nsteps:\n  - home\n  - tap: "Continue"\n` })).content[0].text.split("\n\nReport:")[0]);
    assert.match(home.failure.message, /"home" key leaves the app/);
    assert.ok(!p.sent().some((c) => c.includes("KEYCODE_HOME")));
    // A flow for another app never starts.
    denied(await p.call("run_flow", { yaml: `app: ${OTHER}\nsteps:\n  - launch\n` }), /outside this server's --package scope/);
  } finally { await p.close(); }
});

test("an APK is never installed under another app's name", async () => {
  const p = await phone({ packages: [APP] });
  try {
    const evil = join(p.dir, "evil.apk");
    await writeFile(evil, buildApk(OTHER));
    denied(await p.call("install_apk", { path: evil }), /outside this server's --package scope/);
    denied(await p.call("smoke_test", { package: APP, apkPath: evil }), /contains org\.other\.bank, not com\.example\.notes/);
    denied(await p.call("explore_app", { package: APP, apkPath: evil }), /contains org\.other\.bank, not com\.example\.notes/);
    assert.deepEqual(p.acted(), []);
  } finally { await p.close(); }
  // Without a scope the mismatch is still refused: the caller named one app and handed over another.
  const open = await phone();
  try {
    const evil = join(open.dir, "evil.apk");
    await writeFile(evil, buildApk(OTHER));
    denied(await open.call("smoke_test", { package: APP, apkPath: evil }), /refusing to install a different app/);
    assert.deepEqual(open.acted(), []);
  } finally { await open.close(); }
});

test("a server started for one device stays on it, and reconnecting keeps every restriction", async () => {
  const p = await phone({ packages: [APP] });
  try {
    denied(await p.call("select_device", { address: "10.0.0.9:5555" }), /switching to 10\.0\.0\.9:5555 is not allowed/);
    denied(await p.call("select_device", {}), /auto-discovering another phone is not allowed/);
    // Reconnect to the same phone: a new connection, the same rules.
    assert.match((await p.call("select_device", { address: p.address })).content[0].text, /Connected/);
    p.state.front = OTHER;
    denied(await p.call("tap", { x: 540, y: 2075 }), /is in front/);
    denied(await p.call("launch_app", { package: OTHER }), /outside this server's --package scope/);
    assert.deepEqual(p.acted(), []);
  } finally { await p.close(); }
});

test("confirmation is enforced by the server: denied calls do not run, approved ones do, preauthorized ones need no one", async () => {
  const asked = [];
  let answer = false;
  const p = await phone({ confirm: ["interact", "install"], approver: async (req) => { asked.push(req); return answer; } });
  try {
    denied(await p.call("tap", { x: 540, y: 2075 }), /needs approval \(interact\) and was not approved: the user declined/);
    assert.deepEqual(p.acted(), []);
    assert.equal((await p.call("ui_tree", {})).isError, undefined, "reading needs no approval");
    answer = true;
    assert.match((await p.call("tap", { x: 540, y: 2075 })).content[0].text, /Tapped/);
    assert.equal(p.acted().length, 1);
    assert.equal(asked.length, 2);
    assert.deepEqual(asked[1].classes, ["interact"]);
  } finally { await p.close(); }

  // No approver at all: the answer is no.
  await assert.rejects(new Policy({ confirm: ["interact"], auditFile: false }).authorize({ tool: "tap" }), /no approver is available/);

  // Unattended, explicitly preauthorized: runs without asking anyone.
  let calls = 0;
  const ci = await phone({ confirm: ["interact", "install"], preauthorize: ["interact"], approver: async () => { calls++; return false; } });
  try {
    assert.match((await ci.call("tap", { x: 540, y: 2075 })).content[0].text, /Tapped/);
    assert.equal(calls, 0);
    assert.ok((await ci.audit()).some((e) => e.tool === "tap" && e.decision === "preauthorized"));
  } finally { await ci.close(); }
});

test("without --confirm, ordinary automated tests run with no prompts", async () => {
  const p = await phone({ approver: async () => { throw new Error("nobody should be asked"); } });
  try {
    const s = JSON.parse((await p.call("run_flow", { yaml: `app: ${APP}\nsteps:\n  - launch\n  - tap: "Continue"\n  - back\n` })).content[0].text.split("\n\nReport:")[0]);
    assert.equal(s.status, "passed", JSON.stringify(s.failure));
  } finally { await p.close(); }
});

test("out-of-band approval: pending until a person approves, then valid for exactly one call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tt-approvals-"));
  const policy = new Policy({ allowShell: true, confirm: ["execute"], approver: fileApprover(dir), auditFile: false });
  const req = { tool: "shell", summary: "run a shell command on the phone: id" };
  const first = await policy.authorize(req).catch((e) => e);
  assert.ok(first instanceof PolicyError);
  const id = /tethertrace approve ([a-f0-9]{8})/.exec(first.message)?.[1];
  assert.ok(id, first.message);
  // Asking again does not approve it, and does not pile up requests.
  await assert.rejects(policy.authorize(req), new RegExp(`approve ${id}`));
  assert.equal((await listApprovals(dir)).length, 1);
  // A different command is a different request.
  await assert.rejects(policy.authorize({ ...req, summary: "run a shell command on the phone: rm -rf /sdcard" }), /Approval needed/);
  await assert.rejects(approve("zzzzzzzz", dir), /8 hex/);
  await approve(id, dir);
  await policy.authorize(req); // passes once
  await assert.rejects(policy.authorize(req), /Approval needed/); // and only once
});

test("the audit log records allowed and denied calls, and never what was typed", async () => {
  const p = await phone({ packages: [APP] });
  try {
    await p.call("type_text", { text: "s3cret-passw0rd" });
    await p.call("launch_app", { package: OTHER });
    p.state.front = OTHER;
    await p.call("tap", { x: 1, y: 1 });
    const log = await p.audit();
    assert.ok(log.some((e) => e.tool === "type_text" && e.decision === "allowed" && e.classes.includes("interact")));
    assert.ok(log.some((e) => e.tool === "launch_app" && e.decision === "denied" && e.package === OTHER && /scope/.test(e.reason)));
    assert.ok(log.some((e) => e.tool === "tap" && e.decision === "denied" && /is in front/.test(e.reason)));
    for (const e of log) assert.ok(e.t && !Number.isNaN(Date.parse(e.t)));
    assert.ok(!JSON.stringify(log).includes("s3cret"), "typed text leaked into the audit log");
  } finally { await p.close(); }
});

test("the policy is platform-neutral: any adapter that can say what is in front gets the same rules", async () => {
  // Stand-in for a non-Android adapter (there is no iOS adapter yet): bundle ids instead of packages.
  const policy = new Policy({ packages: ["com.example.Notes"], auditFile: false });
  const probe = (front, at) => ({ focusedPackage: async () => front, packageAt: async () => at });
  await policy.assertInScope("tap", probe("com.example.Notes", "com.example.Notes"), { x: 1, y: 1 });
  await assert.rejects(policy.assertInScope("tap", probe("com.apple.Preferences")), /com\.apple\.Preferences is in front/);
  await assert.rejects(policy.assertInScope("tap", probe(undefined)), /could not tell/);
  await assert.rejects(policy.assertInScope("tap", { focusedPackage: async () => { throw new Error("no service"); } }), /could not tell/);
  await assert.rejects(policy.assertInScope("tap", { focusedPackage: async () => "com.example.Notes" }, { x: 1, y: 1 }), /could not tell which app owns/);
  assert.throws(() => parseClasses("interact,root", "--confirm"), /unknown permission class "root"/);
  assert.deepEqual(parseClasses("install, execute", "--confirm"), ["install", "execute"]);
});
