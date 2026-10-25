import { useEffect, useId, useRef, type ReactNode } from 'react'
import { IconClose } from './Icons'

interface ModalProps {
  title: string
  onClose: () => void
  /** when false, Esc / backdrop / X are all disabled (e.g. during broadcast) */
  canDismiss?: boolean
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Stacked modals (e.g. Settings + the real-mode confirm) each register a
// document-level keydown listener; without coordination one Esc closes both
// and the two focus traps fight over Tab. This module-level stack lets only
// the topmost modal handle keyboard events.
const modalStack: symbol[] = []

/**
 * Accessible modal: role=dialog, aria-modal, focus trap, Esc + backdrop
 * dismissal (unless canDismiss=false), focus restore on close. Renders as a
 * centered card on desktop and a bottom sheet on small screens (CSS).
 */
export default function Modal({ title, onClose, canDismiss = true, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const canDismissRef = useRef(canDismiss)
  canDismissRef.current = canDismiss

  useEffect(() => {
    const stackToken = Symbol('modal')
    modalStack.push(stackToken)
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current

    const focusables = (): HTMLElement[] => {
      if (!dialog) return []
      return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    }

    const first = focusables()[0]
    if (first) first.focus()
    else dialog?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== stackToken) return
      if (e.key === 'Escape') {
        if (canDismissRef.current) {
          e.stopPropagation()
          onCloseRef.current()
        }
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const active = document.activeElement
      const inside = dialog !== null && active !== null && dialog.contains(active)
      if (e.shiftKey) {
        if (!inside || active === firstItem) {
          e.preventDefault()
          lastItem.focus()
        }
      } else if (!inside || active === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      const i = modalStack.indexOf(stackToken)
      if (i !== -1) modalStack.splice(i, 1)
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus()
    }
  }, [])

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canDismissRef.current) onCloseRef.current()
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            disabled={!canDismiss}
          >
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
