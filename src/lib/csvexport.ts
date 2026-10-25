// CSV export of transaction history for Kailah Wallet.
//
// Contract (types.ts):
//   txsToCsv(chain: ChainConfig, txs: TxSummary[]): string
//
// RFC-4180 output: fields containing a comma, double-quote, CR or LF are wrapped
// in double-quotes with embedded quotes doubled. Amounts are exact signed coin
// strings (formatCoin). Deterministic — the row order is whatever caller passes.

import { formatCoin } from './format'
import type { ChainConfig, TxSummary } from './types'

/**
 * Serialize a field: neutralize spreadsheet formula injection, then RFC-4180
 * quote. A provider-controlled cell (counterparty address, txid) beginning with
 * = + @ - or a control char is interpreted as a live formula by Excel/Sheets;
 * prefix such text with a single quote so it renders literally. `isNumeric`
 * cells (our own formatted amounts) are exempt so a negative amount like
 * "-0.001" is not mangled.
 */
function csvField(value: string, isNumeric = false): string {
  let v = value
  if (!isNumeric && /^[=+\-@\t\r]/.test(v)) v = `'${v}`
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

export function txsToCsv(chain: ChainConfig, txs: TxSummary[]): string {
  const header = [
    'Date',
    'Type',
    `Amount ${chain.ticker}`,
    `Fee ${chain.ticker}`,
    'Counterparty',
    'Txid',
    'Confirmations',
  ]

  // Column index → treat as numeric (exempt from formula-quoting): Amount(2),
  // Fee(3), Confirmations(6). Date/Type are wallet-controlled constants.
  const numericCols = new Set([2, 3, 6])

  const rows = txs.map((tx) => {
    const date = tx.time !== null ? new Date(tx.time * 1000).toISOString() : 'pending'
    // formatCoin renders the sign, so 'out' amounts come out negative.
    const amount = formatCoin(tx.amount, chain.decimals)
    const fee = tx.fee !== null ? formatCoin(tx.fee, chain.decimals) : ''
    const counterparty = tx.counterparty ?? ''
    return [date, tx.direction, amount, fee, counterparty, tx.txid, String(tx.confirmations)]
  })

  return [header, ...rows]
    .map((row) => row.map((cell, i) => csvField(cell, numericCols.has(i))).join(','))
    .join('\n')
}
