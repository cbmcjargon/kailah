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

/** A number format's decimal mark and digit-group separator ("." and "," in the US, "," and "." in Germany). */
export interface NumberMarks {
  decimal: string
  group: string
}

let deviceMarks: NumberMarks | null = null

/** This device's number format, from its locale. */
export function localNumberMarks(): NumberMarks {
  if (deviceMarks !== null) return deviceMarks
  const marks = { decimal: '.', group: ',' }
  try {
    for (const p of new Intl.NumberFormat().formatToParts(12345.6)) {
      if (p.type === 'decimal') marks.decimal = p.value
      if (p.type === 'group') marks.group = p.value
    }
  } catch {
    // keep the defaults
  }
  deviceMarks = marks
  return marks
}

/**
 * Read an amount typed into a form, in smallest units. The decimal mark may
 * be "." or "," (bug audit 2026-10-27, BH7): iOS's decimal keypad shows the
 * region's mark, "," across most of Europe and Latin America, and every form
 * refused it. A number with two marks ("1,234.5") is refused, and so is one
 * that reads as a thousands grouping where this device groups with that mark
 * ("1,234" in the US, "1.234" in Germany): it could mean either. An empty
 * field is { amount: null, error: null }; `example` is written with ".".
 */
export function readTypedAmount(
  s: string,
  decimals: number,
  symbol: string,
  example: string,
  local: NumberMarks = localNumberMarks(),
): { amount: bigint | null; error: string | null } {
  const t = s.trim()
  if (t === '') return { amount: null, error: null }
  const mark = local.decimal === ',' ? ',' : '.'
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) {
    return { amount: null, error: `Enter a plain number, like ${example.replace('.', mark)}` }
  }
  const sep = t.replace(/\d/g, '')
  if (sep.length > 1) {
    return { amount: null, error: `Type the amount without thousands separators, like 1234${mark}5` }
  }
  const [whole = '', frac = ''] = sep === '' ? [t] : t.split(sep)
  if (sep === local.group && /^[1-9]\d{0,2}$/.test(whole) && /^\d{3}$/.test(frac)) {
    const other = sep === ',' ? '.' : ','
    return {
      amount: null,
      error:
        `"${t}" could mean ${whole}${frac} or ${whole}${other}${frac}. Type ${whole}${frac} for the whole number, ` +
        `or ${whole}${other}${frac} (or ${t}0) for the decimal.`,
    }
  }
  if (frac.length > decimals) return { amount: null, error: `${symbol} has at most ${decimals} decimal places` }
  const amount = BigInt((whole === '' ? '0' : whole) + frac.padEnd(decimals, '0'))
  if (amount <= 0n) return { amount: null, error: 'Amount must be more than zero' }
  return { amount, error: null }
}

/**
 * An exact amount written into a form's amount field (a scanned request, a
 * Max button), with this device's decimal mark so readTypedAmount reads it
 * back unchanged: "1.234" would read as a thousands grouping in Germany.
 */
export function formatTypedAmount(v: bigint, decimals: number, local: NumberMarks = localNumberMarks()): string {
  const s = formatCoin(v, decimals)
  return local.decimal === ',' ? s.replace('.', ',') : s
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
