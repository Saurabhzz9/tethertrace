import { crc32, deflateSync, inflateSync } from "node:zlib";

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

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what `screencap -p` produces) into RGBA pixels. */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  let p = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("latin1", p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error("Unsupported PNG layout");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]!;
      out[o + 1] = line[x * bpp + 1]!;
      out[o + 2] = line[x * bpp + 2]!;
      out[o + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** Downscale a PNG on the computer (box filter). Much faster than pulling the raw framebuffer over Wi-Fi. */
export function downscalePng(png: Buffer, scale: number): Buffer {
  const { width, height, rgba } = decodePng(png);
  const raw = Buffer.alloc(16 + rgba.length);
  raw.writeUInt32LE(width, 0);
  raw.writeUInt32LE(height, 4);
  raw.writeUInt32LE(1, 8);
  rgba.copy(raw, 16);
  return rawScreencapToPng(raw, scale);
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
