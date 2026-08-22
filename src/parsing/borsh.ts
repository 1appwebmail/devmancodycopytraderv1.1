import { PublicKey } from "@solana/web3.js";

// Minimal borsh reader covering only the field types that appear in the
// pump.fun / PumpSwap event structs (see idl/pump.json, idl/pump_amm.json).
export class BorshReader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  private take(n: number): Buffer {
    const slice = this.buf.subarray(this.offset, this.offset + n);
    if (slice.length < n) throw new Error(`borsh: buffer underrun at offset ${this.offset}, wanted ${n} bytes`);
    this.offset += n;
    return slice;
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }
  u16(): number {
    return this.take(2).readUInt16LE(0);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  i128(): bigint {
    const b = this.take(16);
    const lo = b.readBigUInt64LE(0);
    const hi = b.readBigInt64LE(8);
    return (hi << 64n) | lo;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  pubkey(): string {
    return new PublicKey(this.take(32)).toBase58();
  }
  string(): string {
    const len = this.u32();
    return this.take(len).toString("utf8");
  }
  vec<T>(readOne: () => T): T[] {
    const len = this.u32();
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(readOne());
    return out;
  }
  remaining(): number {
    return this.buf.length - this.offset;
  }
}

export type FieldType =
  | "u8" | "u16" | "u32" | "u64" | "i64" | "i128" | "bool" | "pubkey" | "string" | "shareholderVec";

export type Schema = readonly (readonly [string, FieldType])[];

// Fields not needed downstream are still listed here (with `_` prefix in call
// sites if unused) because borsh is a sequential format: every field must be
// read in order even if we only care about a few of them.
function readField(r: BorshReader, type: FieldType): unknown {
  switch (type) {
    case "u8": return r.u8();
    case "u16": return r.u16();
    case "u32": return r.u32();
    case "u64": return r.u64();
    case "i64": return r.i64();
    case "i128": return r.i128();
    case "bool": return r.bool();
    case "pubkey": return r.pubkey();
    case "string": return r.string();
    case "shareholderVec":
      return r.vec(() => ({ address: r.pubkey(), share_bps: r.u16() }));
  }
}

export function decodeStruct<T extends Record<string, unknown>>(buf: Buffer, schema: Schema): T {
  const r = new BorshReader(buf);
  const out: Record<string, unknown> = {};
  for (const [name, type] of schema) {
    out[name] = readField(r, type);
  }
  return out as T;
}
