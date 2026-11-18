// The wallet's own memory of the Solana activity it has seen.
//
// Contract:
//   rememberedSolTxs(chainId, address): SolTx[]           — newest first
//   rememberSolTxs(chainId, address, rows, session): void — rows the chain has
//                                                           finalized, and only
//                                                           while `session` is
//                                                           still the unlock
//                                                           that read them
//   mergeSolHistory(fresh, remembered): SolTx[]           — one list, newest
//                                                           first, fresh wins
//
// Why this exists: the keyless Solana servers prune. On 2026-11-18 one kept
// about 2.8 days of history and the other between 8 and 40 hours, so a
// payment from last week was in no list either could give, and Activity went
// empty for a wallet that hadn't moved in three days. No keyless server fit
// to rely on keeps more, so the wallet keeps what it has already been shown:
// a row seen once stays, and a server that has since pruned it can't take it
// back. Activity from a stretch when the wallet wasn't opened for longer than
// the servers keep is not here; the card says so and links the explorer.
//
// Trust: these rows are DISPLAY state, exactly as a fresh history answer is.
// They came from a data service, so they never make an address trusted (the
// lookalike check trusts only sentlog.ts) and never feed a send. Only rows
// the chain has finalized are kept, so a transaction a fork dropped can't
// stay on screen for good.
//
// Privacy: the list is the account's history, so it lives in the encrypted
// secure store ('solhistory' → kailah.sec.solhistory): ciphertext while
// locked, removed by erase with every other kailah.sec.* blob. It is keyed by
// chain id and address, and written only by the unlock that read it
// (storeSession), so an erased wallet's refresh still in flight can't write
// its history into the next wallet's store.

import type { SolTx } from './sol'
import { secureGet, secureSet, storeSession } from './securestore'

const NAME = 'solhistory'
/** Rows kept per account; a personal wallet takes months to fill it, and the oldest fall off. */
export const SOL_HISTORY_KEEP = 100

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const AMOUNT = /^-?\d{1,30}$/

/** One row as stored: bigints as decimal strings, flags only when set. */
interface StoredTx {
  s: string
  d: SolTx['direction']
  a: string
  u: string
  t: number | null
  c: string | null
  f?: 1
  w?: 1
}

const keyOf = (chainId: string, address: string): string => `${chainId}:${address}`

function toStored(t: SolTx): StoredTx {
  return {
    s: t.signature,
    d: t.direction,
    a: t.amount.toString(),
    u: t.usdcAmount.toString(),
    t: t.time,
    c: t.counterparty,
    ...(t.failed ? { f: 1 as const } : {}),
    ...(t.swap ? { w: 1 as const } : {}),
  }
}

/** A stored row back as a SolTx, or null for anything not shaped like one. */
function fromStored(v: unknown): SolTx | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<Record<keyof StoredTx, unknown>>
  // the signature becomes an explorer link: only a real one gets through
  if (typeof r.s !== 'string' || !SIGNATURE.test(r.s)) return null
  if (r.d !== 'in' && r.d !== 'out' && r.d !== 'self') return null
  if (typeof r.a !== 'string' || !AMOUNT.test(r.a) || typeof r.u !== 'string' || !AMOUNT.test(r.u)) return null
  if (r.t !== null && !(typeof r.t === 'number' && Number.isSafeInteger(r.t) && r.t > 0)) return null
  if (r.c !== null && !(typeof r.c === 'string' && ADDRESS.test(r.c))) return null
  return {
    signature: r.s,
    direction: r.d,
    amount: BigInt(r.a),
    usdcAmount: BigInt(r.u),
    time: r.t,
    counterparty: r.c,
    failed: r.f === 1,
    swap: r.w === 1,
  }
}

function readAll(): Record<string, unknown> {
  const v = secureGet(NAME)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Newest first; a row with no time yet is the newest there is. */
function newestFirst(rows: SolTx[]): SolTx[] {
  return [...rows].sort(
    (a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER),
  )
}

/** One list from a fresh answer and what the wallet remembers: by signature, the fresh row wins. */
export function mergeSolHistory(fresh: SolTx[], remembered: SolTx[]): SolTx[] {
  const bySignature = new Map<string, SolTx>()
  for (const t of remembered) bySignature.set(t.signature, t)
  for (const t of fresh) bySignature.set(t.signature, t)
  return newestFirst([...bySignature.values()]).slice(0, SOL_HISTORY_KEEP)
}

export function rememberedSolTxs(chainId: string, address: string): SolTx[] {
  const list = readAll()[keyOf(chainId, address)]
  if (!Array.isArray(list)) return []
  const out: SolTx[] = []
  const seen = new Set<string>()
  for (const v of list) {
    const t = fromStored(v)
    if (t === null || seen.has(t.signature)) continue
    seen.add(t.signature)
    out.push(t)
  }
  return newestFirst(out).slice(0, SOL_HISTORY_KEEP)
}

/**
 * Keep these finalized rows. `session` is storeSession() from before the rows
 * were read: after a lock, an erase or another unlock, nothing is written.
 */
export function rememberSolTxs(chainId: string, address: string, rows: SolTx[], session: number): void {
  if (rows.length === 0 || storeSession() !== session) return
  const merged = mergeSolHistory(rows, rememberedSolTxs(chainId, address))
  secureSet(NAME, { ...readAll(), [keyOf(chainId, address)]: merged.map(toStored) })
}
