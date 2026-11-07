import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
  randomBytes,
  sign,
  constants,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

/**
 * The host's ADB identity: an RSA-2048 key, the Android-format public key string that
 * the phone stores, and a self-signed certificate used for wireless-debugging TLS.
 */
export class AdbKey {
  readonly publicKeyString: string;
  readonly certPem: string;
  readonly keyPem: string;

  constructor(
    readonly privateKey: KeyObject,
    readonly name = defaultKeyName(),
  ) {
    this.keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = createPublicKey(privateKey);
    this.publicKeyString = `${androidPublicKey(pub).toString("base64")} ${name}`;
    this.certPem = selfSignedCertPem(privateKey, pub);
  }

  static generate(name?: string) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    return new AdbKey(privateKey, name);
  }

  /** Signs an AUTH token the way adbd expects: RSA PKCS#1 v1.5 over a SHA-1 DigestInfo of the raw token. */
  signToken(token: Buffer) {
    return privateEncrypt({ key: this.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_DIGEST_INFO, token]));
  }
}

export function homeDir() {
  return process.env.TETHERTRACE_HOME ?? join(homedir(), ".tethertrace");
}

function defaultKeyName() {
  let user = "user";
  try {
    user = userInfo().username || user;
  } catch {
    /* some sandboxes have no user entry */
  }
  return `${user}@${hostname()}`.replace(/\s+/g, "_");
}

/** Load the host key from ~/.tethertrace/adbkey, creating it on first use. */
export async function loadOrCreateKey(dir = homeDir()): Promise<AdbKey> {
  const path = join(dir, "adbkey");
  try {
    return new AdbKey(createPrivateKey(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dir, { recursive: true });
  const key = AdbKey.generate();
  await writeFile(path, key.keyPem, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600).catch(() => undefined);
  await writeFile(`${path}.pub`, `${key.publicKeyString}\n`);
  return key;
}

const SHA1_DIGEST_INFO = Buffer.from("3021300906052b0e03021a05000414", "hex");

function bigFromB64url(s: string) {
  return BigInt(`0x${Buffer.from(s, "base64url").toString("hex")}`);
}

function bigToLE(n: bigint, bytes: number) {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modInverse(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** Android's `RSAPublicKey` struct (mincrypt layout) used in adbkey.pub and AUTH RSAPUBLICKEY. */
export function androidPublicKey(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("Expected an RSA public key");
  const n = bigFromB64url(jwk.n);
  const e = Number(bigFromB64url(jwk.e));
  const words = 64;
  if (n >> 2047n !== 1n || n >> 2048n !== 0n) throw new Error("ADB requires a 2048-bit RSA key");
  const r32 = 1n << 32n;
  const n0inv = (r32 - modInverse(n % r32, r32)) % r32;
  const rr = (1n << 4096n) % n;
  const out = Buffer.alloc(4 + 4 + 256 + 256 + 4);
  out.writeUInt32LE(words, 0);
  out.writeUInt32LE(Number(n0inv), 4);
  bigToLE(n, 256).copy(out, 8);
  bigToLE(rr, 256).copy(out, 264);
  out.writeUInt32LE(e, 520);
  return out;
}

/** Recover the modulus from an Android-format key (used by tests and the mock device). */
export function modulusFromAndroidKey(buf: Buffer): bigint {
  let n = 0n;
  for (let i = 255; i >= 0; i--) n = (n << 8n) | BigInt(buf[8 + i]!);
  return n;
}

// ---- Minimal DER/X.509 encoder (just enough for a self-signed RSA cert) ----

function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  const len = body.length;
  let lenBytes: Buffer;
  if (len < 0x80) lenBytes = Buffer.from([len]);
  else {
    let hex = len.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const raw = Buffer.from(hex, "hex");
    lenBytes = Buffer.concat([Buffer.from([0x80 | raw.length]), raw]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const set = (...p: Buffer[]) => der(0x31, ...p);
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const utf8 = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const derNull = Buffer.from([0x05, 0x00]);

function derInt(b: Buffer) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  return der(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function utcTime(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, "ascii"));
}

function selfSignedCertPem(privateKey: KeyObject, pub: KeyObject) {
  const sha256WithRsa = seq(oid("2a864886f70d01010b"), derNull);
  const name = seq(set(seq(oid("550403"), utf8("tethertrace"))));
  const now = Date.now();
  const validity = seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 10 * 365 * 86_400_000)));
  const spki = pub.export({ type: "spki", format: "der" });
  const basicConstraints = seq(oid("551d13"), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff])))));
  const extensions = der(0xa3, seq(basicConstraints));
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = seq(der(0xa0, derInt(Buffer.from([2]))), derInt(serial), sha256WithRsa, name, validity, name, spki, extensions);
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  const b64 = cert.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`;
}
