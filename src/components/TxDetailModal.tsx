import type { ChainConfig, TxSummary } from '../lib/types'
import { formatCoin, formatUsd, shortAddress } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import { IconBolt, IconExternal } from './Icons'
import { absoluteTime, coinsToUsd } from './ui'

interface TxDetailModalProps {
  chain: ChainConfig
  tx: TxSummary
  price: number | undefined
  onClose: () => void
  /** present only when tx.bumpable — opens the RBF flow */
  onBump?: () => void
}

export default function TxDetailModal({ chain, tx, price, onClose, onBump }: TxDetailModalProps) {
  const abs = tx.amount < 0n ? -tx.amount : tx.amount
  const sign = tx.amount > 0n ? '+' : tx.amount < 0n ? '−' : ''
  const heading = tx.direction === 'in' ? 'Received' : tx.direction === 'out' ? 'Sent' : 'Sent to self'
  const cpLabel = tx.direction === 'in' ? 'From' : tx.direction === 'out' ? 'To' : 'Address'
  const fmt = (v: bigint) => `${formatCoin(v, chain.decimals)} ${chain.ticker}`

  return (
    <Modal title="Transaction" onClose={onClose}>
      <div className="stack">
        <div className="tx-detail-hero">
          <span className={`tx-amount tnum tx-amount-${tx.direction} tx-detail-amount`}>
            {sign}
            {fmt(abs)}
          </span>
          <span className="text-secondary">{heading}</span>
          {price !== undefined && abs > 0n && (
            <span className="text-tertiary tnum">
              {formatUsd(coinsToUsd(abs, chain.decimals, price))}
            </span>
          )}
        </div>

        <dl className="review-list">
          <div className="review-row">
            <dt>Status</dt>
            <dd>
              {tx.pending ? (
                <span className="tx-badge tx-badge-pending">Pending</span>
              ) : (
                <span className="tnum">
                  {tx.confirmations >= 100 ? '100+' : tx.confirmations} confirmations
                </span>
              )}
            </dd>
          </div>
          {tx.fee !== null && (
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">{fmt(tx.fee)}</dd>
            </div>
          )}
          {tx.counterparty !== null && (
            <div className="review-row">
              <dt>{cpLabel}</dt>
              <dd className="tx-detail-cp">
                <span className="mono" title={tx.counterparty}>
                  {shortAddress(tx.counterparty)}
                </span>
                <CopyButton text={tx.counterparty} label={`Copy ${cpLabel.toLowerCase()} address`} />
              </dd>
            </div>
          )}
          <div className="review-row">
            <dt>Time</dt>
            <dd>{absoluteTime(tx.time)}</dd>
          </div>
          <div className="review-row">
            <dt>Transaction ID</dt>
            <dd className="tx-detail-cp">
              <span className="mono" title={tx.txid}>
                {shortAddress(tx.txid)}
              </span>
              <CopyButton text={tx.txid} label="Copy transaction id" />
            </dd>
          </div>
        </dl>

        {tx.bumpable && onBump && (
          <button type="button" className="btn btn-secondary" onClick={onBump}>
            <IconBolt size={17} />
            Speed up (higher fee)
          </button>
        )}

        <a
          className="btn btn-ghost"
          href={chain.explorerTx(tx.txid)}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on explorer
          <IconExternal size={15} />
        </a>
      </div>
    </Modal>
  )
}
