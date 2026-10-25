// Formatting and parsing helpers. All coin math is exact bigint — no floats
// anywhere near amounts.

/**
 * Render a bigint amount in smallest units as an exact decimal coin string.
 * Trailing zeros are trimmed; whole numbers render with no decimal point.
 * Negative values are supported (e.g. pending net-outgoing mempool balance).
 */
export function formatCoin(v: bigint, decimals: number = 8): string {
  const negative = v < 0n
  const abs = negative ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = (abs / base).toString()
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const s = frac.length > 0 ? `${whole}.${frac}` : whole
  return negative && abs > 0n ? `-${s}` : s
}

/**
 * Parse a user-entered decimal amount into smallest units.
 * Accepts plain decimal strings ("1", "0.5", ".5", "12.").
 * Throws Error (user-readable) on empty, negative, non-numeric input, or more
 * fraction digits than the chain supports.
 */
export function parseCoinAmount(s: string, decimals: number = 8): bigint {
  const t = s.trim()
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m) throw new Error('Enter a valid amount, like 0.5')
  const wholeDigits = m[1] ?? ''
  const fracDigits = m[2] ?? ''
  if (wholeDigits.length === 0 && fracDigits.length === 0) {
    throw new Error('Enter a valid amount, like 0.5')
  }
  if (fracDigits.length > decimals) {
    throw new Error(`Too many decimal places — at most ${decimals} allowed`)
  }
  const whole = BigInt(wholeDigits.length > 0 ? wholeDigits : '0')
  const padded = fracDigits.padEnd(decimals, '0')
  const frac = padded.length > 0 ? BigInt(padded) : 0n
  return whole * 10n ** BigInt(decimals) + frac
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

/** "$1,234.56" */
export function formatUsd(n: number): string {
  return usdFormatter.format(n)
}

/** Shorten long addresses for display: first 10 chars + ellipsis + last 6. */
export function shortAddress(a: string): string {
  if (a.length <= 20) return a
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}
