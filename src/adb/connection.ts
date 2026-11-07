import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { AdbKey } from "./keys.js";
import {
  A_AUTH,
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_STLS,
  A_STLS_VERSION,
  A_VERSION,
  A_WRTE,
  AUTH_RSAPUBLICKEY,
  AUTH_SIGNATURE,
  AUTH_TOKEN,
  HEADER_SIZE,
  HOST_FEATURES,
  MAX_PAYLOAD,
  commandName,
  decodeHeader,
  encodeMessage,
  parseBanner,
  type AdbMessage,
} from "./protocol.js";
import { SocketReader } from "./reader.js";

export class AdbError extends Error {
  constructor(
    readonly code: "CONNECT" | "AUTH_REJECTED" | "AUTH_TIMEOUT" | "TLS_REJECTED" | "PROTOCOL" | "STREAM_REFUSED" | "CLOSED" | "TIMEOUT",
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectOptions {
  host: string;
  port: number;
  key: AdbKey;
  /** How long to wait for the user to tap "Allow" on the phone (USB-style auth). */
  authTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Called when the phone must show the "Allow USB debugging?" style prompt. */
  onAuthPrompt?: () => void;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** null when the device lacks shell_v2 and cannot report an exit code. */
  exitCode: number | null;
}

/** One logical ADB stream (a shell, a service, a sync session...). */
export class AdbStream {
  private queue: Buffer[] = [];
  private waiter?: () => void;
  private ackWaiter?: { resolve: () => void; reject: (e: Error) => void };
  closed = false;
  remoteId = 0;

  constructor(
    private readonly conn: AdbConnection,
    readonly localId: number,
    readonly service: string,
  ) {}

  /** Next chunk of data, or null once the device closes the stream. */
  async read(): Promise<Buffer | null> {
    while (!this.queue.length) {
      if (this.closed) return null;
      await new Promise<void>((r) => (this.waiter = r));
    }
    return this.queue.shift()!;
  }

  async readAll(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let c = await this.read(); c; c = await this.read()) parts.push(c);
    return Buffer.concat(parts);
  }

  async write(data: Buffer) {
    for (let off = 0; off < data.length; off += this.conn.maxPayload) {
      if (this.closed) throw new AdbError("CLOSED", `Stream ${this.service} is closed`);
      const chunk = data.subarray(off, off + this.conn.maxPayload);
      const acked = new Promise<void>((resolve, reject) => (this.ackWaiter = { resolve, reject }));
      this.conn.send({ command: A_WRTE, arg0: this.localId, arg1: this.remoteId, payload: chunk });
      await acked;
    }
  }

  close() {
    if (this.closed) return;
    this.conn.send({ command: A_CLSE, arg0: this.localId, arg1: this.remoteId, payload: Buffer.alloc(0) });
    this.markClosed();
  }

  /** @internal */ push(data: Buffer) {
    this.queue.push(data);
    this.wake();
  }
  /** @internal */ acked() {
    const a = this.ackWaiter;
    this.ackWaiter = undefined;
    a?.resolve();
  }
  /** @internal */ markClosed(err?: Error) {
    this.closed = true;
    const a = this.ackWaiter;
    this.ackWaiter = undefined;
    a?.reject(err ?? new AdbError("CLOSED", `Stream ${this.service} closed by device`));
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}

/**
 * A direct ADB connection to adbd over TCP — no adb server, no adb binary.
 * Handles RSA token auth (classic `adb tcpip`) and the STLS upgrade used by Android 11+ wireless debugging.
 */
export class AdbConnection {
  maxPayload = MAX_PAYLOAD;
  banner = { kind: "", properties: {} as Record<string, string>, features: new Set<string>() };
  usedTls = false;
  private socket!: Socket | TLSSocket;
  private reader!: SocketReader;
  private nextLocalId = 1;
  private streams = new Map<number, AdbStream>();
  private pendingOpens = new Map<number, { resolve: (s: AdbStream) => void; reject: (e: Error) => void; stream: AdbStream }>();
  private closedError?: Error;
  private closeListeners: ((e: Error) => void)[] = [];

  private constructor() {}

  static async connect(opts: ConnectOptions): Promise<AdbConnection> {
    const c = new AdbConnection();
    await c.handshake(opts);
    void c.readLoop();
    return c;
  }

  get features() {
    return this.banner.features;
  }

  onClose(fn: (e: Error) => void) {
    this.closeListeners.push(fn);
  }

  /** @internal */ send(m: AdbMessage) {
    if (this.closedError) throw this.closedError;
    this.socket.write(encodeMessage(m));
  }

  private async readMessage(): Promise<AdbMessage> {
    const h = decodeHeader(await this.reader.readExact(HEADER_SIZE));
    const payload = h.length ? await this.reader.readExact(h.length) : Buffer.alloc(0);
    return { command: h.command, arg0: h.arg0, arg1: h.arg1, payload };
  }

  private async handshake(opts: ConnectOptions) {
    const connectTimeout = opts.connectTimeoutMs ?? 10_000;
    const raw = netConnect({ host: opts.host, port: opts.port });
    raw.setNoDelay(true);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", (e) => reject(new AdbError("CONNECT", `Cannot connect to ${opts.host}:${opts.port}: ${e.message}`)));
      }),
      connectTimeout,
      () => raw.destroy(),
      new AdbError("CONNECT", `Timed out connecting to ${opts.host}:${opts.port}`),
    );
    raw.on("error", () => undefined); // surfaced through the reader instead
    this.socket = raw;
    this.reader = new SocketReader(raw);
    this.send({ command: A_CNXN, arg0: A_VERSION, arg1: MAX_PAYLOAD, payload: Buffer.from(`host::features=${HOST_FEATURES.join(",")}`) });

    let signed = false;
    let sentPublicKey = false;
    const deadline = () => (sentPublicKey ? (opts.authTimeoutMs ?? 60_000) : connectTimeout);
    try {
      for (;;) {
        const m = await withTimeout(this.readMessage(), deadline(), () => raw.destroy(), sentPublicKey ? new AdbError("AUTH_TIMEOUT", "Timed out waiting for the debugging prompt to be accepted on the phone") : new AdbError("TIMEOUT", "Device did not answer the ADB handshake"));
        if (m.command === A_CNXN) {
          this.banner = parseBanner(m.payload);
          this.maxPayload = Math.min(m.arg1 || MAX_PAYLOAD, MAX_PAYLOAD);
          return;
        }
        if (m.command === A_STLS) {
          await this.upgradeTls(opts);
          continue;
        }
        if (m.command === A_AUTH && m.arg0 === AUTH_TOKEN) {
          if (!signed) {
            signed = true;
            this.send({ command: A_AUTH, arg0: AUTH_SIGNATURE, arg1: 0, payload: opts.key.signToken(m.payload) });
          } else if (!sentPublicKey) {
            sentPublicKey = true;
            this.send({ command: A_AUTH, arg0: AUTH_RSAPUBLICKEY, arg1: 0, payload: Buffer.from(`${opts.key.publicKeyString}\0`) });
            opts.onAuthPrompt?.();
          } else throw new AdbError("AUTH_REJECTED", "The phone rejected this computer's key");
          continue;
        }
        throw new AdbError("PROTOCOL", `Unexpected ${commandName(m.command)} during handshake`);
      }
    } catch (e) {
      this.socket.destroy();
      if (e instanceof AdbError) throw e;
      if (this.usedTls) throw new AdbError("TLS_REJECTED", "The phone closed the TLS connection. Pair this computer first (tethertrace pair).");
      throw new AdbError("PROTOCOL", (e as Error).message);
    }
  }

  private async upgradeTls(opts: ConnectOptions) {
    this.send({ command: A_STLS, arg0: A_STLS_VERSION, arg1: 0, payload: Buffer.alloc(0) });
    // adbd sends nothing between STLS and the TLS handshake, so nothing may be buffered here.
    if (this.reader.detach().length) throw new AdbError("PROTOCOL", "Unexpected data before TLS upgrade");
    const tls = tlsConnect({
      socket: this.socket as Socket,
      key: opts.key.keyPem,
      cert: opts.key.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // adbd authenticates *us* by the key we paired; its own cert is self-signed.
      rejectUnauthorized: false,
    });
    this.usedTls = true;
    await new Promise<void>((resolve, reject) => {
      tls.once("secureConnect", resolve);
      tls.once("error", (e) => reject(new AdbError("TLS_REJECTED", `TLS handshake failed: ${e.message}. Pair this computer first (tethertrace pair).`)));
    });
    tls.on("error", () => undefined);
    this.socket = tls;
    this.reader = new SocketReader(tls);
  }

  private async readLoop() {
    try {
      for (;;) this.dispatch(await this.readMessage());
    } catch (e) {
      this.shutdown(e instanceof AdbError ? e : new AdbError("CLOSED", (e as Error).message));
    }
  }

  private dispatch(m: AdbMessage) {
    switch (m.command) {
      case A_OKAY: {
        const pending = this.pendingOpens.get(m.arg1);
        if (pending) {
          this.pendingOpens.delete(m.arg1);
          pending.stream.remoteId = m.arg0;
          this.streams.set(m.arg1, pending.stream);
          pending.resolve(pending.stream);
        } else this.streams.get(m.arg1)?.acked();
        return;
      }
      case A_WRTE: {
        const s = this.streams.get(m.arg1);
        if (!s) return;
        this.send({ command: A_OKAY, arg0: s.localId, arg1: s.remoteId, payload: Buffer.alloc(0) });
        s.push(m.payload);
        return;
      }
      case A_CLSE: {
        const pending = this.pendingOpens.get(m.arg1);
        if (pending) {
          this.pendingOpens.delete(m.arg1);
          pending.reject(new AdbError("STREAM_REFUSED", `Device refused service "${pending.stream.service.split(":")[0]}"`));
          return;
        }
        const s = this.streams.get(m.arg1);
        if (s) {
          this.streams.delete(m.arg1);
          s.markClosed();
        }
        return;
      }
      default:
        // Ignore anything else (e.g. a late CNXN) rather than killing the connection.
        return;
    }
  }

  async open(service: string, timeoutMs = 10_000): Promise<AdbStream> {
    const id = this.nextLocalId++;
    const stream = new AdbStream(this, id, service);
    const opened = new Promise<AdbStream>((resolve, reject) => this.pendingOpens.set(id, { resolve, reject, stream }));
    this.send({ command: A_OPEN, arg0: id, arg1: 0, payload: Buffer.from(`${service}\0`) });
    return withTimeout(opened, timeoutMs, () => this.pendingOpens.delete(id), new AdbError("TIMEOUT", `Device did not open "${service.split(":")[0]}"`));
  }

  /** Run a shell command and collect its output (uses shell_v2 for a real exit code when available). */
  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    if (!this.features.has("shell_v2")) {
      const s = await this.open(`shell:${command}`);
      const stdout = await withTimeout(s.readAll(), timeoutMs, () => s.close(), new AdbError("TIMEOUT", "Shell command timed out"));
      return { stdout, stderr: Buffer.alloc(0), exitCode: null };
    }
    const s = await this.open(`shell,v2,raw:${command}`);
    const run = async (): Promise<ExecResult> => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let exitCode: number | null = null;
      let buf = Buffer.alloc(0);
      for (let c = await s.read(); c; c = await s.read()) {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 5) {
          const id = buf[0]!;
          const len = buf.readUInt32LE(1);
          if (buf.length < 5 + len) break;
          const data = buf.subarray(5, 5 + len);
          buf = buf.subarray(5 + len);
          if (id === 1) out.push(data);
          else if (id === 2) err.push(data);
          else if (id === 3) exitCode = data[0] ?? null;
        }
        if (exitCode !== null) break;
      }
      s.close();
      return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode };
    };
    return withTimeout(run(), timeoutMs, () => s.close(), new AdbError("TIMEOUT", "Shell command timed out"));
  }

  close() {
    this.shutdown(new AdbError("CLOSED", "Connection closed"));
  }

  private shutdown(e: Error) {
    if (this.closedError) return;
    this.closedError = e;
    this.socket.destroy();
    for (const s of this.streams.values()) s.markClosed(e);
    for (const p of this.pendingOpens.values()) p.reject(e);
    this.streams.clear();
    this.pendingOpens.clear();
    for (const fn of this.closeListeners) fn(e);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void, err: Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        onTimeout();
        reject(err);
      }, ms);
    }),
  ]);
}
