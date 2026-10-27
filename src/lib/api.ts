// api.ts — getClient(chain): a FailoverClient over the chain's ordered
// ProviderApi list (types.ts / networks.ts). Providers are tried in order; the
// last-good one is remembered and tried first next time. BTC mainnet and
// Dogecoin (BlockCypher + Bitcore) have a genuine second provider, and
// Litecoin two backup-only ones (Bitcore, then BlockCypher;
// ProviderApi.backupOnly); testnet4 runs single-provider through the same
// client so the seam is uniform.

import type {
  AccountUtxo,
  ChainConfig,
  ChainId,
  FailoverClient,
  FeeOption,
  ProviderApi,
  RawTxInfo,
  Utxo,
} from './types'
import { EsploraProvider } from './esplora'
import { BlockcypherProvider } from './blockcypher'
import { BitcoreProvider } from './bitcore'
import { readProviderPref, writeProviderPref } from './providerpref'
import { storeSession } from './securestore'

// Shell.tsx clears it on erase from providerpref.ts directly (keeping the
// providers out of the first-load chunk); re-exported for callers of api.ts.
export { clearProviderPref } from './providerpref'

/**
 * Build the ProviderApi list for a chain from its ordered `providers` spec.
 * `kind` selects the implementation; primary is first. Bitcore has no raw
 * transaction endpoint, so it borrows the other providers' (in order) for
 * the funding txs a legacy chain signs with.
 */
export function buildProviders(chain: ChainConfig): ProviderApi[] {
  const providers: ProviderApi[] = []
  const rawHexElsewhere = async (txid: string): Promise<string> => {
    let lastErr: unknown = new Error('no provider serves raw transactions')
    for (const p of providers) {
      if (p instanceof BitcoreProvider) continue
      try {
        return await p.getRawTxHex(txid)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }
  for (const spec of chain.providers) {
    providers.push(
      spec.kind === 'esplora'
        ? new EsploraProvider(spec, chain)
        : spec.kind === 'blockcypher'
          ? new BlockcypherProvider(spec, chain)
          : new BitcoreProvider(spec, chain, rawHexElsewhere),
    )
  }
  return providers
}

class FailoverClientImpl implements FailoverClient {
  private readonly providers: ProviderApi[]
  private readonly persistKey: string | undefined
  /** index of the provider that served the last successful call */
  private activeIndex = 0

  constructor(providers: ProviderApi[], persistKey?: string, tuning?: FailoverTuning) {
    if (providers.length === 0) throw new Error('FailoverClient requires at least one provider')
    this.providers = providers
    this.persistKey = persistKey
    this.backoffMs = tuning?.backoffMs ?? FailoverClientImpl.BACKOFF_MS
    this.maxWaitMs = tuning?.maxWaitMs ?? FailoverClientImpl.MAX_WAIT_MS
    if (persistKey !== undefined) {
      const preferred = readProviderPref(persistKey)
      if (preferred !== null) {
        // a backup is never the starting provider, even if an older build saved it
        const i = providers.findIndex((p) => p.providerName === preferred && p.backupOnly !== true)
        if (i >= 0) this.activeIndex = i
      }
    }
  }

  activeProvider(): string {
    return this.providers[this.activeIndex]?.providerName ?? 'none'
  }

  hasXpubApi(): boolean {
    // Whether the CURRENT healthy provider supports account queries. None do
    // today, so scanner.ts always takes the per-address path — but the seam is
    // preserved so a future Blockbook backend just works.
    return this.providers[this.activeIndex]?.xpub !== undefined
  }

  /**
   * Per-provider cooldown after a network-level failure (timeout / no HTTP
   * response). Without it, every concurrent scanner request re-tries a
   * black-holed provider and each pays the full request timeout — the live
   * mempool.space outage (2026-08-01) turned every Bitcoin refresh into
   * minutes of stalls. Cooled-down providers are skipped while the cooldown
   * lasts, but always remain as last resort so a single-provider chain
   * (testnet4) still gets attempted.
   */
  private static readonly DOWN_COOLDOWN_MS = 60_000
  private downUntil: number[] = []

  /**
   * A rate limit is not an outage. A testnet4 scan used to fail with
   * "Couldn't reach the network data service" (live 2026-10-25): under scan
   * load mempool.space answers some lookups with 429 (CORS-less, so a browser
   * sees only "Load failed") and lets others hang, and its backup
   * mempool.emzy.de rate-limits harder still. Every push-back sent the scan
   * to the other provider, which was refusing too.
   *
   * Push-back from a burstLimited provider pauses that provider for EVERY
   * request, for backoffMs[strikes] (strikes reset on its next success).
   * Push-back is a visible 429 (`rateLimited`), or a network-level failure
   * from a provider that answered within RECENT_OK_MS. A timeout counts only
   * once per request: a second one means the host is down. Requests go to a
   * provider that isn't paused, or wait for the earliest pause to end, within
   * maxWaitMs and MAX_ATTEMPTS. A provider that hasn't answered recently and
   * fails at network level is down, as before (DOWN_COOLDOWN_MS).
   */
  private static readonly RECENT_OK_MS = 30_000
  private static readonly BACKOFF_MS: readonly number[] = [1_500, 4_000, 8_000]
  private static readonly MAX_WAIT_MS = 30_000
  private static readonly MAX_ATTEMPTS = 8
  private readonly backoffMs: readonly number[]
  private readonly maxWaitMs: number
  private lastOkAt: number[] = []
  private pauseUntil: number[] = []
  private strikes: number[] = []

  /**
   * One-time startup probe: ask every provider's tip endpoint at once and
   * start on the first IN THE CONFIGURED ORDER that answers. Without this, a
   * first load during a primary outage sends the whole initial scan burst
   * into a dead host and the user stares at a skeleton while timeouts drain
   * (live incident 2026-08-01). It used to start on whichever answered
   * FIRST, which made the fastest host the daily driver over the configured
   * order (bug audit 2026-10-27, BL8): blockstream.info, listed last for its
   * 700-requests-an-hour cap, could win. All fail → keep the order as it is;
   * run()'s failover handles the rest.
   */
  private probePromise: Promise<void> | null = null

  private ensureProbed(): Promise<void> {
    this.probePromise ??= (async () => {
      // A chain with one regular provider (LTC, testnet4) has no choice to
      // make — skip the probe entirely; a backup is never asked (BlockCypher's
      // hourly budget: every request counts). Dogecoin asks BlockCypher and
      // Bitcore: one tip request each per page load.
      const regular = this.providers.map((_, i) => i).filter((i) => !this.isBackup(i))
      if (regular.length < 2) return
      const session = storeSession()
      const answered = regular.map(async (i) => {
        try {
          const p = this.providers[i]!
          const tip = await Promise.race([
            p.getTipHeight(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3_500)),
          ])
          if (typeof tip !== 'number' || tip <= 0) return false
          this.lastOkAt[i] = Date.now()
          return true
        } catch {
          return false
        }
      })
      for (const [k, i] of regular.entries()) {
        if (!(await answered[k]!)) continue
        if (i !== this.activeIndex && this.persistKey !== undefined && storeSession() === session) {
          writeProviderPref(this.persistKey, this.providers[i]!.providerName)
        }
        this.activeIndex = i
        return
      }
    })()
    return this.probePromise
  }

  private isBackup(i: number): boolean {
    return this.providers[i]?.backupOnly === true
  }

  /** whether the last answer came from a backup (the regular providers were failing) */
  private lastFromBackup = false

  onBackup(): boolean {
    return this.lastFromBackup
  }

  /** Active provider first, then healthy rest, then cooled-down last. */
  private order(): number[] {
    const now = Date.now()
    const all = this.providers.map((_, i) => i)
    const ranked = [this.activeIndex, ...all.filter((i) => i !== this.activeIndex)]
    const healthy = ranked.filter((i) => (this.downUntil[i] ?? 0) <= now)
    const cooling = ranked.filter((i) => (this.downUntil[i] ?? 0) > now)
    return [...healthy, ...cooling]
  }

  /** A failure with no HTTP response — the kind worth a cooldown. */
  private static isNetworkLevel(err: unknown): boolean {
    if (err instanceof TypeError) return true
    const msg = err instanceof Error ? err.message : String(err)
    return /timed? ?out|abort|load failed|failed to fetch|networkerror/i.test(msg)
  }

  /** A deadline or abort: the host hung rather than refused. */
  private static isTimeout(err: unknown): boolean {
    const name = err instanceof Error ? err.name : ''
    const msg = err instanceof Error ? err.message : String(err)
    return name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|abort/i.test(msg)
  }

  /** Push-back from a burstLimited provider: pause it for every request. */
  private pause(i: number): void {
    // Concurrent requests caught in one burst all report it; count it once.
    if ((this.pauseUntil[i] ?? 0) > Date.now()) return
    const strike = this.strikes[i] ?? 0
    this.strikes[i] = strike + 1
    const delay = this.backoffMs[Math.min(strike, this.backoffMs.length - 1)] ?? 0
    this.pauseUntil[i] = Math.max(this.pauseUntil[i] ?? 0, Date.now() + delay)
  }

  /**
   * Run an idempotent read across providers with failover. A provider that
   * answers with an error (5xx and, conservatively, 4xx too; reads are
   * side-effect-free) or is down is skipped for the rest of this request. One
   * that pushes back (see BACKOFF_MS) is paused and retried once the pause
   * ends, unless another provider is free first. Remembers the provider that
   * succeeds as the new active one.
   */
  private async run<T>(label: string, op: (p: ProviderApi) => Promise<T>): Promise<T> {
    const session = storeSession()
    await this.ensureProbed()
    let lastErr: unknown
    const giveUpAt = Date.now() + this.maxWaitMs
    const done = new Set<number>() // answered with an error, or down: not retried in this request
    const timedOut = new Set<number>()
    for (let attempts = 0; attempts < FailoverClientImpl.MAX_ATTEMPTS; ) {
      const now = Date.now()
      const candidates = this.order().filter((i) => !done.has(i))
      if (candidates.length === 0) break
      // A backup steps in only once no regular provider can serve this
      // request (each has failed it or is cooling down); one that is merely
      // paused for a rate limit is waited for instead.
      const regularLeft = candidates.some((c) => !this.isBackup(c) && (this.downUntil[c] ?? 0) <= now)
      const eligible = regularLeft ? candidates.filter((c) => !this.isBackup(c)) : candidates
      const i = eligible.find((c) => (this.pauseUntil[c] ?? 0) <= now)
      // A provider with an hourly budget (BlockCypher) isn't spent to dodge
      // the active provider's brief pause: wait for the pause instead (bug
      // audit 2026-10-27, BM6).
      const a = this.activeIndex
      const activeWake = this.pauseUntil[a] ?? 0
      if (
        i !== undefined &&
        i !== a &&
        this.providers[i]?.budgetLimited === true &&
        eligible.includes(a) &&
        activeWake > now &&
        activeWake <= giveUpAt
      ) {
        await new Promise((r) => setTimeout(r, activeWake - now))
        continue
      }
      if (i === undefined) {
        const wake = Math.min(...eligible.map((c) => this.pauseUntil[c] ?? 0))
        if (wake > giveUpAt) break
        await new Promise((r) => setTimeout(r, wake - now))
        continue
      }
      attempts++
      const provider = this.providers[i]
      try {
        const result = await op(provider)
        this.lastFromBackup = this.isBackup(i)
        if (!this.isBackup(i)) {
          // a backup's success is never remembered: the next request tries
          // the regular providers first again. Nor is anything written once
          // the wallet has locked or been erased since (bug audit BL9).
          if (this.activeIndex !== i && this.persistKey !== undefined && storeSession() === session) {
            writeProviderPref(this.persistKey, provider.providerName)
          }
          this.activeIndex = i
        }
        this.downUntil[i] = 0
        this.lastOkAt[i] = Date.now()
        this.strikes[i] = 0
        return result
      } catch (err) {
        lastErr = err
        const burst = provider.burstLimited === true
        const visible429 = (err as { rateLimited?: unknown } | null)?.rateLimited === true
        const networkLevel = FailoverClientImpl.isNetworkLevel(err)
        const recentlyOk = Date.now() - (this.lastOkAt[i] ?? -Infinity) < FailoverClientImpl.RECENT_OK_MS
        const timeout = networkLevel && FailoverClientImpl.isTimeout(err)
        // A visible 429 is push-back from any provider (Bitcore's limiter
        // answers 429 with CORS: it was handled as an outage and sent the
        // scan to BlockCypher's budget; bug audit 2026-10-27, BM6) except
        // one with an hourly budget, where a 429 means the hour is spent; a
        // bare network error counts only from a burst-limited one.
        const pushBack =
          (visible429 && provider.budgetLimited !== true) ||
          (burst && networkLevel && recentlyOk && !(timeout && timedOut.has(i)))
        if (pushBack) {
          if (timeout) timedOut.add(i)
          this.pause(i)
          continue
        }
        if (networkLevel) this.downUntil[i] = Date.now() + FailoverClientImpl.DOWN_COOLDOWN_MS
        done.add(i)
      }
    }
    // Network-level failures ("Load failed" / "Failed to fetch" / timeouts)
    // are also what a CORS-less rate-limit response looks like from a browser —
    // BlockCypher's 429s carry no CORS headers. Say something a human can act on.
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
    const networky =
      (lastErr as { rateLimited?: unknown } | null)?.rateLimited === true ||
      /load failed|failed to fetch|networkerror|timed? ?out|abort/i.test(detail)
    throw new Error(
      networky
        ? `Couldn't reach the network data service — it may be busy or rate-limited. ` +
          `Your coins are safe; try again in a few minutes.`
        : `All providers failed for ${label}: ${detail}`,
    )
  }

  getAddressStats(address: string) {
    return this.run('getAddressStats', (p) => p.getAddressStats(address))
  }

  getAddressUtxos(address: string): Promise<Utxo[]> {
    return this.run('getAddressUtxos', (p) => p.getAddressUtxos(address))
  }

  getAddressTxs(address: string): Promise<RawTxInfo[]> {
    return this.run('getAddressTxs', (p) => p.getAddressTxs(address))
  }

  getRawTxHex(txid: string): Promise<string> {
    return this.run('getRawTxHex', (p) => p.getRawTxHex(txid))
  }

  getTxOutspends(txid: string): Promise<{ spent: boolean; txid: string | null; confirmed: boolean }[]> {
    return this.run('getTxOutspends', (p) => {
      if (p.getTxOutspends === undefined) throw new Error(`${p.providerName}: outspends unsupported`)
      return p.getTxOutspends(txid)
    })
  }

  getTxFee(txid: string): Promise<bigint | null> {
    return this.run('getTxFee', (p) => {
      if (p.getTxFee === undefined) throw new Error(`${p.providerName}: tx fee lookup unsupported`)
      return p.getTxFee(txid)
    })
  }

  getTipHeight(): Promise<number> {
    return this.run('getTipHeight', (p) => p.getTipHeight())
  }

  txSeen(txid: string): Promise<boolean> {
    return this.run('txSeen', (p) => p.txSeen(txid))
  }

  getFeeOptions(): Promise<FeeOption[]> {
    return this.run('getFeeOptions', (p) => p.getFeeOptions())
  }

  /**
   * Broadcast is NOT a blind read-style failover: double-sending a signed tx to
   * two backends is harmless on-chain (same txid) but a rejection from the first
   * node is authoritative and must be shown, not masked by a second attempt.
   *
   * Rule: try the active provider; if it returns ANY HTTP response — success or
   * error — stop there. Only a CLEAR network failure (fetch rejects with a
   * TypeError: DNS/connection/CORS, so nothing ever reached a node) is safe to
   * retry on the next provider.
   */
  async broadcast(txHex: string): Promise<string> {
    let lastNetworkErr: unknown
    for (const i of this.order()) {
      const provider = this.providers[i]
      try {
        const txid = await provider.broadcast(txHex)
        if (!this.isBackup(i)) this.activeIndex = i
        return txid
      } catch (err) {
        if (err instanceof TypeError) {
          // Network/CORS: the request never reached a node — safe to try next.
          lastNetworkErr = err
          continue
        }
        // An HTTP response came back (even a rejection). Surface it; do NOT
        // fail over — the tx may already be in the first node's mempool.
        throw err
      }
    }
    const detail = lastNetworkErr instanceof Error ? lastNetworkErr.message : String(lastNetworkErr)
    throw new Error(`Broadcast failed: could not reach any provider (${detail})`)
  }

  // -- Account (xpub) surface -------------------------------------------------
  // No configured provider implements XpubApi today. scanner.ts checks
  // hasXpubApi() (false) and never calls these; they throw clearly if it does.

  scanXpub: FailoverClient['scanXpub'] = async (xpub: string) => {
    const provider = this.providers.find((p) => p.xpub !== undefined)
    if (!provider || !provider.xpub) {
      throw new Error(
        'Account (xpub) queries are not supported by any provider for this chain; ' +
          'use per-address scanning.',
      )
    }
    return provider.xpub.scanXpub(xpub)
  }

  getXpubUtxos: FailoverClient['getXpubUtxos'] = async (xpub: string): Promise<AccountUtxo[]> => {
    const provider = this.providers.find((p) => p.xpub !== undefined)
    if (!provider || !provider.xpub) {
      throw new Error(
        'Account (xpub) queries are not supported by any provider for this chain; ' +
          'use per-address scanning.',
      )
    }
    return provider.xpub.getXpubUtxos(xpub)
  }
}

/**
 * Construct a FailoverClient from an explicit provider list. Used by getClient
 * and by tests that want to force a specific ordering (e.g. bad-first failover).
 * `tuning` shortens the rate-limit backoff for tests.
 */
export function createFailoverClient(
  providers: ProviderApi[],
  persistKey?: string,
  tuning?: FailoverTuning,
): FailoverClient {
  return new FailoverClientImpl(providers, persistKey, tuning)
}

/** Rate-limit timing overrides (tests only). */
export interface FailoverTuning {
  /** pause after the 1st, 2nd, 3rd+ push-back in a row */
  backoffMs?: readonly number[]
  /** longest one request waits for paused providers before giving up */
  maxWaitMs?: number
}

const clients = new Map<ChainId, FailoverClient>()

/** Return the FailoverClient for a chain, constructing it once per chain id. */
export function getClient(chain: ChainConfig): FailoverClient {
  const existing = clients.get(chain.id)
  if (existing) return existing
  const client = createFailoverClient(buildProviders(chain), chain.id)
  clients.set(chain.id, client)
  return client
}
