import { useEffect, useRef, useState } from 'react'
import type { SolChainConfig, SolKey, SolUiState } from '../lib/sol'
import {
  formatSol,
  formatSolUsdc,
  rebroadcastSol,
  SOL_REVIEW_FRESH_MS,
  SolBroadcastError,
  SolExpiredError,
  SOL_LANDED_FAILED,
  solTxStatus,
} from '../lib/sol'
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
import { formatTypedAmount, formatUsd, readTypedAmount } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import { IconBack, IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import { EarlierSendLanded, type Pending } from '../lib/pending'
import PrepareError from './PrepareError'

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
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | { kind: 'review'; prepared: PreparedSwap; at: number }
  | { kind: 'broadcasting' }
  | { kind: 'success'; signature: string; prepared: PreparedSwap }
  | { kind: 'failed'; message: string; signature?: string; signed?: string; prepared: PreparedSwap }

/** SOL kept back on a MAX swap so fees and a possible token account fit. */
const MAX_SWAP_SOL_RESERVE = 5_000_000n
/**
 * SOL a USDC→SOL swap needs on hand: the network fee and the temporary
 * wrapped-SOL account's deposit (returned in the same transaction).
 */
const USDC_SWAP_SOL_NEEDED = 3_000_000n

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
  // the reviewed quote outlived its blockhash and was fetched again (BM17)
  const [expiredNote, setExpiredNote] = useState(false)

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

  const typed = readTypedAmount(amountStr, inDecimals, inSymbol, '0.25')
  const parsedAmount = typed.amount
  let amountError = typed.error
  const overBalance =
    parsedAmount !== null && inBalance !== null && parsedAmount > inBalance
  if (overBalance && amountError === null) {
    amountError = `You only have ${fmtIn(inBalance ?? 0n)} ${inSymbol}`
  }
  // The SOL the swap itself needs, checked here: the network refused an
  // amount it couldn't cover only in simulation, in raw words (bug audit
  // 2026-10-27, BM21).
  const solShort =
    parsedAmount !== null &&
    state.balance !== null &&
    (solToUsdc ? parsedAmount + MAX_SWAP_SOL_RESERVE > state.balance : state.balance < USDC_SWAP_SOL_NEEDED)
  if (solShort && amountError === null) {
    amountError = solToUsdc
      ? `Keep about ${formatSol(MAX_SWAP_SOL_RESERVE)} SOL for the network fee and account deposits: you can swap up to ${formatSol(
          (state.balance ?? 0n) > MAX_SWAP_SOL_RESERVE ? (state.balance ?? 0n) - MAX_SWAP_SOL_RESERVE : 0n,
        )} SOL.`
      : `A swap to SOL needs about ${formatSol(USDC_SWAP_SOL_NEEDED)} SOL on hand for the network fee and a temporary account deposit (returned in the same swap).`
  }

  // Live quote, debounced; a sequence guard keeps stale replies from landing.
  // The sequence moves on first, so a quote still in flight for an amount
  // that was since cleared or refused can't land on the form (bug audit
  // 2026-10-27, BM20).
  useEffect(() => {
    const seq = ++quoteSeqRef.current
    setQuote(null)
    setQuoteError(null)
    if (parsedAmount === null || overBalance || solShort) {
      setQuoteLoading(false)
      return
    }
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
  const gapOf = (d: SwapDirection, inAmount: bigint, outAmount: bigint) => {
    const gap = swapMarketGap(d, inAmount, outAmount, price, usdcPrice, chain.usdc.decimals)
    return gap !== null && gap.pct > MARKET_GAP_WARN_PCT ? gap : null
  }
  const ackKey = (d: SwapDirection, inAmount: bigint, outAmount: bigint) => `${d}:${inAmount}:${outAmount}`
  // A swap's own direction names its sides — on the review and after it, the
  // form's toggle may say otherwise (BM20).
  const sides = (d: SwapDirection) => {
    const fromSol = d === 'sol-to-usdc'
    return {
      fromSol,
      inSymbol: fromSol ? 'SOL' : chain.usdc.symbol,
      outSymbol: fromSol ? chain.usdc.symbol : 'SOL',
      fmtIn: (v: bigint) => (fromSol ? formatSol(v) : formatSolUsdc(chain, v)),
      fmtOut: (v: bigint) => (fromSol ? formatSolUsdc(chain, v) : formatSol(v)),
    }
  }
  const rs = sides(
    step.kind === 'review' || step.kind === 'success' || step.kind === 'failed' ? step.prepared.direction : direction,
  )
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
  const badRate = quote !== null ? gapOf(quote.direction, quote.inAmount, quote.outAmount) : null
  const rateAcked = quote !== null && rateAcks.has(ackKey(quote.direction, quote.inAmount, quote.outAmount))
  const reviewGap =
    step.kind === 'review' ? gapOf(step.prepared.direction, step.prepared.inAmount, step.prepared.outAmount) : null
  const reviewAcked =
    step.kind === 'review' &&
    rateAcks.has(ackKey(step.prepared.direction, step.prepared.inAmount, step.prepared.outAmount))
  const rateWarning = (gap: MarketGap, acked: boolean, key: string, d: SwapDirection) => (
    <div className="warning-box" role="alert">
      <IconWarning size={20} />
      <div>
        <strong>This quote is {gap.pct.toFixed(1)}% below the market price</strong>
        <p>
          You would get about {formatUsd(gap.outUsd)} of {sides(d).outSymbol} for {formatUsd(gap.inUsd)} of{' '}
          {sides(d).inSymbol}, by the wallet&rsquo;s own price feed. A route can lag the market for a
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
    setAmountStr(formatTypedAmount(max, inDecimals))
  }

  const handleContinue = () => {
    // only the quote for what the form says now (BM20)
    if (quote === null || quote.direction !== direction || quote.inAmount !== parsedAmount) return
    setExpiredNote(false)
    setStep({ kind: 'preparing' })
    prepareSwap(chain, solKey.address, quote)
      .then((prepared) => {
        if (aliveRef.current) setStep({ kind: 'review', prepared, at: Date.now() })
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
    solTxStatus(chain, signature)
      .then((status) => {
        if (!aliveRef.current) return
        if (status === 'ok') {
          onSwapped()
          setStep({ kind: 'success', signature, prepared: failed.prepared })
        } else if (status === 'failed') {
          // it landed but failed there: not a success (BL25)
          onSwapped()
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
            rateWarning(badRate, rateAcked, ackKey(quote.direction, quote.inAmount, quote.outAmount), quote.direction)}

          {expiredNote && (
            <p className="text-tertiary">
              The quote you reviewed expired before you confirmed it, so here is a fresh one. Check it
              and continue.
            </p>
          )}

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
        <PrepareError
          title="Swap not signed"
          message={step.message}
          landed={step.landed}
          onBack={() => {
            setStep({ kind: 'form' })
            setRequote((n) => n + 1)
          }}
          onSendAgain={handleContinue}
        />
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
                {rs.fmtIn(step.prepared.inAmount)} {rs.inSymbol}
              </dd>
            </div>
            <div className="review-row">
              <dt>You receive</dt>
              <dd className="tnum">
                {rs.fromSol
                  ? `${formatSolUsdc(chain, step.prepared.simulatedUsdcDelta)} ${rs.outSymbol}`
                  : `${formatSol(step.prepared.simulatedSolDelta)} ${rs.outSymbol}`}
              </dd>
            </div>
            <div className="review-row">
              <dt>Guaranteed minimum</dt>
              <dd className="tnum">
                {rs.fmtOut(step.prepared.minOutAmount)} {rs.outSymbol}
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
            {step.prepared.accountDepositLamports > 0n && (
              <div className="review-row">
                <dt>USDC account deposit (one-time)</dt>
                <dd className="tnum">{formatSol(step.prepared.accountDepositLamports)} SOL</dd>
              </div>
            )}
          </dl>
          {step.prepared.accountDepositLamports > 0n && (
            <p className="text-tertiary">
              This is your first USDC on Solana, so the swap also opens your USDC account: a deposit
              the network requires, paid once in SOL.
            </p>
          )}
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
            rateWarning(
              reviewGap,
              reviewAcked,
              ackKey(step.prepared.direction, step.prepared.inAmount, step.prepared.outAmount),
              step.prepared.direction,
            )}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'form' })}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={reviewGap !== null && !reviewAcked}
              onClick={() => {
                // a review left open past its blockhash gets a fresh quote first (BM17)
                if (Date.now() - step.at > SOL_REVIEW_FRESH_MS) {
                  setExpiredNote(true)
                  setStep({ kind: 'form' })
                  setRequote((n) => n + 1)
                  return
                }
                handleBroadcast(step.prepared)
              }}
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
            {rs.fmtIn(step.prepared.inAmount)} {rs.inSymbol} → at least{' '}
            {rs.fmtOut(step.prepared.minOutAmount)} {rs.outSymbol}. Balances update once the
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
              {step.signed !== undefined && (
                <p>
                  If the network took it before the error, it can still go through for about a
                  minute. &ldquo;Send again&rdquo; re-sends this same transaction, which can&rsquo;t
                  execute twice. Before any new swap, the wallet checks whether this one went
                  through and tells you if it did.
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
