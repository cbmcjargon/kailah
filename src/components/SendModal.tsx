import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AccountKeys,
  AccountState,
  BuiltTx,
  ChainConfig,
  FeeOption,
  HardwareAccountKeys,
  UnsignedTx,
} from '../lib/types'
import { getClient } from '../lib/api'
import { scanAccount } from '../lib/scanner'
import { formatCoin, formatTypedAmount, formatUsd, readTypedAmount } from '../lib/format'
import { buildTxV2, isValidAddress, prepareTxV2 } from '../lib/txbuild'
import { assembleSigned, buildSignRequest, fetchPrevTxs } from '../lib/hwsign'
import { isHardwareAccount, ledgerAccountKey } from '../lib/hwaccount'
import { browserTransport, ledgerSigner } from '../lib/ledger'
import { parseScannedPayment } from '../lib/qrparse'
import Modal from './Modal'
import CopyButton from './CopyButton'
import QrScanner from './LazyQrScanner'
import HardwareReview from './HardwareReview'
import LedgerPrompt, { useDevice } from './LedgerPrompt'
import { IconBack, IconCheck, IconExternal, IconQrScan, IconShield, IconWarning, Spinner } from './Icons'
import { coinsToUsd, errMessage } from './ui'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import { knownAddresses, UTXO_FORMAT } from '../lib/lookalike'
import { sentToAddresses } from '../lib/sentlog'
import { agoText, EarlierSendLanded, utxoInFlightBlock, type Pending } from '../lib/pending'
import { broadcastUtxo, UtxoBroadcastError } from '../lib/utxosend'
import PrepareError from './PrepareError'

interface SendModalProps {
  chain: ChainConfig
  /** a seed account signs here; a hardware account signs on its device */
  account: AccountKeys | HardwareAccountKeys
  /** last successful scan; the send re-scans on Continue for freshness */
  accountState: AccountState | null
  price: number | undefined
  onClose: () => void
  /** called once a broadcast is accepted, so the dashboard can re-scan */
  onSent: () => void
}

type Step =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | { kind: 'review'; built: BuiltTx }
  // hardware account: reviewed unsigned; the device signs on demand
  | { kind: 'hw-review'; unsigned: UnsignedTx; prevTxs: Map<string, Uint8Array> }
  | { kind: 'broadcasting'; built: BuiltTx }
  | { kind: 'success'; built: BuiltTx; txid: string }
  | { kind: 'failed'; built: BuiltTx; message: string; definite: boolean }

export default function SendModal({
  chain,
  account,
  accountState,
  price,
  onClose,
  onSent,
}: SendModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' })
  const [scanOpen, setScanOpen] = useState(false)
  const [dest, setDest] = useState('')
  const [amountStr, setAmountStr] = useState('')
  // what a scanned code's amount needs from the user (it couldn't be read)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [sendMax, setSendMax] = useState(false)
  const [feeIdx, setFeeIdx] = useState(0)
  const [fees, setFees] = useState<FeeOption[] | null>(null)
  const [feeError, setFeeError] = useState<string | null>(null)
  const [feeReload, setFeeReload] = useState(0)

  const client = useMemo(() => getClient(chain), [chain])
  const balance = accountState?.balance ?? null
  const device = useDevice()

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setFees(null)
    setFeeError(null)
    client
      .getFeeOptions()
      .then((opts) => {
        if (!alive) return
        setFees(opts)
        setFeeIdx(0)
      })
      .catch((e) => {
        if (alive) setFeeError(errMessage(e))
      })
    return () => {
      alive = false
    }
  }, [client, feeReload])

  // ---- form validation -----------------------------------------------------
  const destTrimmed = dest.trim()
  const destValid = destTrimmed !== '' && isValidAddress(destTrimmed, chain)
  const known = useMemo(
    () =>
      knownAddresses(
        accountState?.addresses.map((a) => a.address) ?? [],
        accountState?.txs.map((t) => t.counterparty) ?? [],
        sentToAddresses(chain.id),
      ),
    [accountState, chain.id],
  )
  const lookalike = useLookalike(destValid ? destTrimmed : '', known, UTXO_FORMAT)

  const typed = sendMax ? { amount: null, error: null } : readTypedAmount(amountStr, chain.decimals, chain.ticker, '0.5')
  const parsedAmount = typed.amount
  const amountError = typed.error

  // MAX sweeps every UTXO, confirmed and pending alike — mirror that in the
  // hint (clamped at zero for a net-negative pending delta).
  const sweepableBalance =
    balance === null
      ? null
      : balance.confirmed + balance.unconfirmed > 0n
        ? balance.confirmed + balance.unconfirmed
        : 0n

  const usdHintValue =
    price === undefined
      ? null
      : sendMax
        ? sweepableBalance !== null
          ? coinsToUsd(sweepableBalance, chain.decimals, price)
          : null
        : parsedAmount !== null
          ? coinsToUsd(parsedAmount, chain.decimals, price)
          : null

  const canContinue =
    destValid && lookalike.ok && fees !== null && fees.length > 0 && (sendMax || parsedAmount !== null)

  // ---- step transitions ----------------------------------------------------
  const handleContinue = () => {
    if (!canContinue || fees === null) return
    const feeOpt = fees[Math.min(feeIdx, fees.length - 1)]
    setStep({ kind: 'preparing' })
    // One send in flight at a time: an attempt from the last half hour that
    // the network doesn't report yet could still land beside a new one
    // (the failed screen's Retry re-sends the SAME bytes, which is safe).
    utxoInFlightBlock(chain.id, (txid) => client.txSeen(txid), ledgerAccountKey(account))
      .then((block) => {
        if (block !== null) {
          const p = block.entry
          if (block.reason === 'landed') {
            throw new EarlierSendLanded(p, `Your send from ${agoText(p.ts)} (to ${p.to.slice(0, 10)}…) on ${chain.name}`)
          }
          throw new Error(
            block.reason === 'pending'
              ? `A send from ${agoText(p.ts)} (to ${p.to.slice(0, 10)}…) may still be on its way on ${chain.name}. Wait for it to show up, or for half an hour, before sending again — sending now could pay twice.`
              : `Couldn't check whether your send from ${agoText(p.ts)} (to ${p.to.slice(0, 10)}…) went through on ${chain.name}. Try again in a moment — sending without knowing could pay twice.`,
          )
        }
        // Always build from a FRESH scan — never a cached one. A stale UTXO set
        // can include coins a previous send already spent (producing an
        // invalid tx) and a stale change index reuses an address. If the scan
        // fails we fail closed; the user retries rather than spending from
        // possibly-spent inputs.
        return scanAccount(account, client)
      })
      .then(async (state) => {
        if (!aliveRef.current) return
        try {
          // A sweep must see every coin: if any address's utxos failed to
          // load in THIS scan, "send everything" would quietly leave some
          // behind. Refuse rather than underspend.
          if (sendMax && state.incomplete?.utxos === true) {
            throw new Error(
              "Couldn't load every coin in the wallet just now, so a MAX send could leave some behind. Try again in a moment.",
            )
          }
          if (isHardwareAccount(account)) {
            // Same selection, unsigned; then every input's funding tx, bound to
            // its txid and to the scanned value, for the device to verify.
            const unsigned = prepareTxV2({
              chain,
              utxos: state.utxos,
              keyFor: (u) => account.address(u.branch, u.index),
              toAddress: destTrimmed,
              amount: sendMax ? 0n : (parsedAmount ?? 0n),
              feeRate: feeOpt.rate,
              sendMax,
              change: account.address(1, state.nextChange.index),
            })
            const prevTxs = await fetchPrevTxs(chain, client, unsigned)
            device.reset()
            if (aliveRef.current) setStep({ kind: 'hw-review', unsigned, prevTxs })
            return
          }
          const built = buildTxV2({
            chain,
            utxos: state.utxos,
            keyFor: (u) => account.address(u.branch, u.index),
            toAddress: destTrimmed,
            amount: sendMax ? 0n : (parsedAmount ?? 0n),
            feeRate: feeOpt.rate,
            sendMax,
            changeAddress: state.nextChange.address,
          })
          setStep({ kind: 'review', built })
        } catch (e) {
          // With some coins unreadable (a data service busy, or BlockCypher's
          // budget spent: Dogecoin's coins need its raw transactions), "not
          // enough funds" isn't true. Say what is (bug audit 2026-10-27, BM5).
          const message =
            state.incomplete?.utxos === true && /^Insufficient funds/.test(errMessage(e))
              ? "Couldn't load every coin in the wallet just now — a network data service is busy or rate-limited — so this send can't be built yet. Your coins are safe; try again in a few minutes."
              : errMessage(e)
          if (aliveRef.current) setStep({ kind: 'prepare-error', message })
        }
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

  const handleBroadcast = (built: BuiltTx) => {
    setStep({ kind: 'broadcasting', built })
    // recorded BEFORE the send (broadcastUtxo): an attempt whose answer never
    // arrives must still block the next send until the network reports it
    broadcastUtxo(client, chain, built, { account: ledgerAccountKey(account) })
      .then((txid) => {
        onSent()
        if (aliveRef.current) setStep({ kind: 'success', built, txid })
      })
      .catch((e) => {
        if (aliveRef.current) {
          setStep({
            kind: 'failed',
            built,
            message: errMessage(e),
            definite: e instanceof UtxoBroadcastError && e.definite,
          })
        }
      })
  }

  // Hardware: the device signs the reviewed object; the wallet verifies every
  // signature against its own digest before anything is broadcast.
  const handleHardwareSign = async (unsigned: UnsignedTx, prevTxs: Map<string, Uint8Array>) => {
    if (!isHardwareAccount(account)) return
    const built = await device.run(async (onStatus) => {
      const sigs = await ledgerSigner(account, browserTransport(true), onStatus).sign(
        buildSignRequest(unsigned, account, prevTxs),
      )
      return assembleSigned(unsigned, sigs)
    })
    if (built !== null && aliveRef.current) handleBroadcast(built)
  }

  // Scanner: parse the decoded text; null return accepts the code and closes
  // the scanner, a message return keeps it open with the error shown.
  const handleScanDecoded = (text: string): string | null => {
    try {
      const scanned = parseScannedPayment(text, chain)
      setDest(scanned.address)
      // A code's amount is the payment: it replaces MAX and anything typed
      // before; one that couldn't be read clears the field rather than
      // leaving an old amount beside the new address (bug audit BL3).
      if (scanned.amount !== undefined) {
        setSendMax(false)
        setAmountStr(formatTypedAmount(scanned.amount, chain.decimals))
      } else if (scanned.amountUnreadable === true) {
        setSendMax(false)
        setAmountStr('')
      }
      setScanNote(scanned.amountUnreadable === true ? "The code's amount couldn't be read. Type the amount the recipient asked for." : null)
      setScanOpen(false)
      return null
    } catch (e) {
      return errMessage(e)
    }
  }

  const broadcasting = step.kind === 'broadcasting'
  const fmt = (v: bigint) => `${formatCoin(v, chain.decimals)} ${chain.ticker}`

  return (
    <Modal
      title={`Send ${chain.ticker}${isHardwareAccount(account) ? ' · Ledger' : ''}`}
      onClose={onClose}
      canDismiss={!broadcasting && !device.busy}
    >
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
                placeholder={`${chain.name} address`}
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
                {destTrimmed.toLowerCase().startsWith('ltcmweb1')
                  ? 'That’s a private (MWEB) Litecoin address — this wallet can only send to regular ltc1 addresses.'
                  : `Not a valid ${chain.name} address`}
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
                placeholder={sendMax ? 'Entire balance' : `0.0 ${chain.ticker}`}
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
            {scanNote !== null && amountStr === '' && !sendMax && <span className="field-hint">{scanNote}</span>}
            {amountError !== null && !sendMax && (
              <span className="field-hint field-hint-error">{amountError}</span>
            )}
            {usdHintValue !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHintValue)}</span>
            )}
            {sendMax && (
              <span className="field-hint">
                Sends everything after the network fee is deducted.
              </span>
            )}
            {sendMax && accountState?.incomplete?.utxos === true && (
              <span className="field-hint field-hint-error">
                Some balance couldn&rsquo;t be loaded just now, so a Max send might not include
                all your coins. Refresh and try again for the full amount.
              </span>
            )}
          </label>

          <div className="field">
            <span className="field-label" id="fee-group-label">
              Network fee
            </span>
            {fees === null && feeError === null && (
              <div className="fee-pills">
                <div className="skeleton skeleton-pill" />
                <div className="skeleton skeleton-pill" />
                <div className="skeleton skeleton-pill" />
              </div>
            )}
            {feeError !== null && (
              <div className="chain-error" role="alert">
                <span>{feeError}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => setFeeReload((n) => n + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {fees !== null && (
              <div className="fee-pills" role="group" aria-labelledby="fee-group-label">
                {fees.map((f, i) => (
                  <button
                    key={`${f.label}-${i}`}
                    type="button"
                    aria-pressed={i === feeIdx}
                    className={`fee-pill ${i === feeIdx ? 'is-selected' : ''}`}
                    onClick={() => setFeeIdx(i)}
                  >
                    <span className="fee-pill-label">{f.label}</span>
                    <span className="fee-pill-eta">
                      {f.eta}
                      <span className="text-tertiary tnum"> · {f.rate.toString()} {chain.unitName}/vB</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

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
          onSendAgain={handleContinue}
        />
      )}

      {step.kind === 'review' && (
        <div className="stack">
          <p className="text-secondary">Check everything — sends cannot be reversed.</p>
          <dl className="review-list">
            <div className="review-row">
              <dt>To</dt>
              <dd className="mono review-addr">{step.built.toAddress}</dd>
            </div>
            <div className="review-row">
              <dt>Amount</dt>
              <dd className="tnum">{fmt(step.built.amount)}</dd>
            </div>
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">
                {fmt(step.built.fee)}
                <span className="text-tertiary"> · {step.built.vbytes} vB</span>
              </dd>
            </div>
            <div className="review-row review-total">
              <dt>Total</dt>
              <dd className="tnum">{fmt(step.built.amount + step.built.fee)}</dd>
            </div>
          </dl>
          {step.built.change > 0n && (
            <p className="text-tertiary">
              Change of {fmt(step.built.change)} returns to a fresh address in your wallet.
            </p>
          )}
          {step.built.fee * 4n > step.built.amount && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Unusually large fee</strong>
                <p>
                  The network fee is more than a quarter of the amount you&rsquo;re
                  sending. Only continue if that&rsquo;s what you expect.
                </p>
              </div>
            </div>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setStep({ kind: 'form' })}
            >
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleBroadcast(step.built)}
            >
              Confirm &amp; send
            </button>
          </div>
        </div>
      )}

      {step.kind === 'hw-review' && isHardwareAccount(account) && (
        <div className="stack">
          <HardwareReview unsigned={step.unsigned} />
          {step.unsigned.fee * 4n > step.unsigned.amount && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Unusually large fee</strong>
                <p>
                  The network fee is more than a quarter of the amount you&rsquo;re
                  sending. Only continue if that&rsquo;s what you expect.
                </p>
              </div>
            </div>
          )}
          <LedgerPrompt
            chainId={account.record.chain}
            ui={device.ui}
            confirmText={`It must show ${fmt(step.unsigned.amount)} to ${step.unsigned.toAddress} and a fee of ${fmt(step.unsigned.fee)} — the same as above.`}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={device.busy}
              onClick={() => setStep({ kind: 'form' })}
            >
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={device.busy}
              onClick={() => void handleHardwareSign(step.unsigned, step.prevTxs)}
            >
              <IconShield size={16} />
              {device.ui.phase === 'error' ? 'Try again' : 'Sign on Ledger'}
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
            {fmt(step.built.amount)} is on its way.
          </p>
          <div className="address-block">
            <div className="mono address-full">{step.txid}</div>
            <CopyButton text={step.txid} label="Copy transaction id" withText />
          </div>
          <a
            className="btn btn-secondary"
            href={chain.explorerTx(step.txid)}
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
                  If the network took it before the error, it can still confirm. Retry re-sends
                  this same transaction, which can't pay twice. Before any new send, the wallet
                  checks whether this one went through and tells you if it did.
                </p>
              )}
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            {step.definite ? (
              <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'form' })}>
                <IconBack size={16} />
                Back
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleBroadcast(step.built)}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
