import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { AdbKey, Device, Recording, attachRecording, nativeRecorderWorks, encodePng } from "../dist/index.js";
import { decodePng, downscalePng } from "../dist/image.js";
import { startAdbd } from "./helpers/mock-device.mjs";

const key = AdbKey.generate("test@host");

/** A PNG using all five row filters, like real `screencap -p` output. */
function filteredPng(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([(i * 37) & 255, (i * 11) & 255, (i * 5) & 255, 255], i * 4);
  const stride = w * 4;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const filter = y % 5;
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i + 1] = (cur[i] - pred) & 255;
    }
    rows.push(out);
  }
  const png = encodePng(w, h, Buffer.alloc(0));
  // Swap in our filtered IDAT: rebuild via encodePng's chunk layout is internal, so assemble manually.
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require_crc(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = png.subarray(16, 29);
  return { rgba, png: Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]) };
}
import { crc32 } from "node:zlib";
const require_crc = (b) => crc32(b) >>> 0;

test("PNG decoder handles every row filter, and downscaling halves the size", () => {
  const { rgba, png } = filteredPng(6, 10);
  const d = decodePng(png);
  assert.equal(d.width, 6);
  assert.equal(d.height, 10);
  assert.deepEqual(d.rgba, rgba);
  const small = downscalePng(png, 0.5);
  assert.equal(small.readUInt32BE(16), 3);
  assert.equal(small.readUInt32BE(20), 5);
});

function phone({ nativeRecorder }) {
  const frame = filteredPng(4, 8).png;
  return (cmd, kind) => {
    if (kind === "exec" && cmd === "screencap -p") return frame;
    if (kind === "shell" && cmd.startsWith("screenrecord --time-limit 1")) return nativeRecorder ? "ok\n" : "";
    return undefined;
  };
}

test("recording falls back to screenshot frames when the phone's recorder is broken", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone({ nativeRecorder: false }) });
  const out = await mkdtemp(join(tmpdir(), "tt-rec-"));
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    assert.equal(await nativeRecorderWorks(d), false);
    const rec = await Recording.start(d);
    assert.equal(rec.mode, "frames");
    await new Promise((r) => setTimeout(r, 300));
    const res = await rec.stop();
    d.close();
    assert.equal(res.kind, "frames");
    assert.ok(res.frames.length >= 2, `frames: ${res.frames.length}`);
    assert.ok(res.frames.every((f, i) => i === 0 || f.ms >= res.frames[i - 1].ms), "frames are in time order");

    await writeFile(join(out, "summary.json"), JSON.stringify({ files: ["report.html"] }));
    await writeFile(join(out, "report.html"), '<h1>x</h1><p style="color:#666;font-size:13px">privacy</p>');
    const names = await attachRecording(out, res);
    assert.ok(names.includes("recording/index.html"));
    const player = await readFile(join(out, "recording", "index.html"), "utf8");
    assert.match(player, /frame-00000\.png/);
    assert.ok((await readdir(join(out, "recording"))).filter((f) => f.endsWith(".png")).length === res.frames.length);
    assert.match(await readFile(join(out, "report.html"), "utf8"), /Screen recording/);
    assert.ok(JSON.parse(await readFile(join(out, "summary.json"), "utf8")).files.includes("recording/index.html"));
  } finally {
    await dev.close();
  }
});

test("recording uses the phone's own recorder when it works", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler: phone({ nativeRecorder: true }) });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    assert.equal(await nativeRecorderWorks(d), true);
    d.close();
  } finally {
    await dev.close();
  }
});
