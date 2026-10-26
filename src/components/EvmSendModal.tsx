import { useEffect, useMemo, useRef, useState } from 'react'
import type { DetectedToken, EvmChainConfig, EvmKey, EvmTx, PreparedEvmSend } from '../lib/evm'
import {
  broadcastEvmSend,
  evmToUsd,
  formatEvmAmount,
  isValidEvmAddress,
  parseEvmScanned,
  prepareEvmSend,
} from '../lib/evm'
import { formatUsd } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import { EVM_FORMAT, knownFromEvm } from '../lib/lookalike'

interface EvmSendModalProps {
  chain: EvmChainConfig
  evmKey: EvmKey
  balances: { token: bigint | null; gas: bigint | null } | null
  /** this chain's history, for the lookalike-address check */
  txs: EvmTx[]
  tokenPrice: number | undefined
  gasPrice: number | undefined
  /** when set, the modal sends this detected custom ERC-20 (no asset pills) */
  customToken?: DetectedToken
  onClose: () => void
  onSent: () => void
}

type Asset = 'token' | 'gas'

type Step =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string }
  | { kind: 'review'; prepared: PreparedEvmSend }
  | { kind: 'broadcasting' }
  | { kind: 'success'; hash: string; prepared: PreparedEvmSend }
  | { kind: 'failed'; prepared: PreparedEvmSend; message: string }

export default function EvmSendModal({
  chain,
  evmKey,
  balances,
  txs,
  tokenPrice,
  gasPrice,
  customToken,
  onClose,
  onSent,
}: EvmSendModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [scanOpen, setScanOpen] = useState(false)
  // Nonce of an attempt whose broadcast failed ambiguously. A retry re-signs
  // at this same nonce so it REPLACES the first attempt instead of paying a
  // second time if the first actually reached the network (see EvmSendArgs).
  const [retryNonce, setRetryNonce] = useState<number | null>(null)
  const [asset, setAsset] = useState<Asset>(chain.gasPrimary === true ? 'gas' : 'token')
  const [dest, setDest] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [sendMax, setSendMax] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const decimals =
    asset === 'token' ? (customToken?.decimals ?? chain.token.decimals) : 18
  const symbol =
    asset === 'token' ? (customToken?.symbol ?? chain.token.symbol) : chain.gas.symbol
  const destTrimmed = dest.trim()
  const destValid = destTrimmed !== '' && isValidEvmAddress(destTrimmed)
  const known = useMemo(() => knownFromEvm(evmKey.address, txs), [evmKey.address, txs])
  const lookalike = useLookalike(destValid ? destTrimmed : '', known, EVM_FORMAT)

  let parsedAmount: bigint | null = null
  let amountError: string | null = null
  if (!sendMax && amountStr.trim() !== '') {
    const t = amountStr.trim()
    if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') {
      amountError = 'Enter a plain number, like 12.50'
    } else {
      const [whole = '0', frac = ''] = t.split('.')
      if (frac.length > decimals) {
        amountError = `${symbol} has at most ${decimals} decimal places`
      } else {
        parsedAmount = BigInt(whole + frac.padEnd(decimals, '0'))
        if (parsedAmount <= 0n) {
          parsedAmount = null
          amountError = 'Amount must be more than zero'
        }
      }
    }
  }

  // Custom tokens are never priced — a fake USD value is exactly the bait
  // scam airdrops rely on.
  const price =
    customToken !== undefined ? undefined : asset === 'token' ? tokenPrice : gasPrice
  const usdHint =
    price !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, price)
      : null

  const canContinue = destValid && lookalike.ok && (sendMax || parsedAmount !== null)

  const handleContinue = () => {
    if (!canContinue) return
    setStep({ kind: 'preparing' })
    prepareEvmSend({
      chain,
      key: evmKey,
      to: destTrimmed,
      amount: parsedAmount ?? 0n,
      asset,
      ...(customToken !== undefined && { customToken }),
      sendMax,
      ...(retryNonce !== null && { reuseNonce: retryNonce }),
    })
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared })
      })
      .catch((e) => {
        if (aliveRef.current) setStep({ kind: 'prepare-error', message: errMessage(e) })
      })
  }

  const handleBroadcast = (prepared: PreparedEvmSend) => {
    setStep({ kind: 'broadcasting' })
    broadcastEvmSend(evmKey, prepared)
      .then((hash) => {
        onSent()
        if (aliveRef.current) {
          setRetryNonce(null)
          setStep({ kind: 'success', hash, prepared })
        }
      })
      .catch((e) => {
        if (aliveRef.current) {
          // The failure may hide a transaction that actually reached the
          // mempool (e.g. a timeout after acceptance), so any retry must
          // reuse this nonce rather than take a fresh one.
          setRetryNonce(prepared.request.nonce)
          setStep({ kind: 'failed', prepared, message: errMessage(e) })
        }
      })
  }

  const handleScanDecoded = (text: string): string | null => {
    try {
      const r = parseEvmScanned(text, chain.chainId)
      setDest(r.address)
      setScanOpen(false)
      return null
    } catch (e) {
      return errMessage(e)
    }
  }

  const broadcasting = step.kind === 'broadcasting'
  const feeUsd = (p: PreparedEvmSend): string | null =>
    gasPrice !== undefined && chain.mainnet ? formatUsd(evmToUsd(p.feeWei, 18, gasPrice)) : null

  return (
    <Modal title={`Send ${symbol}`} onClose={onClose} canDismiss={!broadcasting}>
      {step.kind === 'form' && scanOpen && (
        <QrScanner onDecoded={handleScanDecoded} onClose={() => setScanOpen(false)} />
      )}

      {step.kind === 'form' && !scanOpen && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            handleContinue()
          }}
        >
          {customToken !== undefined ? (
            <div className="warning-box">
              <IconWarning size={20} />
              <div>
                <strong>
                  Custom token: {customToken.unnamed ? 'unnamed' : customToken.symbol}
                </strong>
                <p className="mono" title={customToken.address}>
                  {customToken.address}
                </p>
                <p>
                  Kailah can&rsquo;t verify what this token is worth — only that its contract
                  says you hold {formatEvmAmount(customToken.balance, customToken.decimals)}.
                  If it arrived unexpectedly, close this and ignore it.
                </p>
              </div>
            </div>
          ) : (
            <div className="field">
              <span className="field-label" id="evm-asset-label">
                Asset
              </span>
              <div className="fee-pills" role="group" aria-labelledby="evm-asset-label">
                <button
                  type="button"
                  aria-pressed={asset === 'token'}
                  className={`fee-pill ${asset === 'token' ? 'is-selected' : ''}`}
                  onClick={() => {
                    setAsset('token')
                    setAmountStr('')
                    setSendMax(false)
                  }}
                >
                  <span className="fee-pill-label">{chain.token.symbol}</span>
                  <span className="fee-pill-eta tnum">
                    {balances?.token != null ? formatEvmAmount(balances.token, chain.token.decimals) : '—'}
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={asset === 'gas'}
                  className={`fee-pill ${asset === 'gas' ? 'is-selected' : ''}`}
                  onClick={() => {
                    setAsset('gas')
                    setAmountStr('')
                    setSendMax(false)
                  }}
                >
                  <span className="fee-pill-label">{chain.gas.symbol}</span>
                  <span className="fee-pill-eta tnum">
                    {balances?.gas != null ? formatEvmAmount(balances.gas, 18) : '—'}
                  </span>
                </button>
              </div>
            </div>
          )}

          <label className="field">
            <span className="field-label">To</span>
            <div className="dest-row">
              <input
                type="text"
                className={`input mono dest-input ${destTrimmed !== '' && !destValid ? 'input-invalid' : ''}`}
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={`0x… address on ${chain.networkName}`}
              />
              <button
                type="button"
                className="icon-btn dest-scan-btn"
                aria-label="Scan a QR code"
                onClick={() => setScanOpen(true)}
              >
                <IconQrScan />
              </button>
            </div>
            {destTrimmed !== '' && !destValid && (
              <span className="field-hint field-hint-error">
                {/^(bc1|tb1|ltc1|D)/i.test(destTrimmed)
                  ? `That looks like a Bitcoin-family address — ${chain.token.symbol} on ${chain.networkName} needs a 0x address.`
                  : 'Not a valid 0x address'}
              </span>
            )}
          </label>

          {lookalike.match !== null && (
            <LookalikeWarning
              address={destTrimmed}
              match={lookalike.match}
              checked={lookalike.checked}
              onCheckedChange={lookalike.setChecked}
            />
          )}

          <label className="field">
            <span className="field-label">Amount</span>
            <div className="amount-row">
              <input
                type="text"
                inputMode="decimal"
                className={`input amount-input ${amountError !== null ? 'input-invalid' : ''}`}
                value={sendMax ? '' : amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={sendMax ? `Entire ${symbol} balance` : `0.0 ${symbol}`}
                disabled={sendMax}
              />
              <button
                type="button"
                className={`max-toggle ${sendMax ? 'is-on' : ''}`}
                aria-pressed={sendMax}
                onClick={() => setSendMax((v) => !v)}
              >
                MAX
              </button>
            </div>
            {amountError !== null && !sendMax && (
              <span className="field-hint field-hint-error">{amountError}</span>
            )}
            {usdHint !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHint)}</span>
            )}
            {sendMax && asset === 'gas' && (
              <span className="field-hint">Sends everything after the network fee.</span>
            )}
          </label>

          <p className="text-tertiary">{chain.feeNote}</p>

          <button type="submit" className="btn btn-primary" disabled={!canContinue}>
            Continue
          </button>
        </form>
      )}

      {step.kind === 'preparing' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Preparing transaction…</p>
        </div>
      )}

      {step.kind === 'prepare-error' && (
        <div className="stack">
          <div className="warning-box" role="alert">
            <IconWarning size={20} />
            <div>
              <strong>Couldn&rsquo;t prepare this transaction</strong>
              <p>{step.message}</p>
            </div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setStep({ kind: 'form' })}>
            <IconBack size={16} />
            Back
          </button>
        </div>
      )}

      {step.kind === 'review' && (
        <div className="stack">
          <p className="text-secondary">Check everything — sends cannot be reversed.</p>
          <dl className="review-list">
            <div className="review-row">
              <dt>To</dt>
              <dd className="mono review-addr">{step.prepared.to}</dd>
            </div>
            <div className="review-row">
              <dt>Amount</dt>
              <dd className="tnum">
                {formatEvmAmount(
                  step.prepared.amount,
                  step.prepared.asset === 'gas'
                    ? 18
                    : (step.prepared.customToken?.decimals ?? chain.token.decimals),
                )}{' '}
                {step.prepared.asset === 'gas'
                  ? chain.gas.symbol
                  : (step.prepared.customToken?.symbol ?? chain.token.symbol)}
              </dd>
            </div>
            {step.prepared.customToken !== undefined && (
              <div className="review-row">
                <dt>Token contract</dt>
                <dd className="mono review-addr">{step.prepared.customToken.address}</dd>
              </div>
            )}
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">
                up to {formatEvmAmount(step.prepared.feeWei, 18)} {chain.gas.symbol}
                {feeUsd(step.prepared) !== null && (
                  <span className="text-tertiary"> · {feeUsd(step.prepared)}</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'form' })}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleBroadcast(step.prepared)}
            >
              Confirm &amp; send
            </button>
          </div>
        </div>
      )}

      {step.kind === 'broadcasting' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Broadcasting…</p>
          <p className="text-tertiary">Don&rsquo;t close this window.</p>
        </div>
      )}

      {step.kind === 'success' && (
        <div className="stack success-body">
          <div className="success-badge">
            <IconCheck size={26} />
          </div>
          <h3 className="state-title">Sent</h3>
          <p className="text-secondary tnum">
            {formatEvmAmount(
              step.prepared.amount,
              step.prepared.asset === 'gas'
                ? 18
                : (step.prepared.customToken?.decimals ?? chain.token.decimals),
            )}{' '}
            {step.prepared.asset === 'gas'
              ? chain.gas.symbol
              : (step.prepared.customToken?.symbol ?? chain.token.symbol)}{' '}
            is on its way.
          </p>
          <div className="address-block">
            <div className="mono address-full">{step.hash}</div>
            <CopyButton text={step.hash} label="Copy transaction hash" withText />
          </div>
          <a
            className="btn btn-secondary"
            href={chain.explorerTx(step.hash)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on explorer
            <IconExternal size={15} />
          </a>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {step.kind === 'failed' && (
        <div className="stack">
          <div className="warning-box" role="alert">
            <IconWarning size={20} />
            <div>
              <strong>Broadcast failed</strong>
              <p>{step.message}</p>
              <p>
                If the attempt did reach the network despite the error, it may still go through —
                check the explorer before assuming it failed. Retrying from here replaces that
                attempt instead of paying twice.
              </p>
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep({ kind: 'form' })}
            >
              <IconBack size={16} />
              Back
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
