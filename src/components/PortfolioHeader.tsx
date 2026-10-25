import { formatUsd } from '../lib/format'

export interface PortfolioSegment {
  id: string
  label: string
  color: string
  usd: number
}

interface PortfolioHeaderProps {
  /** one entry per asset whose price AND balance have loaded; [] → show "—" */
  segments: PortfolioSegment[]
  /** some networks are hidden (not scanned), so the total covers the shown ones only */
  partial?: boolean
}

/**
 * Total USD across the real-money accounts, with a slim allocation bar —
 * one colored band per asset, width proportional to its share — and a legend
 * for the assets that actually hold value. Pure display: the dashboard
 * computes the numbers.
 */
export default function PortfolioHeader({ segments, partial = false }: PortfolioHeaderProps) {
  const total = segments.reduce((acc, s) => acc + s.usd, 0)
  const nonzero = segments.filter((s) => s.usd > 0.005)

  return (
    <div className="portfolio-header">
      <div className="portfolio-topline">
        <span className="portfolio-label">{partial ? 'Total · shown networks' : 'Total balance'}</span>
        <span className="portfolio-total tnum">
          {segments.length === 0 ? '—' : formatUsd(total)}
        </span>
      </div>
      {total > 0 && nonzero.length > 0 && (
        <>
          <div className="portfolio-bar" role="img" aria-label="Portfolio allocation">
            {nonzero.map((s) => (
              <span
                key={s.id}
                className="portfolio-bar-seg"
                style={{ width: `${(s.usd / total) * 100}%`, backgroundColor: s.color }}
                title={`${s.label}: ${formatUsd(s.usd)}`}
              />
            ))}
          </div>
          <div className="portfolio-legend">
            {nonzero.map((s) => (
              <span key={s.id} className="portfolio-legend-item">
                <span className="portfolio-dot" style={{ backgroundColor: s.color }} />
                {s.label}
                <span className="tnum text-secondary">{formatUsd(s.usd)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
