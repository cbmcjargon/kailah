// The review screen for a hardware account (docs/hardware-signing.md §8):
// exactly what the device will display — every non-change output in
// transaction order, then the fee — in coins, as the device shows them.
import type { UnsignedTx } from '../lib/types'
import { formatCoin } from '../lib/format'

export default function HardwareReview({ unsigned }: { unsigned: UnsignedTx }) {
  const { chain } = unsigned
  const fmt = (v: bigint) => `${formatCoin(v, chain.decimals)} ${chain.ticker}`
  const shown = unsigned.outputs.filter((o) => o.change === null)
  const hidden = unsigned.outputs.filter((o) => o.change !== null)
  const sent = shown.reduce((s, o) => s + o.amount, 0n)
  return (
    <div className="stack">
      <p className="text-secondary">
        Your Ledger will show exactly this. Approve on the device only if both screens match what
        you intended.
      </p>
      <dl className="review-list">
        {shown.map((o, i) => (
          <div key={`${o.address}-${i}`} className="stack" style={{ gap: 0 }}>
            <div className="review-row">
              <dt>{shown.length > 1 ? `To (${i + 1} of ${shown.length})` : 'To'}</dt>
              <dd className="mono review-addr">{o.address}</dd>
            </div>
            <div className="review-row">
              <dt>Amount</dt>
              <dd className="tnum">{fmt(o.amount)}</dd>
            </div>
          </div>
        ))}
        <div className="review-row">
          <dt>Network fee</dt>
          <dd className="tnum">
            {fmt(unsigned.fee)}
            <span className="text-tertiary"> · ~{unsigned.vbytesEstimate} vB</span>
          </dd>
        </div>
        <div className="review-row review-total">
          <dt>Total</dt>
          <dd className="tnum">{fmt(sent + unsigned.fee)}</dd>
        </div>
      </dl>
      {hidden.length > 0 && (
        <p className="text-tertiary">
          Change of {fmt(hidden.reduce((s, o) => s + o.amount, 0n))} returns to a fresh address on
          your Ledger. The device checks that address against its own key and doesn&rsquo;t list it.
        </p>
      )}
    </div>
  )
}
