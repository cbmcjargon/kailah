import type { BuyOption } from '../lib/onramp'
import { IconExternal } from './Icons'

/**
 * Shared exchange-option list used by every Buy modal, so all eight network
 * cards present the same buying experience. Options carrying a `tag` (the
 * Kraken invite link) render it as a visible pill — referrals are always
 * disclosed, never disguised.
 */
export default function ExchangeList({
  label,
  options,
}: {
  label: string
  options: BuyOption[]
}) {
  if (options.length === 0) return null
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <ul className="buy-list">
        {options.map((o) => (
          <li key={o.name} className="buy-option buy-option-column">
            <div className="row-between buy-option-row">
              <div className="buy-option-info">
                <span className="buy-option-name">
                  {o.name}
                  {o.tag !== undefined && <span className="buy-option-tag">{o.tag}</span>}
                </span>
                <span className="buy-option-blurb">{o.blurb}</span>
              </div>
              <a
                className="btn btn-ghost btn-small"
                href={o.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
                <IconExternal size={14} />
              </a>
            </div>
            {o.steps && o.steps.length > 0 && (
              <ol className="buy-steps">
                {o.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
