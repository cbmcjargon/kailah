import { useMemo, useState } from 'react'
import { findLookalike, type AddressFormat, type KnownAddress, type Lookalike } from '../lib/lookalike'
import { IconWarning } from './Icons'

/**
 * The send form's side of the check: the match for `address` ('' while the
 * destination isn't a valid address), and the acknowledgement, which resets
 * whenever the address changes. `ok` is false while a warning is unanswered.
 */
export function useLookalike(address: string, known: KnownAddress[], format: AddressFormat) {
  const match = useMemo(
    () => (address === '' ? null : findLookalike(address, known, format)),
    [address, known, format],
  )
  const [checkedFor, setCheckedFor] = useState<string | null>(null)
  const checked = match !== null && checkedFor === address
  return {
    match,
    checked,
    setChecked: (v: boolean) => setCheckedFor(v ? address : null),
    ok: match === null || checked,
  }
}

interface LookalikeWarningProps {
  /** the address typed, pasted or scanned */
  address: string
  match: Lookalike
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/** Full address, with the start and end it shares with the other one marked. */
function AddressDiff({ address, start, end }: { address: string; start: number; end: number }) {
  const a = address.trim()
  const cut = Math.max(start, a.length - end)
  return (
    <span className="mono lookalike-addr">
      <span className="lookalike-same">{a.slice(0, start)}</span>
      <span className="lookalike-diff">{a.slice(start, cut)}</span>
      <span className="lookalike-same">{a.slice(cut)}</span>
    </span>
  )
}

/**
 * Shown on a send form when the destination starts and ends like an address
 * from this account's history but isn't it (address poisoning, lookalike.ts).
 * Continue stays disabled until the user says they've checked the address.
 */
export default function LookalikeWarning({ address, match, checked, onCheckedChange }: LookalikeWarningProps) {
  const knownLabel =
    match.relation === 'sent'
      ? 'You sent to'
      : match.relation === 'own'
        ? 'Your own address'
        : 'In your history'
  const whom =
    match.relation === 'sent'
      ? 'an address you’ve sent to before'
      : match.relation === 'own'
        ? 'one of your own addresses'
        : 'another address in your history'
  return (
    <div className="warning-box lookalike-warning" role="alert">
      <IconWarning size={20} />
      <div>
        <strong>This looks like {whom}, but it’s a different address</strong>
        <p>
          Scammers make addresses that start and end the same way as one you use
          {match.seenIncoming
            ? ', then send you a tiny amount so theirs shows up in your history. This address sent you something.'
            : ', hoping you won’t check the middle.'}
        </p>
        <dl className="lookalike-pair">
          <dt>You entered</dt>
          <dd>
            <AddressDiff address={address} start={match.sameStart} end={match.sameEnd} />
          </dd>
          <dt>{knownLabel}</dt>
          <dd>
            <AddressDiff address={match.known} start={match.sameStart} end={match.sameEnd} />
          </dd>
        </dl>
        <p>
          Check the whole address with the person you’re paying. Don’t copy it from your
          transaction history.
        </p>
        <label className="lookalike-ack">
          <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />
          <span>I’ve checked the whole address and it’s the right one</span>
        </label>
      </div>
    </div>
  )
}
