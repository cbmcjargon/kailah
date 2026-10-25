import { IconEye } from './Icons'

interface WordGridProps {
  words: string[]
  revealed: boolean
  onReveal: () => void
}

/**
 * Numbered recovery-phrase grid, blurred until the user explicitly reveals it.
 * The reveal control is a real button covering the grid.
 */
export default function WordGrid({ words, revealed, onReveal }: WordGridProps) {
  return (
    <div className="word-grid-wrap">
      <ol className={`word-grid ${revealed ? '' : 'word-grid-blurred'}`} aria-hidden={!revealed}>
        {words.map((w, i) => (
          <li key={i} className="word-cell">
            <span className="word-num">{i + 1}</span>
            <span className="word-text">{w}</span>
          </li>
        ))}
      </ol>
      {!revealed && (
        <button type="button" className="word-grid-cover" onClick={onReveal}>
          <IconEye size={22} />
          <span>Tap to reveal</span>
          <span className="word-grid-cover-hint">Make sure no one is looking</span>
        </button>
      )}
    </div>
  )
}
