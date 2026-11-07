import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Tiny mDNS browser for Android wireless debugging services — replaces `adb mdns services`.
 * Sends one-shot (legacy unicast) PTR queries on every IPv4 interface and collects replies.
 */

export const SERVICE_CONNECT = "_adb-tls-connect._tcp.local";
export const SERVICE_PAIRING = "_adb-tls-pairing._tcp.local";

export interface DiscoveredService {
  /** Instance name, e.g. "adb-1A2B3C4D-xYz12" or a QR pairing name. */
  name: string;
  service: string;
  host: string;
  port: number;
}

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

function encodeName(name: string) {
  const parts = name.split(".").filter(Boolean).map((l) => {
    const b = Buffer.from(l, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

export function buildQuery(services: string[]) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(services.length, 4);
  const qs = services.map((s) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE_PTR, 0);
    tail.writeUInt16BE(0x8001, 2); // class IN with the "unicast response" bit
    return Buffer.concat([encodeName(s), tail]);
  });
  return Buffer.concat([header, ...qs]);
}

function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let jumped = false;
  let next = offset;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[offset];
    if (len === undefined) throw new Error("truncated name");
    if (len === 0) {
      if (!jumped) next = offset + 1;
      return [labels.join("."), next];
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) next = offset + 2;
      offset = ((len & 0x3f) << 8) | buf.readUInt8(offset + 1);
      jumped = true;
      continue;
    }
    labels.push(buf.toString("utf8", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  throw new Error("name too long");
}

export interface DnsRecord {
  name: string;
  type: number;
  data: string | { port: number; target: string };
}

export function parseResponse(buf: Buffer): DnsRecord[] {
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  const out: DnsRecord[] = [];
  for (let i = 0; i < total; i++) {
    const [name, o] = readName(buf, off);
    const type = buf.readUInt16BE(o);
    const rdlen = buf.readUInt16BE(o + 8);
    const rd = o + 10;
    if (type === TYPE_PTR) out.push({ name, type, data: readName(buf, rd)[0] });
    else if (type === TYPE_SRV) out.push({ name, type, data: { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6)[0] } });
    else if (type === TYPE_A && rdlen === 4) out.push({ name, type, data: [...buf.subarray(rd, rd + 4)].join(".") });
    off = rd + rdlen;
  }
  return out;
}

export function servicesFromRecords(records: DnsRecord[], fallbackHost?: string): DiscoveredService[] {
  const lc = (s: string) => s.toLowerCase();
  const srv = new Map<string, { port: number; target: string }>();
  const addr = new Map<string, string>();
  for (const r of records) {
    if (r.type === TYPE_SRV && typeof r.data === "object") srv.set(lc(r.name), r.data);
    if (r.type === TYPE_A && typeof r.data === "string") addr.set(lc(r.name), r.data);
  }
  const found: DiscoveredService[] = [];
  for (const r of records) {
    if (r.type !== TYPE_PTR || typeof r.data !== "string") continue;
    const service = [SERVICE_CONNECT, SERVICE_PAIRING].find((s) => lc(r.name) === s);
    if (!service) continue;
    const s = srv.get(lc(r.data));
    const host = s ? (addr.get(lc(s.target)) ?? fallbackHost) : undefined;
    if (!s || !host) continue;
    found.push({ name: r.data.slice(0, -(service.length + 1)), service, host, port: s.port });
  }
  return found;
}

/** Browse for wireless-debugging services for `timeoutMs`, returning de-duplicated results. */
export async function discover(opts: { timeoutMs?: number; services?: string[] } = {}): Promise<DiscoveredService[]> {
  const services = opts.services ?? [SERVICE_CONNECT, SERVICE_PAIRING];
  const query = buildQuery(services);
  const results = new Map<string, DiscoveredService>();
  const sockets: Socket[] = [];
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
  await Promise.all(
    addrs.map(
      (address) =>
        new Promise<void>((resolve) => {
          const sock = createSocket({ type: "udp4", reuseAddr: true });
          sockets.push(sock);
          sock.on("error", () => resolve());
          sock.on("message", (msg, rinfo) => {
            try {
              for (const s of servicesFromRecords(parseResponse(msg), rinfo.address)) results.set(`${s.service}|${s.name}|${s.host}|${s.port}`, s);
            } catch {
              /* ignore malformed packets */
            }
          });
          sock.bind(0, address, () => {
            try {
              sock.setMulticastInterface(address);
              sock.send(query, 5353, "224.0.0.251");
              // mDNS is lossy over Wi-Fi; ask once more shortly after.
              setTimeout(() => sock.send(query, 5353, "224.0.0.251", () => undefined), 700).unref();
            } catch {
              /* interface without multicast */
            }
            resolve();
          });
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 3000));
  for (const s of sockets) s.close();
  return [...results.values()];
}
