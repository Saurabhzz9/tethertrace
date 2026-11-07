import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Read an APK's identity (package name, version, label resource) without aapt or the SDK:
 * find AndroidManifest.xml in the ZIP central directory and decode Android's binary XML.
 */

export interface ApkInfo {
  packageName: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export async function readApkInfo(path: string): Promise<ApkInfo> {
  return parseManifest(await readZipEntry(path, "AndroidManifest.xml"));
}

export async function readZipEntry(path: string, name: string): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not an APK/ZIP file (no end-of-central-directory)");
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error("ZIP64 APKs are not supported");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN) throw new Error("Corrupt ZIP central directory");
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const entryName = cd.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (entryName !== name) continue;
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOffset);
      if (lh.readUInt32LE(0) !== LOC) throw new Error("Corrupt ZIP local header");
      const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, dataStart);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${method}`);
    }
    throw new Error(`${name} not found in ${path}`);
  } finally {
    await fh.close();
  }
}

const RES_STRING_POOL = 0x0001;
const RES_XML_START_ELEMENT = 0x0102;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

function readStringPool(buf: Buffer, start: number): string[] {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = start + stringsStart + buf.readUInt32LE(start + headerSize + i * 4);
    if (utf8) {
      p += buf[p]! & 0x80 ? 2 : 1; // UTF-16 length, skipped
      let len = buf[p]!;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1]!;
        p += 2;
      } else p += 1;
      out.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      out.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

/** Decode the attributes of <manifest> and <uses-sdk> from binary AndroidManifest.xml. */
export function parseManifest(buf: Buffer): ApkInfo {
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error("AndroidManifest.xml is not binary XML");
  let strings: string[] = [];
  const info: Partial<ApkInfo> = {};
  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === RES_STRING_POOL) strings = readStringPool(buf, p);
    else if (type === RES_XML_START_ELEMENT) {
      const element = strings[buf.readUInt32LE(p + 20)];
      const attrStart = buf.readUInt16LE(p + 24);
      const attrSize = buf.readUInt16LE(p + 26);
      const attrCount = buf.readUInt16LE(p + 28);
      for (let i = 0; i < attrCount; i++) {
        const a = p + 16 + attrStart + i * attrSize;
        const attr = strings[buf.readUInt32LE(a + 4)];
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15]!;
        const data = buf.readUInt32LE(a + 16);
        const str = raw !== 0xffffffff ? strings[raw] : dataType === TYPE_STRING ? strings[data] : undefined;
        const num = dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX ? data : str !== undefined && /^\d+$/.test(str) ? Number(str) : undefined;
        if (element === "manifest") {
          if (attr === "package" && str) info.packageName = str;
          if (attr === "versionName" && str) info.versionName = str;
          if (attr === "versionCode" && num !== undefined) info.versionCode = num;
        } else if (element === "uses-sdk") {
          if (attr === "minSdkVersion" && num !== undefined) info.minSdk = num;
          if (attr === "targetSdkVersion" && num !== undefined) info.targetSdk = num;
        }
      }
      if (element !== "manifest" && element !== "uses-sdk" && info.packageName && info.minSdk !== undefined) break;
    }
    p += size;
  }
  if (!info.packageName) throw new Error("Could not find the package name in AndroidManifest.xml");
  return info as ApkInfo;
}
