// Display helpers for bigint smallest-unit amounts, shared by the EVM, Solana
// and TRON engines and the dashboard. They live apart from evm.ts so that
// loading the Solana or TRON engine chunk doesn't pull in viem's client and
// signing stack: formatUnits alone is a few hundred bytes. evm.ts re-exports
// both, so its API is unchanged.

import { formatUnits } from 'viem'

/** USD value of a token/wei amount at a spot price. Display only. */
export function evmToUsd(v: bigint, decimals: number, price: number): number {
  return (Number(v) / 10 ** decimals) * price
}

/**
 * "0.0021 ETH" style display for wei fees: six places, or, for a non-zero
 * amount below the sixth place, its first two significant digits — a Base
 * fee read "0.000000" (bug audit 2026-10-27, BL16).
 */
export function formatEvmAmount(v: bigint, decimals: number): string {
  const s = formatUnits(v < 0n ? -v : v, decimals)
  let trimmed = s.includes('.') ? s.replace(/(\.\d{0,6})\d*$/, '$1').replace(/\.$/, '') : s
  if (v !== 0n && /^0(\.0*)?$/.test(trimmed)) {
    const tiny = /^0\.(0*)([1-9]\d?)/.exec(s)
    if (tiny !== null) trimmed = `0.${tiny[1]}${tiny[2]}`
  }
  return (v < 0n ? '-' : '') + trimmed
}
