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
//           send is an explicit same-nonce retry, which replaces it. A tx the
//           network has never seen is forgotten; a confirmed one is dropped.
//   Solana: a signature from the last ~90 s that the network does not report
//           yet could still land (its blockhash is still valid) — refuse to
//           send again until it is seen or expires.

import { secureGet, secureSet } from './securestore'

export interface PendingEvm {
  kind: 'evm'
  chainId: number
  nonce: number
  hash: string
  to: string
  ts: number
}

export interface PendingSol {
  kind: 'sol'
  chainId: string
  signature: string
  ts: number
}

export type Pending = PendingEvm | PendingSol

const NAME = 'pending'
const EVM_TTL_MS = 24 * 3600 * 1000
/** Solana blockhashes expire after ~60-90 s; after that an unseen tx is dead. */
export const SOL_TTL_MS = 90_000

function readAll(): Pending[] {
  const v = secureGet(NAME)
  return Array.isArray(v) ? (v as Pending[]) : []
}

function writeAll(list: Pending[]): void {
  const now = Date.now()
  secureSet(
    NAME,
    list.filter((p) => now - p.ts < (p.kind === 'evm' ? EVM_TTL_MS : SOL_TTL_MS)),
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
  return a.kind === 'evm'
    ? a.chainId === (b as PendingEvm).chainId && a.nonce === (b as PendingEvm).nonce
    : a.signature === (b as PendingSol).signature
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
    (p): p is PendingSol => p.kind === 'sol' && p.chainId === chainId && now - p.ts < SOL_TTL_MS,
  )
}

/** Where a recorded EVM attempt stands, as the network reports it. */
export type EvmAttemptStatus = 'pending' | 'mined' | 'unknown-to-network' | 'unreachable'

/** A recorded attempt that blocks a new send, and why. */
export interface InFlightBlock<P extends Pending> {
  entry: P
  /** 'pending': it may still land. 'unreachable': the network couldn't be asked. */
  reason: 'pending' | 'unreachable'
}

/**
 * Resolve this chain's recorded EVM attempts against the network. Mined ones
 * and ones the network has never seen are dropped; the first attempt that
 * still blocks a new send is returned. A same-nonce retry is never blocked by
 * the attempt it replaces. Not being able to ask the network blocks too:
 * "couldn't check" must never be read as "safe to send again".
 */
export async function evmInFlightBlock(
  chainId: number,
  reuseNonce: number | undefined,
  status: (hash: string) => Promise<EvmAttemptStatus>,
): Promise<InFlightBlock<PendingEvm> | null> {
  for (const p of pendingEvm(chainId)) {
    if (reuseNonce !== undefined && p.nonce === reuseNonce) continue
    const s = await status(p.hash).catch((): EvmAttemptStatus => 'unreachable')
    if (s === 'mined' || s === 'unknown-to-network') {
      dropPending(p)
      continue
    }
    return { entry: p, reason: s === 'pending' ? 'pending' : 'unreachable' }
  }
  return null
}

/**
 * Same for Solana. An attempt the network reports is dropped; an unseen one
 * blocks. A failed lookup blocks as well — the record expires after
 * SOL_TTL_MS, so this can hold a send back for at most ~90 s, never forever.
 */
export async function solInFlightBlock(
  chainId: string,
  seen: (signature: string) => Promise<boolean>,
): Promise<InFlightBlock<PendingSol> | null> {
  for (const p of pendingSol(chainId)) {
    let wasSeen: boolean
    try {
      wasSeen = await seen(p.signature)
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

/** "a moment ago" / "3 minutes ago" for user-facing refusals. */
export function agoText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'a moment ago'
  const m = Math.round(s / 60)
  return m === 1 ? 'a minute ago' : `${m} minutes ago`
}
