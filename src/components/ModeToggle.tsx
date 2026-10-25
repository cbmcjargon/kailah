import type { NetMode } from '../lib/types'

interface ModeToggleProps {
  mode: NetMode
  onChange: (mode: NetMode) => void
}

/** Segmented Practice / Real control. */
export default function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="mode-toggle" role="group" aria-label="Network mode">
      <button
        type="button"
        className={`mode-seg ${mode === 'practice' ? 'is-active' : ''}`}
        aria-pressed={mode === 'practice'}
        onClick={() => onChange('practice')}
      >
        Practice
      </button>
      <button
        type="button"
        className={`mode-seg ${mode === 'real' ? 'is-active is-real' : ''}`}
        aria-pressed={mode === 'real'}
        onClick={() => onChange('real')}
      >
        Real
      </button>
    </div>
  )
}
