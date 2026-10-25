// Little byte helpers shared by the Ledger clients. Integers that are money
// (u64) stay bigint end to end.

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Bitcoin CompactSize. */
export function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad varint')
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  if (n <= 0xffffffff) return concat([0xfe], u32le(n))
  return concat([0xff], u64le(BigInt(n)))
}

/** Read a CompactSize at `off`; returns [value, bytes consumed]. */
export function readVarint(b: Uint8Array, off: number): [number, number] {
  const first = b[off]
  if (first === undefined) throw new Error('truncated varint')
  if (first < 0xfd) return [first, 1]
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
  if (off + 1 + width > b.length) throw new Error('truncated varint')
  let v = 0n
  for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + 1 + i]!)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint too large')
  return [Number(v), 1 + width]
}

export function u32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
}

export function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new Error('u64 out of range')
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export function readU32le(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0
}

export function readU64le(b: Uint8Array, off: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!)
  return v
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** BIP32 path as the legacy app wants it: count byte + 4-byte BE indices. */
export function pathBytes(path: number[]): Uint8Array {
  if (path.length > 10) throw new Error('path too deep')
  return concat([path.length], ...path.map(u32be))
}

/** Display txid (hex) → internal byte order. */
export function txidBytes(txid: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('bad txid')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[31 - i] = Number.parseInt(txid.slice(i * 2, i * 2 + 2), 16)
  return out
}
