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
//           unseen and unexpired (audit 2026-10-26, H2).
//   UTXO:   a signed transaction stays valid until its inputs are spent, so
//           one the network does not report yet could still land for a long
//           time; refuse to send again while an attempt from the last 30
//           minutes is unseen (audit 2026-10-26, M1). A retry of the SAME
//           bytes is always safe (same txid).

import { secureGet, secureSet } from './securestore'

export interface PendingEvm {
  kind: 'evm'
  chainId: number
  nonce: number
  hash: string
  to: string
  ts: number
  /** the attempt's fee fields (decimal strings), so a same-nonce retry can outbid it */
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

export interface PendingSol {
  kind: 'sol'
  chainId: string
  signature: string
  ts: number
  /** the blockhash's last valid block height, from the RPC at prepare time */
  lastValidBlockHeight?: number
}

export interface PendingUtxo {
  kind: 'utxo'
  chainId: string
  txid: string
  to: string
  ts: number
}

export interface PendingTron {
  kind: 'tron'
  chainId: string
  txid: string
  to: string
  /** the transaction's own expiration (unix ms), from the verified bytes */
  expiration: number
  ts: number
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

function ttlOf(p: Pending): number {
  if (p.kind === 'tron') return p.expiration - p.ts
  return p.kind === 'evm' ? EVM_TTL_MS : p.kind === 'sol' ? SOL_TTL_HARD_MS : UTXO_TTL_MS
}

function readAll(): Pending[] {
  const v = secureGet(NAME)
  return Array.isArray(v) ? (v as Pending[]) : []
}

function writeAll(list: Pending[]): void {
  const now = Date.now()
  secureSet(
    NAME,
    list.filter((p) => now - p.ts < ttlOf(p)),
  )
}

export function recordPending(p: Pending): void {
  writeAll([...readAll().filter((q) => !samePending(q, p)), p])
}

export function dropPending(p: Pending): void {
  writeAll(readAll().filter((q) => !samePending(q, p)))
}

function samePending(a: Pending, b: Pending): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'evm') return a.chainId === (b as PendingEvm).chainId && a.hash === (b as PendingEvm).hash
  if (a.kind === 'sol') return a.signature === (b as PendingSol).signature
  return a.txid === (b as PendingUtxo | PendingTron).txid
}

export function pendingEvm(chainId: number): PendingEvm[] {
  const now = Date.now()
  return readAll().filter(
    (p): p is PendingEvm => p.kind === 'evm' && p.chainId === chainId && now - p.ts < EVM_TTL_MS,
  )
}

export function pendingSol(chainId: string): PendingSol[] {
  const now = Date.now()
  return readAll().filter(
    (p): p is PendingSol => p.kind === 'sol' && p.chainId === chainId && now - p.ts < SOL_TTL_HARD_MS,
  )
}

export function pendingTron(chainId: string): PendingTron[] {
  const now = Date.now()
  return readAll().filter(
    (p): p is PendingTron => p.kind === 'tron' && p.chainId === chainId && now < p.expiration,
  )
}

export function pendingUtxo(chainId: string): PendingUtxo[] {
  const now = Date.now()
  return readAll().filter(
    (p): p is PendingUtxo => p.kind === 'utxo' && p.chainId === chainId && now - p.ts < UTXO_TTL_MS,
  )
}

/** Where a recorded EVM attempt stands, as the network reports it. */
export type EvmAttemptStatus = 'pending' | 'mined' | 'unknown-to-network' | 'unreachable'

/** A recorded attempt that blocks a new send, and why. */
export interface InFlightBlock<P extends Pending> {
  entry: P
  /**
   * 'pending': it may still land. 'unreachable': the network couldn't be
   * asked. 'mined': the attempt a same-nonce retry meant to replace has
   * already gone through, so there is nothing to re-send.
   */
  reason: 'pending' | 'unreachable' | 'mined'
}

/**
 * Resolve this chain's recorded EVM attempts against the network, nonce by
 * nonce. One attempt mined → that nonce is settled: every attempt at it is
 * dropped (a retry at the same nonce can't land beside it). An attempt the
 * network says it has never seen is dropped only once it is older than
 * EVM_UNKNOWN_GRACE_MS; younger, it blocks like a pending one (a node that
 * took it would show it, so "unknown" may be a lying or lagging node). Not
 * being able to ask blocks too: "couldn't check" is never "safe to send".
 *
 * A same-nonce retry (`reuseNonce`) is not blocked by the attempts it
 * replaces — unless one of them has mined, which is reported as 'mined' so
 * the caller can say "it went through" instead of sending anything.
 */
export async function evmInFlightBlock(
  chainId: number,
  reuseNonce: number | undefined,
  status: (hash: string) => Promise<EvmAttemptStatus>,
): Promise<InFlightBlock<PendingEvm> | null> {
  const now = Date.now()
  const byNonce = new Map<number, PendingEvm[]>()
  for (const p of pendingEvm(chainId)) byNonce.set(p.nonce, [...(byNonce.get(p.nonce) ?? []), p])
  for (const [nonce, attempts] of byNonce) {
    const resolved: { p: PendingEvm; s: EvmAttemptStatus }[] = []
    for (const p of attempts) {
      resolved.push({ p, s: await status(p.hash).catch((): EvmAttemptStatus => 'unreachable') })
    }
    const mined = resolved.find((r) => r.s === 'mined')
    if (mined !== undefined) {
      for (const r of resolved) dropPending(r.p)
      if (reuseNonce === nonce) return { entry: mined.p, reason: 'mined' }
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

/** Seen-or-not entries: one the network reports is dropped; an unseen one blocks; a failed lookup blocks. */
async function seenBlock<P extends Pending>(
  entries: P[],
  idOf: (p: P) => string,
  seen: (id: string) => Promise<boolean>,
): Promise<InFlightBlock<P> | null> {
  for (const p of entries) {
    let wasSeen: boolean
    try {
      wasSeen = await seen(idOf(p))
    } catch {
      return { entry: p, reason: 'unreachable' }
    }
    if (wasSeen) {
      dropPending(p)
      continue
    }
    return { entry: p, reason: 'pending' }
  }
  return null
}

/**
 * Same for Solana. An attempt the network reports is dropped; an unseen one
 * blocks; a failed lookup blocks as well. An attempt older than SOL_TTL_MS
 * whose blockhash the chain has moved past (block height from `blockHeight`,
 * asked once; a failed ask keeps the entry) is dead and dropped; without a
 * recorded height, the clock alone decides.
 */
export async function solInFlightBlock(
  chainId: string,
  seen: (signature: string) => Promise<boolean>,
  blockHeight?: () => Promise<number>,
): Promise<InFlightBlock<PendingSol> | null> {
  const now = Date.now()
  const live: PendingSol[] = []
  let height: number | null | undefined // undefined: not asked yet; null: couldn't ask
  for (const p of pendingSol(chainId)) {
    if (now - p.ts >= SOL_TTL_MS) {
      if (p.lastValidBlockHeight === undefined) {
        dropPending(p)
        continue
      }
      if (height === undefined) height = await (blockHeight?.().catch(() => null) ?? Promise.resolve(null))
      if (height !== null && height > p.lastValidBlockHeight) {
        dropPending(p)
        continue
      }
    }
    live.push(p)
  }
  return seenBlock(live, (p) => p.signature, seen)
}

/** Same for TRON; an entry stops blocking at its own expiration. */
export function tronInFlightBlock(
  chainId: string,
  seen: (txid: string) => Promise<boolean>,
): Promise<InFlightBlock<PendingTron> | null> {
  return seenBlock(pendingTron(chainId), (p) => p.txid, seen)
}

/**
 * Same for the UTXO chains, with the provider's "is this txid known" as the
 * lookup. Holds a send back for at most UTXO_TTL_MS.
 */
export function utxoInFlightBlock(
  chainId: string,
  seen: (txid: string) => Promise<boolean>,
): Promise<InFlightBlock<PendingUtxo> | null> {
  return seenBlock(pendingUtxo(chainId), (p) => p.txid, seen)
}

/** "a moment ago" / "3 minutes ago" for user-facing refusals. */
export function agoText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'a moment ago'
  const m = Math.round(s / 60)
  return m === 1 ? 'a minute ago' : `${m} minutes ago`
}
