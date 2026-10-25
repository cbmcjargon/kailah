// Client for Ledger's legacy btchip protocol (CLA 0xE0) — the Litecoin app,
// built only from LedgerHQ/app-bitcoin-legacy. docs/hardware-signing.md §2.
//
// Native segwit (BIP143) signing with TRUSTED inputs, as Ledger's reference
// client does for app ≥ 1.4: every previous transaction is streamed to the
// device, which answers with an authenticated "trusted input" carrying the
// outpoint and amount it read itself (so the fee it shows cannot be spoofed).
//
//   1. GET_TRUSTED_INPUT (0x42) per input
//   2. HASH_INPUT_START (0x44, P2=0x02): every input, empty scripts
//   3. HASH_INPUT_FINALIZE_FULL (0x4A): change path (P1=0xFF), then the
//      serialized outputs in 50-byte chunks — the device shows them here
//   4. per input: HASH_INPUT_START (P2=0x80) with that one input and its
//      p2pkh scriptCode, then HASH_SIGN (0x48)

import { createBase58check } from '@scure/base'
import { ripemd160 } from '@noble/hashes/legacy'
import { sha256 } from '@noble/hashes/sha2'
import { concat, equalBytes, pathBytes, readU32le, readU64le, readVarint, txidBytes, u32be, u32le, u64le, varint } from './bytes'
import { sendApdu, type LedgerTransport } from './transport'
import type { InputSignature, SignRequest } from '../types'

const CLA = 0xe0
const INS = {
  GET_WALLET_PUBLIC_KEY: 0x40,
  GET_TRUSTED_INPUT: 0x42,
  HASH_INPUT_START: 0x44,
  HASH_SIGN: 0x48,
  HASH_INPUT_FINALIZE_FULL: 0x4a,
}
const MAX_SCRIPT_BLOCK = 50
const TRUSTED_INPUT_LEN = 56
const SIGHASH_ALL = 0x01
const XPUB_VERSION = 0x0488b21e

const base58check = createBase58check(sha256)
const hash160 = (b: Uint8Array) => ripemd160(sha256(b))

/** 65-byte uncompressed point → 33-byte compressed. */
export function compressPublicKey(pub: Uint8Array): Uint8Array {
  if (pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03)) return pub
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Bad public key from Ledger')
  return concat([pub[64]! & 1 ? 0x03 : 0x02], pub.subarray(1, 33))
}

interface LegacyTxParts {
  version: Uint8Array
  inputs: { prevout: Uint8Array; script: Uint8Array; sequence: Uint8Array }[]
  outputs: { amount: Uint8Array; script: Uint8Array }[]
  lockTime: Uint8Array
}

/** Parse a witness-free serialization into the pieces the device streams. */
export function parseLegacyTx(raw: Uint8Array): LegacyTxParts {
  const bad = () => new Error('Unreadable funding transaction')
  let off = 0
  const take = (n: number) => {
    if (off + n > raw.length) throw bad()
    const out = raw.subarray(off, off + n)
    off += n
    return out
  }
  const vi = () => {
    const [v, n] = readVarint(raw, off)
    off += n
    return v
  }
  const version = take(4)
  if (raw[off] === 0x00) throw bad() // segwit marker: callers must strip witnesses
  const nIn = vi()
  const inputs = []
  for (let i = 0; i < nIn; i++) {
    const prevout = take(36)
    const script = take(vi())
    inputs.push({ prevout, script, sequence: take(4) })
  }
  const nOut = vi()
  const outputs = []
  for (let i = 0; i < nOut; i++) {
    const amount = take(8)
    outputs.push({ amount, script: take(vi()) })
  }
  const lockTime = take(4)
  if (off !== raw.length) throw bad()
  return { version, inputs, outputs, lockTime }
}

/** Script chunks of ≤ 50 bytes with the sequence appended to the last (alone if empty). */
function scriptBlocks(script: Uint8Array, sequence: Uint8Array): Uint8Array[] {
  if (script.length === 0) return [sequence]
  const blocks: Uint8Array[] = []
  for (let off = 0; off < script.length; off += MAX_SCRIPT_BLOCK) {
    const end = Math.min(off + MAX_SCRIPT_BLOCK, script.length)
    blocks.push(end === script.length ? concat(script.subarray(off, end), sequence) : script.subarray(off, end))
  }
  return blocks
}

export class LedgerLegacyApp {
  constructor(private readonly t: LedgerTransport) {}

  private async send(ins: number, p1: number, p2: number, data: Uint8Array): Promise<Uint8Array> {
    return (await sendApdu(this.t, CLA, ins, p1, p2, data)).data
  }

  /** P2: 0 legacy, 1 p2sh-segwit, 2 bech32. Returns the compressed key too. */
  async getWalletPublicKey(
    path: number[],
    opts: { display?: boolean; format?: 0 | 1 | 2 } = {},
  ): Promise<{ publicKey: Uint8Array; address: string; chainCode: Uint8Array }> {
    const r = await this.send(INS.GET_WALLET_PUBLIC_KEY, opts.display ? 1 : 0, opts.format ?? 0, pathBytes(path))
    const pkLen = r[0]
    if (pkLen === undefined || r.length < 1 + pkLen + 1) throw new Error('Bad public key reply from Ledger')
    const publicKey = compressPublicKey(r.subarray(1, 1 + pkLen))
    const aLen = r[1 + pkLen]!
    const aOff = 2 + pkLen
    if (r.length < aOff + aLen + 32) throw new Error('Bad public key reply from Ledger')
    const address = new TextDecoder().decode(r.subarray(aOff, aOff + aLen))
    const chainCode = r.slice(aOff + aLen, aOff + aLen + 32)
    return { publicKey, address, chainCode }
  }

  /**
   * Account xpub (standard 0488b21e bytes) assembled from two public-key
   * replies: the parent's key for the fingerprint, the account's key + chain code.
   */
  async getAccountXpub(accountPath: number[]): Promise<string> {
    if (accountPath.length === 0) throw new Error('Account path required')
    const parent = await this.getWalletPublicKey(accountPath.slice(0, -1))
    const account = await this.getWalletPublicKey(accountPath)
    const payload = concat(
      u32be(XPUB_VERSION),
      [accountPath.length],
      hash160(parent.publicKey).subarray(0, 4),
      u32be(accountPath[accountPath.length - 1]!),
      account.chainCode,
      account.publicKey,
    )
    return base58check.encode(payload)
  }

  /** Stream a previous transaction; returns the device's 56-byte trusted input. */
  async getTrustedInput(prevTx: Uint8Array, vout: number): Promise<Uint8Array> {
    const tx = parseLegacyTx(prevTx)
    const go = (first: boolean, data: Uint8Array) => this.send(INS.GET_TRUSTED_INPUT, first ? 0x00 : 0x80, 0x00, data)
    await go(true, concat(u32be(vout), tx.version, varint(tx.inputs.length)))
    for (const inp of tx.inputs) {
      await go(false, concat(inp.prevout, varint(inp.script.length)))
      for (const b of scriptBlocks(inp.script, inp.sequence)) await go(false, b)
    }
    await go(false, varint(tx.outputs.length))
    for (const o of tx.outputs) {
      const data = concat(o.amount, varint(o.script.length), o.script)
      if (data.length > 255) throw new Error('A funding transaction has an output too large for the Ledger app.')
      await go(false, data)
    }
    let res: Uint8Array = new Uint8Array(0)
    for (const b of scriptBlocks(tx.lockTime, new Uint8Array(0))) res = await go(false, b)
    if (res.length !== TRUSTED_INPUT_LEN) throw new Error('Bad trusted input from Ledger')
    return res
  }

  private async hashInputStart(
    newTransaction: boolean,
    version: number,
    inputs: { trusted: Uint8Array; script: Uint8Array; sequence: number }[],
  ): Promise<void> {
    const p2 = newTransaction ? 0x02 : 0x80
    const go = (first: boolean, data: Uint8Array) => this.send(INS.HASH_INPUT_START, first ? 0x00 : 0x80, p2, data)
    await go(true, concat(u32le(version), varint(inputs.length)))
    for (const inp of inputs) {
      await go(false, concat([0x01, inp.trusted.length], inp.trusted, varint(inp.script.length)))
      for (const b of scriptBlocks(inp.script, u32le(inp.sequence))) await go(false, b)
    }
  }

  /**
   * Sign every input of a native-segwit spend. `onConfirm` fires just before
   * the outputs are sent — that is when the device asks the user.
   */
  async signSegwit(req: SignRequest, onConfirm?: () => void): Promise<InputSignature[]> {
    const trusted: Uint8Array[] = []
    for (const inp of req.inputs) {
      const ti = await this.getTrustedInput(inp.prevTx, inp.vout)
      // The device read this outpoint and amount from the streamed bytes; they
      // must be the coin we planned to spend.
      if (
        !equalBytes(ti.subarray(4, 36), txidBytes(inp.txid)) ||
        readU32le(ti, 36) !== inp.vout ||
        readU64le(ti, 40) !== inp.value
      ) {
        throw new Error('Your Ledger read a different coin than planned — nothing was signed.')
      }
      trusted.push(ti)
    }

    await this.hashInputStart(
      true,
      req.version,
      req.inputs.map((inp, i) => ({ trusted: trusted[i]!, script: new Uint8Array(0), sequence: inp.sequence })),
    )

    const change = req.outputs.find((o) => o.change !== null)?.change
    if (change) await this.send(INS.HASH_INPUT_FINALIZE_FULL, 0xff, 0x00, pathBytes(change.path))
    const outs = concat(
      varint(req.outputs.length),
      ...req.outputs.map((o) => concat(u64le(o.amount), varint(o.script.length), o.script)),
    )
    onConfirm?.()
    for (let off = 0; off < outs.length; off += MAX_SCRIPT_BLOCK) {
      const end = Math.min(off + MAX_SCRIPT_BLOCK, outs.length)
      await this.send(INS.HASH_INPUT_FINALIZE_FULL, end === outs.length ? 0x80 : 0x00, 0x00, outs.subarray(off, end))
    }

    const sigs: InputSignature[] = []
    for (let i = 0; i < req.inputs.length; i++) {
      const inp = req.inputs[i]!
      const scriptCode = concat([0x76, 0xa9, 0x14], hash160(inp.publicKey), [0x88, 0xac])
      await this.hashInputStart(false, req.version, [{ trusted: trusted[i]!, script: scriptCode, sequence: inp.sequence }])
      const r = await this.send(
        INS.HASH_SIGN,
        0x00,
        0x00,
        concat(pathBytes(inp.path), [0x00], u32be(req.lockTime), [SIGHASH_ALL]),
      )
      if (r.length < 9) throw new Error('Bad signature reply from Ledger')
      const signature = r.slice()
      signature[0] = 0x30 // the first byte carries the R parity flag (0x31); DER needs 0x30
      sigs.push({ index: i, publicKey: inp.publicKey, signature })
    }
    return sigs
  }
}
