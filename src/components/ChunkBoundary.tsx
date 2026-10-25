// Loading and failure states for code-split chunks (src/engines). A chunk can
// fail to load (offline, or a deploy replaced it while this page was open);
// that must end in a message with a way out, never a blank screen. The way
// out is a fresh page load, which comes back up on the lock screen.
import { Component, type ReactNode } from 'react'
import Modal from './Modal'
import { Spinner } from './Icons'

interface ChunkBoundaryProps {
  /** shown instead of the children once anything below has thrown */
  fallback: ReactNode
  children: ReactNode
}

/** Error boundary around lazily loaded UI. React logs the error itself. */
export default class ChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function reloadPage(): void {
  location.reload()
}

/**
 * Suspense fallback while a modal's chunk loads: a backdrop and spinner that
 * stay invisible for the first 300ms (CSS), so a fast load shows only the
 * modal itself. A tap on the backdrop gives up, as it would on a modal.
 */
export function ModalPending({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-overlay chunk-pending"
      role="status"
      aria-label="Loading"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Spinner size={28} />
    </div>
  )
}

/** Boundary fallback for a modal whose chunk failed to load. */
export function ModalFailed({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Couldn’t open this" onClose={onClose}>
      <div className="stack">
        <p className="form-error" role="alert">
          This part of the wallet didn’t load. Check your connection, then reload the page — you’ll
          unlock again, and nothing in your wallet changes.
        </p>
        <button type="button" className="btn btn-primary" onClick={reloadPage}>
          Reload
        </button>
      </div>
    </Modal>
  )
}
