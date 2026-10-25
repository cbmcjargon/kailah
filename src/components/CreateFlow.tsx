import { useState, type FormEvent } from 'react'
import { generateMnemonic } from '../lib/keys'
import { saveVault } from '../lib/vault'
import { IconBack, IconWarning } from './Icons'
import PasswordForm from './PasswordForm'
import WordGrid from './WordGrid'

interface CreateFlowProps {
  /** vault is saved; hand the mnemonic to the app to unlock immediately */
  onComplete: (mnemonic: string) => void
  onBack: () => void
}

type Step = 'reveal' | 'confirm' | 'password'

/** three distinct random word positions (0-based), sorted ascending */
function pickQuizPositions(): number[] {
  const pool = Array.from({ length: 12 }, (_, i) => i)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = pool[i]
    pool[i] = pool[j]
    pool[j] = a
  }
  return pool.slice(0, 3).sort((x, y) => x - y)
}

export default function CreateFlow({ onComplete, onBack }: CreateFlowProps) {
  const [mnemonic] = useState(() => generateMnemonic())
  const [step, setStep] = useState<Step>('reveal')
  const [revealed, setRevealed] = useState(false)
  const [quiz] = useState(pickQuizPositions)
  const [answers, setAnswers] = useState<string[]>(['', '', ''])
  const [quizError, setQuizError] = useState<string | null>(null)

  const words = mnemonic.split(' ')

  const checkQuiz = (e: FormEvent) => {
    e.preventDefault()
    const ok = quiz.every((pos, i) => (answers[i] ?? '').trim().toLowerCase() === words[pos])
    if (!ok) {
      setQuizError('One or more words do not match. Check your written phrase and try again.')
      return
    }
    setQuizError(null)
    setStep('password')
  }

  const stepNumber = step === 'reveal' ? 1 : step === 'confirm' ? 2 : 3

  return (
    <div className="onboard-screen">
      <div className="onboard-nav">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          onClick={() => {
            if (step === 'reveal') onBack()
            else if (step === 'confirm') setStep('reveal')
            else setStep('confirm')
          }}
        >
          <IconBack />
        </button>
        <span className="step-caption">Step {stepNumber} of 3</span>
      </div>

      {step === 'reveal' && (
        <div className="stack">
          <h1 className="screen-title">Your recovery phrase</h1>
          <p className="text-secondary">
            These 12 words are your wallet. Write them down on paper, in order, and keep them
            somewhere safe.
          </p>
          <div className="warning-box" role="alert">
            <IconWarning size={20} />
            <div>
              <strong>Anyone with these words controls the money.</strong>
              <p>Never share them, never type them into a website, never store them in email.</p>
            </div>
          </div>
          <WordGrid words={words} revealed={revealed} onReveal={() => setRevealed(true)} />
          {revealed && (
            <p className="text-tertiary">
              {/* deliberately no copy button: clipboard history and cross-device
                  clipboard sync would persist the seed outside this device */}
              Write the words on paper, in order. Don&rsquo;t photograph them or paste them
              anywhere digital.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!revealed}
            onClick={() => setStep('confirm')}
          >
            I&rsquo;ve written it down
          </button>
        </div>
      )}

      {step === 'confirm' && (
        <form className="stack" onSubmit={checkQuiz} noValidate>
          <h1 className="screen-title">Quick check</h1>
          <p className="text-secondary">
            Enter these three words from your written phrase to prove the backup is real.
          </p>
          {quiz.map((pos, i) => (
            <label className="field" key={pos}>
              <span className="field-label">Word #{pos + 1}</span>
              <input
                type="text"
                className="input"
                value={answers[i]}
                onChange={(e) => {
                  const next = [...answers]
                  next[i] = e.target.value
                  setAnswers(next)
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          ))}
          {quizError && (
            <p className="form-error" role="alert">
              {quizError}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={answers.some((a) => a.trim() === '')}
          >
            Continue
          </button>
        </form>
      )}

      {step === 'password' && (
        <div className="stack">
          <h1 className="screen-title">Set a password</h1>
          <PasswordForm
            submitLabel="Create wallet"
            busyLabel="Encrypting…"
            onSubmit={async (password) => {
              await saveVault(mnemonic, password)
              onComplete(mnemonic)
            }}
          />
        </div>
      )}
    </div>
  )
}
