import assert from "node:assert/strict";
import { createHash, randomBytes, X509Certificate, createPublicKey } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AdbConnection, AdbKey, Device, Spake2, SPAKE2_POINTS, pair, androidPublicKey, buildQuery, parseResponse, servicesFromRecords, SERVICE_CONNECT, protocol as P } from "../dist/index.js";
import { startAdbd, startPairingServer, publicKeyFromAndroidString } from "./helpers/mock-device.mjs";

const key = AdbKey.generate("test@host");

test("SPAKE2 M/N match BoringSSL's sha256-iterated generation seeds", () => {
  for (const [tag, point] of [["M", SPAKE2_POINTS.M], ["N", SPAKE2_POINTS.N]]) {
    const seed = createHash("sha256").update(`edwards25519 point generation seed (${tag})`).digest();
    assert.equal(Buffer.from(ed25519.Point.fromBytes(seed, true).toBytes()).toString("hex"), Buffer.from(point.toBytes()).toString("hex"));
  }
});

test("SPAKE2 alice and bob agree only with the same password", () => {
  const names = [Buffer.from("adb pair client\0"), Buffer.from("adb pair server\0")];
  const a = new Spake2("alice", Buffer.from("123456"), names[0], names[1]);
  const b = new Spake2("bob", Buffer.from("123456"), names[1], names[0]);
  const ka = a.finish(b.message);
  const kb = b.finish(a.message);
  assert.equal(ka.length, 64);
  assert.deepEqual(ka, kb);
  const c = new Spake2("alice", Buffer.from("123457"), names[0], names[1]);
  const d = new Spake2("bob", Buffer.from("123456"), names[1], names[0]);
  assert.notDeepEqual(c.finish(d.message), d.finish(c.message));
});

test("Android public key layout: n0inv, rr and exponent are consistent", () => {
  const raw = androidPublicKey(createPublicKey(key.privateKey));
  assert.equal(raw.length, 524);
  assert.equal(raw.readUInt32LE(0), 64);
  const n0 = BigInt(raw.readUInt32LE(8));
  const n0inv = BigInt(raw.readUInt32LE(4));
  assert.equal((n0 * n0inv) % (1n << 32n), (1n << 32n) - 1n); // n0inv = -1/n mod 2^32
  assert.equal(raw.readUInt32LE(520), 65537);
  const back = publicKeyFromAndroidString(key.publicKeyString);
  assert.equal(back.export({ format: "jwk" }).n, createPublicKey(key.privateKey).export({ format: "jwk" }).n);
  assert.match(key.publicKeyString, /^[A-Za-z0-9+/=]+ test@host$/);
});

test("self-signed certificate parses and matches the key", () => {
  const cert = new X509Certificate(key.certPem);
  assert.ok(cert.checkPrivateKey(key.privateKey));
  assert.ok(cert.verify(cert.publicKey));
  assert.ok(new Date(cert.validTo) > new Date());
});

test("message framing round-trips and rejects bad magic", () => {
  const buf = P.encodeMessage({ command: P.A_OPEN, arg0: 7, arg1: 0, payload: Buffer.from("shell:ls\0") });
  const h = P.decodeHeader(buf.subarray(0, 24));
  assert.equal(P.commandName(h.command), "OPEN");
  assert.equal(h.arg0, 7);
  assert.equal(h.length, 9);
  buf[20] ^= 1;
  assert.throws(() => P.decodeHeader(buf.subarray(0, 24)), /magic/);
});

test("pairing with the right code succeeds and hands over our public key", async () => {
  const srv = await startPairingServer({ code: "482913", guid: "adb-ABCD-xyz" });
  try {
    const r = await pair({ host: "127.0.0.1", port: srv.port, code: "482913", key });
    assert.equal(r.deviceGuid, "adb-ABCD-xyz");
    assert.equal(srv.paired[0], key.publicKeyString);
  } finally {
    await srv.close();
  }
});

test("pairing with a wrong code is rejected without trusting the key", async () => {
  const srv = await startPairingServer({ code: "482913" });
  try {
    await assert.rejects(pair({ host: "127.0.0.1", port: srv.port, code: "000000", key }), (e) => e.code === "WRONG_CODE_OR_EXPIRED");
    assert.equal(srv.paired.length, 0);
  } finally {
    await srv.close();
  }
});

test("TLS connect after pairing, then shell v2 with exit codes", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString] });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    assert.equal(d.adb.usedTls, true);
    assert.equal(d.model, "MockPhone");
    const r = await d.shell("echo hello");
    assert.equal(r.text, "hello\n");
    assert.equal(r.exitCode, 0);
    assert.equal((await d.shell("false")).exitCode, 1);
    const info = await d.info();
    assert.equal(info.model, "MockPhone");
    assert.equal(info.androidVersion, "15");
    assert.equal(info.sdk, 35);
    await assert.rejects(d.adb.open("sync:"), (e) => e.code === "STREAM_REFUSED");
    d.close();
  } finally {
    await dev.close();
  }
});

test("TLS connect with an unpaired key fails with a pairing hint", async () => {
  const dev = await startAdbd({ mode: "tls", trusted: [] });
  try {
    await assert.rejects(AdbConnection.connect({ host: "127.0.0.1", port: dev.port, key, connectTimeoutMs: 3000 }), (e) => e.code === "TLS_REJECTED" && /pair/i.test(e.message));
  } finally {
    await dev.close();
  }
});

test("classic RSA auth: known key signs in, unknown key is offered to the phone", async () => {
  const known = await startAdbd({ mode: "auth", trusted: [key.publicKeyString] });
  const fresh = await startAdbd({ mode: "auth", trusted: [] });
  try {
    const a = await AdbConnection.connect({ host: "127.0.0.1", port: known.port, key });
    assert.equal(known.log.some((l) => l.publicKeyOffered), false);
    a.close();
    let prompted = false;
    const b = await AdbConnection.connect({ host: "127.0.0.1", port: fresh.port, key, onAuthPrompt: () => (prompted = true) });
    assert.ok(prompted);
    assert.equal(fresh.log.find((l) => l.publicKeyOffered).publicKeyOffered, key.publicKeyString);
    b.close();
  } finally {
    await known.close();
    await fresh.close();
  }
});

test("mDNS response parsing finds the connect service with address and port", () => {
  // Hand-built response: PTR -> instance, SRV -> port 37123 on target, A -> 192.168.1.50.
  const name = (s) => Buffer.concat([...s.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (n, type, data) => {
    const h = Buffer.alloc(10);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(1, 2);
    h.writeUInt32BE(120, 4);
    h.writeUInt16BE(data.length, 8);
    return Buffer.concat([name(n), h, data]);
  };
  const inst = "adb-R5CT123-Ab1Cd2._adb-tls-connect._tcp.local";
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x91, 0x03]), name("Android-2.local")]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(2, 10);
  const pkt = Buffer.concat([header, rr(SERVICE_CONNECT, 12, name(inst)), rr(inst, 33, srv), rr("Android-2.local", 1, Buffer.from([192, 168, 1, 50]))]);
  const found = servicesFromRecords(parseResponse(pkt));
  assert.deepEqual(found, [{ name: "adb-R5CT123-Ab1Cd2", service: SERVICE_CONNECT, host: "192.168.1.50", port: 37123 }]);
  assert.ok(buildQuery([SERVICE_CONNECT]).length > 12);
});

test("keys are unique per generation", () => {
  assert.notEqual(AdbKey.generate().publicKeyString, key.publicKeyString);
  assert.equal(randomBytes(1).length, 1);
});
