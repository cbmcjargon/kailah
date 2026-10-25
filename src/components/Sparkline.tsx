import type { PricePoint } from '../lib/types'

interface SparklineProps {
  history: PricePoint[]
  width?: number
  height?: number
  /** override the up/down auto-tint with a fixed stroke (e.g. the chain color) */
  color?: string
}

/**
 * Tiny inline 7-day price line. Auto-tints green/red on the period's net
 * direction unless `color` is given. Renders an empty box (no crash) when
 * there is not enough history to draw a line.
 */
export default function Sparkline({ history, width = 64, height = 24, color }: SparklineProps) {
  if (history.length < 2) {
    return (
      <svg
        className="sparkline sparkline-empty"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      />
    )
  }

  const prices = history.map((h) => h.p)
  const first = prices[0]
  const last = prices[prices.length - 1]
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const n = prices.length
  const pad = 2
  const w = width - pad * 2
  const h = height - pad * 2

  const xy = (p: number, i: number): [number, number] => [
    pad + (i / (n - 1)) * w,
    pad + (1 - (p - min) / span) * h,
  ]

  const linePts = prices.map((p, i) => xy(p, i).map((v) => v.toFixed(1)).join(',')).join(' ')
  const [lastX, lastY] = xy(last, n - 1)
  const baseY = (height - pad).toFixed(1)
  const areaPts = `${pad.toFixed(1)},${baseY} ${linePts} ${lastX.toFixed(1)},${baseY}`

  const up = last >= first
  const stroke = color ?? (up ? 'var(--ok)' : 'var(--danger)')
  const changePct = first !== 0 ? ((last - first) / first) * 100 : 0

  return (
    <svg
      className={`sparkline ${up ? 'is-up' : 'is-down'}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`7-day trend ${up ? 'up' : 'down'} ${Math.abs(changePct).toFixed(1)} percent`}
    >
      <polygon points={areaPts} fill={stroke} fillOpacity={0.12} stroke="none" />
      <polyline
        points={linePts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={1.9} fill={stroke} />
    </svg>
  )
}
