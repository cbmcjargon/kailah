// The send forms' QR scanner, split off: the camera code and its jsQR
// fallback decoder (one of the largest libraries in the wallet) are their own
// chunk, fetched only when a scan starts. Send modals import this, not
// QrScanner directly.
import { lazy, Suspense, type ComponentProps } from 'react'
import ChunkBoundary from './ChunkBoundary'
import { Spinner } from './Icons'

const QrScanner = lazy(() => import('./QrScanner'))

export default function LazyQrScanner(props: ComponentProps<typeof QrScanner>) {
  return (
    <ChunkBoundary
      fallback={
        <div className="qr-scanner">
          <div className="qr-cam-error" role="alert">
            <p>The scanner didn’t load. Check your connection, or paste the address instead.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="qr-scanner">
            <div className="modal-state">
              <Spinner size={28} />
            </div>
          </div>
        }
      >
        <QrScanner {...props} />
      </Suspense>
    </ChunkBoundary>
  )
}
