/**
 * ADB wire protocol framing (see AOSP packages/modules/adb/protocol.txt).
 * Every message is a 24-byte little-endian header followed by an optional payload.
 */

const cmd = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | ((s.charCodeAt(3) << 24) >>> 0);

export const A_CNXN = cmd("CNXN") >>> 0;
export const A_AUTH = cmd("AUTH") >>> 0;
export const A_OPEN = cmd("OPEN") >>> 0;
export const A_OKAY = cmd("OKAY") >>> 0;
export const A_CLSE = cmd("CLSE") >>> 0;
export const A_WRTE = cmd("WRTE") >>> 0;
export const A_STLS = cmd("STLS") >>> 0;

export const A_VERSION = 0x01000001;
export const A_STLS_VERSION = 0x01000000;
export const MAX_PAYLOAD = 1024 * 1024;

export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

export const HEADER_SIZE = 24;

export interface AdbMessage {
  command: number;
  arg0: number;
  arg1: number;
  payload: Buffer;
}

export function commandName(c: number) {
  return String.fromCharCode(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
}

function checksum(data: Buffer) {
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  return sum;
}

export function encodeMessage(m: AdbMessage): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(m.command >>> 0, 0);
  header.writeUInt32LE(m.arg0 >>> 0, 4);
  header.writeUInt32LE(m.arg1 >>> 0, 8);
  header.writeUInt32LE(m.payload.length, 12);
  header.writeUInt32LE(checksum(m.payload), 16);
  header.writeUInt32LE((m.command ^ 0xffffffff) >>> 0, 20);
  return m.payload.length ? Buffer.concat([header, m.payload]) : header;
}

export interface MessageHeader {
  command: number;
  arg0: number;
  arg1: number;
  length: number;
}

export function decodeHeader(h: Buffer): MessageHeader {
  const command = h.readUInt32LE(0);
  const magic = h.readUInt32LE(20);
  if (((command ^ 0xffffffff) >>> 0) !== magic) throw new Error("Corrupt ADB message header (bad magic)");
  const length = h.readUInt32LE(12);
  if (length > MAX_PAYLOAD) throw new Error(`ADB payload too large (${length} bytes)`);
  return { command, arg0: h.readUInt32LE(4), arg1: h.readUInt32LE(8), length };
}

/** Parse the device banner, e.g. `device::ro.product.model=Pixel 7;features=shell_v2,cmd`. */
export function parseBanner(payload: Buffer) {
  const text = payload.toString("utf8").replace(/\0+$/, "");
  const [kind = "", , props = ""] = text.split(":");
  const properties: Record<string, string> = {};
  for (const part of props.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) properties[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const features = new Set((properties.features ?? "").split(",").filter(Boolean));
  return { kind, properties, features };
}

export const HOST_FEATURES = ["shell_v2", "cmd", "stat_v2", "ls_v2", "fixed_push_mkdir", "abb_exec"];
