import { crc32, deflateRawSync } from "node:zlib";

// Minimal binary AndroidManifest + ZIP builders, enough for readApkInfo.
export function axml(strings, elements) {
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

export function zip(entries) {
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


/** A tiny APK whose manifest names `pkg`. */
export function buildApk(pkg) {
  const strings = ["manifest", "package", "versionName", "versionCode", pkg, "1.0", "application"];
  const manifest = axml(strings, [
    { name: "manifest", attrs: [["versionCode", 1], ["versionName", "1.0"], ["package", pkg]] },
    { name: "application", attrs: [] },
  ]);
  return zip([{ name: "AndroidManifest.xml", data: manifest, deflate: true }]);
}
