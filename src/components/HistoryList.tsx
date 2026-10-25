import { useState } from 'react'
import type { ChainConfig, TxSummary } from '../lib/types'
import { IconChevronDown } from './Icons'
import TxRow from './TxRow'

interface HistoryListProps {
  chain: ChainConfig
  txs: TxSummary[]
  price: number | undefined
  onSelect: (tx: TxSummary) => void
}

/** How many rows show before the "Show all" disclosure. */
const COLLAPSED_COUNT = 3

export default function HistoryList({ chain, txs, price, onSelect }: HistoryListProps) {
  const [expanded, setExpanded] = useState(false)

  if (txs.length === 0) {
    return <p className="tx-empty text-tertiary">No activity yet.</p>
  }

  const shown = expanded ? txs : txs.slice(0, COLLAPSED_COUNT)
  const hidden = txs.length - shown.length

  return (
    <div className="tx-list">
      {shown.map((tx) => (
        <TxRow key={tx.txid} chain={chain} tx={tx} price={price} onClick={() => onSelect(tx)} />
      ))}
      {(hidden > 0 || expanded) && txs.length > COLLAPSED_COUNT && (
        <button
          type="button"
          className="tx-more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>{expanded ? 'Show less' : `Show ${hidden} more`}</span>
          <IconChevronDown size={15} className={expanded ? 'chevron-up' : undefined} />
        </button>
      )}
    </div>
  )
}
