import { useEffect, useMemo, useRef, useState } from 'react'
import type { PreparedSolSend, SolAsset, SolChainConfig, SolKey, SolUiState } from '../lib/sol'
import {
  broadcastSolSend,
  formatSol,
  formatSolUsdc,
  isValidSolAddress,
  parseSolScanned,
  prepareSolSend,
  rebroadcastSol,
  SolBroadcastError,
  SolExpiredError,
  SOL_REVIEW_FRESH_MS,
  solPayUnits,
  SOL_LANDED_FAILED,
  solTxStatus,
} from '../lib/sol'
import { evmToUsd } from '../lib/units'
import { formatCoin, formatTypedAmount, formatUsd, readTypedAmount } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import { knownAddresses, SOL_FORMAT } from '../lib/lookalike'
import { sentToAddresses } from '../lib/sentlog'
import { EarlierSendLanded, type Pending } from '../lib/pending'
import PrepareError from './PrepareError'

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
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | { kind: 'review'; prepared: PreparedSolSend; at: number; refreshed?: boolean }
  | { kind: 'broadcasting' }
  | { kind: 'success'; signature: string; prepared: PreparedSolSend }
  | { kind: 'failed'; message: string; signature?: string; signed?: string; prepared: PreparedSolSend }

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
  // Solana Pay extras from a scanned request; they belong to that address
  // only, so editing the address drops them.
  const [pay, setPay] = useState<{ address: string; reference?: string[]; memo?: string } | null>(null)
  const payExtras = pay !== null && pay.address === dest.trim() ? pay : null

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const decimals = asset === 'sol' ? 9 : chain.usdc.decimals
  const symbol = asset === 'sol' ? 'SOL' : chain.usdc.symbol
  // the amount sent, to the last unit: a rounded figure here once hid a
  // short Solana Pay payment (bug audit 2026-10-27, BH6)
  const fmtAmount = (v: bigint) => formatCoin(v, decimals)

  const destTrimmed = dest.trim()
  const destValid = destTrimmed !== '' && isValidSolAddress(destTrimmed)
  const known = useMemo(
    () => knownAddresses([solKey.address], state.txs.map((t) => t.counterparty), sentToAddresses(chain.id)),
    [solKey.address, state.txs, chain.id],
  )
  const lookalike = useLookalike(destValid ? destTrimmed : '', known, SOL_FORMAT)

  const typed = sendMax ? { amount: null, error: null } : readTypedAmount(amountStr, decimals, symbol, '0.25')
  const parsedAmount = typed.amount
  const amountError = typed.error

  const assetPrice = asset === 'sol' ? price : usdcPrice
  const usdHint =
    assetPrice !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, assetPrice)
      : null

  const canContinue = destValid && lookalike.ok && (sendMax || parsedAmount !== null)

  const handleContinue = (refreshed = false) => {
    if (!canContinue) return
    setStep({ kind: 'preparing' })
    prepareSolSend({
      chain,
      key: solKey,
      asset,
      to: destTrimmed,
      amount: parsedAmount ?? 0n,
      sendMax,
      ...(payExtras?.reference !== undefined && { reference: payExtras.reference }),
      ...(payExtras?.memo !== undefined && { memo: payExtras.memo }),
    })
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared, at: Date.now(), refreshed })
      })
      .catch((e) => {
        if (aliveRef.current) {
          setStep({
            kind: 'prepare-error',
            message: errMessage(e),
            landed: e instanceof EarlierSendLanded ? e.entry : undefined,
          })
        }
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
            ...(e instanceof SolBroadcastError && { signature: e.signature, signed: e.signed }),
          })
        }
      })
  }

  // Send the SAME signed bytes again: harmless if the first try landed (same
  // signature), the only safe retry while its blockhash is still valid.
  const handleResend = (failed: { signature?: string; signed?: string; prepared: PreparedSolSend }) => {
    if (failed.signature === undefined || failed.signed === undefined) return
    const { signature, signed, prepared } = failed
    setStep({ kind: 'broadcasting' })
    rebroadcastSol(chain, signature, signed)
      .then(() => {
        onSent()
        if (aliveRef.current) setStep({ kind: 'success', signature, prepared })
      })
      .catch((e) => {
        if (!aliveRef.current) return
        if (e instanceof SolExpiredError) {
          setStep({ kind: 'failed', message: e.message, prepared })
        } else {
          setStep({ kind: 'failed', message: errMessage(e), prepared, signature, signed })
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
    solTxStatus(chain, signature)
      .then((status) => {
        if (!aliveRef.current) return
        if (status === 'ok') {
          onSent()
          setStep({ kind: 'success', signature, prepared: failed.prepared })
        } else if (status === 'failed') {
          // it landed but failed there: not a success (BL25)
          onSent()
          setStep({ ...failed, kind: 'failed', message: SOL_LANDED_FAILED, signature: undefined, signed: undefined })
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
      // exact, or the request is refused (more places than USDC has)
      const tokenUnits =
        r.splToken !== undefined && r.tokenAmount !== undefined
          ? solPayUnits(r.tokenAmount, chain.usdc.decimals, chain.usdc.symbol)
          : undefined
      setDest(r.address)
      setPay({ address: r.address, ...(r.reference !== undefined && { reference: r.reference }), ...(r.memo !== undefined && { memo: r.memo }) })
      if (r.splToken !== undefined) {
        setAsset('usdc')
        // a request's amount is the payment: it replaces MAX (BL3)
        if (tokenUnits !== undefined && tokenUnits > 0n) {
          setSendMax(false)
          setAmountStr(formatTypedAmount(tokenUnits, chain.usdc.decimals))
        }
      } else {
        // a plain request is a SOL request, whatever asset was selected
        setAsset('sol')
        if (r.amount !== undefined) {
          setSendMax(false)
          setAmountStr(formatTypedAmount(r.amount, 9))
        }
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
        <PrepareError
          title="Couldn’t prepare this transaction"
          message={step.message}
          landed={step.landed}
          onBack={() => setStep({ kind: 'form' })}
          onSendAgain={() => handleContinue()}
        />
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
            {step.prepared.memo !== null && (
              <div className="review-row">
                <dt>Memo</dt>
                <dd className="review-addr">{step.prepared.memo}</dd>
              </div>
            )}
            {step.prepared.reference.length > 0 && (
              <div className="review-row">
                <dt>Payment reference</dt>
                <dd className="mono review-addr">{step.prepared.reference.join(', ')}</dd>
              </div>
            )}
          </dl>
          {step.prepared.rentLamports > 0n && (
            <p className="text-tertiary">
              The recipient has never held {symbol} on Solana, so this send also creates their
              token account — a one-time deposit the network requires, paid by you in SOL.
            </p>
          )}
          {step.refreshed === true && (
            <p className="text-tertiary">
              The earlier version&rsquo;s network window closed before you confirmed it, so the wallet
              prepared it again. Check it and confirm.
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
              onClick={() =>
                // a review left open past its blockhash is prepared again first (BM17)
                Date.now() - step.at > SOL_REVIEW_FRESH_MS ? handleContinue(true) : handleBroadcast(step.prepared)
              }
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
              <p>{step.message}</p>
              {step.signed !== undefined && (
                <p>
                  If the network took it before the error, it can still go through for about a
                  minute. &ldquo;Send again&rdquo; re-sends this same transaction, which can&rsquo;t
                  pay twice. Before any new send, the wallet checks whether this one went through
                  and tells you if it did.
                </p>
              )}
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={step.signed !== undefined ? 'btn btn-secondary' : 'btn btn-primary'}
              disabled={retryChecking}
              onClick={() => handleRetryAfterFailure(step)}
            >
              <IconBack size={16} />
              {retryChecking ? 'Checking…' : 'Back'}
            </button>
            {step.signed !== undefined && (
              <button type="button" className="btn btn-primary" onClick={() => handleResend(step)}>
                Send again
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
