// USD spot prices via Coinbase's public API. Response shape (verified live):
//   GET https://api.coinbase.com/v2/prices/{SYM}-USD/spot
//   -> { "data": { "amount": "64690.715", "base": "BTC", "currency": "USD" } }
//
// Plus fetchPriceHistory: ~7d USD series for the sparklines, from CoinGecko
// (keyless, CORS-open) with a Coinbase-candles fallback.

import type { PricePoint } from './types'

interface CacheEntry {
  price: number
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000

const cache = new Map<string, CacheEntry>()

interface CoinbaseSpotResponse {
  data?: { amount?: string }
}

/**
 * Fetch USD spot prices for the given symbols (e.g. ['BTC', 'DOGE']).
 * Fetches run in parallel with a 60-second in-memory cache. Any symbol that
 * fails to fetch or parse is simply omitted from the result — never throws.
 */
export async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  await Promise.all(
    symbols.map(async (symbol) => {
      const cached = cache.get(symbol)
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        result[symbol] = cached.price
        return
      }
      try {
        const res = await fetch(
          `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`,
        )
        if (!res.ok) return
        const json = (await res.json()) as CoinbaseSpotResponse
        const price = Number(json.data?.amount)
        if (!Number.isFinite(price) || price <= 0) return
        cache.set(symbol, { price, fetchedAt: Date.now() })
        result[symbol] = price
      } catch {
        // network/parse failure -> omit this symbol
      }
    }),
  )
  return result
}

// ===========================================================================
// fetchPriceHistory — ~7 days of USD points for a compact sparkline
// ===========================================================================

const HISTORY_CACHE_TTL_MS = 10 * 60_000 // 10 minutes
const SPARKLINE_MAX_POINTS = 48
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60

/** Wallet symbol -> CoinGecko coin id. */
const COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  DOGE: 'dogecoin',
  LTC: 'litecoin',
  USDC: 'usd-coin',
  ETH: 'ethereum',
}

/** Wallet symbol -> Coinbase Exchange product id (fallback source). */
const COINBASE_PRODUCT: Record<string, string> = {
  BTC: 'BTC-USD',
  DOGE: 'DOGE-USD',
  LTC: 'LTC-USD',
  USDC: 'USDC-USD',
  ETH: 'ETH-USD',
}

interface HistoryCacheEntry {
  points: PricePoint[]
  fetchedAt: number
}

const historyCache = new Map<string, HistoryCacheEntry>()

interface CoinGeckoMarketChart {
  prices?: [number, number][]
}

/**
 * ~7 days of daily-ish USD price points for one symbol, oldest-first.
 * CoinGecko is primary; on any failure a Coinbase 6-hour-candle series is
 * tried. Result is downsampled to <= 48 points for a compact sparkline. Never
 * throws — returns [] if both sources fail (and does not cache the empty
 * result, so the next call retries). Successful results are cached 10 minutes.
 */
export async function fetchPriceHistory(symbol: string): Promise<PricePoint[]> {
  const cached = historyCache.get(symbol)
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return cached.points
  }

  let points = await fetchFromCoinGecko(symbol)
  if (points.length === 0) points = await fetchFromCoinbase(symbol)
  if (points.length === 0) return []

  const compact = downsample(points, SPARKLINE_MAX_POINTS)
  historyCache.set(symbol, { points: compact, fetchedAt: Date.now() })
  return compact
}

async function fetchFromCoinGecko(symbol: string): Promise<PricePoint[]> {
  const id = COINGECKO_ID[symbol]
  if (!id) return []
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=7`,
    )
    if (!res.ok) return []
    const json = (await res.json()) as CoinGeckoMarketChart
    const rows = json.prices ?? []
    const points: PricePoint[] = []
    for (const row of rows) {
      const ms = row[0]
      const usd = row[1]
      if (!Number.isFinite(ms) || !Number.isFinite(usd) || usd <= 0) continue
      points.push({ t: Math.floor(ms / 1000), p: usd })
    }
    return points
  } catch {
    return []
  }
}

async function fetchFromCoinbase(symbol: string): Promise<PricePoint[]> {
  const product = COINBASE_PRODUCT[symbol]
  if (!product) return []
  try {
    // granularity 21600s = 6h candles; rows are [t, low, high, open, close, vol]
    // and arrive newest-first.
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=21600`,
    )
    if (!res.ok) return []
    const rows = (await res.json()) as number[][]
    if (!Array.isArray(rows)) return []
    const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SEC
    const points: PricePoint[] = []
    for (const row of rows) {
      const t = row[0]
      const close = row[4]
      if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) continue
      if (t < cutoff) continue // keep the last ~7 days only
      points.push({ t, p: close })
    }
    // Coinbase returns newest-first; sparklines want oldest-first.
    points.sort((a, b) => a.t - b.t)
    return points
  } catch {
    return []
  }
}

/** Keep at most `max` points, always preserving the newest one. */
function downsample(points: PricePoint[], max: number): PricePoint[] {
  if (points.length <= max) return points
  const step = Math.ceil(points.length / max)
  const out: PricePoint[] = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  const last = points[points.length - 1]
  if (out.length === 0 || out[out.length - 1].t !== last.t) out.push(last)
  return out
}
