import { useEffect, useMemo, useRef, useState } from 'react'
import type { DetectedToken, EvmChainConfig, EvmKey, EvmTx, PreparedEvmSend } from '../lib/evm'
import {
  broadcastEvmSend,
  EvmBroadcastError,
  EvmNonceSettled,
  evmErrorText,
  EvmSendWaiting,
  evmToUsd,
  formatEvmAmount,
  isValidEvmAddress,
  parseEvmScanned,
  prepareEvmSend,
} from '../lib/evm'
import { formatCoin, formatTypedAmount, formatUsd, readTypedAmount } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import { EVM_FORMAT, knownAddresses } from '../lib/lookalike'
import { sentToAddresses } from '../lib/sentlog'
import { agoText, EarlierSendLanded, type Pending, type PendingEvm } from '../lib/pending'
import PrepareError from './PrepareError'

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
  | { kind: 'prepare-error'; message: string; landed?: Pending; waiting?: PendingEvm }
  | { kind: 'review'; prepared: PreparedEvmSend }
  | { kind: 'broadcasting' }
  | { kind: 'success'; hash: string; prepared: PreparedEvmSend }
  | { kind: 'failed'; prepared: PreparedEvmSend; message: string; definite: boolean }

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
  // An earlier send still waiting to confirm, which this one is to replace
  // (the same nonce at a higher fee: only one of the two can go through).
  const [replacing, setReplacing] = useState<PendingEvm | null>(null)
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
  const known = useMemo(
    () => knownAddresses([evmKey.address], txs.map((t) => t.counterparty), sentToAddresses(chain.id)),
    [evmKey.address, txs, chain.id],
  )
  const lookalike = useLookalike(destValid ? destTrimmed : '', known, EVM_FORMAT)

  const typed = sendMax ? { amount: null, error: null } : readTypedAmount(amountStr, decimals, symbol, '12.50')
  const parsedAmount = typed.amount
  const amountError = typed.error

  // Custom tokens are never priced — a fake USD value is exactly the bait
  // scam airdrops rely on.
  const price =
    customToken !== undefined ? undefined : asset === 'token' ? tokenPrice : gasPrice
  const usdHint =
    price !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, decimals, price)
      : null

  const canContinue = destValid && lookalike.ok && (sendMax || parsedAmount !== null)

  const handleContinue = (nonce: number | null = retryNonce) => {
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
      ...(nonce !== null && { reuseNonce: nonce }),
    })
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared })
      })
      .catch((e) => {
        if (!aliveRef.current) return
        // the attempt a retry meant to replace has settled on chain: its
        // nonce is used, so the next try must take a fresh one
        if (e instanceof EvmNonceSettled) {
          setRetryNonce(null)
          setReplacing(null)
        }
        setStep({
          kind: 'prepare-error',
          message: evmErrorText(e, chain),
          landed: e instanceof EarlierSendLanded ? e.entry : undefined,
          waiting: e instanceof EvmSendWaiting ? e.entry : undefined,
        })
      })
  }

  const handleBroadcast = (prepared: PreparedEvmSend) => {
    setStep({ kind: 'broadcasting' })
    broadcastEvmSend(evmKey, prepared)
      .then((hash) => {
        onSent()
        if (aliveRef.current) {
          setRetryNonce(null)
          setReplacing(null)
          setStep({ kind: 'success', hash, prepared })
        }
      })
      .catch((e) => {
        if (aliveRef.current) {
          const definite = e instanceof EvmBroadcastError && e.definite
          // An unclear failure may hide a transaction that actually reached
          // the mempool (e.g. a timeout after acceptance), so any retry must
          // reuse this nonce rather than take a fresh one. A refusal by every
          // node took nothing, so it changes nothing about the nonce, unless
          // it was "nonce too low": that nonce is used, and a retry at it
          // could only be refused again (bug audit 2026-10-27, BM14).
          if (!definite) setRetryNonce(prepared.request.nonce)
          else if (e.nonceUsed) {
            setRetryNonce(null)
            setReplacing(null)
          }
          setStep({ kind: 'failed', prepared, message: evmErrorText(e, chain), definite })
        }
      })
  }

  const handleScanDecoded = (text: string): string | null => {
    try {
      const r = parseEvmScanned(text, chain.chainId)
      // A payment request names its asset: switch to it (or refuse one this
      // form doesn't send) and fill its amount exactly (bug audit BM16).
      if (r.token !== undefined) {
        const sendable = customToken?.address ?? chain.token.address
        if (r.token.toLowerCase() !== sendable.toLowerCase()) {
          return `That payment code asks for a different token (contract ${r.token.slice(0, 10)}…) — this form sends ${customToken?.symbol ?? chain.token.symbol}.`
        }
        if (customToken === undefined) setAsset('token')
        const d = customToken?.decimals ?? chain.token.decimals
        if (r.amount !== undefined && r.amount > 0n) {
          setSendMax(false)
          setAmountStr(formatTypedAmount(r.amount, d))
        }
      } else if (r.amount !== undefined && r.amount > 0n) {
        if (customToken !== undefined) {
          return `That payment code asks for ${chain.gas.symbol}, not ${customToken.symbol} — send it from the ${chain.gas.symbol} form.`
        }
        setAsset('gas')
        setSendMax(false)
        setAmountStr(formatTypedAmount(r.amount, 18))
      }
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
        <PrepareError
          title={step.waiting !== undefined ? 'An earlier send is still waiting' : 'Couldn’t prepare this transaction'}
          message={step.message}
          landed={step.landed}
          onBack={() => setStep({ kind: 'form' })}
          onSendAgain={() => handleContinue()}
          {...(step.waiting !== undefined && {
            action: {
              label: 'Replace it',
              run: () => {
                const w = step.waiting!
                setRetryNonce(w.nonce)
                setReplacing(w)
                handleContinue(w.nonce)
              },
            },
          })}
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
                {formatCoin(
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
          {replacing !== null && step.prepared.request.nonce === replacing.nonce && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>This replaces your waiting send</strong>
                <p>
                  It takes the place of your send from {agoText(replacing.ts)} (to{' '}
                  <span className="mono">{replacing.to.slice(0, 10)}…</span>) at a higher fee. Only
                  one of the two can go through: if that one confirms first, this one fails and costs
                  nothing.
                </p>
              </div>
            </div>
          )}
          {step.prepared.asset === 'token' && step.prepared.recipientIsContract && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>The recipient is a contract, not a wallet</strong>
                <p>
                  Tokens sent to a contract are gone unless it was built to hold them. A Safe
                  can; an exchange&rsquo;s deposit contract or a swap router usually can&rsquo;t.
                  Only continue if the recipient told you a contract address on purpose.
                </p>
              </div>
            </div>
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
            {formatCoin(
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
              <strong>{step.definite ? 'The network refused it' : 'Broadcast failed'}</strong>
              <p>{step.message}</p>
              {!step.definite && (
                <p>
                  If the attempt did reach the network despite the error, it may still go through.
                  Retrying from here re-sends at the same nonce with a higher fee, so it replaces
                  that attempt rather than adding to it. Before any new send, the wallet checks
                  whether this one went through and tells you if it did.
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
