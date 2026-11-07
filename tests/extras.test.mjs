import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync, inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdbKey, createMcpServer, explainLocally, explainWithModel, parseModelSpec, rawScreencapToPng, readApkInfo, loadFlow } from "../dist/index.js";
import { startAdbd } from "./helpers/mock-device.mjs";

const key = AdbKey.generate("test@host");

// ---- minimal binary AndroidManifest + ZIP builders --------------------------

function axml(strings, elements) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const strData = strings.map((s) => Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)]));
  const offsets = [];
  let off = 0;
  for (const s of strData) { offsets.push(off); off += s.length; }
  let pool = Buffer.concat(strData);
  if (pool.length % 4) pool = Buffer.concat([pool, Buffer.alloc(4 - (pool.length % 4))]);
  const headerSize = 28;
  const sp = Buffer.concat([u16(1), u16(headerSize), u32(headerSize + offsets.length * 4 + pool.length), u32(strings.length), u32(0), u32(0), u32(headerSize + offsets.length * 4), u32(0), ...offsets.map(u32), pool]);
  const idx = (s) => strings.indexOf(s);
  const els = elements.map(({ name, attrs }) => {
    const attrBufs = attrs.map(([an, value]) => {
      const isNum = typeof value === "number";
      return Buffer.concat([u32(0xffffffff), u32(idx(an)), u32(isNum ? 0xffffffff : idx(value)), u16(8), Buffer.from([0, isNum ? 0x10 : 0x03]), u32(isNum ? value : idx(value))]);
    });
    const ext = Buffer.concat([u32(0xffffffff), u32(idx(name)), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0)]);
    const body = Buffer.concat([u32(1), u32(0xffffffff), ext, ...attrBufs]);
    return Buffer.concat([u16(0x0102), u16(16), u32(8 + body.length), body]);
  });
  const all = Buffer.concat([sp, ...els]);
  return Buffer.concat([u16(3), u16(8), u32(8 + all.length), all]);
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const n = Buffer.from(name);
    const payload = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, payload);
    centrals.push(ch, n);
    offset += 30 + n.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("readApkInfo reads package, version and SDKs from any APK (stored and deflated)", async () => {
  const strings = ["manifest", "package", "versionName", "versionCode", "uses-sdk", "minSdkVersion", "targetSdkVersion", "com.example.notes", "2.1.0", "application"];
  const manifest = axml(strings, [
    { name: "manifest", attrs: [["versionCode", 42], ["versionName", "2.1.0"], ["package", "com.example.notes"]] },
    { name: "uses-sdk", attrs: [["minSdkVersion", 24], ["targetSdkVersion", 35]] },
    { name: "application", attrs: [] },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "tt-apk-"));
  for (const deflate of [false, true]) {
    const f = join(dir, `${deflate}.apk`);
    await writeFile(f, zip([{ name: "classes.dex", data: Buffer.from("dex\n035"), deflate }, { name: "AndroidManifest.xml", data: manifest, deflate }]));
    assert.deepEqual(await readApkInfo(f), { packageName: "com.example.notes", versionName: "2.1.0", versionCode: 42, minSdk: 24, targetSdk: 35 });
  }
  const bad = join(dir, "bad.apk");
  await writeFile(bad, "not a zip");
  await assert.rejects(readApkInfo(bad), /Not an APK/);
});

test("raw screencap is box-downscaled into a valid PNG", () => {
  const w = 4, h = 2;
  const raw = Buffer.alloc(16 + w * h * 4);
  raw.writeUInt32LE(w, 0); raw.writeUInt32LE(h, 4); raw.writeUInt32LE(1, 8);
  for (let i = 0; i < w * h; i++) raw.set([i % 2 ? 200 : 100, 0, 50, 255], 16 + i * 4);
  const png = rawScreencapToPng(raw, 0.5);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  const idatLen = png.readUInt32BE(33);
  const pixels = inflateSync(png.subarray(41, 41 + idatLen));
  assert.deepEqual([...pixels], [0, 150, 0, 50, 255, 150, 0, 50, 255]);
});

test("model specs parse provider and model", () => {
  assert.deepEqual(parseModelSpec("anthropic"), { provider: "anthropic", model: undefined });
  assert.deepEqual(parseModelSpec("ollama:qwen3:8b"), { provider: "ollama", model: "qwen3:8b" });
});

const failedReport = {
  summary: { kind: "flow", name: "login", package: "com.example.notes", status: "failed", device: { manufacturer: "Acme", model: "One", androidVersion: "14" }, launchTimeMs: 700, failure: { step: 3, category: "element_not_found", message: '"Sign in" not found on screen', evidence: [], visibleOnScreen: ["[tap] Log in"] }, steps: [] },
  logTail: "11-07 10:00:00.000 1 1 I app: ready",
  crash: "",
  ui: "[tap] Log in",
};

test("local explanation states the failure, what was on screen, and a next check", () => {
  const t = explainLocally(failedReport);
  assert.match(t, /FAILED at step 3 — element_not_found/);
  assert.match(t, /\[tap\] Log in/);
  assert.match(t, /Next:/);
});

test("OpenAI-compatible explain (Ollama / LM Studio / OpenAI) sends the evidence and returns the answer", async () => {
  let body;
  const srv = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      body = JSON.parse(data);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "The button is labelled 'Log in', not 'Sign in'." } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const out = await explainWithModel(failedReport, { model: "openai-compatible:local-test", baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
    assert.match(out, /Log in/);
    assert.equal(body.model, "local-test");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[1].content, /element_not_found/);
  } finally {
    srv.close();
  }
  await assert.rejects(explainWithModel(failedReport, { model: "nope:x" }), /Unknown provider/);
});

test("flow files are validated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tt-flow-"));
  const f = join(dir, "bad.yaml");
  await writeFile(f, "steps: [launch]\n");
  await assert.rejects(loadFlow(f), /missing "app/);
});

// ---- MCP over a real MCP client --------------------------------------------

const UI = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]"><node text="Continue" content-desc="" resource-id="com.example.notes:id/next" class="android.widget.Button" clickable="true" bounds="[100,2000][980,2150]" /></node></hierarchy>`;

async function mcpAgainstMock(opts = {}) {
  const taps = [];
  const handler = (cmd, kind) => {
    if (kind === "exec" && cmd === "screencap") {
      const raw = Buffer.alloc(16 + 4 * 4 * 4);
      raw.writeUInt32LE(4, 0); raw.writeUInt32LE(4, 4); raw.writeUInt32LE(1, 8);
      return raw;
    }
    if (cmd.startsWith("uiautomator dump")) return UI;
    if (cmd.startsWith("input tap ")) { taps.push(cmd); return ""; }
    if (cmd.startsWith("pm list packages")) return "package:com.example.notes\npackage:org.other.app\n";
    return undefined;
  };
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const server = createMcpServer(key, { device: `127.0.0.1:${dev.port}`, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, taps, close: async () => { await client.close(); await dev.close(); } };
}

test("MCP: an agent can list tools, read the screen, tap by text and get a screenshot image", async () => {
  const m = await mcpAgainstMock();
  try {
    const names = (await m.client.listTools()).tools.map((t) => t.name);
    for (const n of ["device_info", "screenshot", "ui_tree", "tap", "type_text", "run_flow", "smoke_test", "install_apk", "app_logs", "pair_device"]) assert.ok(names.includes(n), n);
    assert.ok(!names.includes("shell"), "shell is opt-in");
    const ui = await m.client.callTool({ name: "ui_tree", arguments: {} });
    assert.match(ui.content[0].text, /\[tap\] Continue {2}#com\.example\.notes:id\/next/);
    const tap = await m.client.callTool({ name: "tap", arguments: { id: "next" } });
    assert.match(tap.content[0].text, /Tapped "Continue" at 540,2075/);
    assert.deepEqual(m.taps, ["input tap 540 2075"]);
    const miss = await m.client.callTool({ name: "tap", arguments: { text: "Nope", timeoutMs: 300 } });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /On screen instead:\n\[tap\] Continue/);
    const shot = await m.client.callTool({ name: "screenshot", arguments: {} });
    assert.equal(shot.content[0].type, "image");
    assert.equal(Buffer.from(shot.content[0].data, "base64").subarray(1, 4).toString(), "PNG");
    const apps = await m.client.callTool({ name: "list_apps", arguments: { filter: "example" } });
    assert.equal(apps.content[0].text, "com.example.notes");
  } finally {
    await m.close();
  }
});

test("MCP: --read-only hides every tool that changes the phone; --package scopes app tools", async () => {
  const ro = await mcpAgainstMock({ readOnly: true });
  try {
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    for (const n of ["tap", "type_text", "install_apk", "launch_app", "run_flow", "smoke_test", "pair_device"]) assert.ok(!names.includes(n), n);
    assert.ok(names.includes("screenshot"));
  } finally {
    await ro.close();
  }
  const scoped = await mcpAgainstMock({ packages: ["com.example.notes"] });
  try {
    const r = await scoped.client.callTool({ name: "launch_app", arguments: { package: "org.other.app" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /outside this server's --package scope/);
  } finally {
    await scoped.close();
  }
});
