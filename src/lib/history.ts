// Transaction history classification for Kailah Wallet.
//
// Contract (types.ts):
//   classifyTxs(raw: RawTxInfo[], ours: Set<string>, tipHeight: number): TxSummary[]
//
// Turns provider-normalized RawTxInfo into wallet-centric TxSummary rows:
// direction (in/out/self), signed net amount, counterparty, confirmations, and
// whether the tx can be RBF-bumped. Sorted newest-first (pending on top).

import type { RawTxInfo, TxSummary } from './types'

/**
 * Classify raw transactions relative to the set of addresses we own.
 * `ours` is every address the wallet controls (receive + change, across the
 * scanned gap). `tipHeight` is the current chain tip for confirmation counts.
 */
export function classifyTxs(raw: RawTxInfo[], ours: Set<string>, tipHeight: number): TxSummary[] {
  const summaries = raw.map((tx) => classifyOne(tx, ours, tipHeight))
  summaries.sort(compareTx)
  return summaries
}

function classifyOne(tx: RawTxInfo, ours: Set<string>, tipHeight: number): TxSummary {
  // Value flowing out of / into addresses we control.
  let ourIn = 0n
  for (const i of tx.inputs) {
    if (i.address !== null && ours.has(i.address)) ourIn += i.value
  }
  let ourOut = 0n
  for (const o of tx.outputs) {
    if (o.address !== null && ours.has(o.address)) ourOut += o.value
  }

  // Any output paying somewhere other than our own addresses (a real recipient,
  // OP_RETURN, or an unresolved output) means this isn't a pure self-transfer.
  const hasExternalOutput = tx.outputs.some((o) => o.address === null || !ours.has(o.address))

  let direction: 'in' | 'out' | 'self'
  if (ourIn > 0n) {
    if (ourOut > 0n) direction = hasExternalOutput ? 'out' : 'self'
    else direction = 'out'
  } else {
    // ourIn === 0 → we didn't fund it; anything we received is incoming.
    direction = 'in'
  }

  let amount: bigint
  if (direction === 'in') {
    amount = ourOut
  } else if (direction === 'self') {
    amount = -(tx.fee ?? 0n)
  } else {
    // 'out': negative net effect, which already folds in the fee.
    amount = -(ourIn - ourOut)
  }

  const firstInputNotOurs =
    tx.inputs.find((i) => i.address !== null && !ours.has(i.address))?.address ?? null
  const firstOutputOurs =
    tx.outputs.find((o) => o.address !== null && ours.has(o.address))?.address ?? null
  const firstOutputNotOurs =
    tx.outputs.find((o) => o.address !== null && !ours.has(o.address))?.address ?? null

  let counterparty: string | null
  if (direction === 'in') {
    counterparty = firstInputNotOurs ?? firstOutputOurs
  } else {
    // out/self: the recipient (first output that isn't our own).
    counterparty = firstOutputNotOurs
  }

  const height = tx.height
  const pending = height === null
  const confirmations = height === null ? 0 : Math.max(0, tipHeight - height + 1)

  // We can only replace a tx we fully funded (every input is ours) that still
  // sits in the mempool signalling BIP125 replaceability.
  const allInputsOurs =
    tx.inputs.length > 0 && tx.inputs.every((i) => i.address !== null && ours.has(i.address))
  const bumpable = pending && tx.rbfSignaled && allInputsOurs

  return {
    txid: tx.txid,
    direction,
    amount,
    fee: tx.fee,
    time: tx.time,
    height,
    confirmations,
    pending,
    counterparty,
    bumpable,
  }
}

/** Newest-first: pending on top (by time desc), then by height desc, time desc. */
function compareTx(a: TxSummary, b: TxSummary): number {
  if (a.pending !== b.pending) return a.pending ? -1 : 1
  if (a.pending) {
    const ta = a.time ?? 0
    const tb = b.time ?? 0
    if (ta !== tb) return tb - ta
  } else {
    const ha = a.height ?? 0
    const hb = b.height ?? 0
    if (ha !== hb) return hb - ha
    const ta = a.time ?? 0
    const tb = b.time ?? 0
    if (ta !== tb) return tb - ta
  }
  // Deterministic tie-break so output order is stable across runs/providers.
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0
}
