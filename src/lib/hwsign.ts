// Hardware signing glue: UnsignedTx → device request → verified BuiltTx.
// Design: docs/hardware-signing.md §6 and §8.
//
// Only signatures come back from a device. Every one is checked here against
// the BIP143 digest THIS wallet computes over the exact transaction it is
// about to broadcast, with the public key derived from the account xpub — so
// a device (or anything in between) that signed something other than the
// reviewed transaction is refused, never broadcast.

import { HDKey } from '@scure/bip32'
import { Address, OutScript, Transaction, p2pkh, p2wpkh } from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { assertBumpRules, verifiedPrevout } from './txbuild'
import type {
  AddressApi,
  BuiltTx,
  ChainConfig,
  HardwareAccountKeys,
  InputSignature,
  SignRequest,
  UnsignedTx,
} from './types'

const FROM_RAW_OPTS = {
  allowUnknownOutputs: true,
  allowUnknownInputs: true,
  disableScriptCheck: true,
} as const

const SIGHASH_ALL = 0x01

/** Shown whenever a device's answer doesn't match what was reviewed. */
export const SIGNATURE_MISMATCH =
  "Your Ledger's signature doesn't match this transaction — nothing was sent."

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}

/** txid (display hex) of a witness-free serialization */
function legacyTxid(raw: Uint8Array): string {
  return bytesToHex(sha256(sha256(raw)).reverse())
}

/**
 * The funding transaction of every input, witness-stripped (what devices
 * hash), bound to its txid, and required to pay exactly the planned value to
 * the planned address. `known` reuses hex already fetched (the bump flow).
 */
export async function fetchPrevTxs(
  chain: ChainConfig,
  client: Pick<AddressApi, 'getRawTxHex'>,
  unsigned: UnsignedTx,
  known?: Map<string, string>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  // the provider's original hex per txid (witnesses included): several inputs
  // often spend one funding tx, and the stripped copy can't be re-parsed as a
  // final transaction
  const rawById = new Map<string, string>()
  for (const inp of unsigned.inputs) {
    let hex = rawById.get(inp.txid)
    if (hex === undefined) {
      hex = known?.get(inp.txid) ?? (await client.getRawTxHex(inp.txid))
      let tx: Transaction
      try {
        tx = Transaction.fromRaw(hexToBytes(hex), FROM_RAW_OPTS)
      } catch {
        throw new Error(`The ${chain.name} provider returned unreadable data for coin ${inp.txid}:${inp.vout}.`)
      }
      const stripped = tx.toBytes(true, false)
      if (tx.id !== inp.txid || legacyTxid(stripped) !== inp.txid) {
        throw new Error(
          `The ${chain.name} provider returned the wrong transaction for coin ${inp.txid}:${inp.vout} — refusing to sign.`,
        )
      }
      rawById.set(inp.txid, hex)
      out.set(inp.txid, stripped)
    }
    const prev = verifiedPrevout(chain, inp.txid, hex, inp.vout)
    if (prev.address !== inp.address || prev.value !== inp.value) {
      throw new Error(
        `Coin ${inp.txid}:${inp.vout} isn't what the scan reported (${chain.name} provider data disagrees) — refusing to sign.`,
      )
    }
  }
  return out
}

function hexFingerprint(hex: string | null): Uint8Array | null {
  return hex === null ? null : hexToBytes(hex)
}

/** The vendor-neutral request a device signs, built from the reviewed object. */
export function buildSignRequest(
  unsigned: UnsignedTx,
  account: HardwareAccountKeys,
  prevTxs: Map<string, Uint8Array>,
): SignRequest {
  const { chain } = unsigned
  if (account.chain !== chain.id) throw new Error('Internal error: account/chain mismatch.')
  const base = account.accountPathIndices
  return {
    chain,
    version: unsigned.version,
    lockTime: unsigned.lockTime,
    account: {
      path: base,
      xpub: account.record.xpub,
      masterFingerprint: hexFingerprint(account.record.masterFingerprint),
    },
    inputs: unsigned.inputs.map((inp) => {
      const prevTx = prevTxs.get(inp.txid)
      if (prevTx === undefined) throw new Error(`Missing funding transaction for ${inp.txid}.`)
      const key = account.address(inp.branch, inp.index)
      if (!sameBytes(key.publicKey, inp.publicKey)) throw new Error('Internal error: input key mismatch.')
      return {
        txid: inp.txid,
        vout: inp.vout,
        sequence: unsigned.sequence,
        value: inp.value,
        script: p2wpkh(inp.publicKey, chain.network).script,
        publicKey: inp.publicKey,
        path: [...base, inp.branch, inp.index],
        prevTx,
      }
    }),
    outputs: unsigned.outputs.map((o) => {
      if (o.change !== null) {
        const key = account.address(o.change.branch, o.change.index)
        if (!sameBytes(key.publicKey, o.change.publicKey) || key.address !== o.address) {
          throw new Error('Internal error: change key mismatch.')
        }
      }
      return {
        address: o.address,
        amount: o.amount,
        script: OutScript.encode(Address(chain.network).decode(o.address)),
        change:
          o.change === null
            ? null
            : { publicKey: o.change.publicKey, path: [...base, o.change.branch, o.change.index] },
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Signatures: strict DER (BIP66), low-S, verified against our own digest.

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function bytesToBig(b: Uint8Array): bigint {
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}

function bigTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Parse a strict DER ECDSA signature (no sighash byte) into r, s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const bad = () => new Error('malformed DER signature')
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw bad()
  const readInt = (off: number): { v: bigint; next: number } => {
    if (der[off] !== 0x02) throw bad()
    const len = der[off + 1]!
    if (len === 0 || len > 33 || off + 2 + len > der.length) throw bad()
    const body = der.subarray(off + 2, off + 2 + len)
    if (body[0]! & 0x80) throw bad() // negative
    if (len > 1 && body[0] === 0x00 && !(body[1]! & 0x80)) throw bad() // padded
    return { v: bytesToBig(body), next: off + 2 + len }
  }
  const r = readInt(2)
  const s = readInt(r.next)
  if (s.next !== der.length) throw bad()
  if (r.v <= 0n || r.v >= N || s.v <= 0n || s.v >= N) throw bad()
  return { r: r.v, s: s.v }
}

function encodeDerInt(v: bigint): Uint8Array {
  let b = bigTo32(v)
  let i = 0
  while (i < 31 && b[i] === 0) i++
  b = b.subarray(i)
  if (b[0]! & 0x80) {
    const p = new Uint8Array(b.length + 1)
    p.set(b, 1)
    b = p
  }
  const out = new Uint8Array(2 + b.length)
  out[0] = 0x02
  out[1] = b.length
  out.set(b, 2)
  return out
}

export function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const ri = encodeDerInt(r)
  const si = encodeDerInt(s)
  const out = new Uint8Array(2 + ri.length + si.length)
  out[0] = 0x30
  out[1] = ri.length + si.length
  out.set(ri, 2)
  out.set(si, 2 + ri.length)
  return out
}

/**
 * Check one device signature (DER || sighash) for `digest` under `publicKey`
 * and return its canonical low-S DER form with the sighash byte. Throws
 * SIGNATURE_MISMATCH on anything else.
 */
export function canonicalVerifiedSignature(
  sigWithHashType: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  if (sigWithHashType.length < 9 || sigWithHashType[sigWithHashType.length - 1] !== SIGHASH_ALL) {
    throw new Error(SIGNATURE_MISMATCH)
  }
  let r: bigint
  let s: bigint
  try {
    ;({ r, s } = parseDerSignature(sigWithHashType.subarray(0, -1)))
  } catch {
    throw new Error(SIGNATURE_MISMATCH)
  }
  // ECDSA malleability: (r, n−s) is the same signature; relay policy wants low S.
  if (s > N / 2n) s = N - s
  const compact = new Uint8Array(64)
  compact.set(bigTo32(r), 0)
  compact.set(bigTo32(s), 32)
  let ok = false
  try {
    ok = new HDKey({ publicKey }).verify(digest, compact)
  } catch {
    ok = false
  }
  if (!ok) throw new Error(SIGNATURE_MISMATCH)
  const der = encodeDerSignature(r, s)
  const out = new Uint8Array(der.length + 1)
  out.set(der, 0)
  out[der.length] = SIGHASH_ALL
  return out
}

/** Why a pending transaction can't be sped up: it isn't this wallet's. */
export const NOT_OURS =
  "This transaction wasn't signed by this wallet, so it can't be sped up from here."

/**
 * Prove a pending transaction is ours before rebuilding it: every input's
 * witness must be exactly [signature, our public key] and the signature
 * must verify against the wallet's own BIP143 digest for that input. The
 * data service chooses which transaction it shows as pending and can forge
 * its bytes; it cannot forge our signatures (audit 2026-10-26, C1).
 */
export function assertSignedByUs(
  chain: ChainConfig,
  rawTxHex: string,
  inputs: { publicKey: Uint8Array; value: bigint }[],
): void {
  if (chain.addressType !== 'p2wpkh') throw new Error(NOT_OURS)
  let tx: Transaction
  try {
    tx = Transaction.fromRaw(hexToBytes(rawTxHex), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
      disableScriptCheck: true,
    })
  } catch {
    throw new Error(NOT_OURS)
  }
  if (tx.inputsLength !== inputs.length) throw new Error(NOT_OURS)
  inputs.forEach((inp, i) => {
    const w = tx.getInput(i).finalScriptWitness
    const pub = w?.[1]
    if (
      w === undefined ||
      w.length !== 2 ||
      pub === undefined ||
      pub.length !== inp.publicKey.length ||
      !pub.every((b, j) => b === inp.publicKey[j])
    ) {
      throw new Error(NOT_OURS)
    }
    const digest = tx.preimageWitnessV0(i, p2pkh(inp.publicKey).script, SIGHASH_ALL, inp.value)
    try {
      canonicalVerifiedSignature(w[0]!, digest, inp.publicKey)
    } catch {
      throw new Error(NOT_OURS)
    }
  })
}

/** The unsigned btc-signer transaction for a plan — same construction as buildTxV2's segwit branch. */
export function unsignedTransaction(unsigned: UnsignedTx): Transaction {
  const { chain } = unsigned
  const tx = new Transaction({ version: unsigned.version, lockTime: unsigned.lockTime })
  for (const inp of unsigned.inputs) {
    tx.addInput({
      txid: inp.txid,
      index: inp.vout,
      sequence: unsigned.sequence,
      witnessUtxo: { script: p2wpkh(inp.publicKey, chain.network).script, amount: inp.value },
    })
  }
  for (const o of unsigned.outputs) tx.addOutputAddress(o.address, o.amount, chain.network)
  return tx
}

/** BIP143 digest every input's signature must commit to (SIGHASH_ALL). */
export function inputDigests(unsigned: UnsignedTx): Uint8Array[] {
  const tx = unsignedTransaction(unsigned)
  return unsigned.inputs.map((inp, i) =>
    tx.preimageWitnessV0(i, p2pkh(inp.publicKey).script, SIGHASH_ALL, inp.value),
  )
}

/**
 * Assemble the broadcast transaction from a device's signatures. Exactly one
 * verified signature per input, from the planned key; outputs and fee must
 * still be exactly the reviewed ones; bumps re-check BIP125 on the real size.
 */
export function assembleSigned(unsigned: UnsignedTx, sigs: InputSignature[]): BuiltTx {
  const { chain } = unsigned
  const digests = inputDigests(unsigned)
  const tx = unsignedTransaction(unsigned)

  const seen = new Set<number>()
  for (const s of sigs) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= unsigned.inputs.length || seen.has(s.index)) {
      throw new Error(SIGNATURE_MISMATCH)
    }
    seen.add(s.index)
  }
  unsigned.inputs.forEach((inp, i) => {
    const s = sigs.find((x) => x.index === i)
    if (s === undefined || !sameBytes(s.publicKey, inp.publicKey)) throw new Error(SIGNATURE_MISMATCH)
    const sig = canonicalVerifiedSignature(s.signature, digests[i]!, inp.publicKey)
    tx.updateInput(i, { partialSig: [[inp.publicKey, sig]] })
  })
  tx.finalize()

  // The bytes about to be broadcast must be exactly the reviewed spend.
  if (tx.outputsLength !== unsigned.outputs.length || tx.inputsLength !== unsigned.inputs.length) {
    throw new Error(SIGNATURE_MISMATCH)
  }
  unsigned.outputs.forEach((o, i) => {
    const got = tx.getOutput(i)
    const want = OutScript.encode(Address(chain.network).decode(o.address))
    if (got.amount !== o.amount || got.script === undefined || !sameBytes(got.script, want)) {
      throw new Error(SIGNATURE_MISMATCH)
    }
  })
  const actualFee = tx.fee
  if (actualFee !== unsigned.fee) {
    throw new Error(`Internal error: fee mismatch (charged ${unsigned.fee}, transaction pays ${actualFee}).`)
  }
  if (unsigned.bump !== undefined) {
    assertBumpRules(chain, unsigned.bump.original, unsigned.bump.conflictExtraFees, actualFee, tx.vsize)
  }
  return {
    hex: tx.hex,
    txid: tx.id,
    amount: unsigned.amount,
    fee: actualFee,
    change: unsigned.change,
    toAddress: unsigned.toAddress,
    vbytes: tx.vsize,
  }
}
