// Shared UI-layer types and small helpers. No secrets pass through here.
import type { AccountState, ChainId } from '../lib/types'
import { CHAINS } from '../lib/networks'

/**
 * Per-chain UI slice. `account` is the last successful HD account scan
 * (balance, addresses, utxos, history); null before the first scan lands.
 * `loading`/`error` drive spinners and retry affordances exactly as the
 * balance-only v1 state did.
 */
export interface ChainUiState {
  account: AccountState | null
  loading: boolean
  error: string | null
}

/** Keyed by account slot: a ChainId for seed accounts, 'hw:<id>' for hardware accounts. */
export type ChainStates = Record<string, ChainUiState>

export function initialChainStates(): ChainStates {
  const out = {} as ChainStates
  for (const id of Object.keys(CHAINS) as ChainId[]) {
    out[id] = { account: null, loading: false, error: null }
  }
  return out
}

export function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return 'Something went wrong'
}

/** USD value of an on-chain amount given a spot price. Display only. */
export function coinsToUsd(v: bigint, decimals: number, price: number): number {
  return (Number(v) / 10 ** decimals) * price
}

export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

/** Compact relative time ("just now" / "2h ago" / "3d ago") from unix seconds. */
export function relativeTime(t: number | null): string {
  if (t === null) return ''
  const diff = Math.max(0, Date.now() / 1000 - t)
  if (diff < 45) return 'just now'
  const mins = Math.round(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(diff / 3600)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(diff / 86_400)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(days / 365)}y ago`
}

/** Full local timestamp for detail views; "Pending" when unconfirmed. */
export function absoluteTime(t: number | null): string {
  if (t === null) return 'Pending'
  return new Date(t * 1000).toLocaleString()
}

/** yyyymmdd stamp for export filenames (local date). */
export function yyyymmdd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** Client-side text download (CSV export). */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revocation: revoking synchronously can abort the download before the
  // browser has read the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const MODE_STORAGE_KEY = 'kailah.mode'
export const REAL_ACK_STORAGE_KEY = 'kailah.realAck'
export const STORAGE_NUDGE_KEY = 'kailah.storageNudge'

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — mode just won't persist */
  }
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
