import { useState } from 'react'
import { isValidMnemonic } from '../lib/keys'
import { saveVault } from '../lib/vault'
import { IconBack } from './Icons'
import PasswordForm from './PasswordForm'
import { normalizeMnemonic } from './ui'

interface RestoreFlowProps {
  onComplete: (mnemonic: string) => void
  onBack: () => void
}

export default function RestoreFlow({ onComplete, onBack }: RestoreFlowProps) {
  const [raw, setRaw] = useState('')
  const [step, setStep] = useState<'phrase' | 'password'>('phrase')

  const normalized = normalizeMnemonic(raw)
  const wordCount = normalized === '' ? 0 : normalized.split(' ').length
  const valid = (wordCount === 12 || wordCount === 24) && isValidMnemonic(normalized)
  const showInvalid = !valid && wordCount >= 12

  return (
    <div className="onboard-screen">
      <div className="onboard-nav">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          onClick={() => (step === 'phrase' ? onBack() : setStep('phrase'))}
        >
          <IconBack />
        </button>
        <span className="step-caption">Step {step === 'phrase' ? 1 : 2} of 2</span>
      </div>

      {step === 'phrase' && (
        <div className="stack">
          <h1 className="screen-title">Restore from phrase</h1>
          <p className="text-secondary">
            Enter your 12 or 24 word recovery phrase, separated by spaces. Order matters.
          </p>
          <label className="field">
            <span className="field-label">Recovery phrase</span>
            <textarea
              className="input phrase-input mono"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="wave shrimp lunar …"
            />
          </label>
          <div className="phrase-status" aria-live="polite">
            <span className="text-tertiary">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </span>
            {valid && <span className="status-ok">Valid phrase</span>}
            {showInvalid && (
              <span className="status-bad">Not a valid phrase — check spelling and order</span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => setStep('password')}
          >
            Continue
          </button>
        </div>
      )}

      {step === 'password' && (
        <div className="stack">
          <h1 className="screen-title">Set a password</h1>
          <PasswordForm
            submitLabel="Restore wallet"
            busyLabel="Encrypting…"
            onSubmit={async (password) => {
              await saveVault(normalized, password)
              onComplete(normalized)
            }}
          />
        </div>
      )}
    </div>
  )
}
