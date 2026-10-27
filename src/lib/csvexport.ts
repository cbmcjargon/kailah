// CSV export of transaction history for Kailah Wallet.
//
// Contract (types.ts):
//   txsToCsv(chain: ChainConfig, txs: TxSummary[]): string
//   csvExportHint(networks: string[]): string
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

/**
 * The Settings row's hint: the networks the file will hold, by name ("One
 * file: Bitcoin and Dogecoin history"), or "No history yet". The caller
 * passes the networks the export covers (shown, this mode, with history), so
 * the practice set or a hidden network is never named for history the file
 * won't hold (bug audit 2026-10-27, BL2). A name listed twice (a seed and a
 * Ledger account on one network) is named once.
 */
export function csvExportHint(networks: string[]): string {
  const names = networks.filter((n, i) => networks.indexOf(n) === i)
  if (names.length === 0) return 'No history yet'
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `One file: ${list} history`
}

export function txsToCsv(chain: ChainConfig, txs: TxSummary[]): string {
  // The amount is the net change to the wallet, so a send's fee is already
  // in it; the fee column says so instead of inviting a double count, and an
  // incoming row has none (the sender paid it; bug audit 2026-10-27, BL2).
  const header = [
    'Date',
    'Type',
    `Net amount ${chain.ticker}`,
    `Fee paid ${chain.ticker} (included in net amount)`,
    'Counterparty',
    'Txid',
    'Confirmations',
  ]

  // Column index → treat as numeric (exempt from formula-quoting): Amount(2),
  // Fee(3), Confirmations(6). Date/Type are wallet-controlled constants.
  const numericCols = new Set([2, 3, 6])

  const rows = txs.map((tx) => {
    const date = tx.time !== null ? new Date(tx.time * 1000).toISOString() : 'pending'
    // formatCoin renders the sign, so 'out' amounts come out negative. A
    // row served in part has no amount or direction to export.
    const unknown = tx.partial === true
    const amount = unknown ? '' : formatCoin(tx.amount, chain.decimals)
    const fee = tx.fee !== null && tx.direction !== 'in' && !unknown ? formatCoin(tx.fee, chain.decimals) : ''
    const counterparty = unknown ? '' : (tx.counterparty ?? '')
    return [date, unknown ? 'unknown' : tx.direction, amount, fee, counterparty, tx.txid, String(tx.confirmations)]
  })

  return [header, ...rows]
    .map((row) => row.map((cell, i) => csvField(cell, numericCols.has(i))).join(','))
    .join('\n')
}
