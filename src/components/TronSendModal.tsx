import { useEffect, useMemo, useRef, useState } from 'react'
import type { PreparedTronSend, TronAsset, TronChainConfig, TronKey, TronUiState } from '../lib/tron'
import {
  broadcastTronSend,
  rebroadcastTron,
  TronBroadcastError,
  formatTron,
  formatTronUsdt,
  isValidTronAddress,
  parseTronScanned,
  prepareTronSend,
  TRON_REVIEW_FRESH_MS,
} from '../lib/tron'
import { evmToUsd } from '../lib/units'
import { formatUsd, readTypedAmount } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import { knownAddresses, TRON_FORMAT } from '../lib/lookalike'
import { sentToAddresses } from '../lib/sentlog'
import { EarlierSendLanded, type Pending } from '../lib/pending'
import PrepareError from './PrepareError'

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
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | { kind: 'review'; prepared: PreparedTronSend; at: number; refreshed?: boolean }
  | { kind: 'broadcasting' }
  | { kind: 'success'; txId: string; prepared: PreparedTronSend }
  | { kind: 'failed'; message: string; err?: TronBroadcastError }

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
  const sentRef = useRef<PreparedTronSend | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [asset, setAsset] = useState<TronAsset>('trx')
  const [dest, setDest] = useState('')
  const [amountStr, setAmountStr] = useState('')
  // everything: TRX after this send's own network cost, or all the USDT (BL33)
  const [sendMax, setSendMax] = useState(false)

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
  const known = useMemo(
    () => knownAddresses([tronKey.address], state.txs.map((t) => t.counterparty), sentToAddresses(chain.id)),
    [tronKey.address, state.txs, chain.id],
  )
  const lookalike = useLookalike(destValid ? destTrimmed : '', known, TRON_FORMAT)

  const typed = sendMax ? { amount: null, error: null } : readTypedAmount(amountStr, decimals, symbol, '25')
  const parsedAmount = typed.amount
  const amountError = typed.error

  const assetPrice = asset === 'trx' ? price : usdtPrice
  const usdHint =
    assetPrice !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, assetPrice)
      : null

  const canContinue = destValid && lookalike.ok && (sendMax || (parsedAmount !== null && amountError === null))

  const handleContinue = (refreshed = false) => {
    if (!canContinue) return
    setStep({ kind: 'preparing' })
    prepareTronSend(chain, tronKey, asset, destTrimmed, parsedAmount ?? 0n, { sendMax })
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared, at: Date.now(), refreshed })
      })
      .catch((e: unknown) => {
        if (aliveRef.current) {
          setStep({
            kind: 'prepare-error',
            message: errMessage(e),
            landed: e instanceof EarlierSendLanded ? e.entry : undefined,
          })
        }
      })
  }

  const settle = (p: Promise<string>, prepared: PreparedTronSend) => {
    setStep({ kind: 'broadcasting' })
    p.then((txId) => {
      onSent()
      if (aliveRef.current) setStep({ kind: 'success', txId, prepared })
    }).catch((e: unknown) => {
      if (aliveRef.current) {
        setStep({ kind: 'failed', message: errMessage(e), err: e instanceof TronBroadcastError ? e : undefined })
      }
    })
  }
  const handleBroadcast = (prepared: PreparedTronSend) => {
    sentRef.current = prepared
    settle(broadcastTronSend(tronKey, prepared), prepared)
  }
  // the SAME signed transaction again — never a rebuilt one, which could pay twice
  const handleResend = (err: TronBroadcastError) => {
    if (sentRef.current !== null) settle(rebroadcastTron(chain, err), sentRef.current)
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
                  setSendMax(false)
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
                  setSendMax(false)
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
            {sendMax && asset === 'trx' && <span className="field-hint">Sends everything after the network cost.</span>}
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
        <PrepareError
          title="Couldn’t prepare this transaction"
          message={step.message}
          landed={step.landed}
          onBack={() => setStep({ kind: 'form' })}
          onSendAgain={handleContinue}
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
          {step.prepared.recipientIsContract === true && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>The recipient is a contract, not a wallet</strong>
                <p>
                  What you send to a contract is gone unless it was built to hold it. An exchange
                  deposit address is a wallet; a token or swap contract usually isn&rsquo;t. Only
                  continue if the recipient gave you a contract address on purpose.
                </p>
              </div>
            </div>
          )}
          {step.refreshed === true && (
            <p className="text-tertiary">
              The earlier version was about to expire on the network, so the wallet built it again.
              Check it and confirm.
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
                // a review left open near its expiry is built again first (BL32)
                Date.now() - step.at > TRON_REVIEW_FRESH_MS ? handleContinue(true) : handleBroadcast(step.prepared)
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
              <p>{step.message}</p>
              {step.err !== undefined && (
                <p>
                  If the network took it before the error, it can still go through for about a
                  minute. &ldquo;Send again&rdquo; re-sends this same transaction, which can&rsquo;t pay
                  twice. Before any new send, the wallet checks whether this one went through and
                  tells you if it did.
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
              className={step.err !== undefined ? 'btn btn-secondary' : 'btn btn-primary'}
              onClick={() => setStep({ kind: 'form' })}
            >
              <IconBack size={16} />
              Back
            </button>
            {step.err !== undefined && (
              <button type="button" className="btn btn-primary" onClick={() => handleResend(step.err!)}>
                Send again
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
