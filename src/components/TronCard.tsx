import type { TronChainConfig, TronTx, TronUiState } from '../lib/tron'
import { formatTron, formatTronUsdt } from '../lib/tron'
import { evmToUsd } from '../lib/units'
import { formatUsd, shortAddress } from '../lib/format'
import CopyButton from './CopyButton'
import { IconArrowDown, IconArrowUp, IconCard, IconRefresh, Spinner } from './Icons'

interface TronCardProps {
  chain: TronChainConfig
  address: string
  state: TronUiState
  price: number | undefined
  usdtPrice: number | undefined
  onRefresh: () => void
  onReceive: () => void
  onSend: () => void
  onBuy: () => void
  onStake: () => void
  onTxClick: (tx: TronTx) => void
}

export default function TronCard({
  chain,
  address,
  state,
  price,
  usdtPrice,
  onRefresh,
  onReceive,
  onSend,
  onBuy,
  onStake,
  onTxClick,
}: TronCardProps) {
  const { balance, usdtBalance, txs, loading, error } = state
  // staked or unstaking TRX: the holder's, not spendable (bug audit 2026-10-27, BM9)
  const staked = state.staked ?? 0n
  const usd =
    balance !== null && price !== undefined && chain.mainnet
      ? evmToUsd(balance, chain.decimals, price)
      : null
  const usdtUsd =
    usdtBalance !== null && usdtPrice !== undefined && chain.mainnet
      ? evmToUsd(usdtBalance, chain.usdt.decimals, usdtPrice)
      : null

  return (
    <section
      className="card chain-card"
      style={{ borderLeft: `3px solid ${chain.color}` }}
      aria-label={`${chain.name} account`}
    >
      <div className="chain-card-head">
        <div className="chain-id">
          <span
            className="chain-chip"
            style={{ backgroundColor: `${chain.color}24`, color: chain.color }}
          >
            TRX
          </span>
          <span className="chain-name">{chain.name}</span>
        </div>
        <div className="chain-head-right">
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
              {formatTron(balance)} <span className="balance-ticker">TRX</span>
            </div>
            {usd !== null && <div className="balance-usd">{formatUsd(usd)}</div>}
            {usdtBalance !== null && usdtBalance > 0n && (
              <div className="balance-pending">
                {formatTronUsdt(chain, usdtBalance)} {chain.usdt.symbol}
                {usdtUsd !== null ? ` (${formatUsd(usdtUsd)})` : ''}
              </div>
            )}
            {balance === 0n && (usdtBalance ?? 0n) === 0n && staked === 0n && (
              <p className="zero-state">Nothing here yet — tap Receive to get your address.</p>
            )}
          </>
        )}
      </div>

      {error !== null && !loading && (
        <div className="chain-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-small" onClick={onRefresh}>
            Retry
          </button>
        </div>
      )}

      <div className="chain-address">
        <span className="mono text-secondary" title={address}>
          {shortAddress(address)}
        </span>
        <CopyButton text={address} label={`Copy ${chain.name} address`} />
      </div>

      {balance !== null && (
        <button type="button" className="stake-row" onClick={onStake}>
          <span>
            {staked > 0n ? (
              <>
                <span className="tnum">{formatTron(staked)}</span> TRX staked
              </>
            ) : (
              'Stake TRX'
            )}
          </span>
          <span className="stake-row-hint">{staked > 0n ? 'Manage' : 'Earn rewards + cheaper USDT sends'}</span>
        </button>
      )}

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

      {txs.length > 0 && (
        <div className="chain-activity">
          <h3 className="chain-activity-label">Activity</h3>
          <div className="tx-list">
            {txs.slice(0, 3).map((t) => (
              <button key={t.id} type="button" className="tx-row" onClick={() => onTxClick(t)}>
                <span className={`tx-icon tx-icon-${t.direction}`} aria-hidden="true">
                  {t.direction === 'in' ? <IconArrowDown size={14} /> : <IconArrowUp size={14} />}
                </span>
                <div className="tx-main">
                  <span className="tx-title">
                    {t.failed
                      ? 'Failed'
                      : t.direction === 'in'
                        ? 'Received'
                        : t.direction === 'out'
                          ? 'Sent'
                          : 'Self'}
                  </span>
                  <span className="tx-sub">
                    {t.time !== null ? new Date(t.time * 1000).toLocaleDateString() : ''}
                  </span>
                </div>
                <span className={`tx-amount tnum ${t.amount > 0n && !t.failed ? 'tx-amount-in' : ''} ${t.failed ? 'text-tertiary' : ''}`}>
                  {/* a failed send moved nothing: its amount was only intended */}
                  {t.amount > 0n && !t.failed ? '+' : ''}
                  {t.asset === 'usdt'
                    ? `${formatTronUsdt(chain, t.failed && t.amount < 0n ? -t.amount : t.amount)} ${chain.usdt.symbol}`
                    : `${formatTron(t.failed && t.amount < 0n ? -t.amount : t.amount)} TRX`}
                  {t.failed ? ' (not sent)' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
