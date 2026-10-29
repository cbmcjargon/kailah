import type { ChainConfig, PricePoint, TxSummary, WatchAccountKeys } from '../lib/types'
import { formatCoin, formatUsd, shortAddress } from '../lib/format'
import { STRIKE_INVITE_URL } from '../lib/onramp'
import { IconArrowDown, IconArrowUp, IconCard, IconRefresh, Spinner } from './Icons'
import CopyButton from './CopyButton'
import Sparkline from './Sparkline'
import HistoryList from './HistoryList'
import { coinsToUsd, type ChainUiState } from './ui'

interface ChainCardProps {
  chain: ChainConfig
  account: WatchAccountKeys
  /** set for a hardware account ("Ledger"): tags the card and its labels */
  deviceLabel?: string
  state: ChainUiState
  price: number | undefined
  priceHistory: PricePoint[]
  onRefresh: () => void
  onReceive: () => void
  onSend: () => void
  onBuy: () => void
  onSelectTx: (tx: TxSummary) => void
}

export default function ChainCard({
  chain,
  account,
  deviceLabel,
  state,
  price,
  priceHistory,
  onRefresh,
  onReceive,
  onSend,
  onBuy,
  onSelectTx,
}: ChainCardProps) {
  const { account: acct, loading, error } = state
  const balance = acct?.balance ?? null
  // a scan that couldn't read every address, with no complete one to show
  // instead (App keeps the last complete balance when it has one): the
  // figure may be low, and is never "nothing here" (bug audit 2026-10-27, BM4)
  const partialBalance = acct?.incomplete?.balance === true
  const isEmpty = balance !== null && !partialBalance && balance.confirmed === 0n && balance.unconfirmed === 0n
  const showUsd = chain.priceSymbol !== undefined && price !== undefined && balance !== null
  const showSparkline = chain.priceSymbol !== undefined && priceHistory.length >= 2

  // Current (fresh) receive address, with a stable fallback before the first scan.
  const receiveAddr = acct?.nextReceive.address ?? account.address(0, 0).address

  const pending = balance?.unconfirmed ?? 0n
  const pendingLabel =
    pending === 0n
      ? null
      : pending > 0n
        ? `+${formatCoin(pending, chain.decimals)} ${chain.ticker} pending`
        : `−${formatCoin(-pending, chain.decimals)} ${chain.ticker} pending`

  return (
    <section
      className="card chain-card"
      style={{ borderLeft: `3px solid ${chain.color}` }}
      aria-label={`${chain.name}${deviceLabel ? ` ${deviceLabel}` : ''} account`}
    >
      <div className="chain-card-head">
        <div className="chain-id">
          <span
            className="chain-chip"
            style={{ backgroundColor: `${chain.color}24`, color: chain.color }}
          >
            {chain.ticker}
          </span>
          <span className="chain-name">
            {chain.name}
            {deviceLabel !== undefined && <span className="device-chip">{deviceLabel}</span>}
          </span>
        </div>
        <div className="chain-head-right">
          {showSparkline && <Sparkline history={priceHistory} />}
          <button
            type="button"
            className="icon-btn icon-btn-small"
            onClick={onRefresh}
            aria-label={`Refresh ${chain.name} balance`}
            disabled={loading}
          >
            {loading ? <Spinner size={16} /> : <IconRefresh size={16} />}
          </button>
        </div>
      </div>

      <div className="chain-balance">
        {balance === null && loading ? (
          <>
            <div className="skeleton skeleton-balance" />
            <div className="skeleton skeleton-caption" />
          </>
        ) : balance === null ? (
          <div className="balance-main text-secondary">—</div>
        ) : (
          <>
            <div className="balance-main">
              {formatCoin(balance.confirmed, chain.decimals)}{' '}
              <span className="balance-ticker">{chain.ticker}</span>
            </div>
            {pendingLabel && <div className="balance-pending">{pendingLabel}</div>}
            {partialBalance && (
              <p className="zero-state">
                Some addresses couldn&rsquo;t be read just now, so the balance may be higher. Refresh in a
                moment.
              </p>
            )}
            {showUsd && balance !== null && (
              <div className="balance-usd">
                {formatUsd(coinsToUsd(balance.confirmed, chain.decimals, price))}
              </div>
            )}
            {isEmpty && deviceLabel !== undefined && (
              <p className="zero-state">
                Nothing here yet. Tap Receive, check the address on your {deviceLabel}, then send
                coins to it — only the device can spend them.
              </p>
            )}
            {isEmpty && deviceLabel === undefined && chain.id !== 'btc' && (
              <p className="zero-state">Nothing here yet — tap Receive to get your address.</p>
            )}
            {isEmpty && deviceLabel === undefined && chain.id === 'btc' && (
              // Bitcoin onboarding: a first-time holder's most likely next step
              // is buying, so point at the simplest on-ramp (disclosed invite).
              <p className="zero-state">
                Nothing here yet. New to bitcoin?{' '}
                <a href={STRIKE_INVITE_URL} target="_blank" rel="noopener noreferrer">
                  Strike
                </a>
                <span className="buy-option-tag">Invite link</span> is the simplest place to buy
                your first, with fee-free trades to start through this invite (the wallet&rsquo;s
                creator gets a referral reward) — or tap Receive if you already have some.
              </p>
            )}
          </>
        )}
      </div>

      {error !== null && !loading && chain.mainnet && (
        <div className="chain-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-small" onClick={onRefresh}>
            Retry
          </button>
        </div>
      )}
      {error !== null && !loading && !chain.mainnet && (
        // A test network's free services are often busy, and a practice
        // balance holds nothing of value: a calm note, not an alarm. The
        // scan's own message stays on hover (review 2026-10-28).
        <div className="chain-note" role="status" title={error}>
          <span>
            Couldn&rsquo;t check the test network just now; its free data services are often busy.
            Kailah tries again on its own, and your address and Get coins still work.
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={onRefresh}>
            Check now
          </button>
        </div>
      )}

      <div className="chain-address">
        <span className="chain-address-label text-tertiary">Receive</span>
        <span className="mono text-secondary" title={receiveAddr}>
          {shortAddress(receiveAddr)}
        </span>
        <CopyButton text={receiveAddr} label={`Copy ${chain.name} address`} />
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={onBuy}>
          <IconCard size={17} />
          {chain.mainnet ? 'Buy' : 'Get coins'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onReceive}>
          <IconArrowDown size={17} />
          Receive
        </button>
        <button type="button" className="btn btn-primary" onClick={onSend}>
          <IconArrowUp size={17} />
          Send
        </button>
      </div>

      {acct !== null && (
        <div className="chain-activity">
          <span className="chain-activity-label">Activity</span>
          <HistoryList chain={chain} txs={acct.txs} price={price} onSelect={onSelectTx} />
        </div>
      )}
    </section>
  )
}
