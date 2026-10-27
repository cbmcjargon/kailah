// Account scanner: turn an HD account + a failover client into an AccountState.
//
// Uniform per-address, gap-limit scan for every chain (esplora and blockcypher
// alike). For each branch we walk addresses from index 0, querying per-address
// stats, and stop after GAP_LIMIT consecutive unused addresses (BIP44 gap rule).
// The addrcache seeds the frontier so a warm scan (a) skips a long empty prefix
// and (b) keeps scanning past a hole wider than the gap limit when a higher
// index is already known used — both critical for staying inside DOGE's tight
// BlockCypher request budget.

import type {
  AccountAddressInfo,
  WatchAccountKeys,
  AccountState,
  AccountUtxo,
  Balance,
  FailoverClient,
  RawTxInfo,
  TxSummary,
} from './types'
// Sibling module (history.ts) — may not exist yet; its absence is the only
// acceptable tsc error for this file. classifyTxs turns the deduped raw txs
// into signed, newest-first TxSummary rows using tipHeight for confirmations.
import { classifyTxs } from './history'
import * as addrcache from './addrcache'

/** BIP44 address gap limit. */
const GAP_LIMIT = 20

// ---------------------------------------------------------------------------
// Tip-height cache. The tip call opens every scan; when the provider is busy
// (BlockCypher's CORS-less 429s read as network failures in a browser) a
// slightly stale tip is far better than failing the whole scan — confirmation
// counts drift by a few blocks at worst. Fresh entries also skip the live call
// entirely, saving one request per scan on DOGE's tight budget.

const TIP_CACHE_KEY = 'kailah.tipcache.v1'
const TIP_FRESH_MS = 10 * 60 * 1000

function readTipCache(): Record<string, { h: number; at: number }> {
  try {
    const raw = localStorage.getItem(TIP_CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, { h: number; at: number }>)
      : {}
  } catch {
    return {}
  }
}

function writeTipCache(chain: string, h: number): void {
  try {
    const map = readTipCache()
    map[chain] = { h, at: Date.now() }
    localStorage.setItem(TIP_CACHE_KEY, JSON.stringify(map))
  } catch {
    // best-effort cache
  }
}

/** Wallet erase clears every kailah.* key; the tip cache is one of them. */
export function clearTipCache(): void {
  try {
    localStorage.removeItem(TIP_CACHE_KEY)
  } catch {
    // ignore
  }
}

async function resolveTipHeight(chain: string, client: FailoverClient): Promise<number> {
  const cached = readTipCache()[chain]
  if (cached && typeof cached.h === 'number' && Date.now() - cached.at < TIP_FRESH_MS) {
    return cached.h
  }
  try {
    const h = await client.getTipHeight()
    writeTipCache(chain, h)
    return h
  } catch (e) {
    if (cached && typeof cached.h === 'number') return cached.h
    throw e
  }
}
/** Parallel per-address queries for esplora chains. */
const ESPLORA_CONCURRENCY = 4
/** Hard ceiling so a misbehaving provider can never drive an unbounded scan. */
const MAX_INDEX = 1000

type Branch = 0 | 1

interface AddrStats {
  balance: Balance
  txCount: number
}

/** An address counts as used if it has any history or any balance. */
function isUsed(s: AddrStats): boolean {
  return s.txCount > 0 || s.balance.confirmed !== 0n || s.balance.unconfirmed !== 0n
}

/** Ascending list of used indices from a scanned branch's stats map. */
function usedIndices(stats: Map<number, AddrStats>): number[] {
  return [...stats.entries()]
    .filter(([, s]) => isUsed(s))
    .map(([i]) => i)
    .sort((a, b) => a - b)
}

/** Smallest non-negative index not present in `used` (the fresh address). */
function lowestUnused(used: number[]): number {
  const set = new Set(used)
  let i = 0
  while (set.has(i)) i++
  return i
}

/**
 * Fresh index for a branch, hardened on both sides against a lying provider:
 *  • computed over the UNION of this scan and the pre-scan cache, so a
 *    provider that HIDES usage can't make the wallet silently reuse a
 *    previously used address;
 *  • capped at GAP_LIMIT−1 past the cache's own frontier, so a provider that
 *    INVENTS a long run of fake-used addresses can't push change/receive
 *    beyond the standard recovery gap — a seed restored elsewhere scans
 *    GAP_LIMIT consecutive unused addresses and stops, and funds past that
 *    would be invisible to every wallet. The capped index always lands within
 *    one recovery gap of the previously known frontier, and once real funds
 *    sit there the next cap window anchors on them.
 * The cap needs a baseline, so a cold scan (empty cache — first contact on
 * this device) runs uncapped: a restored wallet with deep history must get
 * its true frontier, not index GAP_LIMIT−1. The residual window — a provider
 * lying during that one first scan — is accepted and far narrower than lying
 * on any later pre-send scan, which the cap covers.
 */
function cappedLowestUnused(scanUsed: number[], cacheUsed: number[]): number {
  const union = lowestUnused([...scanUsed, ...cacheUsed])
  const capped =
    cacheUsed.length === 0 ? union : Math.min(union, lowestUnused(cacheUsed) + GAP_LIMIT - 1)
  // Never beyond MAX_INDEX: an index past the scan ceiling would be invisible
  // even to this wallet forever after.
  return Math.min(capped, MAX_INDEX)
}

/**
 * Bounded-concurrency worker pool that preserves the cap. With limit === 1 it
 * runs fully sequentially in item order (used for BlockCypher/DOGE).
 */
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, limit)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      await fn(items[idx]!)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(size, items.length); w++) workers.push(worker())
  await Promise.all(workers)
}

/**
 * Gap-limit scan of one branch. Returns per-index stats for every address it
 * touched. Seeds from the cache: never stops before passing `seedCeiling`, and
 * treats a cached-used index that fails to load as used (so a transient outage
 * can't drop a known address). A non-cached frontier probe that fails after
 * failover is fatal — we cannot know the gap, so the frontier is undetermined.
 */
async function scanBranch(
  account: WatchAccountKeys,
  client: FailoverClient,
  branch: Branch,
  seedCeiling: number,
  knownUsed: Set<number>,
  concurrency: number,
): Promise<{ stats: Map<number, AddrStats>; balanceIncomplete: boolean }> {
  const statsByIndex = new Map<number, AddrStats>()
  let balanceIncomplete = false
  const batchSize = Math.max(1, concurrency)
  let index = 0
  let consecutiveUnused = 0

  while (index <= MAX_INDEX) {
    const batch: number[] = []
    for (let k = 0; k < batchSize && index + k <= MAX_INDEX; k++) batch.push(index + k)

    const results = await Promise.all(
      batch.map(async (i) => {
        try {
          const address = account.address(branch, i).address
          const stats = await client.getAddressStats(address)
          return { i, stats, ok: true as const }
        } catch (err) {
          return { i, err, ok: false as const }
        }
      }),
    )

    // Process in index order so the consecutive-unused counter is exact.
    for (const r of results) {
      if (!r.ok) {
        if (knownUsed.has(r.i)) {
          // Known used from the cache — keep it, balance unknown (0), reset gap.
          // Its real balance is unknown, so the account total may be undercounted.
          statsByIndex.set(r.i, { balance: { confirmed: 0n, unconfirmed: 0n }, txCount: 1 })
          balanceIncomplete = true
          consecutiveUnused = 0
          continue
        }
        // When the failover client already produced a user-readable message
        // (rate-limit/network copy), pass it through untouched — prefixing it
        // with branch/index internals just adds noise to the error card.
        if (r.err instanceof Error && /coins are safe/i.test(r.err.message)) {
          throw r.err
        }
        const detail = r.err instanceof Error ? `: ${r.err.message}` : ''
        throw new Error(
          `Scan of ${account.chain} branch ${branch} could not reach any provider ` +
            `for index ${r.i}${detail}`,
        )
      }
      statsByIndex.set(r.i, r.stats)
      if (isUsed(r.stats)) consecutiveUnused = 0
      else consecutiveUnused++
    }

    index += batch.length

    // Stop only once we've both seen a full gap AND moved past any cache-seeded
    // used index (guards against a hole wider than the gap limit below it).
    if (consecutiveUnused >= GAP_LIMIT && index > seedCeiling) break
  }

  return { stats: statsByIndex, balanceIncomplete }
}

/**
 * Cheap change detector for background polling. Probes only the cache-known
 * used addresses plus each branch's next-unused address (a payment can only
 * land on an address the wallet has shown someone). Unchanged → the caller
 * reuses the previous AccountState untouched, costing a handful of requests
 * instead of a full gap walk — the difference between staying inside and
 * blowing through BlockCypher's ~100/hour DOGE budget.
 */
async function quickUnchanged(
  account: WatchAccountKeys,
  client: FailoverClient,
  prev: AccountState,
): Promise<boolean> {
  try {
    const cache = addrcache.get(account.xpubs.xpub)
    const probes: { branch: Branch; index: number }[] = [
      ...cache.receive.map((i) => ({ branch: 0 as Branch, index: i })),
      ...cache.change.map((i) => ({ branch: 1 as Branch, index: i })),
      { branch: 0, index: lowestUnused(cache.receive) },
      { branch: 1, index: lowestUnused(cache.change) },
    ]
    let confirmed = 0n
    let unconfirmed = 0n
    let frontierMoved = false
    // Probes run through the same bounded pool as full scans: sequential for
    // DOGE's budget, parallel for esplora — a background poll on a wallet with
    // many used addresses was taking seconds serially.
    const probeConcurrency = account.chain === 'doge' ? 1 : ESPLORA_CONCURRENCY
    await runPool(probes, probeConcurrency, async (p) => {
      const s = await client.getAddressStats(account.address(p.branch, p.index).address)
      confirmed += s.balance.confirmed
      unconfirmed += s.balance.unconfirmed
      const known = (p.branch === 0 ? cache.receive : cache.change).includes(p.index)
      if (!known && isUsed(s)) frontierMoved = true
    })
    return (
      !frontierMoved &&
      confirmed === prev.balance.confirmed &&
      unconfirmed === prev.balance.unconfirmed
    )
  } catch {
    // Any probe failure → report "changed" so the caller runs the full scan,
    // which has proper error handling and partial-failure flags.
    return false
  }
}

/**
 * Scan an HD account into a full AccountState: balance, used addresses, fresh
 * receive/change, annotated utxos, and classified transaction history.
 *
 * With opts.quickCheckAgainst, a cheap change-detection pass runs first and,
 * when nothing changed, the previous state is returned as-is (same object).
 */
export async function scanAccount(
  account: WatchAccountKeys,
  client: FailoverClient,
  opts?: { quickCheckAgainst?: AccountState },
): Promise<AccountState> {
  const prev = opts?.quickCheckAgainst
  if (prev !== undefined && (await quickUnchanged(account, client, prev))) {
    return prev
  }

  // Tip height: needed for confirmation math. Served from a short-lived cache
  // when fresh; falls back to the last known value if the live call fails, so
  // a busy provider degrades confirmations slightly instead of killing scans.
  const tipHeight = await resolveTipHeight(account.chain, client)

  const cache = addrcache.get(account.xpubs.xpub)

  // DOGE reads from BlockCypher (~100-200 req/hour free tier) and Bitcore (no
  // published budget), so scan it strictly sequentially (both providers also
  // self-throttle) and lean on the cache. Esplora chains parallelize a small
  // batch.
  //
  // Call budget (DOGE): cold empty account ~= GAP_LIMIT stats probes per branch
  // (~40 getAddressStats, no utxo/tx calls since nothing is used). Active
  // account ~= (used addresses) x (stats + utxos + txs) + ~GAP_LIMIT frontier
  // probes per branch. A small personal wallet stays well under the ceiling; a
  // warm scan touches only known-used addresses plus one bounded gap probe.
  const concurrency = account.chain === 'doge' ? 1 : ESPLORA_CONCURRENCY

  // Esplora chains walk both branches at once (peak = 2 x concurrency
  // requests, still polite); DOGE keeps them strictly sequential for the
  // BlockCypher budget.
  const scanReceive = () =>
    scanBranch(account, client, 0, cache.highestReceive, new Set(cache.receive), concurrency)
  const scanChange = () =>
    scanBranch(account, client, 1, cache.highestChange, new Set(cache.change), concurrency)
  let receiveScan: Awaited<ReturnType<typeof scanReceive>>
  let changeScan: Awaited<ReturnType<typeof scanChange>>
  if (concurrency === 1) {
    receiveScan = await scanReceive()
    changeScan = await scanChange()
  } else {
    ;[receiveScan, changeScan] = await Promise.all([scanReceive(), scanChange()])
  }
  const receiveStats = receiveScan.stats
  const changeStats = changeScan.stats
  const balanceIncomplete = receiveScan.balanceIncomplete || changeScan.balanceIncomplete

  const usedReceive = usedIndices(receiveStats)
  const usedChange = usedIndices(changeStats)

  // Persist discovered used indices so the next scan starts warm.
  addrcache.update(account.xpubs.xpub, { receive: usedReceive, change: usedChange })

  // Balance = sum over every used address on both branches.
  let confirmed = 0n
  let unconfirmed = 0n
  for (const i of usedReceive) {
    const s = receiveStats.get(i)!
    confirmed += s.balance.confirmed
    unconfirmed += s.balance.unconfirmed
  }
  for (const i of usedChange) {
    const s = changeStats.get(i)!
    confirmed += s.balance.confirmed
    unconfirmed += s.balance.unconfirmed
  }
  const balance: Balance = { confirmed, unconfirmed }

  // Fresh receive/change: lowest unused over scan ∪ pre-scan cache, with the
  // frontier capped near the cache's own frontier (see cappedLowestUnused —
  // `cache` was read before this scan's addrcache.update, which is the point).
  const nextReceiveIndex = cappedLowestUnused(usedReceive, cache.receive)
  const nextChangeIndex = cappedLowestUnused(usedChange, cache.change)
  const nextReceive: AccountAddressInfo = {
    address: account.address(0, nextReceiveIndex).address,
    branch: 0,
    index: nextReceiveIndex,
    used: false,
  }
  const nextChange: AccountAddressInfo = {
    address: account.address(1, nextChangeIndex).address,
    branch: 1,
    index: nextChangeIndex,
    used: false,
  }

  // Used addresses (both branches) plus the two fresh addresses, for the UI.
  const usedAddrs: { address: string; branch: Branch; index: number }[] = [
    ...usedReceive.map((i) => ({ address: account.address(0, i).address, branch: 0 as Branch, index: i })),
    ...usedChange.map((i) => ({ address: account.address(1, i).address, branch: 1 as Branch, index: i })),
  ]
  const addresses: AccountAddressInfo[] = [
    ...usedAddrs.map((a) => ({ address: a.address, branch: a.branch, index: a.index, used: true })),
    nextReceive,
    nextChange,
  ]

  // Union utxos and gather txs over the used addresses. A single-address
  // failure here is tolerated: partial balances/history are still useful, so we
  // skip that address rather than abort the whole scan.
  const utxos: AccountUtxo[] = []
  const rawByTxid = new Map<string, RawTxInfo>()
  let utxosIncomplete = false
  await runPool(usedAddrs, concurrency, async (a) => {
    // The two per-address reads are independent; esplora chains fetch them
    // together, DOGE (concurrency 1) keeps them serial for the budget.
    const fetchUtxos = async () => {
      try {
        const us = await client.getAddressUtxos(a.address)
        for (const u of us) utxos.push({ ...u, address: a.address, branch: a.branch, index: a.index })
      } catch {
        // A used address whose utxos we couldn't fetch means the spendable set is
        // short — flag it so a MAX sweep can warn instead of underspending.
        utxosIncomplete = true
      }
    }
    const fetchTxs = async () => {
      try {
        const txs = await client.getAddressTxs(a.address)
        for (const t of txs) if (!rawByTxid.has(t.txid)) rawByTxid.set(t.txid, t)
      } catch {
        // History is non-critical; a missing address's txs only trims the list.
      }
    }
    if (concurrency === 1) {
      await fetchUtxos()
      await fetchTxs()
    } else {
      await Promise.all([fetchUtxos(), fetchTxs()])
    }
  })

  const rawTxs = [...rawByTxid.values()]
  const ours = new Set<string>(usedAddrs.map((a) => a.address))
  const txs: TxSummary[] = classifyTxs(rawTxs, ours, tipHeight)

  return {
    balance,
    addresses,
    nextReceive,
    nextChange,
    utxos,
    txs,
    rawTxs,
    tipHeight,
    incomplete: { balance: balanceIncomplete, utxos: utxosIncomplete },
  }
}
