// In-flight send ledger — the persisted half of the double-pay guard.
//
// A broadcast that fails ambiguously (timeout after the node accepted it, a
// lying RPC) may still land. Inside the send modal the retry logic already
// knows that; this ledger makes the wallet remember it after the modal is
// closed, the app reloaded, or the device locked. Every attempt is recorded
// BEFORE it goes out, in the encrypted secure store (sends require unlock).
//
//   EVM:    a recorded tx still sitting unconfirmed in the mempool blocks any
//           new send on that chain (one in flight at a time) unless the new
//           send is an explicit same-nonce retry, which replaces it at a
//           higher fee. EVERY attempt at a nonce stays recorded (a retry
//           never erases the attempt it replaces: that one may be the one
//           that lands — audit 2026-10-26, H1). A tx the network reports
//           as unknown is forgotten only once it is old enough that an
//           honest node would have shown it (M2); a confirmed one, and every
//           other attempt at its nonce, is dropped.
//   Solana: a signature from the last ~90 s that the network does not report
//           yet could still land (its blockhash is still valid) — refuse to
//           send again until it is seen or expires.
//   TRON:   a transaction is valid until its own expiration (the node sets
//           ~60 s; the wallet refuses anything over 10 min), and TRON has no
//           nonce, so a rebuilt send would land beside a first attempt whose
//           answer was lost — refuse to send again while an attempt is
//           unseen and unexpired (audit 2026-10-26, H2). The hold is measured
//           on THIS device's clock (bug audit 2026-10-27, BM3: a clock running
//           fast used to drop the entry the moment it was written).
//   UTXO:   a signed transaction stays valid until its inputs are spent, so
//           one the network does not report yet could still land for a long
//           time; refuse to send again while an attempt from the last 30
//           minutes is unseen (audit 2026-10-26, M1). A retry of the SAME
//           bytes is always safe (same txid).
//
// After a failed broadcast (bug audit 2026-10-27, BH1). An attempt whose
// broadcast got no definite answer is marked `failed`. If the network later
// reports it, the next send is refused with EarlierSendLanded — it went
// through after all, and a new send would pay a second time — until the user
// says to send again anyway. Failed entries are kept up to FAILED_KEEP_MS so
// a retry hours later is still caught; outside its window a failed attempt
// the network never saw is forgotten (it isn't coming). An attempt that went
// out cleanly is dropped silently once seen. A definite rejection (the node
// validated it and refused) drops the entry at once — but not a rejection of
// a resend: it is about the resend, not the first try, which may be the very
// reason ("already spent", "balance too low"). That record stays failed; a
// resend that goes out cleanly clears the flag (markPendingSent; review
// 2026-10-28).
//
// Every check re-reads the ledger from storage first: another unlocked
// window of the wallet may have written to it (bug audit 2026-10-27, BM11).

import { refreshSecure, secureGet, secureSet } from './securestore'

interface PendingCommon {
  ts: number
  /** the broadcast got no definite answer: if the network shows it later, say so before any new send */
  failed?: true
}

export interface PendingEvm extends PendingCommon {
  kind: 'evm'
  chainId: number
  nonce: number
  hash: string
  to: string
  /** the attempt's fee fields (decimal strings), so a same-nonce retry can outbid it */
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

export interface PendingSol extends PendingCommon {
  kind: 'sol'
  chainId: string
  signature: string
  /** the recipient, for the "it went through" notice (absent on swaps and stake actions) */
  to?: string
  /** the blockhash's last valid block height, from the RPC at prepare time */
  lastValidBlockHeight?: number
}

export interface PendingUtxo extends PendingCommon {
  kind: 'utxo'
  chainId: string
  txid: string
  to: string
  /**
   * The account that sent it ('seed', or a Ledger account's record id): its
   * coins are its own, so it holds back only that account's sends (bug
   * audit 2026-10-27, BL47). Older entries have none and hold back all.
   */
  account?: string
}

/** A recorded attempt that concerns `account` (an entry with no account concerns every one). */
function forAccount(account: string | undefined) {
  return (p: PendingUtxo) => account === undefined || p.account === undefined || p.account === account
}

export interface PendingTron extends PendingCommon {
  kind: 'tron'
  chainId: string
  txid: string
  to: string
  /** the transaction's own expiration (unix ms, the node's clock), from the verified bytes */
  expiration: number
  /** when the hold ends on THIS device's clock (absent on entries from older builds) */
  holdUntil?: number
}

export type Pending = PendingEvm | PendingSol | PendingUtxo | PendingTron

const NAME = 'pending'
const EVM_TTL_MS = 24 * 3600 * 1000
/**
 * An attempt the network says it has never seen is forgotten only after
 * this long: a node that accepted it shows it within seconds, so a younger
 * "unknown" may be a lying or lagging node, and blocks like "pending".
 */
export const EVM_UNKNOWN_GRACE_MS = 10 * 60_000
/** A same-nonce replacement must outbid the attempt it replaces by this much (basis points). */
export const EVM_REPLACE_BUMP_BPS = 1_000n
/**
 * Solana blockhashes expire after ~60-90 s. An entry is held at least this
 * long by the local clock, then until the RPC's block height passes the
 * blockhash's last valid height (audit 2026-10-26, M7: the wall clock alone
 * is a guess under slow block production), and never beyond SOL_TTL_HARD_MS.
 */
export const SOL_TTL_MS = 90_000
export const SOL_TTL_HARD_MS = 5 * 60_000
/** A UTXO tx the network hasn't reported within this long was almost surely never accepted. */
export const UTXO_TTL_MS = 30 * 60_000
/** How long a failed attempt is remembered, so one that lands is reported even to a late retry. */
export const FAILED_KEEP_MS = 24 * 3600 * 1000

function ttlOf(p: Pending): number {
  const base =
    p.kind === 'tron'
      ? (p.holdUntil ?? p.expiration) - p.ts
      : p.kind === 'evm'
        ? EVM_TTL_MS
        : p.kind === 'sol'
          ? SOL_TTL_HARD_MS
          : UTXO_TTL_MS
  return p.failed === true ? Math.max(base, FAILED_KEEP_MS) : base
}

function retained(p: Pending, now: number): boolean {
  return now - p.ts < ttlOf(p)
}

function readAll(): Pending[] {
  const v = secureGet(NAME)
  return Array.isArray(v) ? (v as Pending[]) : []
}

function writeAll(list: Pending[]): void {
  const now = Date.now()
  secureSet(
    NAME,
    list.filter((p) => retained(p, now)),
  )
}

export function recordPending(p: Pending): void {
  writeAll([...readAll().filter((q) => !samePending(q, p)), p])
}

export function dropPending(p: Pending): void {
  writeAll(readAll().filter((q) => !samePending(q, p)))
}

/**
 * The broadcast of `p` got no definite answer: keep it, flagged, so that if
 * the network shows it later the next send says so instead of paying again.
 */
export function markPendingFailed(p: Pending): void {
  const all = readAll()
  const found = all.some((q) => samePending(q, p))
  writeAll(
    found
      ? all.map((q) => (samePending(q, p) ? ({ ...q, failed: true } as Pending) : q))
      : [...all, { ...p, failed: true } as Pending],
  )
}

/**
 * A resend of `p` went out cleanly, or the network shows it: the person has
 * been told it was sent, so it is an ordinary attempt again (seen → dropped
 * without a word). Left `failed`, the next send said it "went through after
 * all" (review 2026-10-28).
 */
export function markPendingSent(p: Pending): void {
  writeAll(
    readAll().map((q) => {
      if (!samePending(q, p) || q.failed !== true) return q
      const { failed: _failed, ...rest } = q
      return rest as Pending
    }),
  )
}

function samePending(a: Pending, b: Pending): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'evm') return a.chainId === (b as PendingEvm).chainId && a.hash === (b as PendingEvm).hash
  if (a.kind === 'sol') return a.signature === (b as PendingSol).signature
  return a.txid === (b as PendingUtxo | PendingTron).txid
}

export function pendingEvm(chainId: number): PendingEvm[] {
  const now = Date.now()
  return readAll().filter((p): p is PendingEvm => p.kind === 'evm' && p.chainId === chainId && retained(p, now))
}

export function pendingSol(chainId: string): PendingSol[] {
  const now = Date.now()
  return readAll().filter((p): p is PendingSol => p.kind === 'sol' && p.chainId === chainId && retained(p, now))
}

export function pendingTron(chainId: string): PendingTron[] {
  const now = Date.now()
  return readAll().filter((p): p is PendingTron => p.kind === 'tron' && p.chainId === chainId && retained(p, now))
}

export function pendingUtxo(chainId: string): PendingUtxo[] {
  const now = Date.now()
  return readAll().filter((p): p is PendingUtxo => p.kind === 'utxo' && p.chainId === chainId && retained(p, now))
}

/** Where a recorded EVM attempt stands, as the network reports it. */
export type EvmAttemptStatus = 'pending' | 'mined' | 'reverted' | 'unknown-to-network' | 'unreachable'

/** A recorded attempt that blocks a new send, and why. */
export interface InFlightBlock<P extends Pending> {
  entry: P
  /**
   * 'pending': it may still land. 'unreachable': the network couldn't be
   * asked. 'mined': the attempt a same-nonce retry meant to replace has
   * already gone through, so there is nothing to re-send. 'reverted': that
   * attempt reached the chain but failed there (the nonce is used, nothing
   * was paid). 'landed': an attempt whose broadcast had failed went through
   * after all — a new send would pay a second time.
   */
  reason: 'pending' | 'unreachable' | 'mined' | 'reverted' | 'landed'
}

/**
 * An earlier attempt whose broadcast had failed went through after all.
 * Thrown by every prepare; the send forms offer "Send again anyway", which
 * dismisses it (dismissLanded) and prepares again.
 */
export class EarlierSendLanded extends Error {
  readonly entry: Pending
  constructor(entry: Pending, what: string) {
    super(
      `${what} went through after all, although its broadcast reported an error. Sending again would pay a second time — only do that if you mean to make another payment.`,
    )
    this.name = 'EarlierSendLanded'
    this.entry = entry
  }
}

/** The user has seen that a failed attempt landed and wants to send again: forget it (and, for EVM, its nonce's other attempts). */
export function dismissLanded(p: Pending): void {
  if (p.kind === 'evm') {
    writeAll(readAll().filter((q) => !(q.kind === 'evm' && q.chainId === p.chainId && q.nonce === p.nonce)))
    return
  }
  dropPending(p)
}

/**
 * Resolve this chain's recorded EVM attempts against the network, nonce by
 * nonce. One attempt mined (or reverted) → that nonce is settled: every
 * attempt at it is dropped (a retry at the same nonce can't land beside it)
 * — unless the mined one's broadcast had failed, which is reported as
 * 'landed' first. An attempt the network says it has never seen is dropped
 * only once it is older than EVM_UNKNOWN_GRACE_MS; younger, it blocks like a
 * pending one (a node that took it would show it, so "unknown" may be a
 * lying or lagging node). Not being able to ask blocks too: "couldn't check"
 * is never "safe to send".
 *
 * A same-nonce retry (`reuseNonce`) is not blocked by the attempts it
 * replaces — unless one of them has mined or reverted, which is reported so
 * the caller can say what happened instead of sending anything.
 */
export async function evmInFlightBlock(
  chainId: number,
  reuseNonce: number | undefined,
  status: (hash: string) => Promise<EvmAttemptStatus>,
): Promise<InFlightBlock<PendingEvm> | null> {
  await refreshSecure(NAME)
  const now = Date.now()
  const byNonce = new Map<number, PendingEvm[]>()
  for (const p of pendingEvm(chainId)) byNonce.set(p.nonce, [...(byNonce.get(p.nonce) ?? []), p])
  for (const [nonce, attempts] of byNonce) {
    const resolved: { p: PendingEvm; s: EvmAttemptStatus }[] = []
    for (const p of attempts) {
      resolved.push({ p, s: await status(p.hash).catch((): EvmAttemptStatus => 'unreachable') })
    }
    const mined = resolved.find((r) => r.s === 'mined')
    const settled = mined ?? resolved.find((r) => r.s === 'reverted')
    if (settled !== undefined) {
      if (reuseNonce === nonce) {
        for (const r of resolved) dropPending(r.p)
        return { entry: settled.p, reason: settled.s === 'mined' ? 'mined' : 'reverted' }
      }
      if (mined !== undefined && mined.p.failed === true) return { entry: mined.p, reason: 'landed' }
      for (const r of resolved) dropPending(r.p)
      continue
    }
    if (reuseNonce === nonce) continue // the retry replaces these; they stay recorded until settled
    for (const r of resolved) {
      if (r.s === 'unknown-to-network') {
        if (now - r.p.ts >= EVM_UNKNOWN_GRACE_MS) {
          dropPending(r.p)
          continue
        }
        return { entry: r.p, reason: 'pending' }
      }
      return { entry: r.p, reason: r.s === 'pending' ? 'pending' : 'unreachable' }
    }
  }
  return null
}

/**
 * The fees a same-nonce retry must at least pay to replace the recorded
 * attempts at that nonce: the highest of theirs, bumped by
 * EVM_REPLACE_BUMP_BPS (nodes refuse a replacement that doesn't outbid by
 * ~10 %, and a refused "replacement" is no replacement at all).
 */
export function evmReplacementFloor(
  chainId: number,
  nonce: number,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  let maxFee = -1n
  let maxPrio = -1n
  for (const p of pendingEvm(chainId)) {
    if (p.nonce !== nonce) continue
    const fee = BigInt(p.maxFeePerGas ?? '0')
    const prio = BigInt(p.maxPriorityFeePerGas ?? '0')
    if (fee > maxFee) maxFee = fee
    if (prio > maxPrio) maxPrio = prio
  }
  if (maxFee < 0n) return null
  const bump = (v: bigint) => (v * (10_000n + EVM_REPLACE_BUMP_BPS) + 9_999n) / 10_000n
  return { maxFeePerGas: bump(maxFee), maxPriorityFeePerGas: bump(maxPrio) }
}

/**
 * Seen-or-not entries. Inside its window (`blocking`): seen → dropped, or
 * 'landed' if its broadcast had failed; unseen → blocks; a failed lookup
 * blocks. Outside its window: a clean attempt is forgotten without asking; a
 * failed one is asked about once more — seen → 'landed', unseen → forgotten
 * (it isn't coming), lookup failure → kept for the next check.
 */
async function seenBlock<P extends Pending>(
  entries: P[],
  idOf: (p: P) => string,
  seen: (id: string) => Promise<boolean>,
  blocking: (p: P) => boolean,
): Promise<InFlightBlock<P> | null> {
  for (const p of entries) {
    const inWindow = blocking(p)
    if (!inWindow && p.failed !== true) {
      dropPending(p)
      continue
    }
    let wasSeen: boolean
    try {
      wasSeen = await seen(idOf(p))
    } catch {
      if (inWindow) return { entry: p, reason: 'unreachable' }
      continue
    }
    if (wasSeen) {
      if (p.failed === true) return { entry: p, reason: 'landed' }
      dropPending(p)
      continue
    }
    if (inWindow) return { entry: p, reason: 'pending' }
    dropPending(p)
  }
  return null
}

/**
 * Same for Solana. An attempt whose blockhash the chain has moved past
 * (block height from `blockHeight`, asked once) can no longer land, at any
 * age; one the chain hasn't moved past, or whose height lookup failed, holds
 * up to SOL_TTL_HARD_MS. Without a recorded height, the clock alone decides
 * (SOL_TTL_MS). A "height" far beyond what the chain could have
 * produced since the attempt is not a block height (a slot, say — publicnode
 * answers getBlockHeight with the slot, bug audit 2026-10-27, BM2) and is
 * treated as unknown.
 */
export async function solInFlightBlock(
  chainId: string,
  seen: (signature: string) => Promise<boolean>,
  blockHeight?: () => Promise<number>,
): Promise<InFlightBlock<PendingSol> | null> {
  await refreshSecure(NAME)
  const now = Date.now()
  let height: number | null | undefined // undefined: not asked yet; null: couldn't ask
  const entries = pendingSol(chainId)
  const inWindow = new Map<string, boolean>()
  for (const p of entries) {
    const age = now - p.ts
    let holds: boolean
    if (age >= SOL_TTL_HARD_MS) holds = false
    else if (p.lastValidBlockHeight === undefined) holds = age < SOL_TTL_MS
    else {
      // the chain's height decides for every entry, young ones too: an
      // attempt whose blockhash had lapsed before it went out can't land,
      // and held the next send back 90 s (bug audit 2026-10-27, BM17)
      if (height === undefined) height = await (blockHeight?.().catch(() => null) ?? Promise.resolve(null))
      const plausible = height !== null && height - p.lastValidBlockHeight <= (age / 1000) * 5 + 50_000
      holds = !(plausible && height !== null && height > p.lastValidBlockHeight)
    }
    inWindow.set(p.signature, holds)
  }
  return seenBlock(entries, (p) => p.signature, seen, (p) => inWindow.get(p.signature) === true)
}

/** Same for TRON; an entry stops blocking when its hold (this device's clock) or, on older entries, its expiration passes. */
export async function tronInFlightBlock(
  chainId: string,
  seen: (txid: string) => Promise<boolean>,
): Promise<InFlightBlock<PendingTron> | null> {
  await refreshSecure(NAME)
  const now = Date.now()
  return seenBlock(pendingTron(chainId), (p) => p.txid, seen, (p) => now < (p.holdUntil ?? p.expiration))
}

/**
 * Same for the UTXO chains, with the provider's "is this txid known" as the
 * lookup. Holds a send back for at most UTXO_TTL_MS.
 */
export async function utxoInFlightBlock(
  chainId: string,
  seen: (txid: string) => Promise<boolean>,
  account?: string,
): Promise<InFlightBlock<PendingUtxo> | null> {
  await refreshSecure(NAME)
  const now = Date.now()
  return seenBlock(pendingUtxo(chainId).filter(forAccount(account)), (p) => p.txid, seen, (p) => now - p.ts < UTXO_TTL_MS)
}

/**
 * Before a Speed up (bug audit 2026-10-27, BH5): a recorded UTXO attempt on
 * this chain, other than the transaction being replaced, that the network
 * doesn't show yet. A scan can't see what such an attempt spends, so a
 * replacement built now could take the same coin and cancel it. Attempts
 * the network shows are in the scan and don't block; nothing is dropped
 * here (the next send's check does that, and reports a landed one).
 */
export async function utxoUnseenBlock(
  chainId: string,
  seen: (txid: string) => Promise<boolean>,
  replacing: string,
  account?: string,
): Promise<InFlightBlock<PendingUtxo> | null> {
  await refreshSecure(NAME)
  const now = Date.now()
  for (const p of pendingUtxo(chainId).filter(forAccount(account))) {
    if (p.txid === replacing || now - p.ts >= UTXO_TTL_MS) continue
    let wasSeen: boolean
    try {
      wasSeen = await seen(p.txid)
    } catch {
      return { entry: p, reason: 'unreachable' }
    }
    if (!wasSeen) return { entry: p, reason: 'pending' }
  }
  return null
}

/** "a moment ago" / "3 minutes ago" / "2 hours ago" for user-facing refusals. */
export function agoText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'a moment ago'
  const m = Math.round(s / 60)
  if (m < 90) return m === 1 ? 'a minute ago' : `${m} minutes ago`
  const h = Math.round(m / 60)
  return h === 1 ? 'an hour ago' : `${h} hours ago`
}
