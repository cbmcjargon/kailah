import { IconClose } from './Icons'

export interface ToastItem {
  id: number
  title: string
  body: string
}

interface ToastsProps {
  items: ToastItem[]
  onDismiss: (id: number) => void
}

/**
 * Bottom-anchored transient toasts (received payments etc.). The aria-live
 * container stays mounted even when empty — screen readers only reliably
 * announce insertions into a live region that already existed.
 */
export default function Toasts({ items, onDismiss }: ToastsProps) {
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast" role="status">
          <div className="toast-text">
            <strong>{t.title}</strong>
            <p>{t.body}</p>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-small"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
          >
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
