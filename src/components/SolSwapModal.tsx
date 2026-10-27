import { useEffect, useRef, useState } from 'react'
import type { SolChainConfig, SolKey, SolUiState } from '../lib/sol'
import { formatSol, formatSolUsdc, rebroadcastSol, SolBroadcastError, SolExpiredError, solTxSeen } from '../lib/sol'
import type { MarketGap, PreparedSwap, SwapDirection, SwapQuote } from '../lib/solswap'
import {
  broadcastSwap,
  getSwapQuote,
  MARKET_GAP_WARN_PCT,
  prepareSwap,
  swapMarketGap,
  SWAP_SLIPPAGE_BPS,
} from '../lib/solswap'
import { evmToUsd } from '../lib/units'
import { formatUsd } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import { IconBack, IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'

interface SolSwapModalProps {
  chain: SolChainConfig
  solKey: SolKey
  state: SolUiState
  price: number | undefined
  usdcPrice: number | undefined
  onClose: () => void
  onSwapped: () => void
}

type Step =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string }
  | { kind: 'review'; prepared: PreparedSwap }
  | { kind: 'broadcasting' }
  | { kind: 'success'; signature: string; prepared: PreparedSwap }
  | { kind: 'failed'; message: string; signature?: string; signed?: string; prepared: PreparedSwap }

/** SOL kept back on a MAX swap so fees and a possible token account fit. */
const MAX_SWAP_SOL_RESERVE = 5_000_000n

export default function SolSwapModal({
  chain,
  solKey,
  state,
  price,
  usdcPrice,
  onClose,
  onSwapped,
}: SolSwapModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [direction, setDirection] = useState<SwapDirection>('sol-to-usdc')
  const [amountStr, setAmountStr] = useState('')
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const quoteSeqRef = useRef(0)
  // bumped to fetch a fresh route: after a failed test run, the same quote
  // would rebuild the same failing route for up to 30 s
  const [requote, setRequote] = useState(0)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const solToUsdc = direction === 'sol-to-usdc'
  const inDecimals = solToUsdc ? 9 : chain.usdc.decimals
  const inSymbol = solToUsdc ? 'SOL' : chain.usdc.symbol
  const outSymbol = solToUsdc ? chain.usdc.symbol : 'SOL'
  const fmtIn = (v: bigint) => (solToUsdc ? formatSol(v) : formatSolUsdc(chain, v))
  const fmtOut = (v: bigint) => (solToUsdc ? formatSolUsdc(chain, v) : formatSol(v))
  const inBalance = solToUsdc ? state.balance : state.usdcBalance

  let parsedAmount: bigint | null = null
  let amountError: string | null = null
  const trimmed = amountStr.trim()
  if (trimmed !== '') {
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
      amountError = 'Enter a plain number, like 0.25'
    } else {
      const [whole = '0', frac = ''] = trimmed.split('.')
      if (frac.length > inDecimals) {
        amountError = `${inSymbol} has at most ${inDecimals} decimal places`
      } else {
        parsedAmount = BigInt(whole + frac.padEnd(inDecimals, '0'))
        if (parsedAmount <= 0n) {
          parsedAmount = null
          if (trimmed !== '') amountError = 'Amount must be more than zero'
        }
      }
    }
  }
  const overBalance =
    parsedAmount !== null && inBalance !== null && parsedAmount > inBalance
  if (overBalance && amountError === null) {
    amountError = `You only have ${fmtIn(inBalance ?? 0n)} ${inSymbol}`
  }

  // Live quote, debounced; a sequence guard keeps stale replies from landing.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (parsedAmount === null || overBalance) {
      setQuoteLoading(false)
      return
    }
    const seq = ++quoteSeqRef.current
    setQuoteLoading(true)
    const timer = setTimeout(() => {
      getSwapQuote(chain, direction, parsedAmount, solKey.address)
        .then((q) => {
          if (aliveRef.current && quoteSeqRef.current === seq) {
            setQuote(q)
            setQuoteLoading(false)
          }
        })
        .catch((e: unknown) => {
          if (aliveRef.current && quoteSeqRef.current === seq) {
            setQuoteError(errMessage(e))
            setQuoteLoading(false)
          }
        })
    }, 600)
    return () => clearTimeout(timer)
    // parsedAmount is derived from amountStr; comparing the string avoids
    // re-running on unrelated renders while still tracking every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountStr, direction, chain, requote])

  const usdHint =
    parsedAmount !== null && (solToUsdc ? price : usdcPrice) !== undefined
      ? evmToUsd(parsedAmount, inDecimals, (solToUsdc ? price : usdcPrice) ?? 0)
      : null
  // The quote against the wallet's OWN price feed. The gate proves the route
  // does what the quote says; nothing else says whether the quote itself is
  // fair, and a swap service quoting well under market would otherwise look
  // honest all the way to the review screen (audit 2026-10-26, M8). The
  // review checks again: a stale quote is rebuilt, and a failed route is
  // re-routed, after the form's check, so the route prepared can differ.
  const gapOf = (inAmount: bigint, outAmount: bigint) => {
    const gap = swapMarketGap(direction, inAmount, outAmount, price, usdcPrice, chain.usdc.decimals)
    return gap !== null && gap.pct > MARKET_GAP_WARN_PCT ? gap : null
  }
  const ackKey = (inAmount: bigint, outAmount: bigint) => `${direction}:${inAmount}:${outAmount}`
  const outPrice = solToUsdc ? usdcPrice : price
  const outUsd =
    quote !== null && outPrice !== undefined
      ? evmToUsd(quote.outAmount, solToUsdc ? chain.usdc.decimals : 9, outPrice)
      : null
  // one acknowledgement per quote shown, so going back from the review keeps
  // the form's (each route's amounts are their own key)
  const [rateAcks, setRateAcks] = useState<ReadonlySet<string>>(() => new Set())
  const setRateAck = (key: string, on: boolean) =>
    setRateAcks((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  const badRate = quote !== null ? gapOf(quote.inAmount, quote.outAmount) : null
  const rateAcked = quote !== null && rateAcks.has(ackKey(quote.inAmount, quote.outAmount))
  const reviewGap = step.kind === 'review' ? gapOf(step.prepared.inAmount, step.prepared.outAmount) : null
  const reviewAcked =
    step.kind === 'review' && rateAcks.has(ackKey(step.prepared.inAmount, step.prepared.outAmount))
  const rateWarning = (gap: MarketGap, acked: boolean, key: string) => (
    <div className="warning-box" role="alert">
      <IconWarning size={20} />
      <div>
        <strong>This quote is {gap.pct.toFixed(1)}% below the market price</strong>
        <p>
          You would get about {formatUsd(gap.outUsd)} of {outSymbol} for {formatUsd(gap.inUsd)} of{' '}
          {inSymbol}, by the wallet&rsquo;s own price feed. A route can lag the market for a
          moment, but a gap this size usually means the quote is wrong. Try again in a minute
          before accepting it.
        </p>
        <label className="lookalike-ack">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setRateAck(key, e.target.checked)}
          />
          <span>I understand I&rsquo;d be swapping below the market price</span>
        </label>
      </div>
    </div>
  )

  const handleMax = () => {
    if (inBalance === null) return
    const max = solToUsdc
      ? inBalance > MAX_SWAP_SOL_RESERVE
        ? inBalance - MAX_SWAP_SOL_RESERVE
        : 0n
      : inBalance
    setAmountStr(fmtIn(max))
  }

  const handleContinue = () => {
    if (quote === null) return
    setStep({ kind: 'preparing' })
    prepareSwap(chain, solKey.address, quote)
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared })
      })
      .catch((e: unknown) => {
        if (aliveRef.current) setStep({ kind: 'prepare-error', message: errMessage(e) })
      })
  }

  const handleBroadcast = (prepared: PreparedSwap) => {
    setStep({ kind: 'broadcasting' })
    broadcastSwap(solKey, prepared)
      .then((signature) => {
        onSwapped()
        if (aliveRef.current) setStep({ kind: 'success', signature, prepared })
      })
      .catch((e: unknown) => {
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

  // Send the SAME signed bytes again: harmless if the first try landed, the
  // only safe retry while its blockhash is still valid (a fresh quote would
  // be a second swap).
  const handleResend = (failed: { signature?: string; signed?: string; prepared: PreparedSwap }) => {
    if (failed.signature === undefined || failed.signed === undefined) return
    const { signature, signed, prepared } = failed
    setStep({ kind: 'broadcasting' })
    rebroadcastSol(chain, signature, signed)
      .then(() => {
        onSwapped()
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
  // valid), and a fresh-quoted retry would be a SECOND swap, not a
  // replacement. Check whether the first attempt is on the network before
  // returning to the form.
  const [retryChecking, setRetryChecking] = useState(false)
  const handleRetryAfterFailure = (failed: { signature?: string; prepared: PreparedSwap }) => {
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
          onSwapped()
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

  const broadcasting = step.kind === 'broadcasting'
  const highImpact = quote !== null && quote.priceImpactPct > 1

  return (
    <Modal title="Swap" onClose={onClose} canDismiss={!broadcasting}>
      {step.kind === 'form' && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            handleContinue()
          }}
        >
          <div className="field">
            <span className="field-label" id="swap-direction-label">
              Direction
            </span>
            <div className="fee-pills" role="group" aria-labelledby="swap-direction-label">
              <button
                type="button"
                aria-pressed={solToUsdc}
                className={`fee-pill ${solToUsdc ? 'is-selected' : ''}`}
                onClick={() => {
                  setDirection('sol-to-usdc')
                  setAmountStr('')
                }}
              >
                <span className="fee-pill-label">SOL → {chain.usdc.symbol}</span>
                <span className="fee-pill-eta tnum">
                  {state.balance !== null ? `${formatSol(state.balance)} SOL` : '—'}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={!solToUsdc}
                className={`fee-pill ${!solToUsdc ? 'is-selected' : ''}`}
                onClick={() => {
                  setDirection('usdc-to-sol')
                  setAmountStr('')
                }}
              >
                <span className="fee-pill-label">{chain.usdc.symbol} → SOL</span>
                <span className="fee-pill-eta tnum">
                  {state.usdcBalance !== null
                    ? `${formatSolUsdc(chain, state.usdcBalance)} ${chain.usdc.symbol}`
                    : '—'}
                </span>
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field-label">You pay</span>
            <div className="amount-row">
              <input
                type="text"
                inputMode="decimal"
                className={`input amount-input ${amountError !== null ? 'input-invalid' : ''}`}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={`0.0 ${inSymbol}`}
              />
              <button type="button" className="max-toggle" onClick={handleMax}>
                MAX
              </button>
            </div>
            {amountError !== null && (
              <span className="field-hint field-hint-error">{amountError}</span>
            )}
            {usdHint !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHint)}</span>
            )}
          </label>

          <div className="field">
            <span className="field-label">You receive</span>
            {quoteLoading ? (
              <div className="field-hint">
                <Spinner size={14} /> Getting the best route…
              </div>
            ) : quoteError !== null ? (
              <span className="field-hint field-hint-error">{quoteError}</span>
            ) : quote !== null ? (
              <>
                <div className="balance-main tnum" style={{ fontSize: '1.3rem' }}>
                  ≈ {fmtOut(quote.outAmount)} <span className="balance-ticker">{outSymbol}</span>
                  {outUsd !== null && (
                    <span className="text-tertiary" style={{ fontSize: '0.85rem', marginLeft: 8 }}>
                      ≈ {formatUsd(outUsd)}
                    </span>
                  )}
                </div>
                <span className="field-hint">
                  At least {fmtOut(quote.minOutAmount)} {outSymbol} after slippage (
                  {SWAP_SLIPPAGE_BPS / 100}%). Routed by Jupiter across Solana exchanges.
                  {quote.feeBps > 0 ? (
                    <>
                      Includes Kailah&rsquo;s {quote.feeBps / 100}% fee (≈{' '}
                      {formatSolUsdc(chain, quote.estimatedFee)} USDC).
                    </>
                  ) : (
                    <>No Kailah fee: this is the fee wallet.</>
                  )}
                </span>
              </>
            ) : (
              <span className="field-hint">Enter an amount to see a live quote.</span>
            )}
          </div>

          {highImpact && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Large price impact</strong>
                <p>
                  This swap moves the market price by {quote.priceImpactPct.toFixed(2)}% — you
                  get a noticeably worse rate. Consider a smaller amount.
                </p>
              </div>
            </div>
          )}

          {badRate !== null &&
            quote !== null &&
            rateWarning(badRate, rateAcked, ackKey(quote.inAmount, quote.outAmount))}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={quote === null || quoteLoading || amountError !== null || (badRate !== null && !rateAcked)}
          >
            Continue
          </button>
        </form>
      )}

      {step.kind === 'preparing' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Building and safety-checking the swap…</p>
          <p className="text-tertiary">
            The wallet simulates the exact transaction and signs it only if the outcome matches
            the quote.
          </p>
        </div>
      )}

      {step.kind === 'prepare-error' && (
        <div className="stack">
          <div className="warning-box" role="alert">
            <IconWarning size={20} />
            <div>
              <strong>Swap not signed</strong>
              <p>{step.message}</p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setStep({ kind: 'form' })
              setRequote((n) => n + 1)
            }}
          >
            <IconBack size={16} />
            Back
          </button>
        </div>
      )}

      {step.kind === 'review' && (
        <div className="stack">
          <p className="text-secondary">
            Verified by simulation — this is what the transaction actually does to your account.
          </p>
          <dl className="review-list">
            <div className="review-row">
              <dt>You pay</dt>
              <dd className="tnum">
                {fmtIn(step.prepared.inAmount)} {inSymbol}
              </dd>
            </div>
            <div className="review-row">
              <dt>You receive</dt>
              <dd className="tnum">
                {solToUsdc
                  ? `${formatSolUsdc(chain, step.prepared.simulatedUsdcDelta)} ${outSymbol}`
                  : `${formatSol(step.prepared.simulatedSolDelta)} ${outSymbol}`}
              </dd>
            </div>
            <div className="review-row">
              <dt>Guaranteed minimum</dt>
              <dd className="tnum">
                {fmtOut(step.prepared.minOutAmount)} {outSymbol}
              </dd>
            </div>
            <div className="review-row">
              <dt>
                Kailah fee
                {step.prepared.swapFeeBps > 0 ? ` (${step.prepared.swapFeeBps / 100}%)` : ''}
              </dt>
              <dd className="tnum">
                {step.prepared.swapFeeBps > 0
                  ? `${formatSolUsdc(chain, step.prepared.swapFee)} USDC`
                  : 'None (fee wallet)'}
              </dd>
            </div>
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">{formatSol(step.prepared.feeLamports)} SOL</dd>
            </div>
          </dl>
          {step.prepared.swapFeeBps > 0 && (
            <p className="text-tertiary">
              Kailah keeps {step.prepared.swapFeeBps / 100}% of each swap, paid in USDC; Jupiter
              charges no fee. The amounts above already include it.
            </p>
          )}
          <p className="text-tertiary">
            Rates move with the market; if the price shifts beyond the slippage limit before the
            transaction lands, it fails safely and nothing is exchanged.
          </p>
          {step.prepared.reroutedAround !== null && (
            <p className="text-tertiary">
              Jupiter&rsquo;s first route failed its test run at {step.prepared.reroutedAround}, so
              this is a fresh route around it. The amounts above are for the fresh route.
            </p>
          )}
          {reviewGap !== null &&
            rateWarning(reviewGap, reviewAcked, ackKey(step.prepared.inAmount, step.prepared.outAmount))}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'form' })}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={reviewGap !== null && !reviewAcked}
              onClick={() => handleBroadcast(step.prepared)}
            >
              Confirm swap
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
          <h3 className="state-title">Swapped</h3>
          <p className="text-secondary tnum">
            {fmtIn(step.prepared.inAmount)} {inSymbol} → at least{' '}
            {fmtOut(step.prepared.minOutAmount)} {outSymbol}. Balances update once the
            transaction confirms.
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
              <strong>Swap not completed</strong>
              <p>{step.message}</p>
              <p>
                If the network took it before the error, it can still go through for about a
                minute. &ldquo;Send again&rdquo; re-sends this same transaction, which can&rsquo;t execute
                twice; the wallet won&rsquo;t build a new one while this attempt could still land.
              </p>
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
