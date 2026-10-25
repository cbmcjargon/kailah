import { useState } from 'react'
import { IconWarning } from './Icons'

interface EraseFormProps {
  onCancel: () => void
  onConfirm: () => void
}

/** Destructive erase flow: warns, then requires typing DELETE to enable. */
export default function EraseForm({ onCancel, onConfirm }: EraseFormProps) {
  const [typed, setTyped] = useState('')
  const armed = typed.trim() === 'DELETE'

  return (
    <div className="stack">
      <div className="warning-box" role="alert">
        <IconWarning size={20} />
        <div>
          <strong>This wallet will be erased from this device.</strong>
          <p>
            Your recovery phrase is the only backup. If you have not written it down, any money in
            this wallet will be lost forever. This cannot be undone.
          </p>
        </div>
      </div>
      <label className="field">
        <span className="field-label">
          Type <span className="mono">DELETE</span> to confirm
        </span>
        <input
          type="text"
          className="input mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="DELETE"
        />
      </label>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Keep my wallet
        </button>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={onConfirm}>
          Erase wallet
        </button>
      </div>
    </div>
  )
}
