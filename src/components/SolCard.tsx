import type { SolChainConfig, SolTx, SolUiState } from '../lib/sol'
import { formatSol, formatSolUsdc } from '../lib/sol'
import { evmToUsd } from '../lib/units'
import { formatUsd, shortAddress } from '../lib/format'
import type { PricePoint } from '../lib/types'
import Sparkline from './Sparkline'
import CopyButton from './CopyButton'
import { IconArrowDown, IconArrowUp, IconCard, IconRefresh, IconSwap, Spinner } from './Icons'

interface SolCardProps {
  chain: SolChainConfig
  address: string
  state: SolUiState
  price: number | undefined
  usdcPrice: number | undefined
  history: PricePoint[] | undefined
  onRefresh: () => void
  onReceive: () => void
  onSend: () => void
  onBuy: () => void
  onSwap: () => void
  onStake: () => void
  onTxClick: (tx: SolTx) => void
}

export default function SolCard({
  chain,
  address,
  state,
  price,
  usdcPrice,
  history,
  onRefresh,
  onReceive,
  onSend,
  onBuy,
  onSwap,
  onStake,
  onTxClick,
}: SolCardProps) {
  const { balance, usdcBalance, stakeAccounts, txs, loading, error } = state
  const stakedTotal = stakeAccounts.reduce((sum, a) => sum + a.lamports, 0n)
  const usd =
    balance !== null && price !== undefined && chain.mainnet
      ? evmToUsd(balance, chain.decimals, price)
      : null
  const usdcUsd =
    usdcBalance !== null && usdcPrice !== undefined && chain.mainnet
      ? evmToUsd(usdcBalance, chain.usdc.decimals, usdcPrice)
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
            SOL
          </span>
          <span className="chain-name">{chain.name}</span>
        </div>
        <div className="chain-head-right">
          {chain.mainnet && history !== undefined && history.length > 1 && (
            <Sparkline history={history} color={chain.color} />
          )}
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
              {formatSol(balance)} <span className="balance-ticker">SOL</span>
            </div>
            {usd !== null && <div className="balance-usd">{formatUsd(usd)}</div>}
            {usdcBalance !== null && usdcBalance > 0n && (
              <div className="balance-pending">
                {formatSolUsdc(chain, usdcBalance)} {chain.usdc.symbol}
                {usdcUsd !== null ? ` (${formatUsd(usdcUsd)})` : ''}
              </div>
            )}
            {balance === 0n && (usdcBalance ?? 0n) === 0n && stakedTotal === 0n && (
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
            {stakedTotal > 0n ? (
              <>
                <span className="tnum">{formatSol(stakedTotal)}</span> SOL staked
              </>
            ) : (
              'Stake SOL'
            )}
          </span>
          <span className="stake-row-hint">
            {stakedTotal > 0n ? 'Manage' : 'Earn network rewards'}
          </span>
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
        {chain.mainnet && (
          <button type="button" className="btn btn-secondary" onClick={onSwap}>
            <IconSwap size={17} />
            Swap
          </button>
        )}
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
              <button
                key={t.signature}
                type="button"
                className="tx-row"
                onClick={() => onTxClick(t)}
              >
                <span className={`tx-icon tx-icon-${t.swap ? 'self' : t.direction}`} aria-hidden="true">
                  {t.swap ? (
                    <IconSwap size={14} />
                  ) : t.direction === 'in' ? (
                    <IconArrowDown size={14} />
                  ) : (
                    <IconArrowUp size={14} />
                  )}
                </span>
                <div className="tx-main">
                  <span className="tx-title">
                    {t.failed
                      ? 'Failed'
                      : t.swap
                        ? t.amount < 0n
                          ? `Swapped SOL → ${chain.usdc.symbol}`
                          : `Swapped ${chain.usdc.symbol} → SOL`
                        : t.direction === 'in'
                          ? 'Received'
                          : t.direction === 'out'
                            ? 'Sent'
                            : 'Self'}
                  </span>
                  <span className="tx-sub">
                    {t.swap &&
                      (t.amount < 0n
                        ? `${formatSol(-t.amount)} SOL · `
                        : `${formatSolUsdc(chain, -t.usdcAmount)} ${chain.usdc.symbol} · `)}
                    {t.time !== null ? new Date(t.time * 1000).toLocaleDateString() : ''}
                  </span>
                </div>
                {t.swap ? (
                  // what the swap brought in; what it took is on the line above
                  <span className="tx-amount tnum tx-amount-in">
                    {t.amount < 0n
                      ? `+${formatSolUsdc(chain, t.usdcAmount)} ${chain.usdc.symbol}`
                      : `+${formatSol(t.amount)} SOL`}
                  </span>
                ) : t.usdcAmount !== 0n ? (
                  <span className={`tx-amount tnum ${t.usdcAmount > 0n ? 'tx-amount-in' : ''}`}>
                    {t.usdcAmount > 0n ? '+' : ''}
                    {formatSolUsdc(chain, t.usdcAmount)} {chain.usdc.symbol}
                  </span>
                ) : (
                  <span className={`tx-amount tnum ${t.amount > 0n ? 'tx-amount-in' : ''}`}>
                    {t.amount > 0n ? '+' : ''}
                    {formatSol(t.amount)} SOL
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
