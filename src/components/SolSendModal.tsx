import { useEffect, useRef, useState } from 'react'
import type { PreparedSolSend, SolAsset, SolChainConfig, SolKey, SolUiState } from '../lib/sol'
import {
  broadcastSolSend,
  formatSol,
  formatSolUsdc,
  isValidSolAddress,
  parseSolScanned,
  prepareSolSend,
  SolBroadcastError,
  solTxSeen,
} from '../lib/sol'
import { evmToUsd } from '../lib/units'
import { formatUsd } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'

interface SolSendModalProps {
  chain: SolChainConfig
  solKey: SolKey
  state: SolUiState
  price: number | undefined
  usdcPrice: number | undefined
  onClose: () => void
  onSent: () => void
}

type Step =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string }
  | { kind: 'review'; prepared: PreparedSolSend }
  | { kind: 'broadcasting' }
  | { kind: 'success'; signature: string; prepared: PreparedSolSend }
  | { kind: 'failed'; message: string; signature?: string; prepared: PreparedSolSend }

export default function SolSendModal({
  chain,
  solKey,
  state,
  price,
  usdcPrice,
  onClose,
  onSent,
}: SolSendModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [scanOpen, setScanOpen] = useState(false)
  const [asset, setAsset] = useState<SolAsset>('sol')
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

  const decimals = asset === 'sol' ? 9 : chain.usdc.decimals
  const symbol = asset === 'sol' ? 'SOL' : chain.usdc.symbol
  const fmtAmount = (v: bigint) => (asset === 'sol' ? formatSol(v) : formatSolUsdc(chain, v))

  const destTrimmed = dest.trim()
  const destValid = destTrimmed !== '' && isValidSolAddress(destTrimmed)

  let parsedAmount: bigint | null = null
  let amountError: string | null = null
  if (!sendMax && amountStr.trim() !== '') {
    const t = amountStr.trim()
    if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') {
      amountError = 'Enter a plain number, like 0.25'
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

  const assetPrice = asset === 'sol' ? price : usdcPrice
  const usdHint =
    assetPrice !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, assetPrice)
      : null

  const canContinue = destValid && (sendMax || parsedAmount !== null)

  const handleContinue = () => {
    if (!canContinue) return
    setStep({ kind: 'preparing' })
    prepareSolSend({
      chain,
      key: solKey,
      asset,
      to: destTrimmed,
      amount: parsedAmount ?? 0n,
      sendMax,
    })
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared })
      })
      .catch((e) => {
        if (aliveRef.current) setStep({ kind: 'prepare-error', message: errMessage(e) })
      })
  }

  const handleBroadcast = (prepared: PreparedSolSend) => {
    setStep({ kind: 'broadcasting' })
    broadcastSolSend(solKey, prepared)
      .then((signature) => {
        onSent()
        if (aliveRef.current) setStep({ kind: 'success', signature, prepared })
      })
      .catch((e) => {
        if (aliveRef.current) {
          setStep({
            kind: 'failed',
            message: errMessage(e),
            prepared,
            ...(e instanceof SolBroadcastError && { signature: e.signature }),
          })
        }
      })
  }

  // A failed broadcast may still land for ~a minute (its blockhash stays
  // valid), and a Solana retry does NOT replace it — both would pay. Before
  // returning to the form, check whether the first attempt is on the network.
  const [retryChecking, setRetryChecking] = useState(false)
  const handleRetryAfterFailure = (failed: { signature?: string; prepared: PreparedSolSend }) => {
    if (failed.signature === undefined) {
      setStep({ kind: 'form' })
      return
    }
    const signature = failed.signature
    setRetryChecking(true)
    solTxSeen(chain, signature)
      .then((seen) => {
        if (!aliveRef.current) return
        if (seen) {
          onSent()
          setStep({ kind: 'success', signature, prepared: failed.prepared })
        } else {
          setStep({ kind: 'form' })
        }
      })
      .catch(() => {
        if (aliveRef.current) setStep({ kind: 'form' })
      })
      .finally(() => {
        if (aliveRef.current) setRetryChecking(false)
      })
  }

  const handleScanDecoded = (text: string): string | null => {
    try {
      const r = parseSolScanned(text)
      // A spl-token request denominates its amount in that token, not SOL.
      // Only the chain's own USDC is understood; anything else is refused
      // rather than silently filled into the wrong asset.
      if (r.splToken !== undefined && r.splToken !== chain.usdc.mint) {
        return 'That payment request asks for a token this wallet doesn’t support — only SOL and USDC can be sent here.'
      }
      setDest(r.address)
      if (r.splToken !== undefined) {
        setAsset('usdc')
        if (r.tokenAmount !== undefined && !sendMax) setAmountStr(r.tokenAmount)
      } else if (r.amount !== undefined && !sendMax && asset === 'sol') {
        setAmountStr(formatSol(r.amount))
      }
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
            <span className="field-label" id="sol-asset-label">
              What to send
            </span>
            <div className="fee-pills" role="group" aria-labelledby="sol-asset-label">
              <button
                type="button"
                aria-pressed={asset === 'sol'}
                className={`fee-pill ${asset === 'sol' ? 'is-selected' : ''}`}
                onClick={() => {
                  setAsset('sol')
                  setAmountStr('')
                  setSendMax(false)
                }}
              >
                <span className="fee-pill-label">SOL</span>
                <span className="fee-pill-eta tnum">
                  {state.balance !== null ? `${formatSol(state.balance)} available` : '—'}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={asset === 'usdc'}
                className={`fee-pill ${asset === 'usdc' ? 'is-selected' : ''}`}
                onClick={() => {
                  setAsset('usdc')
                  setAmountStr('')
                  setSendMax(false)
                }}
              >
                <span className="fee-pill-label">{chain.usdc.symbol}</span>
                <span className="fee-pill-eta tnum">
                  {state.usdcBalance !== null
                    ? `${formatSolUsdc(chain, state.usdcBalance)} available`
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
                placeholder={`Solana address on ${chain.networkName}`}
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
                  ? "That's an Ethereum-style address — Solana addresses don't start with 0x."
                  : 'Not a valid Solana address'}
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
                value={sendMax ? '' : amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={sendMax ? 'Entire balance' : `0.0 ${symbol}`}
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
            {sendMax && (
              <span className="field-hint">
                {asset === 'sol'
                  ? 'Sends everything after the network fee.'
                  : `Sends all your ${symbol}. The tiny network fee is paid in SOL.`}
              </span>
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
                {fmtAmount(step.prepared.amount)} {symbol}
              </dd>
            </div>
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">{formatSol(step.prepared.feeLamports)} SOL</dd>
            </div>
            {step.prepared.rentLamports > 0n && (
              <div className="review-row">
                <dt>New-account deposit</dt>
                <dd className="tnum">{formatSol(step.prepared.rentLamports)} SOL</dd>
              </div>
            )}
          </dl>
          {step.prepared.rentLamports > 0n && (
            <p className="text-tertiary">
              The recipient has never held {symbol} on Solana, so this send also creates their
              token account — a one-time deposit the network requires, paid by you in SOL.
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
            <div className="mono address-full">{step.signature}</div>
            <CopyButton text={step.signature} label="Copy transaction signature" withText />
          </div>
          <a
            className="btn btn-secondary"
            href={chain.explorerTx(step.signature)}
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
                {step.message} The attempt could still reach the network for about a minute.
                Going back first checks whether it did — if you retry anyway, wait a minute so a
                landed first attempt can&rsquo;t be paid twice.
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
              disabled={retryChecking}
              onClick={() => handleRetryAfterFailure(step)}
            >
              <IconBack size={16} />
              {retryChecking ? 'Checking…' : 'Back'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
