import type { ChainConfig, TxSummary } from '../lib/types'
import { formatCoin, formatUsd } from '../lib/format'
import { IconArrowDown, IconArrowUp, IconSwap } from './Icons'
import { coinsToUsd, relativeTime } from './ui'

interface TxRowProps {
  chain: ChainConfig
  tx: TxSummary
  price: number | undefined
  onClick: () => void
}

export default function TxRow({ chain, tx, price, onClick }: TxRowProps) {
  const abs = tx.amount < 0n ? -tx.amount : tx.amount
  const sign = tx.amount > 0n ? '+' : tx.amount < 0n ? '−' : ''
  // served in part by the data service: no direction or amount to show
  const unknown = tx.partial === true
  const title = unknown
    ? 'Transaction'
    : tx.direction === 'in'
      ? 'Received'
      : tx.direction === 'out'
        ? 'Sent'
        : 'Sent to self'
  const showUsd = price !== undefined && abs > 0n && !unknown

  return (
    <button type="button" className="tx-row" onClick={onClick}>
      <span className={`tx-icon tx-icon-${unknown ? 'self' : tx.direction}`} aria-hidden="true">
        {unknown ? (
          <IconSwap size={16} />
        ) : tx.direction === 'in' ? (
          <IconArrowDown size={16} />
        ) : tx.direction === 'out' ? (
          <IconArrowUp size={16} />
        ) : (
          <IconSwap size={16} />
        )}
      </span>

      <div className="tx-main">
        <span className="tx-title">{title}</span>
        <span className="tx-sub">
          {tx.pending ? (
            <span className="tx-badge tx-badge-pending">Pending</span>
          ) : (
            <>
              <span>{relativeTime(tx.time)}</span>
              {tx.confirmations > 0 && tx.confirmations < 6 && (
                <span className="tx-badge">{tx.confirmations} conf</span>
              )}
            </>
          )}
        </span>
      </div>

      <div className="tx-amounts">
        {unknown ? (
          <span className="tx-amount text-tertiary">Amount unknown</span>
        ) : (
          <span className={`tx-amount tnum tx-amount-${tx.direction}`}>
            {sign}
            {formatCoin(abs, chain.decimals)} {chain.ticker}
          </span>
        )}
        {showUsd && (
          <span className="tx-usd tnum">{formatUsd(coinsToUsd(abs, chain.decimals, price))}</span>
        )}
      </div>
    </button>
  )
}
