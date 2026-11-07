import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { AdbKey } from "./keys.js";
import { SocketReader } from "./reader.js";
import { Spake2 } from "./spake2.js";

/**
 * Android 11+ "Pair device with pairing code" client (AOSP adb/pairing_connection).
 *
 * TLS 1.3 → exported keying material + 6-digit code → SPAKE2 → AES-128-GCM
 * encrypted exchange of PeerInfo (our RSA public key ↔ device GUID).
 */

export const CLIENT_NAME = Buffer.from("adb pair client\0", "latin1");
export const SERVER_NAME = Buffer.from("adb pair server\0", "latin1");
export const EXPORTED_KEY_LABEL = "adb-label\0";
export const EXPORTED_KEY_SIZE = 64;
export const PAIRING_PACKET_VERSION = 1;
export const PACKET_SPAKE2_MSG = 0;
export const PACKET_PEER_INFO = 1;
export const PEER_INFO_SIZE = 8192;
export const PEER_RSA_PUB_KEY = 0;
export const PEER_DEVICE_GUID = 1;
const MAX_PACKET = PEER_INFO_SIZE * 2;
const HKDF_INFO = "adb pairing_auth aes-128-gcm key";

export class PairingError extends Error {
  constructor(
    readonly code: "WRONG_CODE_OR_EXPIRED" | "PROTOCOL" | "CONNECT",
    message: string,
  ) {
    super(message);
  }
}

export function encodePacket(type: number, payload: Buffer) {
  const h = Buffer.alloc(6);
  h.writeUInt8(PAIRING_PACKET_VERSION, 0);
  h.writeUInt8(type, 1);
  h.writeUInt32BE(payload.length, 2);
  return Buffer.concat([h, payload]);
}

export async function readPacket(reader: SocketReader) {
  const h = await reader.readExact(6);
  const version = h.readUInt8(0);
  const type = h.readUInt8(1);
  const size = h.readUInt32BE(2);
  if (version !== PAIRING_PACKET_VERSION) throw new PairingError("PROTOCOL", `Unsupported pairing packet version ${version}`);
  if (size === 0 || size > MAX_PACKET) throw new PairingError("PROTOCOL", `Bad pairing packet size ${size}`);
  return { type, payload: await reader.readExact(size) };
}

/** AES-128-GCM with independent 64-bit little-endian sequence counters, as in adb's Aes128Gcm. */
export class PairingCipher {
  private readonly key: Buffer;
  private enc = 0n;
  private dec = 0n;
  constructor(spakeKey: Buffer) {
    this.key = Buffer.from(hkdfSync("sha256", spakeKey, Buffer.alloc(0), HKDF_INFO, 16));
  }
  private nonce(seq: bigint) {
    const n = Buffer.alloc(12);
    n.writeBigUInt64LE(seq);
    return n;
  }
  encrypt(plain: Buffer) {
    const c = createCipheriv("aes-128-gcm", this.key, this.nonce(this.enc++));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  decrypt(data: Buffer) {
    if (data.length < 16) throw new PairingError("PROTOCOL", "Encrypted message too short");
    const d = createDecipheriv("aes-128-gcm", this.key, this.nonce(this.dec++));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  }
}

export function encodePeerInfo(type: number, data: string) {
  const out = Buffer.alloc(PEER_INFO_SIZE);
  out.writeUInt8(type, 0);
  const bytes = Buffer.from(data, "utf8");
  if (bytes.length > PEER_INFO_SIZE - 2) throw new Error("Peer info too large");
  bytes.copy(out, 1);
  return out;
}

export function decodePeerInfo(buf: Buffer) {
  if (buf.length !== PEER_INFO_SIZE) throw new PairingError("PROTOCOL", "Bad peer info size");
  const end = buf.indexOf(0, 1);
  return { type: buf.readUInt8(0), data: buf.subarray(1, end < 0 ? undefined : end).toString("utf8") };
}

export interface PairOptions {
  host: string;
  port: number;
  /** The 6-digit code (or QR password) shown by the phone. */
  code: string;
  key: AdbKey;
  timeoutMs?: number;
}

export interface PairResult {
  /** Device GUID reported by adbd (e.g. "adb-XXXXXXXX-abc123"). */
  deviceGuid: string;
}

export async function pair(opts: PairOptions): Promise<PairResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let socket: TLSSocket | undefined;
  const timer = setTimeout(() => socket?.destroy(new PairingError("CONNECT", "Pairing timed out")), timeoutMs);
  try {
    socket = tlsConnect({
      host: opts.host,
      port: opts.port,
      key: opts.key.keyPem,
      cert: opts.key.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // adbd uses a self-signed cert; trust comes from the pairing code via SPAKE2, not from PKI.
      rejectUnauthorized: false,
    });
    const s = socket;
    await new Promise<void>((resolve, reject) => {
      s.once("secureConnect", resolve);
      s.once("error", (e) => reject(e instanceof PairingError ? e : new PairingError("CONNECT", `Cannot reach pairing port: ${e.message}`)));
    });
    const reader = new SocketReader(s);
    // TLS 1.3 treats "no context" and "empty context" identically (RFC 8446 §7.5).
    const ekm = s.exportKeyingMaterial(EXPORTED_KEY_SIZE, EXPORTED_KEY_LABEL, Buffer.alloc(0));
    const spake = new Spake2("alice", Buffer.concat([Buffer.from(opts.code, "utf8"), ekm]), CLIENT_NAME, SERVER_NAME);

    s.write(encodePacket(PACKET_SPAKE2_MSG, spake.message));
    const theirs = await readPacket(reader);
    if (theirs.type !== PACKET_SPAKE2_MSG) throw new PairingError("PROTOCOL", "Expected SPAKE2 message");
    let cipher: PairingCipher;
    try {
      cipher = new PairingCipher(spake.finish(theirs.payload));
    } catch {
      throw new PairingError("PROTOCOL", "Device sent an invalid SPAKE2 message");
    }

    s.write(encodePacket(PACKET_PEER_INFO, cipher.encrypt(encodePeerInfo(PEER_RSA_PUB_KEY, opts.key.publicKeyString))));
    let peer;
    try {
      const reply = await readPacket(reader);
      if (reply.type !== PACKET_PEER_INFO) throw new Error("unexpected packet");
      peer = decodePeerInfo(cipher.decrypt(reply.payload));
    } catch {
      // adbd closes the connection when it cannot decrypt our PeerInfo: wrong code.
      throw new PairingError("WRONG_CODE_OR_EXPIRED", "Pairing rejected: the code is wrong or the pairing dialog was closed");
    }
    if (peer.type !== PEER_DEVICE_GUID) throw new PairingError("PROTOCOL", "Device did not send its GUID");
    return { deviceGuid: peer.data };
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
