import { useEffect, useRef, useState } from 'react'
import type { SolChainConfig, SolKey, SolUiState } from '../lib/sol'
import { formatSol, rebroadcastSol, SOL_REVIEW_FRESH_MS, SolBroadcastError, SolExpiredError } from '../lib/sol'
import type { PreparedStakeAction, StakeAccountView, ValidatorOption } from '../lib/solstake'
import {
  broadcastStakeAction,
  fetchValidators,
  getMinimumStake,
  prepareCreateStake,
  prepareDeactivate,
  prepareWithdraw,
} from '../lib/solstake'
import { evmToUsd } from '../lib/units'
import { formatCoin, formatUsd, readTypedAmount, shortAddress } from '../lib/format'
import Modal from './Modal'
import { IconBack, IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import { EarlierSendLanded, type Pending } from '../lib/pending'
import PrepareError from './PrepareError'

interface SolStakeModalProps {
  chain: SolChainConfig
  solKey: SolKey
  state: SolUiState
  price: number | undefined
  onClose: () => void
  onChanged: () => void
}

type Step =
  | { kind: 'list' }
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | {
      kind: 'review'
      prepared: PreparedStakeAction
      /** when it was prepared, and how to prepare it again once its blockhash lapses (BM17) */
      at: number
      redo: () => Promise<PreparedStakeAction>
      refreshed?: boolean
    }
  | { kind: 'broadcasting' }
  | { kind: 'success'; signature: string; prepared: PreparedStakeAction }
  | { kind: 'failed'; message: string; signature?: string; signed?: string; prepared?: PreparedStakeAction }

const STATE_LABEL: Record<StakeAccountView['state'], string> = {
  activating: 'Starting up — earns from the next epoch',
  active: 'Earning rewards',
  deactivating: 'Winding down — withdraw after this epoch',
  withdrawable: 'Finished — ready to withdraw',
}

export default function SolStakeModal({
  chain,
  solKey,
  state,
  price,
  onClose,
  onChanged,
}: SolStakeModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [validators, setValidators] = useState<ValidatorOption[] | null>(null)
  const [minStake, setMinStake] = useState<bigint | null>(null)
  const [chosenVote, setChosenVote] = useState('')
  const [amountStr, setAmountStr] = useState('')

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Validator list + live minimum load once, when the form first opens; a
  // failed load can be tried again from the form (it never retried before,
  // bug audit 2026-10-27, BL28).
  const [validatorTry, setValidatorTry] = useState(0)
  useEffect(() => {
    if (step.kind !== 'form' || validators !== null) return
    Promise.all([fetchValidators(chain), getMinimumStake(chain)])
      .then(([v, min]) => {
        if (!aliveRef.current) return
        setValidators(v)
        setMinStake(min)
        if (v.length > 0) setChosenVote(v[0]!.votePubkey)
      })
      .catch(() => {
        if (aliveRef.current) setValidators([])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind, chain, validatorTry])

  const typed = readTypedAmount(amountStr, 9, 'SOL', '1.5')
  const parsedAmount = typed.amount
  let amountError = typed.error
  if (
    parsedAmount !== null &&
    minStake !== null &&
    parsedAmount < minStake &&
    amountError === null
  ) {
    amountError = `Solana's minimum stake is ${formatSol(minStake)} SOL`
  }

  const usdHint =
    price !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, 9, price)
      : null

  const runPrepare = (make: () => Promise<PreparedStakeAction>, refreshed = false) => {
    setStep({ kind: 'preparing' })
    make().then((prepared) => {
      if (aliveRef.current) setStep({ kind: 'review', prepared, at: Date.now(), redo: make, refreshed })
    }).catch((e: unknown) => {
      if (aliveRef.current) {
        setStep({
          kind: 'prepare-error',
          message: errMessage(e),
          landed: e instanceof EarlierSendLanded ? e.entry : undefined,
        })
      }
    })
  }

  const handleBroadcast = (prepared: PreparedStakeAction) => {
    setStep({ kind: 'broadcasting' })
    broadcastStakeAction(solKey, prepared)
      .then((signature) => {
        onChanged()
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

  // Send the SAME signed bytes again (see SolSendModal): never a rebuilt one
  // while the first could still land.
  const handleResend = (failed: { signature?: string; signed?: string; prepared?: PreparedStakeAction }) => {
    if (failed.signature === undefined || failed.signed === undefined || failed.prepared === undefined) return
    const { signature, signed, prepared } = failed
    setStep({ kind: 'broadcasting' })
    rebroadcastSol(chain, signature, signed)
      .then(() => {
        onChanged()
        if (aliveRef.current) setStep({ kind: 'success', signature, prepared })
      })
      .catch((e: unknown) => {
        if (!aliveRef.current) return
        if (e instanceof SolExpiredError) {
          setStep({ kind: 'failed', message: e.message, prepared })
        } else {
          setStep({ kind: 'failed', message: errMessage(e), prepared, signature, signed })
        }
      })
  }

  const broadcasting = step.kind === 'broadcasting'
  const accounts = state.stakeAccounts

  return (
    <Modal title="Stake SOL" onClose={onClose} canDismiss={!broadcasting}>
      {step.kind === 'list' && (
        <div className="stack">
          <p className="text-secondary">
            Staking locks SOL with a validator to earn network rewards (roughly 6–8% a year,
            set by the network — never guaranteed). Rewards land every epoch (~2 days) and
            compound automatically. Your coins never leave accounts you control.
          </p>
          {accounts.length > 0 ? (
            <div className="tx-list">
              {accounts.map((a) => (
                <div key={a.address} className="tx-row custom-token-row">
                  <div className="tx-main">
                    <span className="tx-title tnum">{formatSol(a.lamports)} SOL</span>
                    <span className="tx-sub">
                      {STATE_LABEL[a.state]}
                      {a.validator !== null ? ` · ${shortAddress(a.validator)}` : ''}
                    </span>
                  </div>
                  {(a.state === 'active' || a.state === 'activating') && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => runPrepare(() => prepareDeactivate(chain, solKey, a))}
                    >
                      Unstake
                    </button>
                  )}
                  {a.state === 'withdrawable' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => runPrepare(() => prepareWithdraw(chain, solKey, a))}
                    >
                      Withdraw
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-tertiary">Nothing staked yet.</p>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'form' })}>
            Stake SOL
          </button>
        </div>
      )}

      {step.kind === 'form' && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (parsedAmount !== null && chosenVote !== '' && amountError === null) {
              runPrepare(() => prepareCreateStake(chain, solKey, parsedAmount, chosenVote))
            }
          }}
        >
          <label className="field">
            <span className="field-label">Amount to stake</span>
            <div className="amount-row">
              <input
                type="text"
                inputMode="decimal"
                className={`input amount-input ${amountError !== null ? 'input-invalid' : ''}`}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={minStake !== null ? `at least ${formatSol(minStake)} SOL` : '0.0 SOL'}
              />
            </div>
            {amountError !== null && (
              <span className="field-hint field-hint-error">{amountError}</span>
            )}
            {usdHint !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHint)}</span>
            )}
          </label>

          <label className="field">
            <span className="field-label">Validator</span>
            {validators === null ? (
              <div className="field-hint">
                <Spinner size={14} /> Loading validators…
              </div>
            ) : validators.length === 0 ? (
              <span className="field-hint field-hint-error">
                Couldn&rsquo;t load the validator list.{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => {
                    setValidators(null)
                    setValidatorTry((n) => n + 1)
                  }}
                >
                  Try again
                </button>
              </span>
            ) : (
              <>
                <select
                  className="input"
                  value={chosenVote}
                  onChange={(e) => setChosenVote(e.target.value)}
                >
                  {validators.map((v) => (
                    <option key={v.votePubkey} value={v.votePubkey}>
                      {shortAddress(v.votePubkey)} — {v.commission}% commission
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Established validators charging at most 10%. Commission is the cut the
                  validator keeps from rewards — the rest is yours.
                </span>
              </>
            )}
          </label>

          <p className="text-tertiary">
            Staking starts earning after the current epoch ends (up to ~2 days). Unstaking
            takes the same wait before you can withdraw. A one-time refundable deposit
            (~{formatSol(2_282_880n)} SOL) opens the stake account.
          </p>

          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'list' })}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={parsedAmount === null || amountError !== null || chosenVote === ''}
            >
              Continue
            </button>
          </div>
        </form>
      )}

      {step.kind === 'preparing' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Preparing…</p>
        </div>
      )}

      {step.kind === 'prepare-error' && (
        <PrepareError
          title="Couldn’t prepare this"
          message={step.message}
          landed={step.landed}
          onBack={() => setStep({ kind: 'list' })}
        />
      )}

      {step.kind === 'review' && (
        <div className="stack">
          <p className="text-secondary">
            {step.prepared.kind === 'create'
              ? 'Check everything — the stake starts with the next epoch.'
              : step.prepared.kind === 'deactivate'
                ? 'Unstaking stops rewards at the end of this epoch; withdraw after that.'
                : 'This returns the full amount, including the account deposit, to your balance.'}
          </p>
          <dl className="review-list">
            <div className="review-row">
              <dt>Action</dt>
              <dd>
                {step.prepared.kind === 'create'
                  ? 'Stake'
                  : step.prepared.kind === 'deactivate'
                    ? 'Unstake'
                    : 'Withdraw'}
              </dd>
            </div>
            {step.prepared.amount > 0n && (
              <div className="review-row">
                <dt>Amount</dt>
                <dd className="tnum">{formatCoin(step.prepared.amount, 9)} SOL</dd>
              </div>
            )}
            {step.prepared.validator !== null && (
              <div className="review-row">
                <dt>Validator</dt>
                <dd className="mono review-addr">{step.prepared.validator}</dd>
              </div>
            )}
            {step.prepared.rentLamports > 0n && (
              <div className="review-row">
                <dt>Account deposit (refunded on withdraw)</dt>
                <dd className="tnum">{formatSol(step.prepared.rentLamports)} SOL</dd>
              </div>
            )}
            <div className="review-row">
              <dt>Network fee</dt>
              <dd className="tnum">{formatSol(step.prepared.feeLamports)} SOL</dd>
            </div>
          </dl>
          {step.refreshed === true && (
            <p className="text-tertiary">
              The earlier version&rsquo;s network window closed before you confirmed it, so the wallet
              prepared it again. Check it and confirm.
            </p>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'list' })}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                Date.now() - step.at > SOL_REVIEW_FRESH_MS ? runPrepare(step.redo, true) : handleBroadcast(step.prepared)
              }
            >
              Confirm
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
          <h3 className="state-title">
            {step.prepared.kind === 'create'
              ? 'Staked'
              : step.prepared.kind === 'deactivate'
                ? 'Unstaking'
                : 'Withdrawn'}
          </h3>
          <p className="text-secondary">
            {step.prepared.kind === 'create'
              ? `${formatCoin(step.prepared.amount, 9)} SOL is delegated — it starts earning with the next epoch.`
              : step.prepared.kind === 'deactivate'
                ? 'Rewards stop at the end of this epoch; the Withdraw button appears once it is out.'
                : `${formatCoin(step.prepared.amount, 9)} SOL is back in your balance.`}
          </p>
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
              <strong>Not completed</strong>
              <p>{step.message}</p>
              {step.signed !== undefined && (
                <p>
                  If the network took it before the error, it can still go through for about a
                  minute. &ldquo;Send again&rdquo; re-sends this same transaction. Before any new
                  action, the wallet checks whether this one went through and tells you if it did.
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
              onClick={() => setStep({ kind: 'list' })}
            >
              <IconBack size={16} />
              Back
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
