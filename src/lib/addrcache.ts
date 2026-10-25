// Warm-scan address cache for HD accounts.
//
// Persists, per account, the set of receive/change indices already known to be
// USED. A warm scan seeds its frontier from this map so it can (a) skip probing
// a long empty range from index 0 and (b) keep scanning past a gap wider than
// the gap limit when we already know a higher index was used. Both matter most
// for DOGE, where BlockCypher's free tier is ~100-200 requests/hour.
//
// Everything stored here is PUBLIC on-chain data (xpubs, addresses, indices)
// — but it maps the whole wallet, so it lives in the encrypted secure store
// (securestore.ts): ciphertext while locked, decrypted into memory on unlock.
// A miss, a wrong key, or tampering must always degrade to a correct-but-cold
// scan, never throw.

import { secureGet, secureRemove, secureSet } from './securestore'

/** pre-encryption plaintext key; removed on erase and on first encrypted write */
const LEGACY_STORAGE_KEY = 'kailah.addrmap.v1'
const NAME = 'addrmap'

/** Known-used indices for one account, keyed by its standard xpub. */
export interface AddrMapEntry {
  /** receive-branch (0) indices observed as used, ascending & deduped */
  receive: number[]
  /** change-branch (1) indices observed as used, ascending & deduped */
  change: number[]
  /** highest used receive index, or -1 when none */
  highestReceive: number
  /** highest used change index, or -1 when none */
  highestChange: number
}

type AddrMap = Record<string, AddrMapEntry>

/** An empty, well-formed entry (used for cold accounts and on any read error). */
function emptyEntry(): AddrMapEntry {
  return { receive: [], change: [], highestReceive: -1, highestChange: -1 }
}

/** localStorage handle, or null when storage is unavailable (e.g. Node). */
function storage(): Storage | null {
  try {
    // `localStorage` is undefined in Node and can throw on access in sandboxed
    // frames; treat every failure mode as "no cache".
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/**
 * Highest index the cache will ever store. Bounds a cold scan's work: a corrupt
 * or maliciously-written entry (same-origin XSS/extension) with an absurd index
 * must not force the scanner to probe thousands of addresses — which on DOGE
 * would exhaust BlockCypher's hourly budget. Far above any real wallet's usage.
 */
const MAX_CACHED_INDEX = 1000

/** Coerce arbitrary parsed JSON into a clean, ascending, deduped, bounded list. */
function cleanIndices(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  for (const v of value) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_CACHED_INDEX) {
      seen.add(v)
    }
  }
  return [...seen].sort((a, b) => a - b)
}

function highest(indices: number[]): number {
  return indices.length > 0 ? indices[indices.length - 1]! : -1
}

function normalizeEntry(value: unknown): AddrMapEntry {
  const obj = (value && typeof value === 'object' ? value : {}) as Partial<AddrMapEntry>
  const receive = cleanIndices(obj.receive)
  const change = cleanIndices(obj.change)
  return { receive, change, highestReceive: highest(receive), highestChange: highest(change) }
}

function readMap(): AddrMap {
  try {
    const parsed = secureGet(NAME)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: AddrMap = {}
    for (const [xpub, entry] of Object.entries(parsed as Record<string, unknown>)) {
      out[xpub] = normalizeEntry(entry)
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(map: AddrMap): void {
  secureSet(NAME, map)
  // the plaintext predecessor must not outlive the first encrypted write
  try {
    storage()?.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Known-used indices for an account (by standard xpub). Always returns a
 * well-formed entry; a miss or any storage error yields an empty one.
 */
export function get(accountXpub: string): AddrMapEntry {
  const map = readMap()
  return map[accountXpub] ?? emptyEntry()
}

/**
 * Merge freshly discovered used indices into the account's entry. Union with
 * whatever was already stored so a partial scan never forgets earlier finds.
 */
export function update(
  accountXpub: string,
  used: { receive?: number[]; change?: number[] },
): void {
  const map = readMap()
  const prev = map[accountXpub] ?? emptyEntry()
  const receive = cleanIndices([...prev.receive, ...(used.receive ?? [])])
  const change = cleanIndices([...prev.change, ...(used.change ?? [])])
  map[accountXpub] = {
    receive,
    change,
    highestReceive: highest(receive),
    highestChange: highest(change),
  }
  writeMap(map)
}

/** Drop one account's entry (a removed hardware account). */
export function forget(accountXpub: string): void {
  const map = readMap()
  if (!(accountXpub in map)) return
  delete map[accountXpub]
  writeMap(map)
}

/** Drop the entire address map. Called on wallet erase. */
export function clearAll(): void {
  secureRemove(NAME)
  try {
    storage()?.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Nothing more we can do; ignore.
  }
}
