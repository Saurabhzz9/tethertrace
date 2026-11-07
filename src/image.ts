import { crc32, deflateSync } from "node:zlib";

/**
 * Turn Android's raw `screencap` output (RGBA_8888) into a downscaled PNG without any image library.
 * Agents get a ~4x smaller image at scale 0.5, which keeps screenshots cheap in an LLM context.
 */
export function rawScreencapToPng(raw: Buffer, scale = 0.5): Buffer {
  if (raw.length < 16) throw new Error("screencap returned no data");
  const w = raw.readUInt32LE(0);
  const h = raw.readUInt32LE(4);
  const format = raw.readUInt32LE(8);
  const header = raw.length - w * h * 4;
  if (!(header === 12 || header === 16) || !(format === 1 || format === 2)) throw new Error(`Unsupported screencap format ${format}`);
  const step = Math.max(1, Math.round(1 / Math.min(1, Math.max(0.05, scale))));
  const ow = Math.floor(w / step);
  const oh = Math.floor(h / step);
  const rows = Buffer.alloc(oh * (ow * 4 + 1));
  for (let y = 0; y < oh; y++) {
    const rowStart = y * (ow * 4 + 1);
    rows[rowStart] = 0; // filter: none
    for (let x = 0; x < ow; x++) {
      // Box-average step×step pixels for a cleaner downscale than nearest-neighbour.
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < step; dy++) {
        let p = header + ((y * step + dy) * w + x * step) * 4;
        for (let dx = 0; dx < step; dx++, p += 4) {
          r += raw[p]!;
          g += raw[p + 1]!;
          b += raw[p + 2]!;
        }
      }
      const n = step * step;
      const o = rowStart + 1 + x * 4;
      rows[o] = r / n;
      rows[o + 1] = g / n;
      rows[o + 2] = b / n;
      rows[o + 3] = 255;
    }
  }
  return encodePng(ow, oh, rows);
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, filteredRows: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filteredRows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
