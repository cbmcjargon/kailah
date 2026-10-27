// Bitcore ProviderApi (BitPay's public Bitcore API, api.bitcore.io):
// Dogecoin's second data service and Litecoin's first backup, ahead of
// BlockCypher.
//
// Why (2026-10-27): Dogecoin had one data service, BlockCypher, whose ~100
// requests an hour per IP are shared with Litecoin's backup. litecoinspace.org
// fell ~14 blocks behind, Litecoin leaned on BlockCypher, the budget ran out,
// and both coins showed "Couldn't reach the network data service". Bitcore is
// keyless, serves both chains, and allows browser origins (CORS *).
//
// Endpoint shapes verified live (2026-10-27; recorded in
// scripts/fixtures/bitcore-answers.json):
//   /block/tip                         -> { height, hash, time, ... }
//   /address/{a}?limit=1               -> [coin]; any coin at all = used
//   /address/{a}?unspent=true&limit=N  -> [coin] not spent in a block
//   /address/{a}?limit=N               -> [coin], newest first; each names the
//                                         tx that created it and the one that
//                                         spent it, so history = those txids
//   /tx/{txid}/populated               -> tx + { coins: { inputs, outputs } }
//   /tx/{txid}                         -> 200, or 404 "could not be found"
//   /fee/{blocks}                      -> { feerate } in coins per 1000 bytes
//   POST /tx/send { rawTx }            -> { txid }; errors are plain text
//                                         (HTTP 500 "TX decode failed")
// A coin's mintHeight / spentHeight is a block height, -1 for the mempool,
// -2 for unspent, and -3 or below for conflicting or errored.
//
// Inputs arrive in Bitcore's order, not the transaction's: it stores coins,
// not input positions (checked against a Blockbook node: same inputs, same
// values, other order). Only the "from" shown for a payment with several
// senders can differ; Speed up rebuilds from the verified raw bytes.
//
// Balances are computed from the unspent coins, not /balance: that call
// counts a coin a pending send is spending, so right after a send it would
// show the old coin AND its change.
//
// There is no raw-transaction endpoint. Dogecoin's legacy inputs need each
// funding tx's bytes (txbuild verifies them against the txid), so on a p2pkh
// chain they come from `rawHex` (BlockCypher) through rawtxcache.ts:
// verified, cached for the session, at most one request each. getRawTxHex
// serves only what that cache holds; otherwise the FailoverClient asks the
// next provider.
//
// Bitcore publishes no budget (no rate-limit headers), so requests queue
// behind one 250 ms gate per host, history is capped per address, and deeply
// confirmed transactions are kept for the session.

import type {
  Balance,
  ChainConfig,
  ChainId,
  FeeOption,
  ProviderApi,
  ProviderSpec,
  RawTxInfo,
  Utxo,
  XpubApi,
} from './types'
import { toRate } from './esplora'
import { cachedRawTx, rememberRawTx } from './rawtxcache'

// ---------------------------------------------------------------------------
// Wire shapes (everything is checked before use)

interface BtCoin {
  mintTxid?: unknown
  mintIndex?: unknown
  mintHeight?: unknown
  spentTxid?: unknown
  spentHeight?: unknown
  address?: unknown
  value?: unknown
  /** the sequence of the input that spends this coin */
  sequenceNumber?: unknown
}

interface BtPopulated {
  txid?: unknown
  blockHeight?: unknown
  blockTime?: unknown
  blockTimeNormalized?: unknown
  fee?: unknown
  outputCount?: unknown
  confirmations?: unknown
  coins?: { inputs?: unknown; outputs?: unknown } | null
}

// bitcore-node's stock limiter allows 200 requests a minute per IP; 250 ms
// (240 a minute) could trip it under a full scan (bug audit 2026-10-27, BM6)
const MIN_REQUEST_GAP_MS = 330
/** Transactions per address in history: the newest, pending ones first. */
const MAX_HISTORY_TXS = 30
/** Coins read to find those transactions (each names up to two). */
const HISTORY_COINS = 100
/** A single address with this many unspent coins is past what we list. */
const UNSPENT_LIMIT = 1000
/** Confirmations after which a transaction is kept for the session. */
const SETTLED_CONFIRMATIONS = 6
const MAX_SETTLED = 1000
const MAX_OUTPUTS = 10_000
const MEMPOOL = -1
const UNSPENT = -2
// Dogecoin does not implement BIP125 replace-by-fee; Litecoin does.
const NO_BIP125: ReadonlySet<ChainId> = new Set<ChainId>(['doge'])
const TXID = /^[0-9a-f]{64}$/i

function malformed(what: string): Error {
  return new Error(`bitcore returned a malformed ${what}`)
}

function amountOf(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw malformed('amount')
  return BigInt(v)
}

function heightOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw malformed('height')
  return v
}

function indexOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw malformed('output index')
  return v
}

function txidOf(v: unknown): string {
  if (typeof v !== 'string' || !TXID.test(v)) throw malformed('txid')
  return v.toLowerCase()
}

/** Bitcore writes the string "false" for a script with no address. */
function addressOf(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && v !== 'false' ? v : null
}

function secondsOf(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null
}

/**
 * Esplora's meaning, from the unspent coins: confirmed = what the chain says
 * the address holds; unconfirmed = the mempool's change to it (new coins in,
 * minus coins a pending tx spends).
 */
export function bitcoreBalance(coins: readonly BtCoin[]): Balance {
  let confirmed = 0n
  let unconfirmed = 0n
  for (const c of coins) {
    const mint = heightOf(c.mintHeight)
    const spent = heightOf(c.spentHeight)
    if (spent >= 0) continue // spent in a block
    const value = amountOf(c.value)
    if (mint >= 0) confirmed += value
    else if (mint === MEMPOOL) unconfirmed += value
    else continue // conflicting or errored: not money
    if (spent === MEMPOOL) unconfirmed -= value
  }
  return { confirmed, unconfirmed }
}

// One queue per host, like BlockCypher's: concurrent scans take turns.
const lastRequestAt = new Map<string, number>()
const queues = new Map<string, Promise<void>>()

function throttle(host: string, gapMs: number): Promise<void> {
  const turn = (queues.get(host) ?? Promise.resolve()).then(async () => {
    const wait = (lastRequestAt.get(host) ?? 0) + gapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt.set(host, Date.now())
  })
  queues.set(host, turn)
  return turn
}

export class BitcoreProvider implements ProviderApi {
  /** the gap between requests to the host (tests shorten it, as with FailoverTuning) */
  static requestGapMs = MIN_REQUEST_GAP_MS

  readonly providerName = 'bitcore'
  readonly xpub: XpubApi | undefined = undefined
  readonly backupOnly: boolean

  private readonly base: string
  private readonly host: string
  private readonly chain: ChainConfig
  private readonly rawHex: ((txid: string) => Promise<string>) | undefined
  /** deeply confirmed transactions, which no longer change */
  private readonly settled = new Map<string, RawTxInfo>()

  /**
   * `rawHex` fetches a legacy funding transaction's bytes from another
   * provider (Bitcore has no endpoint for them); a p2pkh chain needs it.
   */
  constructor(spec: ProviderSpec, chain: ChainConfig, rawHex?: (txid: string) => Promise<string>) {
    this.chain = chain
    this.base = spec.base
    this.host = new URL(spec.base).host
    this.backupOnly = spec.backupOnly === true
    this.rawHex = rawHex
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    await throttle(this.host, BitcoreProvider.requestGapMs)
    // Hard deadline so an unreachable host fails over in seconds.
    const signal =
      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(15_000)
        : undefined
    return fetch(this.base + path, { ...init, signal })
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path)
    const text = await res.text()
    if (!res.ok) {
      const reason = text.trim().slice(0, 200)
      throw Object.assign(
        new Error(reason ? `bitcore: ${reason}` : `bitcore API error (HTTP ${res.status})`),
        // an explicit not-found, which txSeen reads as "not seen"
        res.status === 404 ? { notFound: true } : {},
        res.status === 429 ? { rateLimited: true } : {},
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw malformed('response')
    }
  }

  private async coins(address: string, query: string): Promise<BtCoin[]> {
    const list = await this.getJson<unknown>(`/address/${encodeURIComponent(address)}${query}`)
    if (!Array.isArray(list)) throw malformed('coin list')
    for (const c of list as BtCoin[]) {
      // every coin must be this address's
      if (c === null || typeof c !== 'object' || c.address !== address) throw malformed('coin list')
    }
    return list as BtCoin[]
  }

  private async unspent(address: string): Promise<BtCoin[]> {
    const list = await this.coins(address, `?unspent=true&limit=${UNSPENT_LIMIT}`)
    // a full page may be cut short: never report a partial balance
    if (list.length >= UNSPENT_LIMIT) throw new Error('bitcore: too many coins on one address to list')
    return list
  }

  async txSeen(txid: string): Promise<boolean> {
    try {
      await this.getJson<unknown>(`/tx/${encodeURIComponent(txid)}`)
      return true
    } catch (e) {
      if ((e as { notFound?: unknown } | null)?.notFound === true) return false
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // AddressApi

  async getAddressStats(address: string): Promise<{ balance: Balance; txCount: number }> {
    // The scanner needs only used / unused (txCount > 0) and the balance.
    // An address that never had a coin costs one request; a used one, two.
    const any = await this.coins(address, '?limit=1')
    if (any.length === 0) return { balance: { confirmed: 0n, unconfirmed: 0n }, txCount: 0 }
    return { balance: bitcoreBalance(await this.unspent(address)), txCount: 1 }
  }

  async getAddressUtxos(address: string): Promise<Utxo[]> {
    const utxos: Utxo[] = []
    for (const c of await this.unspent(address)) {
      const mint = heightOf(c.mintHeight)
      const spent = heightOf(c.spentHeight)
      // a coin a pending tx is spending is not ours to spend again
      if (spent !== UNSPENT || mint < MEMPOOL) continue
      utxos.push({
        txid: txidOf(c.mintTxid),
        vout: indexOf(c.mintIndex),
        value: amountOf(c.value),
        confirmed: mint >= 0,
      })
    }
    // Segwit signing needs only the prevout amount.
    if (this.chain.addressType === 'p2wpkh') return utxos

    // Legacy signing needs each funding tx's bytes: cached, or fetched from
    // the other provider and kept once they hash to their txid.
    for (const txid of [...new Set(utxos.map((u) => u.txid))]) {
      if (cachedRawTx(txid) !== undefined) continue
      if (this.rawHex === undefined) throw new Error('bitcore: no source for raw transactions')
      let hex: string
      try {
        hex = await this.rawHex(txid)
      } catch {
        // Not Bitcore's failure: a plain error, so the FailoverClient doesn't
        // cool Bitcore down for the other provider's outage or rate limit.
        throw new Error('bitcore: the raw transaction for a coin is unavailable right now')
      }
      if (!rememberRawTx(txid, hex)) {
        throw new Error(`bitcore: the raw bytes served for ${txid} are not that transaction`)
      }
    }
    for (const u of utxos) u.rawTxHex = cachedRawTx(u.txid)
    return utxos
  }

  async getAddressTxs(address: string): Promise<RawTxInfo[]> {
    const ranked: { txid: string; at: number }[] = []
    for (const c of await this.coins(address, `?limit=${HISTORY_COINS}`)) {
      ranked.push({ txid: txidOf(c.mintTxid), at: heightOf(c.mintHeight) })
      if (typeof c.spentTxid === 'string' && c.spentTxid !== '') {
        ranked.push({ txid: txidOf(c.spentTxid), at: heightOf(c.spentHeight) })
      }
    }
    // pending first, then newest; conflicting ones (-3 and below) are not history
    const key = (at: number) => (at === MEMPOOL ? Number.POSITIVE_INFINITY : at)
    const ids: string[] = []
    for (const r of ranked.filter((r) => r.at >= MEMPOOL).sort((a, b) => key(b.at) - key(a.at))) {
      if (!ids.includes(r.txid)) ids.push(r.txid)
      if (ids.length >= MAX_HISTORY_TXS) break
    }

    const bip125 = !NO_BIP125.has(this.chain.id)
    const out: RawTxInfo[] = []
    for (const id of ids) {
      const known = this.settled.get(id)
      if (known !== undefined) {
        out.push(known)
        continue
      }
      // One transaction Bitcore can't describe (an amount past 2^53, a txid
      // its coin list names but /populated doesn't know) is left out, not the
      // address's whole history (bug audit 2026-10-27, BL6). A rate limit or
      // an outage still fails the call, for the FailoverClient to handle.
      let p: BtPopulated
      let info: RawTxInfo
      try {
        p = await this.getJson<BtPopulated>(`/tx/${encodeURIComponent(id)}/populated`)
        info = bitcoreTxInfo(p, id, bip125)
      } catch (e) {
        const notFound = (e as { notFound?: unknown } | null)?.notFound === true
        if (notFound || (e instanceof Error && e.message.startsWith('bitcore returned a malformed'))) continue
        throw e
      }
      out.push(info)
      const confirmations = typeof p.confirmations === 'number' ? p.confirmations : 0
      if (info.height !== null && confirmations >= SETTLED_CONFIRMATIONS) {
        if (this.settled.size >= MAX_SETTLED) this.settled.clear()
        this.settled.set(id, info)
      }
    }
    return out
  }

  async getRawTxHex(txid: string): Promise<string> {
    const hex = cachedRawTx(txid)
    if (hex !== undefined) return hex
    // no endpoint: the FailoverClient asks the next provider
    throw new Error('bitcore: no raw transaction endpoint')
  }

  async getTipHeight(): Promise<number> {
    const tip = await this.getJson<{ height?: unknown }>('/block/tip')
    const h = heightOf(tip.height)
    if (h <= 0) throw malformed('chain tip')
    return h
  }

  async getFeeOptions(): Promise<FeeOption[]> {
    // Dogecoin: the chain config's flat rate, as with BlockCypher.
    const fixed = this.chain.fixedFeeRate
    if (fixed !== undefined) return [{ label: 'Standard', eta: '~1 min', rate: fixed }]
    // Litecoin: coins per 1000 bytes → smallest units per vbyte, with
    // esplora's rounding, floor and cap (rounded to whole units per kB first,
    // so 0.00001 is exactly 1 per byte, not a float's 1.0000000000000002).
    const rate = async (blocks: number): Promise<bigint> => {
      const r = await this.getJson<{ feerate?: unknown }>(`/fee/${blocks}`)
      if (typeof r.feerate !== 'number' || !(r.feerate > 0) || !Number.isFinite(r.feerate)) {
        throw new Error(`bitcore returned no fee estimate for ${this.chain.name}`)
      }
      return toRate(Math.round(r.feerate * 1e8) / 1000)
    }
    const fast = await rate(2)
    const normal = await rate(6)
    const slow = await rate(12)
    return [
      { label: 'Fast', eta: '~10 min', rate: fast },
      { label: 'Normal', eta: '~30 min', rate: normal },
      { label: 'Slow', eta: '~1 hour', rate: slow },
    ]
  }

  async broadcast(txHex: string): Promise<string> {
    // fetch's TypeError (network) propagates so api.ts can tell a
    // never-sent broadcast from a node rejection.
    const res = await this.request('/tx/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: txHex }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text.trim().slice(0, 300) || `Broadcast failed (HTTP ${res.status})`)
    let id: unknown
    try {
      id = (JSON.parse(text) as { txid?: unknown } | null)?.txid
    } catch {
      id = undefined
    }
    if (typeof id !== 'string' || !TXID.test(id)) {
      throw new Error('Broadcast response did not include a transaction id')
    }
    return id.toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// /tx/{txid}/populated -> normalized RawTxInfo

export function bitcoreTxInfo(p: BtPopulated, txid: string, bip125: boolean): RawTxInfo {
  if (txidOf(p.txid) !== txid) throw malformed('transaction')
  const height = heightOf(p.blockHeight)
  const ins = p.coins?.inputs
  const outs = p.coins?.outputs
  if (!Array.isArray(ins) || !Array.isArray(outs)) throw malformed('transaction')
  const count = p.outputCount === undefined ? outs.length : p.outputCount
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < outs.length || count > MAX_OUTPUTS) {
    throw malformed('transaction')
  }
  // Outputs by index, so position i is vout i. Bitcore lists the coins it
  // stores; an output it doesn't (a data-only OP_RETURN) holds no value.
  const outputs: RawTxInfo['outputs'] = Array.from({ length: count }, () => ({ address: null, value: 0n }))
  for (const o of outs as BtCoin[]) {
    const i = indexOf(o.mintIndex)
    if (i >= count) throw malformed('transaction')
    outputs[i] = { address: addressOf(o.address), value: amountOf(o.value) }
  }
  const inputs = (ins as BtCoin[]).map((c) => ({
    address: addressOf(c.address),
    value: amountOf(c.value),
    prevTxid: txidOf(c.mintTxid),
    prevVout: indexOf(c.mintIndex),
  }))
  return {
    txid,
    height: height > 0 ? height : null,
    time: secondsOf(p.blockTimeNormalized) ?? secondsOf(p.blockTime),
    fee: typeof p.fee === 'number' && Number.isSafeInteger(p.fee) && p.fee >= 0 ? BigInt(p.fee) : null,
    inputs,
    outputs,
    // BIP125: any input with sequence < 0xfffffffe signals replaceability
    // (never on Dogecoin, which doesn't implement it).
    rbfSignaled:
      bip125 &&
      (ins as BtCoin[]).some((c) => typeof c.sequenceNumber === 'number' && c.sequenceNumber < 0xfffffffe),
  }
}
