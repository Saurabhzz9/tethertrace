// A fake adbd (wireless-debugging pairing + connect) for tests and protocol cross-checks.
// Not shipped: lives in tests/ only.
import { createPublicKey, publicDecrypt, constants, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { Duplex } from "node:stream";
import {
  AdbKey,
  Spake2,
  PairingCipher,
  SocketReader,
  protocol as P,
  encodePacket,
  readPacket,
  encodePeerInfo,
  decodePeerInfo,
  CLIENT_NAME,
  SERVER_NAME,
  EXPORTED_KEY_LABEL,
  PACKET_PEER_INFO,
  PACKET_SPAKE2_MSG,
  PEER_DEVICE_GUID,
  modulusFromAndroidKey,
  encodePng,
} from "../../dist/index.js";

/** A valid 1×1 PNG for mocked `screencap -p`. */
export const TINY_PNG = encodePng(1, 1, Buffer.from([0, 20, 20, 20, 255]));

const SHA1_DIGEST_INFO = Buffer.from("3021300906052b0e03021a05000414", "hex");

export function publicKeyFromAndroidString(s) {
  const raw = Buffer.from(s.trim().split(/\s+/)[0], "base64");
  let hex = modulusFromAndroidKey(raw).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return createPublicKey({ key: { kty: "RSA", n: Buffer.from(hex, "hex").toString("base64url"), e: "AQAB" }, format: "jwk" });
}

const modOf = (keyObj) => keyObj.export({ format: "jwk" }).n;

/** Pairing server (the phone's "Pair device with pairing code" dialog). */
export async function startPairingServer({ code, guid = "adb-MOCK1234-abcdef" }) {
  const deviceKey = AdbKey.generate("mock@device");
  const paired = [];
  const server = createTlsServer(
    { key: deviceKey.keyPem, cert: deviceKey.certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: false },
    async (sock) => {
      sock.on("error", () => undefined);
      try {
        const reader = new SocketReader(sock);
        const ekm = sock.exportKeyingMaterial(64, EXPORTED_KEY_LABEL, Buffer.alloc(0));
        const bob = new Spake2("bob", Buffer.concat([Buffer.from(code), ekm]), SERVER_NAME, CLIENT_NAME);
        sock.write(encodePacket(PACKET_SPAKE2_MSG, bob.message));
        const theirs = await readPacket(reader);
        const cipher = new PairingCipher(bob.finish(theirs.payload));
        const pkt = await readPacket(reader);
        if (pkt.type !== PACKET_PEER_INFO) throw new Error("expected peer info");
        const info = decodePeerInfo(cipher.decrypt(pkt.payload)); // throws on wrong code
        paired.push(info.data);
        sock.write(encodePacket(PACKET_PEER_INFO, cipher.encrypt(encodePeerInfo(PEER_DEVICE_GUID, guid))));
        sock.end();
      } catch {
        sock.destroy();
      }
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, paired, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Fake adbd. mode "tls": answers CNXN with STLS and requires a client cert whose key is trusted.
 * mode "auth": classic RSA token auth; unknown keys are accepted via AUTH RSAPUBLICKEY if acceptNewKeys.
 */
/**
 * `upload` shapes how an install is received: `stallAfter` stops acknowledging once that many bytes
 * arrived (a link that went dead), `ackDelayMs` delays every acknowledgement (a slow link).
 */
export async function startAdbd({ mode = "tls", trusted = [], trustAny = false, acceptNewKeys = true, banner, handler, upload = {} } = {}) {
  const deviceKey = AdbKey.generate("mock@device");
  const trustedMods = new Set(trusted.map((s) => modOf(publicKeyFromAndroidString(s))));
  const log = [];
  const bannerText = banner ?? "device::ro.product.name=mock;ro.product.model=MockPhone;ro.product.device=mock;features=shell_v2,cmd,abb_exec";
  const server = createNetServer((raw) => {
    raw.on("error", () => undefined);
    run(raw).catch(() => raw.destroy());
  });

  async function run(raw) {
    let sock = raw;
    let reader = new SocketReader(raw);
    const send = (command, arg0, arg1, payload = Buffer.alloc(0)) => sock.write(P.encodeMessage({ command, arg0, arg1, payload }));
    const read = async () => {
      const h = P.decodeHeader(await reader.readExact(24));
      return { ...h, payload: h.length ? await reader.readExact(h.length) : Buffer.alloc(0) };
    };
    const cnxn = await read();
    if (cnxn.command !== P.A_CNXN) throw new Error("expected CNXN");
    log.push({ hostBanner: cnxn.payload.toString() });
    const accept = () => send(P.A_CNXN, P.A_VERSION, 256 * 1024, Buffer.from(bannerText));

    if (mode === "tls") {
      send(P.A_STLS, P.A_STLS_VERSION, 0);
      const stls = await read();
      if (stls.command !== P.A_STLS) throw new Error("expected STLS");
      // The ClientHello may already sit in our buffer (it follows STLS immediately),
      // so feed the TLS layer through a JS duplex that starts with those bytes.
      const leftover = reader.detach();
      const pipe = new Duplex({
        read() {},
        write(chunk, _enc, cb) {
          raw.write(chunk, cb);
        },
      });
      if (leftover.length) pipe.push(leftover);
      raw.on("data", (c) => pipe.push(c));
      raw.on("close", () => pipe.push(null));
      raw.resume();
      const tls = new TLSSocket(pipe, { isServer: true, key: deviceKey.keyPem, cert: deviceKey.certPem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
      tls.on("error", () => undefined);
      await new Promise((resolve, reject) => {
        tls.once("secure", resolve);
        tls.once("error", reject);
      });
      const peer = tls.getPeerX509Certificate();
      if (!peer || (!trustAny && !trustedMods.has(modOf(peer.publicKey)))) {
        log.push({ tlsRejected: true });
        raw.destroy();
        tls.destroy();
        return;
      }
      sock = tls;
      reader = new SocketReader(tls);
      accept();
    } else {
      let token = randomBytes(20);
      send(P.A_AUTH, P.AUTH_TOKEN, 0, token);
      for (;;) {
        const m = await read();
        if (m.command !== P.A_AUTH) throw new Error("expected AUTH");
        if (m.arg0 === P.AUTH_SIGNATURE) {
          const ok = [...trustedMods].some((n) => {
            try {
              const pub = createPublicKey({ key: { kty: "RSA", n, e: "AQAB" }, format: "jwk" });
              return publicDecrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, m.payload).equals(Buffer.concat([SHA1_DIGEST_INFO, token]));
            } catch {
              return false;
            }
          });
          if (ok) break;
          token = randomBytes(20);
          send(P.A_AUTH, P.AUTH_TOKEN, 0, token);
        } else if (m.arg0 === P.AUTH_RSAPUBLICKEY) {
          const keyString = m.payload.toString("utf8").replace(/\0+$/, "");
          log.push({ publicKeyOffered: keyString });
          if (!acceptNewKeys) {
            raw.destroy();
            return;
          }
          trustedMods.add(modOf(publicKeyFromAndroidString(keyString)));
          break;
        }
      }
      accept();
    }

    let nextId = 1000;
    const uploads = new Map(); // local id -> { remote, expect, got }
    for (;;) {
      const m = await read();
      if (m.command === P.A_WRTE && uploads.has(m.arg1)) {
        const u = uploads.get(m.arg1);
        u.got += m.payload.length;
        u.chunks++;
        log.push({ uploadChunk: m.payload.length });
        if (upload.stallAfter !== undefined && u.got > upload.stallAfter) continue; // never acknowledged
        if (upload.ackDelayMs) await new Promise((r) => setTimeout(r, upload.ackDelayMs));
        send(P.A_OKAY, m.arg1, u.remote);
        if (u.got >= u.expect) {
          uploads.delete(m.arg1);
          send(P.A_WRTE, m.arg1, u.remote, Buffer.from("Success\n"));
          send(P.A_CLSE, m.arg1, u.remote);
        }
        continue;
      }
      if (m.command !== P.A_OPEN) continue;
      const service = m.payload.toString("utf8").replace(/\0$/, "");
      log.push({ open: service });
      const local = nextId++;
      const remote = m.arg0;
      const reply = (data) => send(P.A_WRTE, local, remote, data);
      const exec = /^exec:(.*)$/s.exec(service);
      if (exec) {
        send(P.A_OKAY, local, remote);
        const install = /^cmd package install .*-S (\d+)/.exec(exec[1]);
        if (install) {
          uploads.set(local, { remote, expect: Number(install[1]), got: 0, chunks: 0 });
          continue;
        }
        const data = Buffer.from((handler && handler(exec[1], "exec")) ?? "");
        for (let i = 0; i < data.length; i += 64 * 1024) reply(data.subarray(i, i + 64 * 1024));
        send(P.A_CLSE, local, remote);
        continue;
      }
      const v2 = /^shell,v2,(?:[^:]*,)?raw:(.*)$/s.exec(service);
      if (!v2) {
        send(P.A_CLSE, 0, remote);
        continue;
      }
      send(P.A_OKAY, local, remote);
      const cmd = v2[1];
      let out = "";
      let code = 0;
      const custom = handler && handler(cmd, "shell");
      if (custom !== undefined) out = String(custom);
      else if (cmd.startsWith("echo ")) out = `${cmd.slice(5)}\n`;
      else if (cmd.includes("getprop")) out = "Tether\n__TT_SEP__\nMockPhone\n__TT_SEP__\n15\n__TT_SEP__\n35\n__TT_SEP__\narm64-v8a\n";
      else if (cmd === "false") code = 1;
      else out = `unknown:${cmd}\n`;
      const frame = (id, data) => {
        const h = Buffer.alloc(5);
        h[0] = id;
        h.writeUInt32LE(data.length, 1);
        return Buffer.concat([h, data]);
      };
      if (out) reply(frame(1, Buffer.from(out)));
      reply(frame(3, Buffer.from([code])));
      send(P.A_CLSE, local, remote);
    }
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, log, close: () => new Promise((r) => { server.close(r); }) };
}
