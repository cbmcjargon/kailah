import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AccountKeys,
  AccountState,
  AccountUtxo,
  BuiltTx,
  ChainConfig,
  DerivedKey,
  FeeOption,
  HardwareAccountKeys,
  RawTxInfo,
  TxSummary,
  UnsignedTx,
} from '../lib/types'
import { getClient } from '../lib/api'
import { buildBump, decodeVerifiedTx, prepareBump, verifiedPrevout, verifiedRawTxInfo } from '../lib/txbuild'
import { assembleSigned, assertSignedByUs, buildSignRequest, fetchPrevTxs } from '../lib/hwsign'
import { recordPending } from '../lib/pending'
import { recordSentTo } from '../lib/sentlog'
import { isHardwareAccount } from '../lib/hwaccount'
import { browserTransport, ledgerSigner } from '../lib/ledger'
import { formatCoin } from '../lib/format'
import Modal from './Modal'
import CopyButton from './CopyButton'
import HardwareReview from './HardwareReview'
import LedgerPrompt, { useDevice } from './LedgerPrompt'
import { IconBack, IconBolt, IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'

interface BumpModalProps {
  chain: ChainConfig
  /** a seed account signs here; a hardware account signs on its device */
  account: AccountKeys | HardwareAccountKeys
  accountState: AccountState
  tx: TxSummary
  onClose: () => void
  /** called once the replacement broadcasts, so the dashboard can re-scan */
  onBumped: () => void
}

/** Everything buildBump needs, assembled once from the account scan. */
interface Prep {
  original: RawTxInfo
  ourAddresses: Set<string>
  /** software account only (null for a hardware account) */
  keyFor: ((address: string) => DerivedKey | null) | null
  extraKeyFor: ((u: AccountUtxo) => DerivedKey) | null
  /** address → account position, for public keys (hardware path) */
  lookup: Map<string, { branch: 0 | 1; index: number }>
  /** verified funding hex already fetched, reused when a device signs */
  fundingHex: Map<string, string>
  originalUtxos: AccountUtxo[]
  extraUtxos: AccountUtxo[]
  changeAddress: string
  /** original fee rate estimate (smallest units per vB), or null if fee unknown */
  origRate: bigint | null
  /** fees of unconfirmed OUTSIDE spenders of the original's outputs (they
   *  conflict with the replacement, so BIP125 counts their fees too) */
  conflictExtraFees: bigint
  conflictCount: number
}

type Step =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'choose' }
  | { kind: 'broadcasting'; built: BuiltTx }
  | { kind: 'success'; built: BuiltTx; txid: string }
  | { kind: 'failed'; built: BuiltTx; message: string }

/**
 * Parse the node's BIP125 rejection ("…less fees than conflicting txs;
 * 0.00000564 < 0.00001046") into the required total fee in smallest units.
 * Exact decimal-string math — floats never touch money.
 */
function parseConflictFloor(message: string, decimals: number): bigint | null {
  const m = /less fees than conflicting txs;\s*[\d.]+\s*<\s*([\d.]+)/i.exec(message)
  if (!m) return null
  const [whole = '0', frac = ''] = m[1]!.split('.')
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0').slice(0, decimals))
  } catch {
    return null
  }
}

/** rough vsize for the original tx, to back out its fee rate for presets */
function estimateVbytes(segwit: boolean, nIn: number, nOut: number): number {
  return segwit ? Math.ceil(10.5 + nIn * 68 + nOut * 31) : 10 + nIn * 148 + nOut * 34
}

export default function BumpModal({
  chain,
  account,
  accountState,
  tx,
  onClose,
  onBumped,
}: BumpModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [prep, setPrep] = useState<Prep | null>(null)
  const [fees, setFees] = useState<FeeOption[] | null>(null)
  const [selectedRate, setSelectedRate] = useState<bigint | null>(null)
  const [built, setBuilt] = useState<BuiltTx | null>(null)
  const [unsigned, setUnsigned] = useState<UnsignedTx | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const device = useDevice()
  const hw = isHardwareAccount(account) ? account : null
  // Absolute-fee floor learned from a node rejection ("less fees than
  // conflicting txs; a < b") — the retry rebuilds at >= b plus margin.
  const [nodeFloor, setNodeFloor] = useState<bigint | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const client = useMemo(() => getClient(chain), [chain])

  // Snapshot the scan state THIS bump is based on, taken once at mount. The
  // dashboard keeps re-scanning (60s poll, and the post-bump rescan itself),
  // handing us fresh AccountState objects — but a bump must be prepared from
  // the state that still contains the original tx, and preparation must never
  // re-run to clobber a broadcasting/success screen. Refs, not props, drive it.
  const snapRef = useRef(accountState)

  // ---- one-time preparation (mount only) -----------------------------------
  useEffect(() => {
    let cancelled = false
    const snap = snapRef.current
    const prepare = async () => {
      const scanned = snap.rawTxs.find((r) => r.txid === tx.txid)
      if (scanned === undefined) {
        if (!cancelled) {
          setStep({ kind: 'error', message: 'This transaction is no longer in view — reload and try again.' })
        }
        return
      }

      // Verify the pending tx against its own raw bytes before rebuilding it.
      // Recipients, values, outpoints and the original fee must all come from
      // data that hashes to the txid — a lying provider could otherwise hand
      // the bump a rewritten recipient list and redirect the replacement.
      const fundingHex = new Map<string, string>()
      let original: RawTxInfo
      let rawHex = ''
      try {
        rawHex = await client.getRawTxHex(scanned.txid)
        const decoded = decodeVerifiedTx(chain, scanned.txid, rawHex)
        for (const inp of decoded.inputs) {
          if (!fundingHex.has(inp.prevTxid)) {
            fundingHex.set(inp.prevTxid, await client.getRawTxHex(inp.prevTxid))
          }
        }
        original = verifiedRawTxInfo(scanned, decoded, (prevTxid, vout) =>
          verifiedPrevout(chain, prevTxid, fundingHex.get(prevTxid)!, vout),
        )
      } catch (e) {
        if (!cancelled) setStep({ kind: 'error', message: errMessage(e) })
        return
      }

      // If another still-pending tx spends an output of this one (e.g. a second
      // send that used this tx's unconfirmed change), replacing this tx would
      // invalidate that dependent payment. Refuse rather than silently cancel it.
      const hasPendingDescendant = snap.rawTxs.some(
        (r) =>
          r.txid !== original.txid &&
          r.height === null &&
          r.inputs.some((inp) => inp.prevTxid === original.txid),
      )
      if (hasPendingDescendant) {
        if (!cancelled) {
          setStep({
            kind: 'error',
            message:
              'Another pending payment depends on this one, so speeding it up could cancel that payment. Wait for this transaction to confirm.',
          })
        }
        return
      }

      // Outside spenders: someone (the recipient, an exchange) may have
      // already re-spent an output of this unconfirmed tx. Their tx conflicts
      // with the replacement, so its fee must be outbid as well (this exact
      // case rejected a user's bump with node error -26). Best-effort: if the
      // provider can't answer, the broadcast-error retry path still covers it.
      let conflictExtraFees = 0n
      let conflictCount = 0
      try {
        const outspends = (await client.getTxOutspends?.(original.txid)) ?? []
        const spenders = new Set<string>()
        for (const o of outspends) {
          if (o.spent && !o.confirmed && o.txid !== null && o.txid !== original.txid) {
            spenders.add(o.txid)
          }
        }
        for (const spender of spenders) {
          const fee = await (client.getTxFee?.(spender).catch(() => null) ?? Promise.resolve(null))
          if (fee !== null) {
            conflictExtraFees += fee
            conflictCount += 1
          }
        }
      } catch {
        // provider without outspends support (or transient) — proceed at 0
      }

      const lookup = new Map<string, { branch: 0 | 1; index: number }>()
      for (const a of snap.addresses) lookup.set(a.address, { branch: a.branch, index: a.index })
      const ourAddresses = new Set(snap.addresses.map((a) => a.address))

      const soft = isHardwareAccount(account) ? null : account
      const keyFor = soft
        ? (address: string): DerivedKey | null => {
            const loc = lookup.get(address)
            return loc ? soft.address(loc.branch, loc.index) : null
          }
        : null
      const extraKeyFor = soft ? (u: AccountUtxo): DerivedKey => soft.address(u.branch, u.index) : null

      // Rebuild the original inputs as spendable utxos (rawTxHex only needed
      // for legacy chains, which never signal RBF, so this stays a no-op there).
      // And prove the original is OURS: the provider picked which transaction
      // to show as pending and served its bytes; only our signatures on its
      // inputs can't be forged. Without this a fabricated "pending" payment
      // became a real, signed replacement (audit 2026-10-26).
      const originalUtxos: AccountUtxo[] = []
      const signedInputs: { publicKey: Uint8Array; value: bigint }[] = []
      try {
        for (const inp of original.inputs) {
          if (inp.prevTxid === null || inp.prevVout === null || inp.address === null) {
            throw new Error('The wallet could not identify every input of this transaction.')
          }
          const loc = lookup.get(inp.address)
          if (loc === undefined) {
            throw new Error('This transaction spends an address the wallet no longer tracks.')
          }
          const u: AccountUtxo = {
            txid: inp.prevTxid,
            vout: inp.prevVout,
            value: inp.value,
            address: inp.address,
            branch: loc.branch,
            index: loc.index,
          }
          if (chain.addressType === 'p2pkh') {
            // already fetched (and txid-verified) during raw-byte verification
            const funding = fundingHex.get(inp.prevTxid)
            if (funding !== undefined) u.rawTxHex = funding
          }
          originalUtxos.push(u)
          signedInputs.push({ publicKey: account.address(loc.branch, loc.index).publicKey, value: inp.value })
        }
        assertSignedByUs(chain, rawHex, signedInputs)
      } catch (e) {
        if (!cancelled) setStep({ kind: 'error', message: errMessage(e) })
        return
      }

      // Extra funds: current CONFIRMED utxos, excluding any output of the tx we
      // replace. Unconfirmed extras would violate BIP125 rule 2 (a replacement
      // may not add new unconfirmed inputs) and be rejected at broadcast.
      const extraUtxos = snap.utxos.filter(
        (u) => u.txid !== original.txid && u.confirmed !== false,
      )

      const ourChange = original.outputs.find(
        (o) => o.address !== null && ourAddresses.has(o.address),
      )
      const changeAddress = ourChange?.address ?? snap.nextChange.address

      const vbytes = estimateVbytes(
        chain.addressType === 'p2wpkh',
        original.inputs.length,
        original.outputs.length,
      )
      const origRate = original.fee !== null && vbytes > 0 ? original.fee / BigInt(vbytes) : null

      if (!cancelled) {
        setPrep({
          original,
          ourAddresses,
          keyFor,
          extraKeyFor,
          lookup,
          fundingHex,
          originalUtxos,
          extraUtxos,
          changeAddress,
          origRate,
          conflictExtraFees,
          conflictCount,
        })
        setStep({ kind: 'choose' })
      }
    }

    void prepare()
    client
      .getFeeOptions()
      .then((opts) => {
        if (!cancelled) setFees(opts)
      })
      .catch(() => {
        if (!cancelled) setFees([])
      })

    return () => {
      cancelled = true
    }
  }, [account, chain, client, tx.txid])

  // ---- fee pill options ----------------------------------------------------
  const origRate = prep?.origRate ?? null

  const pills = useMemo<{ label: string; rate: bigint }[]>(() => {
    const out: { label: string; rate: bigint }[] = []
    if (origRate !== null) {
      const p50 = (origRate * 3n + 1n) / 2n
      const p100 = origRate * 2n
      out.push({ label: '+50% fee', rate: p50 > origRate ? p50 : origRate + 1n })
      out.push({ label: 'Double fee', rate: p100 > origRate ? p100 : origRate + 1n })
    }
    for (const f of fees ?? []) {
      if (origRate === null || f.rate > origRate) out.push({ label: f.label, rate: f.rate })
    }
    const seen = new Set<string>()
    const unique = out.filter((o) => {
      const k = o.rate.toString()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    unique.sort((a, b) => (a.rate > b.rate ? 1 : a.rate < b.rate ? -1 : 0))
    return unique
  }, [origRate, fees])

  // default the selection to the smallest valid bump once options are known
  useEffect(() => {
    if (selectedRate === null && pills.length > 0) setSelectedRate(pills[0].rate)
  }, [pills, selectedRate])

  // ---- reactive preview ----------------------------------------------------
  useEffect(() => {
    if (prep === null || selectedRate === null) return
    setBuildError(null)
    try {
      if (hw !== null) {
        // Same plan as buildBump, unsigned: the device signs it on demand.
        const at = (address: string) => {
          const loc = prep.lookup.get(address)
          return loc ? hw.address(loc.branch, loc.index) : null
        }
        const change = at(prep.changeAddress)
        if (change === null) throw new Error('The wallet could not locate its change address — refresh and try again.')
        setUnsigned(
          prepareBump({
            chain,
            original: prep.original,
            ourAddresses: prep.ourAddresses,
            keyFor: at,
            originalUtxos: prep.originalUtxos,
            extraUtxos: prep.extraUtxos,
            extraKeyFor: (u) => hw.address(u.branch, u.index),
            newFeeRate: selectedRate,
            change,
            conflictExtraFees: prep.conflictExtraFees,
            ...(nodeFloor !== null && { absoluteFeeFloor: nodeFloor }),
          }),
        )
        setBuilt(null)
        return
      }
      if (prep.keyFor === null || prep.extraKeyFor === null) return
      const result = buildBump({
        chain,
        original: prep.original,
        ourAddresses: prep.ourAddresses,
        keyFor: prep.keyFor,
        originalUtxos: prep.originalUtxos,
        extraUtxos: prep.extraUtxos,
        extraKeyFor: prep.extraKeyFor,
        newFeeRate: selectedRate,
        changeAddress: prep.changeAddress,
        conflictExtraFees: prep.conflictExtraFees,
        ...(nodeFloor !== null && { absoluteFeeFloor: nodeFloor }),
      })
      setBuilt(result)
    } catch (e) {
      setBuilt(null)
      setUnsigned(null)
      setBuildError(errMessage(e))
    }
  }, [prep, selectedRate, chain, nodeFloor, hw])

  // Hardware: device signs the previewed replacement; verified, then broadcast.
  const handleHardwareReplace = async (u: UnsignedTx) => {
    if (hw === null || prep === null) return
    const result = await device.run(async (onStatus) => {
      const prevTxs = await fetchPrevTxs(chain, client, u, prep.fundingHex)
      const sigs = await ledgerSigner(hw, browserTransport(true), onStatus).sign(buildSignRequest(u, hw, prevTxs))
      return assembleSigned(u, sigs)
    })
    if (result !== null && aliveRef.current) handleBroadcast(result)
  }

  const handleBroadcast = (b: BuiltTx) => {
    setStep({ kind: 'broadcasting', built: b })
    // the replacement may land after a lost answer, like any send
    recordPending({ kind: 'utxo', chainId: chain.id, txid: b.txid, to: b.toAddress, ts: Date.now() })
    recordSentTo(chain.id, b.toAddress)
    client
      .broadcast(b.hex)
      .then((txid) => {
        onBumped()
        if (aliveRef.current) setStep({ kind: 'success', built: b, txid })
      })
      .catch((e) => {
        if (aliveRef.current) setStep({ kind: 'failed', built: b, message: errMessage(e) })
      })
  }

  const fmt = (v: bigint) => `${formatCoin(v, chain.decimals)} ${chain.ticker}`
  const broadcasting = step.kind === 'broadcasting'
  const unit = chain.unitName
  // what the fee warning and the button look at, whichever path is active
  const preview = hw !== null ? unsigned : built

  return (
    <Modal title="Speed up transaction" onClose={onClose} canDismiss={!broadcasting && !device.busy}>
      {step.kind === 'loading' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Reading the stuck transaction…</p>
        </div>
      )}

      {step.kind === 'error' && (
        <div className="stack">
          <div className="warning-box" role="alert">
            <IconWarning size={20} />
            <div>
              <strong>Can&rsquo;t speed this up</strong>
              <p>{step.message}</p>
            </div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      )}

      {step.kind === 'choose' && (
        <div className="stack">
          <p className="text-secondary">
            Rebroadcast this pending payment with a higher fee so miners pick it up sooner. The
            recipient and amount below were re-read from the transaction&rsquo;s own verified
            bytes — check them before replacing.
          </p>

          {prep !== null && prep.conflictExtraFees > 0n && (
            <div className="warning-box">
              <IconWarning size={20} />
              <div>
                <strong>Someone already re-spent this payment</strong>
                <p>
                  {prep.conflictCount === 1 ? 'A follow-on transaction' : `${prep.conflictCount} follow-on transactions`}{' '}
                  already spend coins from this unconfirmed payment. Speeding up cancels{' '}
                  {prep.conflictCount === 1 ? 'it' : 'them'}, and the network requires your new
                  fee to outbid {prep.conflictCount === 1 ? 'its' : 'their'} fee too (+
                  {prep.conflictExtraFees.toString()} {unit}, included below).
                </p>
              </div>
            </div>
          )}

          <div className="field">
            <span className="field-label" id="bump-fee-label">
              New network fee
            </span>
            {fees === null && pills.length === 0 ? (
              <div className="fee-pills">
                <div className="skeleton skeleton-pill" />
                <div className="skeleton skeleton-pill" />
              </div>
            ) : pills.length === 0 ? (
              <p className="field-hint field-hint-error">No higher fee rate is available right now.</p>
            ) : (
              <div className="fee-pills" role="group" aria-labelledby="bump-fee-label">
                {pills.map((p, i) => (
                  <button
                    key={`${p.rate.toString()}-${i}`}
                    type="button"
                    aria-pressed={p.rate === selectedRate}
                    className={`fee-pill ${p.rate === selectedRate ? 'is-selected' : ''}`}
                    // the device signs the fee it was shown; the screen must not move meanwhile
                    disabled={device.busy}
                    onClick={() => setSelectedRate(p.rate)}
                  >
                    <span className="fee-pill-label">{p.label}</span>
                    <span className="fee-pill-eta tnum">
                      {p.rate.toString()} {unit}/vB
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {buildError !== null && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>That fee won&rsquo;t work</strong>
                <p>{buildError}</p>
              </div>
            </div>
          )}

          {hw !== null && unsigned !== null && buildError === null && (
            <>
              <HardwareReview unsigned={unsigned} />
              {prep && prep.original.fee !== null && unsigned.fee > prep.original.fee && (
                <dl className="review-list">
                  <div className="review-row">
                    <dt>Old fee</dt>
                    <dd className="tnum">{fmt(prep.original.fee)}</dd>
                  </div>
                  <div className="review-row review-total">
                    <dt>Extra cost</dt>
                    <dd className="tnum">{fmt(unsigned.fee - prep.original.fee)}</dd>
                  </div>
                </dl>
              )}
            </>
          )}

          {hw === null && built !== null && buildError === null && (
            <dl className="review-list">
              {built.amount > 0n ? (
                <>
                  <div className="review-row">
                    <dt>To</dt>
                    <dd className="mono review-addr">{built.toAddress}</dd>
                  </div>
                  <div className="review-row">
                    <dt>Amount</dt>
                    <dd className="tnum">{fmt(built.amount)}</dd>
                  </div>
                </>
              ) : (
                <div className="review-row">
                  <dt>To</dt>
                  <dd>Your own wallet (everything returns to a change address)</dd>
                </div>
              )}
              <div className="review-row">
                <dt>Old fee</dt>
                <dd className="tnum">
                  {prep && prep.original.fee !== null ? fmt(prep.original.fee) : 'Unknown'}
                </dd>
              </div>
              <div className="review-row">
                <dt>New fee</dt>
                <dd className="tnum">
                  {fmt(built.fee)}
                  <span className="text-tertiary"> · {built.vbytes} vB</span>
                </dd>
              </div>
              {prep && prep.original.fee !== null && built.fee > prep.original.fee && (
                <div className="review-row review-total">
                  <dt>Extra cost</dt>
                  <dd className="tnum">{fmt(built.fee - prep.original.fee)}</dd>
                </div>
              )}
            </dl>
          )}

          {preview !== null && buildError === null && preview.amount > 0n && preview.fee * 4n > preview.amount && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Unusually large fee</strong>
                <p>
                  The replacement&rsquo;s fee is more than a quarter of the amount being sent. Only
                  continue if that&rsquo;s what you expect.
                </p>
              </div>
            </div>
          )}

          {hw !== null && unsigned !== null && (
            <LedgerPrompt
              chainId={hw.record.chain}
              ui={device.ui}
              confirmText={`It must show the same recipient and amount as before, with a fee of ${fmt(unsigned.fee)}.`}
            />
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={preview === null || buildError !== null || device.busy}
            onClick={() => {
              if (hw !== null) {
                if (unsigned) void handleHardwareReplace(unsigned)
              } else if (built) handleBroadcast(built)
            }}
          >
            <IconBolt size={17} />
            {hw !== null ? (device.ui.phase === 'error' ? 'Try again on Ledger' : 'Replace on Ledger') : 'Replace transaction'}
          </button>
        </div>
      )}

      {step.kind === 'broadcasting' && (
        <div className="modal-state">
          <Spinner size={28} />
          <p>Broadcasting replacement…</p>
          <p className="text-tertiary">Don&rsquo;t close this window.</p>
        </div>
      )}

      {step.kind === 'success' && (
        <div className="stack success-body">
          <div className="success-badge">
            <IconCheck size={26} />
          </div>
          <h3 className="state-title">Fee raised</h3>
          <p className="text-secondary">
            The replacement is broadcasting. It confirms once miners include the higher-fee version.
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

      {step.kind === 'failed' && (() => {
        const floor = parseConflictFloor(step.message, chain.decimals)
        return (
          <div className="stack">
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Replacement failed</strong>
                <p>
                  {floor !== null
                    ? `Other pending transactions depend on this payment, so the network requires ` +
                      `a total fee above ${floor.toString()} ${unit} to replace it. Nothing was sent.`
                    : step.message}
                </p>
              </div>
            </div>
            <div className="btn-row">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
              {floor !== null ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    // rebuild with the node's own number as the floor, plus
                    // margin for the incremental relay rule on the new size
                    setNodeFloor(floor + BigInt(step.built.vbytes) + 10n)
                    setStep({ kind: 'choose' })
                  }}
                >
                  Rebuild at the required fee
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'choose' })}>
                  <IconBack size={16} />
                  Back
                </button>
              )}
            </div>
          </div>
        )
      })()}
    </Modal>
  )
}
