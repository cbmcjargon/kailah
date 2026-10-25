// Client for Ledger's Bitcoin app ≥ 2.1.0 ("Bitcoin" / "Bitcoin Test"), the
// PSBT-based protocol (CLA 0xE1, protocol version 1). docs/hardware-signing.md §2.
//
// The device never receives the PSBT in one piece: it gets merkle commitments
// to the PSBTv2 key/value maps and pulls what it needs through "client
// commands" (status 0xE000), each answered with CONTINUE (F8 01 00 01):
//   GET_PREIMAGE 0x40, GET_MERKLE_LEAF_PROOF 0x41, GET_MERKLE_LEAF_INDEX 0x42,
//   GET_MORE_ELEMENTS 0xA0, YIELD 0x10 (signatures arrive this way).
// Byte rules follow LedgerHQ/app-bitcoin-new doc/{bitcoin,merkle,wallet}.md
// and Ledger's reference client where the docs are silent.

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { concat, readVarint, txidBytes, u32le, u64le, varint, u32be } from './bytes'
import { LedgerStatusError, encodeApdu, type LedgerTransport } from './transport'
import { formatPath } from '../hwaccount'
import type { InputSignature, SignRequest } from '../types'

const CLA_BTC = 0xe1
const CLA_FRAMEWORK = 0xf8
const PROTOCOL_VERSION = 1
const INS = { GET_EXTENDED_PUBKEY: 0x00, GET_WALLET_ADDRESS: 0x03, SIGN_PSBT: 0x04, GET_MASTER_FINGERPRINT: 0x05 }
const INS_CONTINUE = 0x01
const SW_OK = 0x9000
const SW_INTERRUPTED = 0xe000

// ---------------------------------------------------------------------------
// Merkle tree (doc/merkle.md): leaf = sha256(0x00 || data), node =
// sha256(0x01 || left || right); the left subtree holds the largest power of
// two strictly below n; the empty tree's root is 32 zero bytes.

export const leafHash = (data: Uint8Array): Uint8Array => sha256(concat([0x00], data))
const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concat([0x01], l, r))

function splitPoint(n: number): number {
  let p = 1
  while (p * 2 < n) p *= 2
  return p
}

export class MerkleTree {
  private readonly memo = new Map<string, Uint8Array>()
  readonly root: Uint8Array

  /** `leaves` are leaf HASHES (already leafHash'ed). */
  constructor(readonly leaves: Uint8Array[]) {
    this.root = leaves.length === 0 ? new Uint8Array(32) : this.rootOf(0, leaves.length)
  }

  get size(): number {
    return this.leaves.length
  }

  private rootOf(lo: number, hi: number): Uint8Array {
    if (hi - lo === 1) return this.leaves[lo]!
    const key = `${lo}:${hi}`
    const hit = this.memo.get(key)
    if (hit) return hit
    const mid = lo + splitPoint(hi - lo)
    const h = nodeHash(this.rootOf(lo, mid), this.rootOf(mid, hi))
    this.memo.set(key, h)
    return h
  }

  /** Sibling hashes from the leaf up to (excluding) the root. */
  proof(index: number): Uint8Array[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) throw new Error('leaf index out of range')
    const walk = (lo: number, hi: number): Uint8Array[] => {
      if (hi - lo === 1) return []
      const mid = lo + splitPoint(hi - lo)
      return index < mid ? [...walk(lo, mid), this.rootOf(mid, hi)] : [...walk(mid, hi), this.rootOf(lo, mid)]
    }
    return walk(0, this.leaves.length)
  }
}

// ---------------------------------------------------------------------------
// Merkleized map: keys sorted bytewise, commitment = varint(n) || keysRoot || valuesRoot

const hexCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export class MerkleMap {
  readonly keys: Uint8Array[]
  readonly values: Uint8Array[]
  readonly commitment: Uint8Array

  /** `entries`: hex(keytype || keydata) → value */
  constructor(entries: Map<string, Uint8Array>) {
    const sorted = [...entries.keys()].sort(hexCompare)
    this.keys = sorted.map((k) => Uint8Array.from(k.match(/../g)!.map((h) => Number.parseInt(h, 16))))
    this.values = sorted.map((k) => entries.get(k)!)
    const keysRoot = new MerkleTree(this.keys.map(leafHash)).root
    const valuesRoot = new MerkleTree(this.values.map(leafHash)).root
    this.commitment = concat(varint(this.keys.length), keysRoot, valuesRoot)
  }
}

// ---------------------------------------------------------------------------
// Client-command interpreter (the host side of every interruption)

const CMD = { YIELD: 0x10, GET_PREIMAGE: 0x40, GET_MERKLE_LEAF_PROOF: 0x41, GET_MERKLE_LEAF_INDEX: 0x42, GET_MORE_ELEMENTS: 0xa0 }

export class ClientCommandInterpreter {
  private readonly preimages = new Map<string, Uint8Array>()
  private readonly trees = new Map<string, MerkleTree>()
  private queue: Uint8Array[] = []
  readonly yielded: Uint8Array[] = []

  addPreimage(p: Uint8Array): void {
    this.preimages.set(bytesToHex(sha256(p)), p)
  }

  /** Register a list: each element's leaf preimage (0x00 || e) and the tree. */
  addList(elements: Uint8Array[]): MerkleTree {
    for (const e of elements) this.addPreimage(concat([0x00], e))
    const tree = new MerkleTree(elements.map(leafHash))
    this.trees.set(bytesToHex(tree.root), tree)
    return tree
  }

  addMap(map: MerkleMap): void {
    this.addList(map.keys)
    this.addList(map.values)
  }

  execute(request: Uint8Array): Uint8Array {
    if (request.length === 0) throw new Error('Empty request from Ledger')
    const body = request.subarray(1)
    switch (request[0]) {
      case CMD.YIELD:
        this.yielded.push(body.slice())
        return new Uint8Array(0)
      case CMD.GET_PREIMAGE: {
        if (body.length !== 33 || body[0] !== 0) throw new Error('Bad GET_PREIMAGE request')
        const p = this.preimages.get(bytesToHex(body.subarray(1)))
        if (!p) throw new Error('Ledger asked for unknown data')
        const len = varint(p.length)
        const take = Math.min(255 - len.length - 1, p.length)
        for (let i = take; i < p.length; i++) this.queue.push(p.subarray(i, i + 1))
        return concat(len, [take], p.subarray(0, take))
      }
      case CMD.GET_MERKLE_LEAF_PROOF: {
        if (body.length < 34) throw new Error('Bad GET_MERKLE_LEAF_PROOF request')
        const tree = this.trees.get(bytesToHex(body.subarray(0, 32)))
        let off = 32
        const [size, a] = readVarint(body, off)
        off += a
        const [index] = readVarint(body, off)
        if (!tree || tree.size !== size || index >= size) throw new Error('Ledger asked for an unknown proof')
        if (this.queue.length > 0) throw new Error('Ledger protocol out of order')
        const proof = tree.proof(index)
        const first = Math.min(Math.floor((255 - 32 - 1 - 1) / 32), proof.length)
        this.queue.push(...proof.slice(first))
        return concat(tree.leaves[index]!, [proof.length], [first], ...proof.slice(0, first))
      }
      case CMD.GET_MERKLE_LEAF_INDEX: {
        if (body.length !== 64) throw new Error('Bad GET_MERKLE_LEAF_INDEX request')
        const tree = this.trees.get(bytesToHex(body.subarray(0, 32)))
        if (!tree) throw new Error('Ledger asked for an unknown tree')
        const want = bytesToHex(body.subarray(32))
        const i = tree.leaves.findIndex((l) => bytesToHex(l) === want)
        return i < 0 ? Uint8Array.of(0, 0) : concat([1], varint(i))
      }
      case CMD.GET_MORE_ELEMENTS: {
        if (body.length !== 0 || this.queue.length === 0) throw new Error('Bad GET_MORE_ELEMENTS request')
        const size = this.queue[0]!.length
        if (this.queue.some((e) => e.length !== size)) throw new Error('Ledger protocol out of order')
        const n = Math.min(Math.floor(253 / size), this.queue.length)
        const out = this.queue.slice(0, n)
        this.queue = this.queue.slice(n)
        return concat([n], [size], ...out)
      }
      default:
        throw new Error(`Unknown request 0x${request[0]!.toString(16)} from Ledger`)
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet policy (doc/wallet.md, BIP-388). Default single-sig native segwit:
// template "wpkh(@0/**)", one key "[fingerprint/84'/coin'/account']xpub",
// empty name, no registration (HMAC = 32 zero bytes).

const ascii = (s: string) => new TextEncoder().encode(s)

export class WalletPolicy {
  constructor(
    readonly name: string,
    readonly template: string,
    readonly keys: string[],
  ) {}

  static defaultWpkh(masterFingerprint: Uint8Array, accountPath: number[], xpub: string): WalletPolicy {
    return new WalletPolicy('', 'wpkh(@0/**)', [`[${bytesToHex(masterFingerprint)}/${formatPath(accountPath)}]${xpub}`])
  }

  serialize(): Uint8Array {
    const keysRoot = new MerkleTree(this.keys.map((k) => leafHash(ascii(k)))).root
    const name = ascii(this.name)
    const template = ascii(this.template)
    return concat([0x02], [name.length], name, varint(template.length), sha256(template), varint(this.keys.length), keysRoot)
  }

  id(): Uint8Array {
    return sha256(this.serialize())
  }

  register(cci: ClientCommandInterpreter): void {
    cci.addList(this.keys.map(ascii))
    cci.addPreimage(this.serialize())
    cci.addPreimage(ascii(this.template))
  }
}

// ---------------------------------------------------------------------------
// PSBTv2 key/value maps (BIP-370) for a SignRequest. Keys are hex of
// keytype || keydata (no length prefix), the form merkleization uses.

const PSBT_GLOBAL = { TX_VERSION: 0x02, FALLBACK_LOCKTIME: 0x03, INPUT_COUNT: 0x04, OUTPUT_COUNT: 0x05, VERSION: 0xfb }
const PSBT_IN = { NON_WITNESS_UTXO: 0x00, WITNESS_UTXO: 0x01, BIP32_DERIVATION: 0x06, PREVIOUS_TXID: 0x0e, OUTPUT_INDEX: 0x0f, SEQUENCE: 0x10 }
const PSBT_OUT = { BIP32_DERIVATION: 0x02, AMOUNT: 0x03, SCRIPT: 0x04 }

export interface PsbtMaps {
  global: Map<string, Uint8Array>
  inputs: Map<string, Uint8Array>[]
  outputs: Map<string, Uint8Array>[]
}

const key = (type: number, data: Uint8Array = new Uint8Array(0)) => bytesToHex(concat([type], data))

function derivationValue(fingerprint: Uint8Array, path: number[]): Uint8Array {
  return concat(fingerprint, ...path.map(u32le))
}

export function psbtV2Maps(req: SignRequest): PsbtMaps {
  const fp = req.account.masterFingerprint
  if (fp === null || fp.length !== 4) throw new Error('The Bitcoin app needs the master fingerprint.')
  const global = new Map<string, Uint8Array>()
  global.set(key(PSBT_GLOBAL.TX_VERSION), u32le(req.version))
  if (req.lockTime !== 0) global.set(key(PSBT_GLOBAL.FALLBACK_LOCKTIME), u32le(req.lockTime))
  global.set(key(PSBT_GLOBAL.INPUT_COUNT), varint(req.inputs.length))
  global.set(key(PSBT_GLOBAL.OUTPUT_COUNT), varint(req.outputs.length))
  global.set(key(PSBT_GLOBAL.VERSION), u32le(2))

  const inputs = req.inputs.map((inp) => {
    const m = new Map<string, Uint8Array>()
    // Full previous tx too, as Ledger's own client does: the device checks the
    // amount against it (segwit fee attack) instead of trusting witness_utxo.
    m.set(key(PSBT_IN.NON_WITNESS_UTXO), inp.prevTx)
    m.set(key(PSBT_IN.WITNESS_UTXO), concat(u64le(inp.value), varint(inp.script.length), inp.script))
    m.set(key(PSBT_IN.BIP32_DERIVATION, inp.publicKey), derivationValue(fp, inp.path))
    m.set(key(PSBT_IN.PREVIOUS_TXID), txidBytes(inp.txid))
    m.set(key(PSBT_IN.OUTPUT_INDEX), u32le(inp.vout))
    m.set(key(PSBT_IN.SEQUENCE), u32le(inp.sequence))
    return m
  })
  const outputs = req.outputs.map((o) => {
    const m = new Map<string, Uint8Array>()
    m.set(key(PSBT_OUT.AMOUNT), u64le(o.amount))
    m.set(key(PSBT_OUT.SCRIPT), o.script)
    if (o.change !== null) m.set(key(PSBT_OUT.BIP32_DERIVATION, o.change.publicKey), derivationValue(fp, o.change.path))
    return m
  })
  return { global, inputs, outputs }
}

/** Standard PSBT serialization of the maps (for export and for the offline suite). */
export function serializePsbt(maps: PsbtMaps): Uint8Array {
  const one = (m: Map<string, Uint8Array>): Uint8Array[] => {
    const parts: Uint8Array[] = []
    for (const k of [...m.keys()].sort(hexCompare)) {
      const kb = Uint8Array.from(k.match(/../g)!.map((h) => Number.parseInt(h, 16)))
      const v = m.get(k)!
      parts.push(varint(kb.length), kb, varint(v.length), v)
    }
    parts.push(Uint8Array.of(0))
    return parts
  }
  return concat(
    [0x70, 0x73, 0x62, 0x74, 0xff],
    ...one(maps.global),
    ...maps.inputs.flatMap(one),
    ...maps.outputs.flatMap(one),
  )
}

// ---------------------------------------------------------------------------
// The app client

export class LedgerBtcApp {
  constructor(private readonly t: LedgerTransport) {}

  private async request(ins: number, data: Uint8Array, cci?: ClientCommandInterpreter): Promise<Uint8Array> {
    let reply = await this.t.exchange(encodeApdu(CLA_BTC, ins, 0x00, PROTOCOL_VERSION, data))
    for (;;) {
      if (reply.length < 2) throw new Error('Short reply from Ledger')
      const sw = (reply[reply.length - 2]! << 8) | reply[reply.length - 1]!
      if (sw === SW_OK) return reply.slice(0, -2)
      if (sw !== SW_INTERRUPTED) throw new LedgerStatusError(sw)
      if (!cci) throw new Error('Unexpected interruption from Ledger')
      const answer = cci.execute(reply.subarray(0, -2))
      reply = await this.t.exchange(encodeApdu(CLA_FRAMEWORK, INS_CONTINUE, 0x00, PROTOCOL_VERSION, answer))
    }
  }

  async getMasterFingerprint(): Promise<Uint8Array> {
    const fp = await this.request(INS.GET_MASTER_FINGERPRINT, new Uint8Array(0))
    if (fp.length !== 4) throw new Error('Bad fingerprint reply from Ledger')
    return fp
  }

  async getExtendedPubkey(path: number[], display = false): Promise<string> {
    if (path.length > 8) throw new Error('path too deep')
    const data = concat([display ? 1 : 0], [path.length], ...path.map(u32be))
    return new TextDecoder().decode(await this.request(INS.GET_EXTENDED_PUBKEY, data))
  }

  async getWalletAddress(policy: WalletPolicy, change: 0 | 1, index: number, display: boolean): Promise<string> {
    const cci = new ClientCommandInterpreter()
    policy.register(cci)
    const data = concat([display ? 1 : 0], policy.id(), new Uint8Array(32), [change], u32be(index))
    return new TextDecoder().decode(await this.request(INS.GET_WALLET_ADDRESS, data, cci))
  }

  /** Sign every input; returns the device's per-input signatures (DER || sighash). */
  async signPsbt(req: SignRequest, policy: WalletPolicy): Promise<InputSignature[]> {
    const maps = psbtV2Maps(req)
    const globalMap = new MerkleMap(maps.global)
    const inputMaps = maps.inputs.map((m) => new MerkleMap(m))
    const outputMaps = maps.outputs.map((m) => new MerkleMap(m))

    const cci = new ClientCommandInterpreter()
    policy.register(cci)
    cci.addMap(globalMap)
    for (const m of inputMaps) cci.addMap(m)
    for (const m of outputMaps) cci.addMap(m)
    const inputsRoot = cci.addList(inputMaps.map((m) => m.commitment)).root
    const outputsRoot = cci.addList(outputMaps.map((m) => m.commitment)).root

    const data = concat(
      globalMap.commitment,
      varint(req.inputs.length),
      inputsRoot,
      varint(req.outputs.length),
      outputsRoot,
      policy.id(),
      new Uint8Array(32),
    )
    await this.request(INS.SIGN_PSBT, data, cci)

    const sigs: InputSignature[] = []
    for (const y of cci.yielded) {
      const [index, used] = readVarint(y, 0)
      // Values above 65535 are MuSig2 tags (doc/bitcoin.md) — never expected
      // for a single-key policy, so a device sending one is refused.
      if (index > 0xffff) throw new Error('Unexpected MuSig2 data from Ledger')
      const pkLen = y[used]
      if (pkLen === undefined || y.length < used + 1 + pkLen + 9) throw new Error('Bad signature reply from Ledger')
      sigs.push({
        index,
        publicKey: y.slice(used + 1, used + 1 + pkLen),
        signature: y.slice(used + 1 + pkLen),
      })
    }
    return sigs
  }
}
