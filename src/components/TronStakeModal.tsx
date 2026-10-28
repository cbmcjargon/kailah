import { useEffect, useRef, useState } from 'react'
import type { TronChainConfig, TronKey } from '../lib/tron'
import { broadcastTronSend, formatTron, rebroadcastTron, TRON_REVIEW_FRESH_MS, TronBroadcastError } from '../lib/tron'
import type { PreparedTronStake, TronResource, TronStakeView, TronWitness } from '../lib/tronstake'
import {
  fetchTronStake,
  fetchTronWitnesses,
  prepareClaimReward,
  prepareFreeze,
  prepareUnfreeze,
  prepareVote,
  prepareWithdrawUnfrozen,
} from '../lib/tronstake'
import { evmToUsd } from '../lib/units'
import { formatUsd, readTypedAmount, shortAddress } from '../lib/format'
import Modal from './Modal'
import { IconBack, IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'
import { EarlierSendLanded, type Pending } from '../lib/pending'
import PrepareError from './PrepareError'

interface TronStakeModalProps {
  chain: TronChainConfig
  tronKey: TronKey
  price: number | undefined
  onClose: () => void
  onChanged: () => void
  /** what a claim, withdrawal or unstake may credit, said before it goes out */
  onOwnCredit: (asset: string, amount: bigint) => void
}

type Step =
  | { kind: 'loading' }
  | { kind: 'overview' }
  | { kind: 'stake-form' }
  | { kind: 'unstake-form' }
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; message: string; landed?: Pending }
  | {
      kind: 'review'
      prepared: PreparedTronStake
      /** when it was built, and how to build it again once it is about to expire (BL32) */
      at: number
      redo: () => Promise<PreparedTronStake>
      refreshed?: boolean
    }
  | { kind: 'broadcasting' }
  | { kind: 'success'; txId: string; prepared: PreparedTronStake }
  | { kind: 'failed'; message: string; err?: TronBroadcastError }

const ACTION_TITLE: Record<PreparedTronStake['action'], string> = {
  freeze: 'Stake',
  vote: 'Vote',
  claim: 'Claim rewards',
  unfreeze: 'Unstake',
  withdraw: 'Withdraw',
}

export default function TronStakeModal({
  chain,
  tronKey,
  price,
  onClose,
  onChanged,
  onOwnCredit,
}: TronStakeModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const sentRef = useRef<PreparedTronStake | null>(null)
  const [stake, setStake] = useState<TronStakeView | null>(null)
  const [witnesses, setWitnesses] = useState<TronWitness[] | null>(null)
  const [chosenSr, setChosenSr] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [resource, setResource] = useState<TronResource>('ENERGY')

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // A reload shows its own loading screen and lands on the overview only if
  // nothing else started meanwhile: a Confirm during a silent reload used to
  // lose its broadcasting screen to the overview (bug audit 2026-10-27, BL31).
  const reload = () => {
    setStep({ kind: 'loading' })
    Promise.all([fetchTronStake(chain, tronKey.address), fetchTronWitnesses(chain)])
      .then(([s, w]) => {
        if (!aliveRef.current) return
        setStake(s)
        setWitnesses(w)
        if (w.length > 0 && chosenSr === '') setChosenSr(w[0]!.address)
        setStep((cur) => (cur.kind === 'loading' ? { kind: 'overview' } : cur))
      })
      .catch((e: unknown) => {
        if (aliveRef.current) setStep((cur) => (cur.kind === 'loading' ? { kind: 'prepare-error', message: errMessage(e) } : cur))
      })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [])

  const typed = readTypedAmount(amountStr, 6, 'TRX', '100')
  const parsedAmount = typed.amount
  const amountError = typed.error

  const usdHint =
    price !== undefined && parsedAmount !== null && chain.mainnet
      ? evmToUsd(parsedAmount, 6, price)
      : null

  const runPrepare = (make: () => Promise<PreparedTronStake>, refreshed = false) => {
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

  const settle = (p: Promise<string>, prepared: PreparedTronStake) => {
    setStep({ kind: 'broadcasting' })
    p.then((txId) => {
      onChanged()
      if (aliveRef.current) setStep({ kind: 'success', txId, prepared })
    }).catch((e: unknown) => {
      if (aliveRef.current) {
        setStep({ kind: 'failed', message: errMessage(e), err: e instanceof TronBroadcastError ? e : undefined })
      }
    })
  }
  const handleBroadcast = (prepared: PreparedTronStake) => {
    sentRef.current = prepared
    // a claim pays the reward; a withdrawal, and an unstake (which takes
    // any unstake that has finished its wait along), pay out unstaked TRX
    if (stake !== null && (prepared.action === 'claim' || prepared.action === 'withdraw' || prepared.action === 'unfreeze')) {
      const ready = stake.pendingUnfreezes.filter((u) => u.withdrawable).reduce((s, u) => s + u.amount, 0n)
      onOwnCredit('TRX', stake.unclaimedReward + ready)
    }
    settle(broadcastTronSend(tronKey, prepared), prepared)
  }
  // the SAME signed transaction again — never a rebuilt one, which could act twice
  const handleResend = (err: TronBroadcastError) => {
    if (sentRef.current !== null) settle(rebroadcastTron(chain, err), sentRef.current)
  }

  const spare = stake !== null ? stake.powerTotal - stake.powerUsed : 0n
  const withdrawableSun =
    stake?.pendingUnfreezes.filter((u) => u.withdrawable).reduce((s, u) => s + u.amount, 0n) ?? 0n
  const broadcasting = step.kind === 'broadcasting'

  return (
    <Modal title="Stake TRX" onClose={onClose} canDismiss={!broadcasting}>
      {step.kind === 'loading' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Reading your staking position…</p>
        </div>
      )}

      {step.kind === 'overview' && stake !== null && (
        <div className="stack">
          <p className="text-secondary">
            Staking locks TRX for network resources and voting power. Voting for a Super
            Representative earns roughly 3–5% a year (set by the network — never guaranteed).
            Staking for Energy also makes your USDT sends cheap, often free.
          </p>
          <dl className="review-list">
            <div className="review-row">
              <dt>Staked (Energy)</dt>
              <dd className="tnum">{formatTron(stake.stakedEnergy)} TRX</dd>
            </div>
            <div className="review-row">
              <dt>Staked (Bandwidth)</dt>
              <dd className="tnum">{formatTron(stake.stakedBandwidth)} TRX</dd>
            </div>
            <div className="review-row">
              <dt>Votes cast</dt>
              <dd className="tnum">
                {stake.powerUsed.toString()} / {stake.powerTotal.toString()}
              </dd>
            </div>
            <div className="review-row">
              <dt>Unclaimed rewards</dt>
              <dd className="tnum">{formatTron(stake.unclaimedReward)} TRX</dd>
            </div>
          </dl>

          {stake.votes.length > 0 && (
            <p className="text-tertiary">
              Voting for{' '}
              {stake.votes.map((v) => `${shortAddress(v.address)} (${v.count.toString()})`).join(', ')}
            </p>
          )}
          {stake.powerTotal > 0n && stake.powerUsed === 0n && (
            <div className="warning-box">
              <IconWarning size={20} />
              <div>
                <strong>Staked but not earning</strong>
                <p>Your stake has voting power but no votes — vote for a representative to earn.</p>
              </div>
            </div>
          )}
          {stake.pendingUnfreezes.length > 0 && (
            <div className="text-tertiary">
              {stake.pendingUnfreezes.map((u, i) => (
                <p key={i}>
                  {formatTron(u.amount)} TRX unstaking —{' '}
                  {u.withdrawable
                    ? 'ready to withdraw'
                    : `withdrawable ${new Date(u.availableAtMs).toLocaleDateString()}`}
                </p>
              ))}
            </div>
          )}

          {spare > 0n && witnesses !== null && witnesses.length > 0 && (
            <label className="field">
              {/* the representative "Vote all" votes for, in the open: it used to be one the overview never showed (BL30) */}
              <span className="field-label">Vote for</span>
              <select className="input" value={chosenSr} onChange={(e) => setChosenSr(e.target.value)}>
                {witnesses.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label} — {shortAddress(w.address)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'stake-form' })}>
              Stake
            </button>
            {spare > 0n && witnesses !== null && witnesses.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  runPrepare(() => prepareVote(chain, tronKey, [{ address: chosenSr, count: spare + stake.powerUsed }]))
                }
              >
                Vote all for {witnesses.find((w) => w.address === chosenSr)?.label ?? shortAddress(chosenSr)}
              </button>
            )}
            {stake.unclaimedReward > 0n && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => runPrepare(() => prepareClaimReward(chain, tronKey))}
              >
                Claim
              </button>
            )}
          </div>
          <div className="btn-row">
            {stake.stakedEnergy + stake.stakedBandwidth > 0n && (
              <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'unstake-form' })}>
                Unstake
              </button>
            )}
            {withdrawableSun > 0n && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => runPrepare(() => prepareWithdrawUnfrozen(chain, tronKey))}
              >
                Withdraw {formatTron(withdrawableSun)} TRX
              </button>
            )}
          </div>
        </div>
      )}

      {(step.kind === 'stake-form' || step.kind === 'unstake-form') && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (parsedAmount === null || amountError !== null) return
            const amount = parsedAmount
            runPrepare(
              step.kind === 'stake-form'
                ? () => prepareFreeze(chain, tronKey, amount, resource)
                : () => prepareUnfreeze(chain, tronKey, amount, resource),
            )
          }}
        >
          <div className="field">
            <span className="field-label" id="tron-res-label">
              Resource
            </span>
            <div className="fee-pills" role="group" aria-labelledby="tron-res-label">
              <button
                type="button"
                aria-pressed={resource === 'ENERGY'}
                className={`fee-pill ${resource === 'ENERGY' ? 'is-selected' : ''}`}
                onClick={() => setResource('ENERGY')}
              >
                <span className="fee-pill-label">Energy</span>
                <span className="fee-pill-eta">cheaper USDT sends</span>
              </button>
              <button
                type="button"
                aria-pressed={resource === 'BANDWIDTH'}
                className={`fee-pill ${resource === 'BANDWIDTH' ? 'is-selected' : ''}`}
                onClick={() => setResource('BANDWIDTH')}
              >
                <span className="fee-pill-label">Bandwidth</span>
                <span className="fee-pill-eta">cheaper TRX sends</span>
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field-label">
              {step.kind === 'stake-form' ? 'Amount to stake' : 'Amount to unstake'}
            </span>
            <div className="amount-row">
              <input
                type="text"
                inputMode="decimal"
                className={`input amount-input ${amountError !== null ? 'input-invalid' : ''}`}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoComplete="off"
                placeholder={step.kind === 'stake-form' ? 'at least 1 TRX' : '0.0 TRX'}
              />
            </div>
            {amountError !== null && <span className="field-hint field-hint-error">{amountError}</span>}
            {usdHint !== null && amountError === null && (
              <span className="field-hint">≈ {formatUsd(usdHint)}</span>
            )}
          </label>

          {step.kind === 'stake-form' && witnesses !== null && witnesses.length > 0 && (
            <label className="field">
              <span className="field-label">Vote for (after staking)</span>
              <select className="input" value={chosenSr} onChange={(e) => setChosenSr(e.target.value)}>
                {witnesses.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label} — {shortAddress(w.address)}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Established representatives, largest first. Voting is what earns — the success
                screen offers it right after the stake lands.
              </span>
            </label>
          )}

          <p className="text-tertiary">
            {step.kind === 'stake-form'
              ? 'Staked TRX stays yours and never leaves your account. Unstaking later takes a fixed 14 days before withdrawal.'
              : 'Unstaking stops the resource and voting power at once; the TRX becomes withdrawable after a fixed 14-day wait.'}
          </p>

          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'overview' })}>
              <IconBack size={16} />
              Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={parsedAmount === null || amountError !== null}>
              Continue
            </button>
          </div>
        </form>
      )}

      {step.kind === 'preparing' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Building and verifying the transaction…</p>
        </div>
      )}

      {step.kind === 'prepare-error' && (
        <PrepareError title="Couldn’t prepare this" message={step.message} landed={step.landed} onBack={reload} />
      )}

      {step.kind === 'review' && (
        <div className="stack">
          <p className="text-secondary">
            {step.prepared.action === 'unfreeze'
              ? 'Unstaking is immediate, but the TRX only becomes withdrawable after 14 days.'
              : 'Check everything before confirming.'}
          </p>
          <dl className="review-list">
            <div className="review-row">
              <dt>Action</dt>
              <dd>{ACTION_TITLE[step.prepared.action]}</dd>
            </div>
            {step.prepared.amount > 0n && (
              <div className="review-row">
                <dt>Amount</dt>
                <dd className="tnum">{formatTron(step.prepared.amount)} TRX</dd>
              </div>
            )}
            {step.prepared.resource !== null && (
              <div className="review-row">
                <dt>Resource</dt>
                <dd>{step.prepared.resource === 'ENERGY' ? 'Energy' : 'Bandwidth'}</dd>
              </div>
            )}
            {step.prepared.votes !== null && step.prepared.votes.length > 0 && (
              <div className="review-row">
                <dt>Vote</dt>
                <dd className="mono review-addr">
                  {step.prepared.votes.map((v) => `${v.count} → ${shortAddress(v.address)}`).join(', ')}
                </dd>
              </div>
            )}
            <div className="review-row">
              <dt>Network cost</dt>
              <dd className="tnum">free bandwidth or ~{formatTron(step.prepared.estimatedFeeSun)} TRX</dd>
            </div>
          </dl>
          {step.prepared.action === 'vote' && stake !== null && stake.votes.length > 0 && (
            <div className="warning-box">
              <IconWarning size={20} />
              <div>
                <strong>This replaces your current votes</strong>
                <p>
                  A TRON vote replaces all earlier ones. You now vote for{' '}
                  {stake.votes.map((v) => `${shortAddress(v.address)} (${v.count.toString()})`).join(', ')}.
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
            <button type="button" className="btn btn-ghost" onClick={reload}>
              <IconBack size={16} />
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                Date.now() - step.at > TRON_REVIEW_FRESH_MS ? runPrepare(step.redo, true) : handleBroadcast(step.prepared)
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
          <h3 className="state-title">{ACTION_TITLE[step.prepared.action]} confirmed</h3>
          <p className="text-secondary">
            {step.prepared.action === 'freeze'
              ? 'Your TRX is staked. One step left to earn: cast your votes.'
              : step.prepared.action === 'unfreeze'
                ? 'Unstaking started — the Withdraw button appears here once the 14 days are up.'
                : step.prepared.action === 'claim'
                  ? 'Rewards moved to your balance.'
                  : step.prepared.action === 'withdraw'
                    ? 'Unstaked TRX is back in your balance.'
                    : 'Your votes are in — rewards accrue every maintenance round.'}
          </p>
          {step.prepared.action === 'freeze' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                // votes = whole staked TRX (network validates against real power)
                setStep({ kind: 'loading' })
                fetchTronStake(chain, tronKey.address)
                  .then((s) => {
                    if (!aliveRef.current) return
                    setStake(s)
                    const power = s.powerTotal
                    if (power <= 0n) {
                      setStep({ kind: 'prepare-error', message: 'Voting power not visible yet — try Vote again in a few seconds.' })
                      return
                    }
                    runPrepare(() => prepareVote(chain, tronKey, [{ address: chosenSr, count: power }]))
                  })
                  .catch((e: unknown) => {
                    if (aliveRef.current) setStep({ kind: 'prepare-error', message: errMessage(e) })
                  })
              }}
            >
              Vote now to start earning
            </button>
          )}
          <a
            className="btn btn-secondary"
            href={chain.explorerTx(step.txId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on explorer
            <IconExternal size={15} />
          </a>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
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
              {step.err !== undefined && (
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
              className={step.err !== undefined ? 'btn btn-secondary' : 'btn btn-primary'}
              onClick={reload}
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
