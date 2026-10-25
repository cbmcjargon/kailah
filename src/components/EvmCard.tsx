import type { DetectedToken, EvmChainConfig, EvmTx, EvmUiState } from '../lib/evm'
import { evmToUsd, formatEvmAmount } from '../lib/evm'
import { formatUsd, shortAddress } from '../lib/format'
import type { PricePoint } from '../lib/types'
import Sparkline from './Sparkline'
import CopyButton from './CopyButton'
import { IconArrowDown, IconArrowUp, IconCard, IconRefresh, IconWarning, Spinner } from './Icons'

interface EvmCardProps {
  chain: EvmChainConfig
  address: string
  state: EvmUiState
  tokenPrice: number | undefined
  gasPrice: number | undefined
  history: PricePoint[] | undefined
  onRefresh: () => void
  onReceive: () => void
  onSend: () => void
  onSendCustom: (token: DetectedToken) => void
  onBuy: () => void
  onTxClick: (tx: EvmTx) => void
}

export default function EvmCard({
  chain,
  address,
  state,
  tokenPrice,
  gasPrice,
  history,
  onRefresh,
  onReceive,
  onSend,
  onSendCustom,
  onBuy,
  onTxClick,
}: EvmCardProps) {
  const { token, gas, others, txs, loading, error } = state
  const usd =
    token !== null && tokenPrice !== undefined ? evmToUsd(token, chain.token.decimals, tokenPrice) : null
  const gasUsd = gas !== null && gasPrice !== undefined ? evmToUsd(gas, 18, gasPrice) : null

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
            {chain.token.symbol}
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
        {token === null && loading ? (
          <>
            <div className="skeleton skeleton-balance" />
            <div className="skeleton skeleton-caption" />
          </>
        ) : token === null ? (
          <div className="balance-main text-secondary">—</div>
        ) : chain.gasPrimary === true ? (
          <>
            <div className="balance-main">
              {formatEvmAmount(gas ?? 0n, 18)}{' '}
              <span className="balance-ticker">{chain.gas.symbol}</span>
            </div>
            {gasUsd !== null && chain.mainnet && <div className="balance-usd">{formatUsd(gasUsd)}</div>}
            {token > 0n && (
              <div className="balance-pending">
                {formatEvmAmount(token, chain.token.decimals)} {chain.token.symbol}
                {usd !== null && chain.mainnet ? ` (${formatUsd(usd)})` : ''}
              </div>
            )}
            {(gas ?? 0n) === 0n && token === 0n && (
              <p className="zero-state">Nothing here yet — tap Receive to get your address.</p>
            )}
          </>
        ) : (
          <>
            <div className="balance-main">
              {formatEvmAmount(token, chain.token.decimals)}{' '}
              <span className="balance-ticker">{chain.token.symbol}</span>
            </div>
            {usd !== null && chain.mainnet && <div className="balance-usd">{formatUsd(usd)}</div>}
            {gas !== null && (
              <div className="balance-pending">
                {formatEvmAmount(gas, 18)} {chain.gas.symbol} for fees
                {gasUsd !== null && chain.mainnet ? ` (${formatUsd(gasUsd)})` : ''}
              </div>
            )}
            {token === 0n && (gas ?? 0n) === 0n && (
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

      {others.length > 0 && (
        <div className="chain-activity">
          <h3 className="chain-activity-label">Other tokens</h3>
          <div className="tx-list">
            {others.map((t) => (
              <div key={t.address} className="tx-row custom-token-row">
                <span className="tx-icon" aria-hidden="true">
                  <IconWarning size={14} />
                </span>
                <div className="tx-main">
                  <span className="tx-title">
                    {t.unnamed ? 'Unnamed token' : t.symbol}
                  </span>
                  <span className="tx-sub mono" title={t.address}>
                    {shortAddress(t.address)}
                  </span>
                </div>
                <span className="tx-amount tnum">{formatEvmAmount(t.balance, t.decimals)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => onSendCustom(t)}
                >
                  Send
                </button>
              </div>
            ))}
          </div>
          <p className="text-tertiary custom-token-note">
            Tokens that arrived at your address outside the wallet&rsquo;s built-ins. Unexpected
            ones are usually scam airdrops — ignore them, and never visit a site a token name
            tells you to. Kailah never prices or endorses these.
          </p>
        </div>
      )}

      {txs.length > 0 && (
        <div className="chain-activity">
          <h3 className="chain-activity-label">Activity</h3>
          <div className="tx-list">
            {txs.slice(0, 3).map((t) => (
              <button
                key={`${t.hash}-${t.asset}-${t.direction}`}
                type="button"
                className="tx-row"
                onClick={() => onTxClick(t)}
              >
                <span className={`tx-icon tx-icon-${t.direction}`} aria-hidden="true">
                  {t.direction === 'in' ? <IconArrowDown size={14} /> : <IconArrowUp size={14} />}
                </span>
                <div className="tx-main">
                  <span className="tx-title">
                    {t.direction === 'in' ? 'Received' : t.direction === 'out' ? 'Sent' : 'Self'}
                    {t.asset === 'gas' ? ` (${chain.gas.symbol})` : t.tokenSymbol !== undefined ? ' (token)' : ''}
                  </span>
                  <span className="tx-sub">
                    {t.pending
                      ? 'Pending'
                      : t.time !== null
                        ? new Date(t.time * 1000).toLocaleDateString()
                        : ''}
                  </span>
                </div>
                <span className={`tx-amount tnum ${t.amount > 0n ? 'tx-amount-in' : ''}`}>
                  {t.amount > 0n ? '+' : ''}
                  {formatEvmAmount(
                    t.amount,
                    t.asset === 'gas' ? 18 : (t.tokenDecimals ?? chain.token.decimals),
                  )}{' '}
                  {t.asset === 'gas' ? chain.gas.symbol : (t.tokenSymbol ?? chain.token.symbol)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
