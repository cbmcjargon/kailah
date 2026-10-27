// Esplora ProviderApi implementation (BTC mainnet + testnet4, LTC).
//
// One instance per ProviderSpec so a chain with several esplora backends
// (BTC: mempool.space -> blockstream.info) becomes several EsploraProvider
// instances that api.ts fails over between. Implements the per-address
// AddressApi surface from types.ts; no account (xpub) endpoint here, so the
// optional ProviderApi.xpub stays absent.
//
// Endpoint shapes verified live from the wallet origin (2026-07-20):
//   /address/{a}          -> { chain_stats:{funded_txo_sum,spent_txo_sum,tx_count},
//                              mempool_stats:{funded_txo_sum,spent_txo_sum,tx_count} }
//   /address/{a}/utxo     -> [{ txid, vout, value, status:{confirmed} }]
//   /address/{a}/txs      -> newest-first tx objects (mempool first);
//                            first page 50 (mempool.space) or 25 (blockstream)
//   /address/{a}/txs/chain/{last_txid} -> next 25 confirmed txs
//   /tx/{txid}/hex        -> raw tx hex (text/plain)
//   /blocks/tip/height    -> integer (text/plain)
//   /v1/fees/recommended  -> { fastestFee, halfHourFee, hourFee } (mempool.space)
//   /fee-estimates        -> { "<confTarget>": sat/vB } (blockstream, litecoinspace)
//   POST /tx (text/plain hex) -> txid; non-200 body is a readable reason

import type {
  Balance,
  ChainConfig,
  FeeOption,
  ProviderApi,
  ProviderSpec,
  RawTxInfo,
  Utxo,
  XpubApi,
} from './types'

// ---------------------------------------------------------------------------
// Wire shapes

interface EsploraTxoStats {
  funded_txo_sum: number
  spent_txo_sum: number
  tx_count: number
}

interface EsploraAddressInfo {
  chain_stats: EsploraTxoStats
  mempool_stats: EsploraTxoStats
}

interface EsploraUtxo {
  txid: string
  vout: number
  value: number
  status?: { confirmed?: boolean }
}

interface EsploraVin {
  txid?: string
  vout?: number
  sequence?: number
  prevout?: { scriptpubkey_address?: string; value?: number } | null
}

interface EsploraVout {
  scriptpubkey_address?: string
  value?: number
}

interface EsploraTx {
  txid: string
  status?: { confirmed?: boolean; block_height?: number; block_time?: number }
  fee?: number
  vin: EsploraVin[]
  vout: EsploraVout[]
}

interface EsploraRecommendedFees {
  fastestFee: number
  halfHourFee: number
  hourFee: number
}

// ---------------------------------------------------------------------------
// Fee-rate normalization: round up, floor at 1, and clamp to an anti-tamper
// ceiling so a compromised/MITM'd fee endpoint can't build an absurd-fee tx.
// 1000 sat/vB sits above every sustained congestion peak to date (the Apr-2024
// spike touched ~2000 for a few blocks); a tampered fee API can cost at most
// ~1000 × vsize, and a user can simply wait out anything higher.

const MAX_FEE_RATE = 1000n

export function toRate(satPerVb: number): bigint {
  const n = Number.isFinite(satPerVb) ? satPerVb : 1
  const ceiled = Math.ceil(n)
  const rate = ceiled >= 1 ? BigInt(ceiled) : 1n
  return rate > MAX_FEE_RATE ? MAX_FEE_RATE : rate
}

// esplora /txs/chain pages always return 25 confirmed txs; cap total paging so
// a personal wallet never walks an entire whale address's history.
const CHAIN_PAGE_SIZE = 25

/** AbortSignal.timeout is missing on older Safari — degrade to no deadline. */
function deadline(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined
}
const MAX_TX_PAGES = 5

export class EsploraProvider implements ProviderApi {
  readonly providerName: string
  // No account endpoint on esplora — the seam stays open (xpub undefined) so
  // api.ts reports hasXpubApi()===false and scans per-address instead.
  readonly xpub: XpubApi | undefined = undefined
  // mempool.space and friends shed scan bursts with brief, CORS-less 429s.
  readonly burstLimited = true

  private readonly base: string
  private readonly spec: ProviderSpec
  // Which fee endpoint this host serves, discovered on first getFeeOptions call.
  // mempool.space & litecoinspace expose /v1/fees/recommended; genuine esplora
  // (blockstream.info) exposes /fee-estimates — each 404s on the other's path.
  private feeStyle: 'recommended' | 'estimates' | undefined

  constructor(spec: ProviderSpec, _chain: ChainConfig) {
    this.spec = spec
    this.base = spec.base
    this.providerName = spec.name
  }

  // -------------------------------------------------------------------------
  // Low-level fetch: read the body even on non-2xx and fold it into the thrown
  // error (esplora error bodies are short human-readable reasons). Network /
  // CORS failures let fetch's TypeError propagate untouched so api.ts can tell
  // "no HTTP response" (safe to fail over) from "server rejected us".

  /**
   * Hard per-request deadline. Browsers otherwise wait 60–130s for a
   * black-holed host before erroring, which stalled every Bitcoin refresh for
   * minutes when mempool.space went unreachable (live incident 2026-08-01);
   * with the deadline, failover to the next provider costs seconds.
   */
  private static readonly REQUEST_TIMEOUT_MS = 10_000

  private async getText(path: string): Promise<string> {
    const res = await fetch(this.base + path, {
      signal: deadline(EsploraProvider.REQUEST_TIMEOUT_MS),
    })
    if (res.status === 429) {
      // Rate-limited, not down. The FailoverClient pauses this provider for
      // every request and retries after backing off (burstLimited). When the
      // 429 carries no CORS headers, a browser never gets here and fetch
      // throws a TypeError instead; the client handles that case too.
      throw Object.assign(new Error(`${this.providerName}: rate limited (HTTP 429)`), {
        rateLimited: true,
      })
    }
    const text = await res.text()
    if (!res.ok) {
      const reason = text.trim().slice(0, 200)
      throw Object.assign(
        new Error(
          reason
            ? `${this.providerName}: ${reason}`
            : `${this.providerName} API error (HTTP ${res.status})`,
        ),
        // an explicit not-found, which txSeen reads as "not seen"
        res.status === 404 ? { notFound: true } : {},
      )
    }
    return text
  }

  async txSeen(txid: string): Promise<boolean> {
    try {
      // /tx/:txid, not /tx/:txid/status: mempool.space and blockstream answer
      // the status path with 200 {"confirmed":false} for a txid that never
      // existed, which made every attempt "seen" and switched the double-pay
      // guard off (bug audit 2026-10-27, BH1). /tx/:txid 404s instead.
      await this.getText(`/tx/${encodeURIComponent(txid)}`)
      return true
    } catch (e) {
      if ((e as { notFound?: unknown } | null)?.notFound === true) return false
      throw e
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    return JSON.parse(await this.getText(path)) as T
  }

  // -------------------------------------------------------------------------
  // AddressApi

  async getAddressStats(address: string): Promise<{ balance: Balance; txCount: number }> {
    const info = await this.getJson<EsploraAddressInfo>(
      `/address/${encodeURIComponent(address)}`,
    )
    const c = info.chain_stats
    const m = info.mempool_stats
    return {
      balance: {
        confirmed: BigInt(c.funded_txo_sum) - BigInt(c.spent_txo_sum),
        // Signed: legitimately negative while a spend of confirmed coins sits
        // in the mempool (mempool spent > mempool funded).
        unconfirmed: BigInt(m.funded_txo_sum) - BigInt(m.spent_txo_sum),
      },
      txCount: c.tx_count + m.tx_count,
    }
  }

  async getAddressUtxos(address: string): Promise<Utxo[]> {
    // Includes unconfirmed utxos so the wallet can spend its own pending change.
    // Segwit signing only needs the prevout amount, so no rawTxHex is fetched.
    const utxos = await this.getJson<EsploraUtxo[]>(
      `/address/${encodeURIComponent(address)}/utxo`,
    )
    return utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      confirmed: u.status?.confirmed !== false,
    }))
  }

  async getAddressTxs(address: string): Promise<RawTxInfo[]> {
    const enc = encodeURIComponent(address)
    const firstPageFull = this.spec.pageSize ?? CHAIN_PAGE_SIZE
    const raw: EsploraTx[] = []

    let page = await this.getJson<EsploraTx[]>(`/address/${enc}/txs`)
    raw.push(...page)
    let pages = 1
    let lastWasFull = page.length >= firstPageFull

    // Page confirmed history via /txs/chain/{last_seen_txid} (25 each) while the
    // previous page was full. Hard cap at MAX_TX_PAGES (5) — plenty for a
    // personal wallet, and it bounds requests against a huge address.
    while (lastWasFull && pages < MAX_TX_PAGES && raw.length > 0) {
      // The chain endpoint pages by the last CONFIRMED txid; the first page
      // lists mempool txs first, so with no confirmed history yet there is
      // nothing to page from.
      const lastConfirmed = [...raw].reverse().find((t) => t.status?.block_height != null)
      if (lastConfirmed === undefined) break
      page = await this.getJson<EsploraTx[]>(`/address/${enc}/txs/chain/${lastConfirmed.txid}`)
      if (page.length === 0) break
      raw.push(...page)
      pages += 1
      lastWasFull = page.length >= CHAIN_PAGE_SIZE
    }

    // Dedupe by txid (defensive: paging boundaries could theoretically repeat).
    const seen = new Set<string>()
    const out: RawTxInfo[] = []
    for (const t of raw) {
      if (seen.has(t.txid)) continue
      seen.add(t.txid)
      out.push(toRawTxInfo(t))
    }
    return out
  }

  async getTxOutspends(
    txid: string,
  ): Promise<{ spent: boolean; txid: string | null; confirmed: boolean }[]> {
    const raw = await this.getJson<
      { spent?: boolean; txid?: string; status?: { confirmed?: boolean } }[]
    >(`/tx/${encodeURIComponent(txid)}/outspends`)
    return raw.map((o) => ({
      spent: o.spent === true,
      txid: o.txid ?? null,
      confirmed: o.status?.confirmed === true,
    }))
  }

  async getTxFee(txid: string): Promise<bigint | null> {
    const tx = await this.getJson<{ fee?: number }>(`/tx/${encodeURIComponent(txid)}`)
    return typeof tx.fee === 'number' ? BigInt(tx.fee) : null
  }

  async getRawTxHex(txid: string): Promise<string> {
    return (await this.getText(`/tx/${encodeURIComponent(txid)}/hex`)).trim()
  }

  async getTipHeight(): Promise<number> {
    const text = await this.getText('/blocks/tip/height')
    const height = Number.parseInt(text.trim(), 10)
    if (!Number.isFinite(height)) {
      throw new Error(`${this.providerName}: bad tip height "${text.trim().slice(0, 40)}"`)
    }
    return height
  }

  async getFeeOptions(): Promise<FeeOption[]> {
    // Probe the mempool-style endpoint first (mempool.space, litecoinspace, and
    // testnet variants all run the mempool codebase); on a 404-style HTTP error
    // fall back to genuine-esplora /fee-estimates. The winner is memoized so we
    // never pay the wasted probe twice. A network (TypeError) failure is left to
    // propagate so api.ts's FailoverClient advances to the next provider.
    if (this.feeStyle === 'estimates') return this.feeFromEstimates()
    if (this.feeStyle === 'recommended') return this.feeFromRecommended()
    try {
      const opts = await this.feeFromRecommended()
      this.feeStyle = 'recommended'
      return opts
    } catch (err) {
      if (err instanceof TypeError) throw err // network failure -> let failover run
      const opts = await this.feeFromEstimates()
      this.feeStyle = 'estimates'
      return opts
    }
  }

  private async feeFromRecommended(): Promise<FeeOption[]> {
    const fees = await this.getJson<EsploraRecommendedFees>('/v1/fees/recommended')
    return [
      { label: 'Fast', eta: '~10 min', rate: toRate(fees.fastestFee) },
      { label: 'Normal', eta: '~30 min', rate: toRate(fees.halfHourFee) },
      { label: 'Slow', eta: '~1 hour', rate: toRate(fees.hourFee) },
    ]
  }

  private async feeFromEstimates(): Promise<FeeOption[]> {
    const est = await this.getJson<Record<string, number>>('/fee-estimates')
    const estFor = (target: number): number => {
      const exact = est[String(target)]
      if (typeof exact === 'number') return exact
      // Fall back to the nearest available confirmation target.
      const keys = Object.keys(est)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
      let best = 1
      let bestDist = Infinity
      for (const k of keys) {
        const d = Math.abs(k - target)
        if (d < bestDist) {
          bestDist = d
          best = k
        }
      }
      const v = est[String(best)]
      return typeof v === 'number' ? v : 1
    }
    return [
      { label: 'Fast', eta: '~10 min', rate: toRate(estFor(1)) },
      { label: 'Normal', eta: '~30 min', rate: toRate(estFor(3)) },
      { label: 'Slow', eta: '~1 hour', rate: toRate(estFor(6)) },
    ]
  }

  async broadcast(txHex: string): Promise<string> {
    // testnet4's node prefers a different broadcast base (broadcastBase). Keep
    // this a CORS "simple request": text/plain body only, never application/json.
    // fetch's TypeError (network/CORS) is intentionally left to propagate so
    // api.ts can distinguish "never reached a node" from "node rejected it".
    const base = this.spec.broadcastBase ?? this.base
    // Longer deadline than reads: a broadcast deserves patience, and a
    // timed-out broadcast is safe here — rebroadcasting identical bytes is
    // idempotent (same txid), and sends always rebuild from a fresh scan.
    const res = await fetch(`${base}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
      signal: deadline(20_000),
    })
    const text = await res.text()
    if (!res.ok) {
      // Bounded and attributed like getText: this string is rendered in the
      // failure card, so a hostile node must not get an unbounded canvas for
      // social-engineering copy. The BIP125 floor ("less fees than
      // conflicting txs; a < b") sits past 200 characters once the node
      // names the replacement's txid, so it is read from the whole body and
      // kept on its own (bug audit 2026-10-27, BL1).
      const floor = /less fees than conflicting txs;\s*\d{1,12}(?:\.\d{1,12})?\s*<\s*\d{1,12}(?:\.\d{1,12})?(?![\d.])/i.exec(text)
      const reason =
        floor !== null ? `insufficient fee, rejecting replacement; ${floor[0]}` : text.trim().slice(0, 200)
      throw new Error(
        reason
          ? `${this.providerName}: ${reason}`
          : `${this.providerName} broadcast failed (HTTP ${res.status})`,
      )
    }
    return text.trim()
  }
}

// ---------------------------------------------------------------------------
// esplora tx object -> normalized RawTxInfo

function toRawTxInfo(t: EsploraTx): RawTxInfo {
  return {
    txid: t.txid,
    height: t.status?.block_height ?? null,
    time: t.status?.block_time ?? null,
    fee: typeof t.fee === 'number' ? BigInt(t.fee) : null,
    inputs: t.vin.map((v) => ({
      address: v.prevout?.scriptpubkey_address ?? null,
      value: BigInt(v.prevout?.value ?? 0),
      prevTxid: v.txid ?? null,
      // vout 0 is valid — only a missing field maps to null.
      prevVout: typeof v.vout === 'number' ? v.vout : null,
    })),
    outputs: t.vout.map((o) => ({
      address: o.scriptpubkey_address ?? null,
      value: BigInt(o.value ?? 0),
    })),
    // BIP125: any input with sequence < 0xfffffffe signals replaceability.
    rbfSignaled: t.vin.some(
      (v) => typeof v.sequence === 'number' && v.sequence < 0xfffffffe,
    ),
  }
}
