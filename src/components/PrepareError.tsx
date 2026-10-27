import { dismissLanded, type Pending } from '../lib/pending'
import { IconBack, IconWarning } from './Icons'

interface PrepareErrorProps {
  /** headline for an ordinary failure ("Couldn't prepare this transaction", "Swap not signed") */
  title: string
  message: string
  /**
   * Set when the failure is EarlierSendLanded: an attempt whose broadcast had
   * failed went through after all. The user can then send again on purpose.
   */
  landed?: Pending
  onBack: () => void
  /** re-run the same preparation once the notice is dismissed; without it, go back */
  onSendAgain?: () => void
  /** a way forward for an ordinary failure ("Replace it" for a send still waiting) */
  action?: { label: string; run: () => void }
}

/**
 * The prepare-error step of every send, swap and stake form. For a landed
 * earlier attempt (bug audit 2026-10-27, BH1) it explains that a new send
 * would pay a second time and asks before allowing one.
 */
export default function PrepareError({ title, message, landed, onBack, onSendAgain, action }: PrepareErrorProps) {
  return (
    <div className="stack">
      <div className="warning-box" role="alert">
        <IconWarning size={20} />
        <div>
          <strong>{landed !== undefined ? 'Your earlier send went through' : title}</strong>
          <p>{message}</p>
        </div>
      </div>
      {landed === undefined && action !== undefined ? (
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            <IconBack size={16} />
            Back
          </button>
          <button type="button" className="btn btn-secondary" onClick={action.run}>
            {action.label}
          </button>
        </div>
      ) : landed === undefined ? (
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          <IconBack size={16} />
          Back
        </button>
      ) : (
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            <IconBack size={16} />
            Back
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              dismissLanded(landed)
              ;(onSendAgain ?? onBack)()
            }}
          >
            {onSendAgain !== undefined ? 'Send again anyway' : 'OK, continue'}
          </button>
        </div>
      )}
    </div>
  )
}
