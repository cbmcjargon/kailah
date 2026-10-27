// Transaction validation + construction for Kailah Wallet.
//
// Contract (types.ts):
//   isValidAddress(addr: string, chain: ChainConfig): boolean
//   buildTx(args: BuildTxArgs): BuiltTx — throws Error with user-readable message
//
// Coin selection: largest-first accumulation until inputs cover amount + fee,
// with the fee re-estimated as inputs are added. Change returns to the wallet's
// own address; sub-dust change is folded into the fee.

import { Address, OutScript, Transaction, p2wpkh } from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { formatCoin as fmtCoin } from './format'
import type {
  AccountState,
  AccountUtxo,
  BuildTxArgs,
  BuildTxArgsV2,
  BuiltTx,
  BumpArgs,
  ChainConfig,
  DerivedKey,
  PlannedInput,
  PlannedOutput,
  PrepareBumpArgs,
  PrepareTxArgsV2,
  PublicAddressKey,
  RawTxInfo,
  UnsignedTx,
  Utxo,
} from './types'

/** txid of a raw transaction: double-SHA256, byte-reversed, hex */
function txidOfRawTx(rawTxHex: string): string {
  return bytesToHex(sha256(sha256(hexToBytes(rawTxHex))).reverse())
}

// ---------------------------------------------------------------------------
// Address validation

/** script types acceptable as a destination, per chain family */
const BTC_DEST_TYPES = ['pkh', 'sh', 'wpkh', 'wsh', 'tr']
const DOGE_DEST_TYPES = ['pkh', 'sh']

export function isValidAddress(addr: string, chain: ChainConfig): boolean {
  let type: string
  try {
    type = Address(chain.network).decode(addr).type
  } catch {
    return false
  }
  const allowed = chain.id === 'doge' ? DOGE_DEST_TYPES : BTC_DEST_TYPES
  return allowed.includes(type)
}

/**
 * Dust is a property of the OUTPUT SCRIPT, not the chain: Bitcoin Core's
 * policy floor is 546 sat for p2pkh and 540 for p2sh, while chain.dustLimit
 * (294) is the p2wpkh figure. Sending 300 sat to a legacy address builds a
 * transaction every node rejects. DOGE's chain-wide limit dwarfs these, so
 * taking the larger of the two is right everywhere.
 */
const DUST_BY_SCRIPT: Record<string, bigint> = { pkh: 546n, sh: 540n, wpkh: 294n, wsh: 330n, tr: 330n }

function destinationDustLimit(chain: ChainConfig, address: string): bigint {
  let byScript = 0n
  try {
    byScript = DUST_BY_SCRIPT[Address(chain.network).decode(address).type] ?? 0n
  } catch {
    // invalid address: validation elsewhere rejects it; chain limit applies
  }
  return byScript > chain.dustLimit ? byScript : chain.dustLimit
}

// ---------------------------------------------------------------------------
// Size / fee estimation (virtual bytes; legacy chains: vbytes === bytes)

/** output size in vB by destination script type */
const OUTPUT_VSIZE: Record<string, number> = {
  wpkh: 31, // 8 amount + 1 len + 22 script
  pkh: 34, //  8 + 1 + 25
  sh: 32, //   8 + 1 + 23
  tr: 43, //   8 + 1 + 34
  wsh: 43, //  8 + 1 + 34
}

// Integer math in half-vbytes so the segwit 10.5 vB overhead stays exact.
const SEGWIT_OVERHEAD_2 = 21 // 10.5 vB
const LEGACY_OVERHEAD_2 = 20 // 10 B
const SEGWIT_INPUT_2 = 136 // 68 vB (p2wpkh)
const LEGACY_INPUT_2 = 296 // 148 B (p2pkh)

function estimateVbytes(segwit: boolean, nInputs: number, outputSizes: number[]): number {
  let half = (segwit ? SEGWIT_OVERHEAD_2 : LEGACY_OVERHEAD_2)
  half += nInputs * (segwit ? SEGWIT_INPUT_2 : LEGACY_INPUT_2)
  for (const s of outputSizes) half += 2 * s
  return Math.ceil(half / 2)
}

// (Amount formatting for error messages uses the shared formatCoin — see imports.)

// ---------------------------------------------------------------------------
// buildTx

export function buildTx(args: BuildTxArgs): BuiltTx {
  const { chain, key, toAddress, feeRate, sendMax } = args

  if (!isValidAddress(toAddress, chain)) {
    throw new Error(`"${toAddress}" is not a valid ${chain.name} address.`)
  }
  const destType = Address(chain.network).decode(toAddress).type
  const destSize = OUTPUT_VSIZE[destType] ?? 43
  const segwit = chain.addressType === 'p2wpkh'
  const changeSize = segwit ? OUTPUT_VSIZE['wpkh']! : OUTPUT_VSIZE['pkh']!

  const feeFor = (nInputs: number, outputSizes: number[]): bigint =>
    BigInt(estimateVbytes(segwit, nInputs, outputSizes)) * feeRate

  const sorted = [...args.utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const totalAvailable = sorted.reduce((acc, u) => acc + u.value, 0n)

  let selected: Utxo[]
  let sendAmount: bigint
  let fee: bigint
  let change = 0n

  if (sendMax) {
    // Sweep: every utxo, single output, amount = total - fee.
    selected = sorted
    fee = feeFor(selected.length, [destSize])
    sendAmount = totalAvailable - fee
    if (selected.length === 0 || sendAmount <= destinationDustLimit(chain, args.toAddress)) {
      throw new Error(
        `Balance is too small to send: after the network fee of ${fmtCoin(fee, chain.decimals)} ` +
          `${chain.ticker}, the remainder would be below the dust limit.`,
      )
    }
  } else {
    const amount = args.amount
    const dust = destinationDustLimit(chain, args.toAddress)
    if (amount < dust) {
      throw new Error(
        `Amount is below the dust limit: the minimum you can send to that address is ` +
          `${fmtCoin(dust, chain.decimals)} ${chain.ticker} (${dust} ${chain.unitName}).`,
      )
    }

    // Largest-first selection; fee re-estimated as each input is added,
    // assuming a destination output plus a change output.
    selected = []
    let total = 0n
    let covered = false
    for (const u of sorted) {
      selected.push(u)
      total += u.value
      if (total >= amount + feeFor(selected.length, [destSize, changeSize])) {
        covered = true
        break
      }
    }

    if (covered) {
      const feeWithChange = feeFor(selected.length, [destSize, changeSize])
      change = total - amount - feeWithChange
      if (change < chain.dustLimit) {
        // Sub-dust change: fold it into the fee, drop the change output.
        fee = total - amount
        change = 0n
      } else {
        fee = feeWithChange
      }
      sendAmount = amount
    } else {
      // Could not cover amount + fee-with-change. A change-less tx needs less;
      // accept it (remainder folds into the fee), otherwise report the shortfall.
      const feeNoChange = feeFor(selected.length, [destSize])
      if (selected.length > 0 && total >= amount + feeNoChange) {
        fee = total - amount
        sendAmount = amount
      } else {
        const shortfall = amount + feeNoChange - total
        throw new Error(
          `Insufficient funds: you need ${fmtCoin(shortfall, chain.decimals)} ${chain.ticker} more ` +
            `to cover this amount plus the network fee.`,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // Construct, sign, finalize

  const sequence = chain.id === 'doge' ? 0xffffffff : 0xfffffffd // RBF on BTC chains
  const tx = new Transaction({ version: chain.txVersion })

  for (const u of selected) {
    if (chain.addressType === 'p2wpkh') {
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        sequence,
        witnessUtxo: { script: p2wpkh(key.publicKey, chain.network).script, amount: u.value },
      })
    } else {
      if (!u.rawTxHex) {
        throw new Error(
          `Cannot sign coin ${u.txid}:${u.vout}: the raw funding transaction is missing ` +
            `(required to sign ${chain.name} legacy inputs).`,
        )
      }
      // Fail fast if the API handed us hex for the wrong transaction —
      // btc-signer's addInput does not verify this, and a mismatch would
      // otherwise only surface as a rejected broadcast.
      if (txidOfRawTx(u.rawTxHex) !== u.txid) {
        throw new Error(
          `The ${chain.name} API returned mismatched transaction data for coin ` +
            `${u.txid}:${u.vout}. Try again in a moment.`,
        )
      }
      tx.addInput({ txid: u.txid, index: u.vout, sequence, nonWitnessUtxo: u.rawTxHex })
    }
  }

  tx.addOutputAddress(toAddress, sendAmount, chain.network)
  if (change > 0n) tx.addOutputAddress(key.address, change, chain.network)

  tx.sign(key.privateKey)
  tx.finalize()

  const actualFee = tx.fee // sum(inputs) - sum(outputs)
  if (actualFee !== fee) {
    throw new Error(`Internal error: fee mismatch (charged ${fee}, transaction pays ${actualFee}).`)
  }

  return {
    hex: tx.hex,
    txid: tx.id,
    amount: sendAmount,
    fee: actualFee,
    change,
    toAddress,
    vbytes: tx.vsize,
  }
}

// ---------------------------------------------------------------------------
// buildTxV2 — HD version of buildTx.
//
// Inputs are AccountUtxos, each signed with its OWN key (different addresses ⇒
// different keys), and change goes to a FRESH change address rather than an
// input address. Same largest-first coin selection, fee re-estimation and
// sub-dust change folding as buildTx. sendMax sweeps every utxo to toAddress.

/** Result of buildTxV2's coin selection, shared with the hardware path. */
interface CoinSelectionV2 {
  selected: AccountUtxo[]
  sendAmount: bigint
  fee: bigint
  change: bigint
  /** vsize contribution of the destination output */
  destSize: number
  /** vsize contribution of a change output */
  changeSize: number
}

/**
 * Validation + largest-first coin selection for buildTxV2 (and prepareTxV2,
 * so a hardware account selects exactly like a software one). Pure: no keys.
 */
function selectCoinsV2(
  args: Pick<BuildTxArgsV2, 'chain' | 'utxos' | 'toAddress' | 'amount' | 'feeRate' | 'sendMax'>,
): CoinSelectionV2 {
  const { chain, toAddress, feeRate, sendMax } = args

  if (!isValidAddress(toAddress, chain)) {
    throw new Error(`"${toAddress}" is not a valid ${chain.name} address.`)
  }
  const destType = Address(chain.network).decode(toAddress).type
  const destSize = OUTPUT_VSIZE[destType] ?? 43
  const segwit = chain.addressType === 'p2wpkh'
  const changeSize = segwit ? OUTPUT_VSIZE['wpkh']! : OUTPUT_VSIZE['pkh']!

  const feeFor = (nInputs: number, outputSizes: number[]): bigint =>
    BigInt(estimateVbytes(segwit, nInputs, outputSizes)) * feeRate

  const sorted = [...args.utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const totalAvailable = sorted.reduce((acc, u) => acc + u.value, 0n)

  let selected: AccountUtxo[]
  let sendAmount: bigint
  let fee: bigint
  let change = 0n

  if (sendMax) {
    selected = sorted
    fee = feeFor(selected.length, [destSize])
    sendAmount = totalAvailable - fee
    if (selected.length === 0 || sendAmount <= destinationDustLimit(chain, args.toAddress)) {
      throw new Error(
        `Balance is too small to send: after the network fee of ${fmtCoin(fee, chain.decimals)} ` +
          `${chain.ticker}, the remainder would be below the dust limit.`,
      )
    }
  } else {
    const amount = args.amount
    const dust = destinationDustLimit(chain, args.toAddress)
    if (amount < dust) {
      throw new Error(
        `Amount is below the dust limit: the minimum you can send to that address is ` +
          `${fmtCoin(dust, chain.decimals)} ${chain.ticker} (${dust} ${chain.unitName}).`,
      )
    }

    selected = []
    let total = 0n
    let covered = false
    for (const u of sorted) {
      selected.push(u)
      total += u.value
      if (total >= amount + feeFor(selected.length, [destSize, changeSize])) {
        covered = true
        break
      }
    }

    if (covered) {
      const feeWithChange = feeFor(selected.length, [destSize, changeSize])
      change = total - amount - feeWithChange
      if (change < chain.dustLimit) {
        fee = total - amount
        change = 0n
      } else {
        fee = feeWithChange
      }
      sendAmount = amount
    } else {
      const feeNoChange = feeFor(selected.length, [destSize])
      if (selected.length > 0 && total >= amount + feeNoChange) {
        fee = total - amount
        sendAmount = amount
      } else {
        const shortfall = amount + feeNoChange - total
        throw new Error(
          `Insufficient funds: you need ${fmtCoin(shortfall, chain.decimals)} ${chain.ticker} more ` +
            `to cover this amount plus the network fee.`,
        )
      }
    }
  }

  return { selected, sendAmount, fee, change, destSize, changeSize }
}

export function buildTxV2(args: BuildTxArgsV2): BuiltTx {
  const { chain, toAddress, changeAddress } = args
  const segwit = chain.addressType === 'p2wpkh'
  const { selected, sendAmount, fee, change } = selectCoinsV2(args)

  // Resolve the per-input signing keys once (each utxo may need a different key).
  const keys = selected.map((u) => args.keyFor(u))

  const sequence = chain.id === 'doge' ? 0xffffffff : 0xfffffffd // RBF on BTC/LTC
  const tx = new Transaction({ version: chain.txVersion })

  selected.forEach((u, i) => {
    const key = keys[i]!
    if (segwit) {
      // Real wrong-key guard: the script must be derived from the key, but the
      // key must actually own the utxo's on-chain address — otherwise the build
      // would "succeed" and every node would reject the broadcast.
      const derived = p2wpkh(key.publicKey, chain.network)
      if (derived.address !== u.address) {
        throw new Error(
          `Internal error: wrong key supplied for coin ${u.txid}:${u.vout} — refresh and try again.`,
        )
      }
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        sequence,
        witnessUtxo: { script: derived.script, amount: u.value },
      })
    } else {
      if (!u.rawTxHex) {
        throw new Error(
          `Cannot sign coin ${u.txid}:${u.vout}: the raw funding transaction is missing ` +
            `(required to sign ${chain.name} legacy inputs).`,
        )
      }
      if (txidOfRawTx(u.rawTxHex) !== u.txid) {
        throw new Error(
          `The ${chain.name} API returned mismatched transaction data for coin ` +
            `${u.txid}:${u.vout}. Try again in a moment.`,
        )
      }
      tx.addInput({ txid: u.txid, index: u.vout, sequence, nonWitnessUtxo: u.rawTxHex })
    }
  })

  tx.addOutputAddress(toAddress, sendAmount, chain.network)
  if (change > 0n) tx.addOutputAddress(changeAddress, change, chain.network)

  // Sign each input with its own key (tx.sign would use one key for all).
  selected.forEach((u, i) => {
    const signed = tx.signIdx(keys[i]!.privateKey, i)
    if (!signed) {
      throw new Error(`Could not sign coin ${u.txid}:${u.vout}: wrong key supplied for this input.`)
    }
  })
  tx.finalize()

  const actualFee = tx.fee
  if (actualFee !== fee) {
    throw new Error(`Internal error: fee mismatch (charged ${fee}, transaction pays ${actualFee}).`)
  }

  return {
    hex: tx.hex,
    txid: tx.id,
    amount: sendAmount,
    fee: actualFee,
    change,
    toAddress,
    vbytes: tx.vsize,
  }
}

// ---------------------------------------------------------------------------
// Raw-byte verification for RBF bumps. A bump re-pays the original recipients
// from scratch, so their addresses and values — and the original fee that
// anchors the BIP125 floor — must come from bytes that hash to the claimed
// txid, never from provider JSON a lying host could rewrite.

const FROM_RAW_OPTS = {
  allowUnknownOutputs: true,
  allowUnknownInputs: true,
  disableScriptCheck: true,
} as const

function outputAddress(chain: ChainConfig, script: Uint8Array): string | null {
  try {
    return Address(chain.network).encode(OutScript.decode(script))
  } catch {
    return null
  }
}

export interface DecodedOriginalTx {
  inputs: { prevTxid: string; prevVout: number }[]
  outputs: { address: string | null; value: bigint }[]
  rbfSignaled: boolean
}

/** Parse a transaction's raw bytes and bind them to the claimed txid. */
export function decodeVerifiedTx(
  chain: ChainConfig,
  claimedTxid: string,
  rawTxHex: string,
): DecodedOriginalTx {
  const BAD = 'The transaction data the provider returned does not match this transaction.'
  let tx: Transaction
  try {
    tx = Transaction.fromRaw(hexToBytes(rawTxHex), FROM_RAW_OPTS)
  } catch {
    throw new Error(BAD)
  }
  // Transaction.id strips witnesses, so this binding is correct on segwit too.
  if (tx.id !== claimedTxid) throw new Error(BAD)
  const inputs: DecodedOriginalTx['inputs'] = []
  let rbfSignaled = false
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    if (inp.txid === undefined || inp.index === undefined) throw new Error(BAD)
    if (typeof inp.sequence === 'number' && inp.sequence < 0xfffffffe) rbfSignaled = true
    inputs.push({
      // btc-signer keeps input txids in display order (its raw coder reverses on
      // the wire), so this is already the txid providers know — no reversal.
      prevTxid: bytesToHex(inp.txid),
      prevVout: inp.index,
    })
  }
  const outputs: DecodedOriginalTx['outputs'] = []
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i)
    if (o.amount === undefined || o.script === undefined) throw new Error(BAD)
    outputs.push({ address: outputAddress(chain, o.script), value: o.amount })
  }
  return { inputs, outputs, rbfSignaled }
}

/** Read output `vout` of a funding transaction, binding its bytes to prevTxid. */
export function verifiedPrevout(
  chain: ChainConfig,
  prevTxid: string,
  fundingRawHex: string,
  vout: number,
): { address: string | null; value: bigint } {
  const BAD = 'The funding transaction the provider returned does not match its id.'
  let tx: Transaction
  try {
    tx = Transaction.fromRaw(hexToBytes(fundingRawHex), FROM_RAW_OPTS)
  } catch {
    throw new Error(BAD)
  }
  if (tx.id !== prevTxid) throw new Error(BAD)
  if (vout >= tx.outputsLength) throw new Error(BAD)
  const o = tx.getOutput(vout)
  if (o.amount === undefined || o.script === undefined) throw new Error(BAD)
  return { address: outputAddress(chain, o.script), value: o.amount }
}

/**
 * Assemble the RawTxInfo a bump builds from entirely out of verified bytes:
 * outputs and outpoints from the transaction itself, input values/addresses
 * from each funding transaction, fee recomputed as inputs minus outputs.
 * height/time are display-only and may keep the provider's values.
 */
export function verifiedRawTxInfo(
  base: { txid: string; height: number | null; time: number | null },
  decoded: DecodedOriginalTx,
  prevoutFor: (prevTxid: string, vout: number) => { address: string | null; value: bigint },
): RawTxInfo {
  const inputs = decoded.inputs.map((inp) => {
    const prev = prevoutFor(inp.prevTxid, inp.prevVout)
    return { address: prev.address, value: prev.value, prevTxid: inp.prevTxid, prevVout: inp.prevVout }
  })
  const inTotal = inputs.reduce((s, i) => s + i.value, 0n)
  const outTotal = decoded.outputs.reduce((s, o) => s + o.value, 0n)
  const fee = inTotal - outTotal
  if (fee < 0n) {
    throw new Error('The verified transaction pays out more than it spends — refusing to use it.')
  }
  return {
    txid: base.txid,
    height: base.height,
    time: base.time,
    fee,
    inputs,
    outputs: decoded.outputs,
    rbfSignaled: decoded.rbfSignaled,
  }
}

// ---------------------------------------------------------------------------
// buildBump — BIP125 RBF replacement of a pending tx at a higher fee rate.
//
// Re-spends every original input, keeps the real recipient outputs at their
// original values, drops the original change, and recomputes change at the new
// rate. If the higher fee needs more than the recovered value, extra confirmed
// utxos are pulled in largest-first. The replacement must pay strictly more
// absolute fee AND a strictly higher fee rate than the original (rules 3 & 4).

interface BumpSpend<K extends { publicKey: Uint8Array }> {
  txid: string
  vout: number
  value: bigint
  key: K
  rawTxHex?: string
}

/** BumpArgs without the software key types, so the hardware path can plan too. */
interface BumpPlanArgs<K extends { publicKey: Uint8Array }> {
  chain: ChainConfig
  original: RawTxInfo
  ourAddresses: Set<string>
  keyFor: (address: string) => K | null
  originalUtxos: AccountUtxo[]
  extraUtxos: AccountUtxo[]
  extraKeyFor: (u: AccountUtxo) => K
  newFeeRate: bigint
  conflictExtraFees?: bigint
  absoluteFeeFloor?: bigint
}

interface BumpPlan<K extends { publicKey: Uint8Array }> {
  segwit: boolean
  sequence: number
  spends: BumpSpend<K>[]
  recipients: { address: string; value: bigint }[]
  recipientTotal: bigint
  fee: bigint
  change: bigint
  conflictExtra: bigint
}

/**
 * Coins a Speed up may add, from a FRESH scan: confirmed ones only (BIP125
 * rule 2: a replacement may not add unconfirmed inputs), never an output of
 * the transaction being replaced, and never a coin a pending transaction
 * already spends — a provider may still list it, and taking it would cancel
 * that payment (bug audit 2026-10-27, BH5).
 */
export function bumpExtraUtxos(state: Pick<AccountState, 'utxos' | 'rawTxs'>, replacing: string): AccountUtxo[] {
  const spentByPending = new Set(
    state.rawTxs.filter((r) => r.height === null).flatMap((r) => r.inputs.map((i) => `${i.prevTxid}:${i.prevVout}`)),
  )
  return state.utxos.filter(
    (u) => u.txid !== replacing && u.confirmed !== false && !spentByPending.has(`${u.txid}:${u.vout}`),
  )
}

/**
 * Selection half of buildBump (also used by prepareBump): resolves every
 * original input's key, keeps the recipients, pulls extra confirmed utxos
 * largest-first if needed, and settles fee/change against every BIP125 floor.
 */
function planBump<K extends { publicKey: Uint8Array }>(args: BumpPlanArgs<K>): BumpPlan<K> {
  const { chain, original, ourAddresses, keyFor, originalUtxos, extraUtxos, extraKeyFor, newFeeRate } = args

  const CANT = "This transaction can't be sped up."

  // Preconditions: must signal replaceability, and we need the original fee to
  // prove the replacement pays strictly more (BIP125 rule 3).
  if (!original.rbfSignaled) throw new Error(CANT)
  if (original.fee === null) throw new Error(CANT)

  const segwit = chain.addressType === 'p2wpkh'
  const sequence = chain.id === 'doge' ? 0xffffffff : 0xfffffffd

  // Every original output must be reconstructable from its address.
  for (const o of original.outputs) {
    if (o.address === null) throw new Error(CANT)
  }

  // Resolve every original input to a spendable entry with its signing key.
  const baseSpends: BumpSpend<K>[] = []
  for (const inp of original.inputs) {
    if (inp.address === null || inp.prevTxid === null || inp.prevVout === null) throw new Error(CANT)
    const key = keyFor(inp.address)
    if (!key) throw new Error(CANT)
    const spend: BumpSpend<K> = { txid: inp.prevTxid, vout: inp.prevVout, value: inp.value, key }
    if (!segwit) {
      const match = originalUtxos.find((u) => u.txid === inp.prevTxid && u.vout === inp.prevVout)
      if (!match || !match.rawTxHex) throw new Error(CANT)
      spend.rawTxHex = match.rawTxHex
    }
    baseSpends.push(spend)
  }

  // Recipients = every output that isn't one of our own addresses (the original
  // change output, which IS ours, is dropped). Kept at their original values.
  const recipients = original.outputs.filter(
    (o) => !ourAddresses.has(o.address as string),
  ) as { address: string; value: bigint }[]
  const recipientSizes = recipients.map(
    (r) => OUTPUT_VSIZE[Address(chain.network).decode(r.address).type] ?? 43,
  )
  const recipientTotal = recipients.reduce((s, r) => s + r.value, 0n)

  const changeSize = segwit ? OUTPUT_VSIZE['wpkh']! : OUTPUT_VSIZE['pkh']!
  const feeFor = (nInputs: number, outputSizes: number[]): bigint =>
    BigInt(estimateVbytes(segwit, nInputs, outputSizes)) * newFeeRate

  // BIP125 rule 3 floor: the replacement must outbid the WHOLE conflicting
  // set — the original's fee, plus any unconfirmed transactions that spend
  // its outputs (theirs die too), plus the incremental relay fee for the
  // replacement's own size. A node-reported floor (absoluteFeeFloor) from a
  // prior rejection overrides everything when higher.
  const origFee = original.fee
  const conflictExtra = args.conflictExtraFees ?? 0n
  const floorFor = (nInputs: number): bigint => {
    const ruleFloor = origFee + conflictExtra + BigInt(estimateVbytes(segwit, nInputs, [...recipientSizes, changeSize]))
    return (args.absoluteFeeFloor ?? 0n) > ruleFloor ? args.absoluteFeeFloor! : ruleFloor
  }

  // Selection: original inputs are mandatory; add extra utxos largest-first
  // only if the fee outruns the value we recovered from the original. The
  // fee to cover is the rate's or the floor's, whichever is higher, at the
  // size with the inputs so far (bug audit 2026-10-27, BM25: covering the
  // rate alone stopped short of the floor and reported "not enough funds"
  // with a spare coin left).
  const extraSorted = [...extraUtxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const spends: BumpSpend<K>[] = [...baseSpends]
  let total = baseSpends.reduce((s, sp) => s + sp.value, 0n)

  const withChangeFee = (): bigint => {
    const atRate = feeFor(spends.length, [...recipientSizes, changeSize])
    const floor = floorFor(spends.length)
    return atRate > floor ? atRate : floor
  }

  let covered = total >= recipientTotal + withChangeFee()
  if (!covered) {
    for (const u of extraSorted) {
      const key = extraKeyFor(u)
      const sp: BumpSpend<K> = { txid: u.txid, vout: u.vout, value: u.value, key }
      if (!segwit) {
        if (!u.rawTxHex) {
          throw new Error(
            `Cannot sign coin ${u.txid}:${u.vout}: the raw funding transaction is missing ` +
              `(required to sign ${chain.name} legacy inputs).`,
          )
        }
        sp.rawTxHex = u.rawTxHex
      }
      spends.push(sp)
      total += u.value
      if (total >= recipientTotal + withChangeFee()) {
        covered = true
        break
      }
    }
  }

  const feeFloor = floorFor(spends.length)

  let fee: bigint
  let change = 0n
  const NEED_MORE = "There aren't enough funds to speed up this transaction at that fee rate."
  if (covered) {
    const feeWithChange = withChangeFee()
    change = total - recipientTotal - feeWithChange
    if (change < chain.dustLimit) {
      fee = total - recipientTotal
      change = 0n
      if (fee < feeFloor) throw new Error(NEED_MORE)
    } else {
      fee = feeWithChange
    }
  } else {
    const feeNoChange = feeFor(spends.length, recipientSizes)
    if (total >= recipientTotal + feeNoChange && total - recipientTotal > 0n) {
      fee = total - recipientTotal
      change = 0n
      if (fee < feeFloor) throw new Error(NEED_MORE)
    } else {
      throw new Error(NEED_MORE)
    }
  }

  return { segwit, sequence, spends, recipients, recipientTotal, fee, change, conflictExtra }
}

/**
 * BIP125 rules 3 & 4 plus the fee-rate ceiling for a replacement paying
 * `fee` at `vsize`. buildBump runs it on the signed size; the hardware path
 * runs it before signing on the size upper bound and again on the real size.
 */
export function assertBumpRules(
  chain: ChainConfig,
  original: RawTxInfo,
  conflictExtra: bigint,
  fee: bigint,
  vsize: number,
): void {
  if (original.fee === null) throw new Error("This transaction can't be sped up.")
  const segwit = chain.addressType === 'p2wpkh'
  // BIP125 rule 3 — the replacement must pay not just a higher absolute fee but
  // at least the original fee PLUS the incremental relay fee (1 sat/vB default)
  // times the new size, or nodes reject it. Without this term a marginal bump
  // passes the wallet's check and fails at broadcast with a raw node error.
  const oldFee = original.fee + conflictExtra
  if (fee < oldFee + BigInt(vsize)) {
    throw new Error(
      'That fee is only slightly higher — pick a larger increase so the network accepts the replacement.',
    )
  }
  // BIP125 rule 4 — a strictly higher fee rate than the transaction it
  // directly replaces: the original's OWN rate. Outside spenders' fees count
  // toward the absolute fee above, not here; dividing them by the original's
  // size asked ~15x the needed rate once an input was added (bug audit
  // 2026-10-27, BM26). Compare without float division:
  // newFee/newVsize > origFee/origVsize ⇔ newFee*origVsize > origFee*newVsize.
  const oldOutSizes = original.outputs.map(
    (o) => OUTPUT_VSIZE[Address(chain.network).decode(o.address as string).type] ?? 43,
  )
  const oldVsize = estimateVbytes(segwit, original.inputs.length, oldOutSizes)
  if (fee * BigInt(oldVsize) <= original.fee * BigInt(vsize)) {
    throw new Error("The new fee rate isn't higher than the original — choose a higher fee rate.")
  }
  // Hard ceiling mirroring the fee-API clamp: no combination of floors (the
  // original fee, conflict fees, a node-reported floor) may push the
  // replacement past this rate — a lying source could otherwise burn funds.
  const MAX_BUMP_FEE_RATE = 2000n
  if (fee > MAX_BUMP_FEE_RATE * BigInt(vsize)) {
    throw new Error(
      'The required replacement fee is unreasonably high — refusing to build this transaction.',
    )
  }
}

export function buildBump(args: BumpArgs): BuiltTx {
  const { chain, original, changeAddress } = args
  const { segwit, sequence, spends, recipients, recipientTotal, fee, change, conflictExtra } =
    planBump<DerivedKey>(args)

  // Build, sign (each input with its own key), finalize.
  const tx = new Transaction({ version: chain.txVersion })
  for (const sp of spends) {
    if (segwit) {
      tx.addInput({
        txid: sp.txid,
        index: sp.vout,
        sequence,
        witnessUtxo: { script: p2wpkh(sp.key.publicKey, chain.network).script, amount: sp.value },
      })
    } else {
      if (!sp.rawTxHex) {
        throw new Error(`Cannot sign coin ${sp.txid}:${sp.vout}: the raw funding transaction is missing.`)
      }
      if (txidOfRawTx(sp.rawTxHex) !== sp.txid) {
        throw new Error(`Mismatched transaction data for coin ${sp.txid}:${sp.vout}.`)
      }
      tx.addInput({ txid: sp.txid, index: sp.vout, sequence, nonWitnessUtxo: sp.rawTxHex })
    }
  }
  for (const r of recipients) tx.addOutputAddress(r.address, r.value, chain.network)
  if (change > 0n) tx.addOutputAddress(changeAddress, change, chain.network)

  spends.forEach((sp, i) => {
    const signed = tx.signIdx(sp.key.privateKey, i)
    if (!signed) throw new Error(`Could not sign coin ${sp.txid}:${sp.vout} while rebuilding the transaction.`)
  })
  tx.finalize()

  const actualFee = tx.fee
  if (actualFee !== fee) {
    throw new Error(`Internal error: fee mismatch (charged ${fee}, transaction pays ${actualFee}).`)
  }

  const newVsize = tx.vsize
  assertBumpRules(chain, original, conflictExtra, actualFee, newVsize)

  return {
    hex: tx.hex,
    txid: tx.id,
    amount: recipientTotal,
    fee: actualFee,
    change,
    toAddress: recipients.length > 0 ? recipients[0]!.address : changeAddress,
    vbytes: newVsize,
  }
}

// ---------------------------------------------------------------------------
// Hardware path (docs/hardware-signing.md §6): the same selection as
// buildTxV2/buildBump, stopped before signing. The result carries public keys
// and account positions only; hwsign.ts turns it into a device request and
// assembles the device's signatures into the broadcast bytes.

const HW_ONLY_SEGWIT = (chain: ChainConfig) =>
  `${chain.name} can't be signed by a hardware wallet in this version (native segwit only).`

function checkPublicKey(chain: ChainConfig, key: PublicAddressKey, coin: string): void {
  if (p2wpkh(key.publicKey, chain.network).address !== key.address) {
    throw new Error(`Internal error: wrong key supplied for ${coin} — refresh and try again.`)
  }
}

function plannedChange(key: PublicAddressKey, amount: bigint): PlannedOutput {
  // Only a change-branch output is marked as change: the device re-derives it
  // from that path to hide it. Anything else stays a displayed payment.
  return {
    address: key.address,
    amount,
    change: key.branch === 1 ? { publicKey: key.publicKey, branch: key.branch, index: key.index } : null,
  }
}

function outputVsize(chain: ChainConfig, address: string): number {
  return OUTPUT_VSIZE[Address(chain.network).decode(address).type] ?? 43
}

function checkBalanced(inputs: PlannedInput[], outputs: PlannedOutput[], fee: bigint): void {
  const inTotal = inputs.reduce((s, i) => s + i.value, 0n)
  const outTotal = outputs.reduce((s, o) => s + o.amount, 0n)
  if (inTotal - outTotal !== fee) {
    throw new Error(`Internal error: fee mismatch (charged ${fee}, transaction pays ${inTotal - outTotal}).`)
  }
}

/** buildTxV2, unsigned: same validation, selection, fee and change. */
export function prepareTxV2(args: PrepareTxArgsV2): UnsignedTx {
  const { chain, toAddress, change: changeKey } = args
  if (chain.addressType !== 'p2wpkh') throw new Error(HW_ONLY_SEGWIT(chain))
  const { selected, sendAmount, fee, change } = selectCoinsV2(args)

  const inputs: PlannedInput[] = selected.map((u) => {
    const key = args.keyFor(u)
    checkPublicKey(chain, key, `coin ${u.txid}:${u.vout}`)
    if (key.address !== u.address || key.branch !== u.branch || key.index !== u.index) {
      throw new Error(
        `Internal error: wrong key supplied for coin ${u.txid}:${u.vout} — refresh and try again.`,
      )
    }
    return {
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      address: u.address,
      publicKey: key.publicKey,
      branch: u.branch,
      index: u.index,
    }
  })

  const outputs: PlannedOutput[] = [{ address: toAddress, amount: sendAmount, change: null }]
  if (change > 0n) {
    checkPublicKey(chain, changeKey, 'the change address')
    outputs.push(plannedChange(changeKey, change))
  }
  checkBalanced(inputs, outputs, fee)

  return {
    chain,
    version: chain.txVersion,
    lockTime: 0,
    sequence: chain.id === 'doge' ? 0xffffffff : 0xfffffffd,
    inputs,
    outputs,
    amount: sendAmount,
    fee,
    change,
    toAddress,
    vbytesEstimate: estimateVbytes(
      true,
      inputs.length,
      outputs.map((o) => outputVsize(chain, o.address)),
    ),
  }
}

/** buildBump, unsigned; BIP125 checks run on the size upper bound. */
export function prepareBump(args: PrepareBumpArgs): UnsignedTx {
  const { chain, original, change: changeKey } = args
  if (chain.addressType !== 'p2wpkh') throw new Error(HW_ONLY_SEGWIT(chain))
  const { sequence, spends, recipients, recipientTotal, fee, change, conflictExtra } =
    planBump<PublicAddressKey>(args)

  const inputs: PlannedInput[] = spends.map((sp) => {
    checkPublicKey(chain, sp.key, `coin ${sp.txid}:${sp.vout}`)
    return {
      txid: sp.txid,
      vout: sp.vout,
      value: sp.value,
      address: sp.key.address,
      publicKey: sp.key.publicKey,
      branch: sp.key.branch,
      index: sp.key.index,
    }
  })
  const outputs: PlannedOutput[] = recipients.map((r) => ({ address: r.address, amount: r.value, change: null }))
  if (change > 0n) {
    checkPublicKey(chain, changeKey, 'the change address')
    outputs.push(plannedChange(changeKey, change))
  }
  checkBalanced(inputs, outputs, fee)

  const vbytesEstimate = estimateVbytes(
    true,
    inputs.length,
    outputs.map((o) => outputVsize(chain, o.address)),
  )
  // Upper bound first: the signed size can only be smaller, which makes rules
  // 3 and 4 easier; assembleSigned re-runs this on the real size.
  assertBumpRules(chain, original, conflictExtra, fee, vbytesEstimate)

  return {
    chain,
    version: chain.txVersion,
    lockTime: 0,
    sequence,
    inputs,
    outputs,
    amount: recipientTotal,
    fee,
    change,
    toAddress: recipients.length > 0 ? recipients[0]!.address : changeKey.address,
    vbytesEstimate,
    bump: { original, conflictExtraFees: conflictExtra },
  }
}
