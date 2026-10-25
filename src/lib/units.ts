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

/** "0.0021 ETH" style display for wei fees. */
export function formatEvmAmount(v: bigint, decimals: number): string {
  const s = formatUnits(v < 0n ? -v : v, decimals)
  const trimmed = s.includes('.') ? s.replace(/(\.\d{0,6})\d*$/, '$1').replace(/\.$/, '') : s
  return (v < 0n ? '-' : '') + trimmed
}
