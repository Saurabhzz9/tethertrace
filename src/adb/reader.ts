import type { Duplex } from "node:stream";

/** Pull-style reader over a socket: `await readExact(n)` returns exactly n bytes or throws on close. */
export class SocketReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter?: () => void;
  private closedError?: Error;
  private readonly onData = (chunk: Buffer) => {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.wake();
  };
  private readonly onEnd = () => this.fail(new Error("Connection closed by device"));
  private readonly onError = (e: Error) => this.fail(e);

  constructor(private readonly socket: Duplex) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  get pending() {
    return this.buffered;
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.buffered < n) {
      if (this.closedError) throw this.closedError;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  /**
   * Stop consuming the socket (used before a TLS upgrade takes it over).
   * Returns bytes that were already buffered but not read, so the caller can hand them on.
   */
  detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
    this.socket.pause();
    const rest = Buffer.concat(this.chunks);
    this.chunks = [];
    this.buffered = 0;
    return rest;
  }

  private fail(e: Error) {
    this.closedError ??= e;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}
