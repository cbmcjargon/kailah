import Modal from './Modal'
import { IconWarning } from './Icons'

interface RealModeConfirmProps {
  onConfirm: () => void
  onCancel: () => void
}

/** One-time confirmation before switching to real networks. */
export default function RealModeConfirm({ onConfirm, onCancel }: RealModeConfirmProps) {
  return (
    <Modal title="Switch to real networks?" onClose={onCancel}>
      <div className="stack">
        <div className="warning-box" role="alert">
          <IconWarning size={20} />
          <div>
            <strong>Real mode moves real money.</strong>
            <p>
              This is a hobby wallet — keep amounts small. If something goes wrong, your recovery
              phrase is the only backup; without it, funds are gone.
            </p>
          </div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Stay in Practice
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            I understand — switch
          </button>
        </div>
      </div>
    </Modal>
  )
}
