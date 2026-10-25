import { useState, type FormEvent } from 'react'
import { errMessage } from './ui'

interface PasswordFormProps {
  /** called with the chosen password; may reject with a user-readable error */
  onSubmit: (password: string) => Promise<void>
  submitLabel: string
  busyLabel: string
}

const MIN_LENGTH = 10

// A tiny common-password list is enough: the vault's Argon2id KDF makes each
// guess expensive, so the realistic failure is a password an attacker tries
// FIRST, not one they brute-force. Lowercased, checked exactly.
const COMMON = new Set([
  'password', 'password1', 'passw0rd', 'qwertyuiop', 'qwerty1234', '1234567890', '12345678910',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1', 'letmein',
  'welcome1', 'admin12345', 'monkey123', 'dragon123', 'abc1234567', 'abcd123456', 'qwerty123456',
  'bitcoin123', 'bitcoin2024', 'bitcoin2025', 'bitcoin2026', 'kailahwallet', 'walletpass',
])

/** Why a password is unacceptable, or null when it passes. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_LENGTH) {
    return `Use at least ${MIN_LENGTH} characters \u2014 three or four random words work best.`
  }
  const lower = pw.toLowerCase()
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890)+$/.test(pw)) {
    return 'That password is far too common to protect money. Pick something only you would think of.'
  }
  if (/(password|kailah|wallet|bitcoin|qwerty|12345)/.test(lower) && pw.length < 20) {
    return 'Avoid obvious words like \u201cpassword\u201d, \u201cwallet\u201d or \u201cbitcoin\u201d unless the password is much longer.'
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  if (pw.length < 14 && classes < 2) {
    return 'Short passwords need more variety \u2014 mix words, numbers or symbols, or just make it longer.'
  }
  return null
}

/** Rough strength label for live feedback (length does most of the work). */
export function passwordStrength(pw: string): 'weak' | 'okay' | 'strong' {
  if (pw.length === 0 || passwordProblem(pw) !== null) return 'weak'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const score = pw.length + 2 * classes
  return score >= 24 ? 'strong' : score >= 16 ? 'okay' : 'weak'
}

/** Set-a-new-password step: password + confirm, min length, mismatch errors. */
export default function PasswordForm({ onSubmit, submitLabel, busyLabel }: PasswordFormProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const problem = passwordProblem(password)
    if (problem !== null) {
      setError(problem)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await onSubmit(password)
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="stack" noValidate>
      <p className="text-secondary">
        This password encrypts your recovery phrase on this device. It cannot recover the phrase if
        you forget it — the phrase itself is the only backup.
      </p>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="At least 10 characters"
          disabled={busy}
        />
        {password.length > 0 && (
          <span className={`pw-strength pw-${passwordStrength(password)}`} aria-live="polite">
            {passwordStrength(password) === 'strong'
              ? 'Strong'
              : passwordStrength(password) === 'okay'
                ? 'Okay \u2014 longer is stronger'
                : 'Weak'}
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">Confirm password</span>
        <input
          type="password"
          className="input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          placeholder="Type it again"
          disabled={busy}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  )
}
