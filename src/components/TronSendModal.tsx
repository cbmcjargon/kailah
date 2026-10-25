import { useEffect, useRef, useState } from 'react'
import type { PreparedTronSend, TronAsset, TronChainConfig, TronKey, TronUiState } from '../lib/tron'
import {
  broadcastTronSend,
  formatTron,
  formatTronUsdt,
  isValidTronAddress,
  parseTronScanned,
  prepareTronSend,
} from '../lib/tron'
import { evmToUsd } from '../lib/units'
import { formatUsd } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'

interface TronSendModalProps {
  chain: TronChainConfig
  tronKey: TronKey
  state: TronUiState
  price: number | undefined
  usdtPrice: number | undefined
  onClose: () => void
  onSent: () => void
}

type Step =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string }
  | { kind: 'review'; prepared: PreparedTronSend }
  | { kind: 'broadcasting' }
  | { kind: 'success'; txId: string; prepared: PreparedTronSend }
  | { kind: 'failed'; message: string }

export default function TronSendModal({
  chain,
  tronKey,
  state,
  price,
  usdtPrice,
  onClose,
  onSent,
}: TronSendModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [scanOpen, setScanOpen] = useState(false)
  const [asset, setAsset] = useState<TronAsset>('trx')
  const [dest, setDest] = useState('')
  const [amountStr, setAmountStr] = useState('')

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const decimals = asset === 'trx' ? 6 : chain.usdt.decimals
  const symbol = asset === 'trx' ? 'TRX' : chain.usdt.symbol
  const fmtAmount = (v: bigint) => (asset === 'trx' ? formatTron(v) : formatTronUsdt(chain, v))

  const destTrimmed = dest.trim()
  const destValid = destTrimmed !== '' && isValidTronAddress(destTrimmed)

  let parsedAmount: bigint | null = null
  let amountError: string | null = null
  const trimmed = amountStr.trim()
  if (trimmed !== '') {
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
      amountError = 'Enter a plain number, like 25'
    } else {
      const [whole = '0', frac = ''] = trimmed.split('.')
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

  const assetPrice = asset === 'trx' ? price : usdtPrice
  const usdHint =
    assetPrice !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, assetPrice)
      : null

  const canContinue = destValid && parsedAmount !== null && amountError === null

  const handleContinue = () => {
    if (!canContinue || parsedAmount === null) return
    setStep({ kind: 'preparing' })
    prepareTronSend(chain, tronKey, asset, destTrimmed, parsedAmount)
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared })
      })
      .catch((e: unknown) => {
        if (aliveRef.current) setStep({ kind: 'prepare-error', message: errMessage(e) })
      })
  }

  const handleBroadcast = (prepared: PreparedTronSend) => {
    setStep({ kind: 'broadcasting' })
    broadcastTronSend(tronKey, prepared)
      .then((txId) => {
        onSent()
        if (aliveRef.current) setStep({ kind: 'success', txId, prepared })
      })
      .catch((e: unknown) => {
        if (aliveRef.current) setStep({ kind: 'failed', message: errMessage(e) })
      })
  }

  const handleScanDecoded = (text: string): string | null => {
    try {
      const r = parseTronScanned(text)
      setDest(r.address)
      setScanOpen(false)
      return null
    } catch (e) {
      return errMessage(e)
    }
  }

  const broadcasting = step.kind === 'broadcasting'

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
          <div className="field">
            <span className="field-label" id="tron-asset-label">
              What to send
            </span>
            <div className="fee-pills" role="group" aria-labelledby="tron-asset-label">
              <button
                type="button"
                aria-pressed={asset === 'trx'}
                className={`fee-pill ${asset === 'trx' ? 'is-selected' : ''}`}
                onClick={() => {
                  setAsset('trx')
                  setAmountStr('')
                }}
              >
                <span className="fee-pill-label">TRX</span>
                <span className="fee-pill-eta tnum">
                  {state.balance !== null ? `${formatTron(state.balance)} available` : '—'}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={asset === 'usdt'}
                className={`fee-pill ${asset === 'usdt' ? 'is-selected' : ''}`}
                onClick={() => {
                  setAsset('usdt')
                  setAmountStr('')
                }}
              >
                <span className="fee-pill-label">{chain.usdt.symbol}</span>
                <span className="fee-pill-eta tnum">
                  {state.usdtBalance !== null
                    ? `${formatTronUsdt(chain, state.usdtBalance)} available`
                    : '—'}
                </span>
              </button>
            </div>
          </div>

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
                placeholder={`T… address on ${chain.networkName}`}
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
                {/^0x/i.test(destTrimmed)
                  ? "That's an Ethereum-style address — TRON addresses start with T."
                  : 'Not a valid TRON address'}
              </span>
            )}
          </label>

          <label className="field">
            <span className="field-label">Amount</span>
            <div className="amount-row">
              <input
                type="text"
                inputMode="decimal"
                className={`input amount-input ${amountError !== null ? 'input-invalid' : ''}`}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={`0.0 ${symbol}`}
              />
            </div>
            {amountError !== null && (
              <span className="field-hint field-hint-error">{amountError}</span>
            )}
            {usdHint !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHint)}</span>
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
          <p>Building and verifying the transaction…</p>
          <p className="text-tertiary">
            The wallet decodes the raw bytes and signs only if they say exactly what you asked.
          </p>
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
                {fmtAmount(step.prepared.amount)} {symbol}
              </dd>
            </div>
            <div className="review-row">
              <dt>Estimated network cost</dt>
              <dd className="tnum">~{formatTron(step.prepared.estimatedFeeSun)} TRX</dd>
            </div>
            {step.prepared.feeLimitSun > 0n && (
              <div className="review-row">
                <dt>Hard cost cap</dt>
                <dd className="tnum">{formatTron(step.prepared.feeLimitSun)} TRX</dd>
              </div>
            )}
          </dl>
          {step.prepared.createsAccount && step.prepared.asset === 'trx' && (
            <p className="text-tertiary">
              This address has never been used, so TRON charges a one-time ~1.1 TRX account
              creation cost (included in the estimate above).
            </p>
          )}
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
            {fmtAmount(step.prepared.amount)} {symbol} is on its way.
          </p>
          <div className="address-block">
            <div className="mono address-full">{step.txId}</div>
            <CopyButton text={step.txId} label="Copy transaction id" withText />
          </div>
          <a
            className="btn btn-secondary"
            href={chain.explorerTx(step.txId)}
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
              <p>
                {step.message} Nothing further was sent — go back to rebuild fresh if you want
                to retry.
              </p>
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'form' })}>
              <IconBack size={16} />
              Back
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
