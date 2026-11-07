import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash, randomBytes } from "node:crypto";

/**
 * SPAKE2 over edwards25519, byte-compatible with BoringSSL's spake25519.c, which is what
 * adbd uses for "Pair device with pairing code".
 *
 * Notable BoringSSL quirks reproduced here:
 *  - the private scalar is multiplied by the cofactor (8) and used unreduced;
 *  - the password scalar has multiples of l added until it is divisible by 8;
 *  - M and N are not in the prime-order subgroup, so scalar multiplication is done
 *    over the full 256-bit scalar instead of modulo l.
 */

type Point = InstanceType<typeof ed25519.Point>;
const Point = ed25519.Point;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

// sha256-iterated points from "edwards25519 point generation seed (M|N)"; verified in tests.
const M = Point.fromHex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
const N = Point.fromHex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");

function leToBig(b: Uint8Array) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

/** Variable-time double-and-add over the full scalar (no reduction mod l). */
function mulFull(p: Point, k: bigint): Point {
  let acc = Point.ZERO;
  for (let i = BigInt(k.toString(2).length - 1); i >= 0n; i--) {
    acc = acc.double();
    if ((k >> i) & 1n) acc = acc.add(p);
  }
  return acc;
}

function lengthPrefixed(h: ReturnType<typeof createHash>, data: Uint8Array) {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(data.length));
  h.update(len).update(data);
}

export type Spake2Role = "alice" | "bob";

export class Spake2 {
  readonly message: Buffer;
  private readonly privateScalar: bigint;
  private readonly passwordScalar: bigint;
  private readonly passwordHash: Buffer;
  private done = false;

  constructor(
    private readonly role: Spake2Role,
    password: Uint8Array,
    private readonly myName: Uint8Array,
    private readonly theirName: Uint8Array,
    randomSource: (n: number) => Uint8Array = randomBytes,
  ) {
    this.privateScalar = (leToBig(randomSource(64)) % L) * 8n;
    this.passwordHash = createHash("sha512").update(password).digest();
    let s = leToBig(this.passwordHash) % L;
    if (s & 1n) s += L;
    if (s & 2n) s += 2n * L;
    if (s & 4n) s += 4n * L;
    this.passwordScalar = s;
    const P = mulFull(Point.BASE, this.privateScalar);
    const mask = mulFull(role === "alice" ? M : N, this.passwordScalar);
    this.message = Buffer.from(P.add(mask).toBytes());
  }

  /** Process the peer's 32-byte message and return the 64-byte shared key. */
  finish(theirMessage: Uint8Array): Buffer {
    if (this.done) throw new Error("SPAKE2 context already used");
    this.done = true;
    if (theirMessage.length !== 32) throw new Error("Invalid SPAKE2 message length");
    const qStar = Point.fromBytes(theirMessage);
    const peersMask = mulFull(this.role === "alice" ? N : M, this.passwordScalar);
    const q = qStar.add(peersMask.negate());
    const dh = mulFull(q, this.privateScalar).toBytes();
    const h = createHash("sha512");
    if (this.role === "alice") {
      lengthPrefixed(h, this.myName);
      lengthPrefixed(h, this.theirName);
      lengthPrefixed(h, this.message);
      lengthPrefixed(h, theirMessage);
    } else {
      lengthPrefixed(h, this.theirName);
      lengthPrefixed(h, this.myName);
      lengthPrefixed(h, theirMessage);
      lengthPrefixed(h, this.message);
    }
    lengthPrefixed(h, dh);
    lengthPrefixed(h, this.passwordHash);
    return h.digest();
  }
}

export const SPAKE2_POINTS = { M, N };
