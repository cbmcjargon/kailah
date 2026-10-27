// Persisted last-known scan snapshots for the UTXO chains.
//
// Why this exists: DOGE runs on BlockCypher's ~100-requests-per-HOUR free
// tier, and a cold full scan (fresh unlock, mode switch) walks 40+ addresses —
// half the hourly budget in one shot. Users who unlocked a few times per hour
// ran the budget dry and saw only the rate-limit error (live incident
// 2026-08-01). With a snapshot, an unlock shows the last-known state instantly
// and re-checks it with the scanner's cheap quick pass (~a handful of
// requests); the full walk only runs when something actually changed.
//
// Money safety: this cache is DISPLAY state only. Sends always rebuild from a
// fresh scan (SendModal prepares against live data), so a stale snapshot can
// never feed coin selection. Snapshots deliberately omit utxos and raw txs and
// are marked utxos-incomplete so anything utxo-hungry (MAX sweep, RBF bump)
// knows to warn or wait for a real scan.
//
// Privacy: balances/addresses/history are public on-chain data, but together
// they are the wallet's whole picture — so snapshots live in the encrypted
// secure store (securestore.ts): ciphertext while locked, decrypted into
// memory on unlock. Erase clears it with every other kailah.* key.

import type { AccountAddressInfo, WatchAccountKeys, AccountState, Balance, TxSummary } from './types'
import { secureGet, secureRemove, secureSet } from './securestore'

/** pre-encryption plaintext key; removed on erase and on first encrypted write */
const LEGACY_KEY = 'kailah.statecache.v1'
const NAME = 'statecache'

/**
 * localStorage is writable without the wallet password (an extension, brief
 * devtools access while locked), and a forged snapshot flows straight onto
 * the Receive screen/QR. Every address a snapshot carries must therefore
 * re-derive from the unlocked account's own keys, or the snapshot is
 * discarded and a real scan runs instead. This also binds a snapshot to THE
 * wallet that saved it — another seed's addresses never validate.
 */
export function snapshotMatchesAccount(snap: AccountState, account: WatchAccountKeys): boolean {
  const matches = (a: AccountAddressInfo): boolean => {
    if ((a.branch !== 0 && a.branch !== 1) || !Number.isInteger(a.index) || a.index < 0 || a.index > 1000) {
      return false
    }
    try {
      return account.address(a.branch, a.index).address === a.address
    } catch {
      return false
    }
  }
  return (
    Array.isArray(snap.addresses) &&
    snap.addresses.every(matches) &&
    matches(snap.nextReceive) &&
    snap.nextReceive.branch === 0 &&
    matches(snap.nextChange) &&
    snap.nextChange.branch === 1
  )
}

interface StoredBalance {
  c: string
  u: string
}

interface StoredTx {
  txid: string
  direction: TxSummary['direction']
  amount: string
  fee: string | null
  time: number | null
  height: number | null
  counterparty: string | null
  partial?: true
}

interface StoredState {
  savedAt: number
  balance: StoredBalance
  addresses: AccountState['addresses']
  nextReceive: AccountState['nextReceive']
  nextChange: AccountState['nextChange']
  txs: StoredTx[]
  tipHeight: number
}

function readAll(): Record<string, StoredState> {
  try {
    const parsed = secureGet(NAME)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredState>) : {}
  } catch {
    return {}
  }
}

function balTo(b: Balance): StoredBalance {
  return { c: b.confirmed.toString(), u: b.unconfirmed.toString() }
}

function balFrom(b: StoredBalance): Balance {
  return { confirmed: BigInt(b.c), unconfirmed: BigInt(b.u) }
}

export function saveStateSnapshot(chainId: string, state: AccountState): void {
  // Never snapshot a partial scan — a too-low cached balance would read as
  // "my coins vanished" on the next unlock.
  if (state.incomplete?.balance === true) return
  try {
    const all = readAll()
    all[chainId] = {
      savedAt: Date.now(),
      balance: balTo(state.balance),
      addresses: state.addresses,
      nextReceive: state.nextReceive,
      nextChange: state.nextChange,
      txs: state.txs.map((t) => ({
        txid: t.txid,
        direction: t.direction,
        amount: t.amount.toString(),
        fee: t.fee !== null ? t.fee.toString() : null,
        time: t.time,
        height: t.height,
        counterparty: t.counterparty,
        ...(t.partial === true && { partial: true as const }),
      })),
      tipHeight: state.tipHeight,
    }
    secureSet(NAME, all)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // best-effort cache
  }
}

export function loadStateSnapshot(chainId: string): AccountState | null {
  try {
    const s = readAll()[chainId]
    if (!s) return null
    return {
      balance: balFrom(s.balance),
      addresses: s.addresses,
      nextReceive: s.nextReceive,
      nextChange: s.nextChange,
      // utxos/rawTxs are deliberately absent; flag it so utxo consumers warn.
      utxos: [],
      rawTxs: [],
      txs: s.txs.map((t) => ({
        txid: t.txid,
        direction: t.direction,
        amount: BigInt(t.amount),
        fee: t.fee !== null ? BigInt(t.fee) : null,
        time: t.time,
        height: t.height,
        // confirmations re-derived from the stored tip; refreshed on scan
        confirmations: t.height !== null ? Math.max(0, s.tipHeight - t.height + 1) : 0,
        pending: t.height === null,
        counterparty: t.counterparty,
        // a snapshot carries no raw txs/utxos, so Speed up must wait for a
        // real scan — never offer a bump we cannot build
        bumpable: false,
        ...(t.partial === true && { partial: true as const }),
      })),
      tipHeight: s.tipHeight,
      incomplete: { balance: false, utxos: true },
      // its own flag: a real scan that missed some coins is not a snapshot,
      // and App's polls treat the two differently (bug audit 2026-10-27, BL10)
      snapshot: true,
    }
  } catch {
    return null
  }
}

/** Drop one account's snapshot (a removed hardware account). */
export function forgetStateSnapshot(key: string): void {
  const all = readAll()
  if (!(key in all)) return
  delete all[key]
  secureSet(NAME, all)
}

/** Wallet erase clears every kailah.* key; this cache is one of them. */
export function clearStateCache(): void {
  secureRemove(NAME)
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // ignore
  }
}
