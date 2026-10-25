// BlockCypher ProviderApi implementation (Dogecoin mainnet).
//
// BUDGET WARNING: the free tier allows only ~100-200 requests per HOUR (not per
// second) — every call here is precious. We serialize requests behind a 500ms
// per-instance gate, fetch each funding tx's raw hex at most once, and cap
// history paging. Callers should cache aggressively on top of this. There is a
// single DOGE provider today, so failover never spreads load to a second host.
//
// Endpoint shapes verified live (2026-07-20):
//   /addrs/{a}/balance                      -> { balance, unconfirmed_balance,
//                                                n_tx, unconfirmed_n_tx, final_n_tx }
//   /addrs/{a}?unspentOnly=true&includeScript=true&limit=2000
//                                           -> { txrefs?, unconfirmed_txrefs? }
//   /addrs/{a}/full?limit=50[&before=H]     -> { hasMore?, txs:[...] }
//   /txs/{hash}?includeHex=true             -> { hash, hex }
//   {base} (chain root)                     -> { name, height, hash }
//   POST /txs/push {"tx": hex}              -> { tx:{ hash } }; errors {"error"}

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

interface BcBalance {
  balance: number
  unconfirmed_balance: number
  n_tx?: number
  unconfirmed_n_tx?: number
  final_n_tx?: number
}

interface BcTxref {
  tx_hash: string
  tx_output_n: number
  value: number
}

interface BcAddressUnspent {
  txrefs?: BcTxref[]
  unconfirmed_txrefs?: BcTxref[]
}

interface BcInput {
  prev_hash?: string
  output_index?: number
  output_value?: number
  addresses?: string[] | null
  sequence?: number
}

interface BcOutput {
  value: number
  addresses?: string[] | null
  script?: string
}

interface BcFullTx {
  hash: string
  block_height?: number
  confirmed?: string
  received?: string
  fees?: number
  inputs: BcInput[]
  outputs: BcOutput[]
}

interface BcAddressFull {
  hasMore?: boolean
  txs?: BcFullTx[]
}

interface BcTxHex {
  hash: string
  hex?: string
}

interface BcChainInfo {
  height: number
}

interface BcPushResult {
  tx?: { hash?: string }
}

// Space every request >= 500ms apart to respect the hourly free-tier budget.
const MIN_REQUEST_GAP_MS = 500
// Cap history paging: two /full pages (~100 txs) is plenty for a personal
// wallet and bounds free-tier spend.
const MAX_TX_PAGES = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** BlockCypher uses block_height -1 for unconfirmed txs. */
function heightOrNull(h: number | undefined): number | null {
  return typeof h === 'number' && h > 0 ? h : null
}

/** ISO-8601 timestamp -> unix seconds, or null. */
function isoToSeconds(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export class BlockcypherProvider implements ProviderApi {
  readonly providerName = 'blockcypher'
  // No account (xpub) endpoint on the free tier — keep the seam open.
  readonly xpub: XpubApi | undefined = undefined

  private readonly base: string
  private readonly chain: ChainConfig
  private lastRequestAt = 0

  constructor(spec: ProviderSpec, chain: ChainConfig) {
    this.chain = chain
    this.base = spec.base
  }

  /** Serialize + space requests behind the shared per-instance gate. */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastRequestAt = Date.now()
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.throttle()
    // Hard deadline so an unreachable BlockCypher fails over in seconds
    // instead of stalling the scan for the browser's connect timeout.
    const signal =
      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(15_000)
        : undefined
    const res = await fetch(this.base + path, { signal })
    const text = await res.text()
    if (!res.ok) {
      // BlockCypher error bodies are usually {"error":"..."}; surface the reason.
      let reason = text.trim().slice(0, 200)
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed.error) reason = parsed.error
      } catch {
        // keep raw body text
      }
      throw new Error(
        reason ? `blockcypher: ${reason}` : `blockcypher API error (HTTP ${res.status})`,
      )
    }
    return JSON.parse(text) as T
  }

  // -------------------------------------------------------------------------
  // AddressApi

  async getAddressStats(address: string): Promise<{ balance: Balance; txCount: number }> {
    const info = await this.getJson<BcBalance>(
      `/addrs/${encodeURIComponent(address)}/balance`,
    )
    // BlockCypher returns balances as JSON numbers. Above ~90M DOGE (koinu >
    // Number.MAX_SAFE_INTEGER) precision would be lost — irrelevant for a
    // personal wallet.
    const txCount =
      info.final_n_tx ?? (info.n_tx ?? 0) + (info.unconfirmed_n_tx ?? 0)
    return {
      balance: {
        confirmed: BigInt(info.balance),
        unconfirmed: BigInt(info.unconfirmed_balance),
      },
      txCount,
    }
  }

  async getAddressUtxos(address: string): Promise<Utxo[]> {
    const info = await this.getJson<BcAddressUnspent>(
      `/addrs/${encodeURIComponent(address)}?unspentOnly=true&includeScript=true&limit=2000`,
    )
    // Include unconfirmed so the wallet can spend its own pending change;
    // tag confirmed vs mempool so RBF bumps can keep their extras confirmed.
    const refs = [
      ...(info.txrefs ?? []).map((r) => ({ r, confirmed: true })),
      ...(info.unconfirmed_txrefs ?? []).map((r) => ({ r, confirmed: false })),
    ]
    const utxos: Utxo[] = refs.map(({ r, confirmed }) => ({
      txid: r.tx_hash,
      vout: r.tx_output_n,
      value: BigInt(r.value),
      confirmed,
    }))

    // Legacy (p2pkh) signing needs each funding tx's full raw hex. Fetch once
    // per DISTINCT txid, through the throttle, to conserve the hourly budget.
    const distinct = [...new Set(utxos.map((u) => u.txid))]
    const hexByTxid = new Map<string, string>()
    for (const txid of distinct) {
      const tx = await this.getJson<BcTxHex>(`/txs/${encodeURIComponent(txid)}?includeHex=true`)
      if (!tx.hex) {
        throw new Error(`blockcypher did not return raw hex for tx ${txid}`)
      }
      hexByTxid.set(txid, tx.hex)
    }
    for (const u of utxos) {
      const hex = hexByTxid.get(u.txid)
      if (hex !== undefined) u.rawTxHex = hex
    }
    return utxos
  }

  async getAddressTxs(address: string): Promise<RawTxInfo[]> {
    const enc = encodeURIComponent(address)
    const collected = new Map<string, RawTxInfo>()
    let before: number | undefined

    for (let page = 0; page < MAX_TX_PAGES; page += 1) {
      const q = before !== undefined ? `&before=${before}` : ''
      const info = await this.getJson<BcAddressFull>(`/addrs/${enc}/full?limit=50${q}`)
      const txs = info.txs ?? []
      for (const t of txs) {
        if (!collected.has(t.hash)) collected.set(t.hash, toRawTxInfo(t))
      }
      if (!info.hasMore || txs.length === 0) break
      // `before` is exclusive (returns txs strictly below this height); seed the
      // next page from the lowest confirmed height we've seen.
      const heights = txs
        .map((t) => t.block_height)
        .filter((h): h is number => typeof h === 'number' && h > 0)
      if (heights.length === 0) break
      before = Math.min(...heights)
    }

    return [...collected.values()]
  }

  async getRawTxHex(txid: string): Promise<string> {
    const tx = await this.getJson<BcTxHex>(`/txs/${encodeURIComponent(txid)}?includeHex=true`)
    if (!tx.hex) throw new Error(`blockcypher did not return raw hex for tx ${txid}`)
    return tx.hex
  }

  async getTipHeight(): Promise<number> {
    // The chain root (base with no sub-path) returns { height, ... }.
    const info = await this.getJson<BcChainInfo>('')
    return info.height
  }

  async getFeeOptions(): Promise<FeeOption[]> {
    // No fee-estimation call for DOGE — the chain config carries a flat rate.
    const rate = this.chain.fixedFeeRate
    if (rate === undefined) {
      throw new Error(`${this.chain.name} is missing fixedFeeRate in its chain config`)
    }
    return [{ label: 'Standard', eta: '~1 min', rate }]
  }

  async broadcast(txHex: string): Promise<string> {
    await this.throttle()
    const res = await fetch(`${this.base}/txs/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: txHex }),
    })
    // fetch's TypeError (network) is left to propagate so api.ts can tell a
    // never-sent broadcast from a node rejection.
    const text = await res.text()
    if (!res.ok) {
      let message = text.trim()
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // keep raw body text
      }
      throw new Error(message || `Broadcast failed (HTTP ${res.status})`)
    }
    const result = JSON.parse(text) as BcPushResult
    const hash = result.tx?.hash
    if (!hash) throw new Error('Broadcast response did not include a transaction hash')
    return hash
  }
}

// ---------------------------------------------------------------------------
// BlockCypher /full tx -> normalized RawTxInfo

function toRawTxInfo(t: BcFullTx): RawTxInfo {
  return {
    txid: t.hash,
    height: heightOrNull(t.block_height),
    time: isoToSeconds(t.confirmed) ?? isoToSeconds(t.received),
    fee: typeof t.fees === 'number' ? BigInt(t.fees) : null,
    inputs: t.inputs.map((i) => ({
      address: i.addresses?.[0] ?? null,
      value: BigInt(i.output_value ?? 0),
      prevTxid: i.prev_hash ?? null,
      // output_index 0 is valid — only a missing field maps to null.
      prevVout: typeof i.output_index === 'number' ? i.output_index : null,
    })),
    outputs: t.outputs.map((o) => ({
      address: o.addresses?.[0] ?? null,
      value: BigInt(o.value),
    })),
    // Dogecoin does not implement BIP125 replace-by-fee.
    rbfSignaled: false,
  }
}
