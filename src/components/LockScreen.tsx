import { useEffect, useState, type FormEvent } from 'react'
import { unlockVault } from '../lib/vault'
import {
  biometricAvailable,
  biometricErrorMessage,
  biometricUnlock,
  hasBiometricVault,
} from '../lib/biometric'
import { IconFaceId, LogoMark } from './Icons'
import Modal from './Modal'
import EraseForm from './EraseForm'

interface LockScreenProps {
  /** an unlock attempt began (the shell starts fetching the wallet chunk) */
  onUnlockStart?: () => void
  onUnlocked: (mnemonic: string) => void
  onErase: () => void
}

export default function LockScreen({ onUnlockStart, onUnlocked, onErase }: LockScreenProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [bioBusy, setBioBusy] = useState(false)
  const [bioReady, setBioReady] = useState(false)
  const [eraseOpen, setEraseOpen] = useState(false)

  useEffect(() => {
    let alive = true
    if (hasBiometricVault()) {
      void biometricAvailable().then((ok) => {
        if (alive) setBioReady(ok)
      })
    }
    return () => {
      alive = false
    }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || bioBusy || password === '') return
    onUnlockStart?.()
    setBusy(true)
    setProgress(0)
    setError(null)
    try {
      const mnemonic = await unlockVault(password, setProgress)
      setPassword('')
      onUnlocked(mnemonic)
    } catch (e) {
      setError(e instanceof Error && e.message !== 'Wrong password' ? e.message : 'Wrong password')
      setBusy(false)
    }
  }

  const handleBiometric = async () => {
    if (busy || bioBusy) return
    onUnlockStart?.()
    setBioBusy(true)
    setError(null)
    try {
      const mnemonic = await biometricUnlock()
      setPassword('')
      onUnlocked(mnemonic)
    } catch (e) {
      setError(biometricErrorMessage(e))
      setBioBusy(false)
    }
  }

  return (
    <div className="onboard-screen lock-screen">
      <div className="onboard-hero">
        <LogoMark size={56} />
        <h1 className="onboard-title">Kailah Wallet</h1>
        <p className="onboard-tagline">Locked</p>
      </div>
      {bioReady && (
        <button
          type="button"
          className="btn btn-secondary bio-unlock-btn"
          onClick={() => void handleBiometric()}
          disabled={busy || bioBusy}
        >
          <IconFaceId size={18} />
          {bioBusy ? 'Waiting for Face ID…' : 'Unlock with Face ID / fingerprint'}
        </button>
      )}
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus={!bioReady}
            disabled={busy}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || password === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {busy && (
          // Key derivation is deliberately slow (memory-hard); show it working.
          <div className="unlock-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="unlock-progress-bar" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
          </div>
        )}
      </form>
      <button type="button" className="link-danger" onClick={() => setEraseOpen(true)}>
        Erase this wallet
      </button>

      {eraseOpen && (
        <Modal title="Erase this wallet" onClose={() => setEraseOpen(false)}>
          <EraseForm
            onCancel={() => setEraseOpen(false)}
            onConfirm={() => {
              setEraseOpen(false)
              onErase()
            }}
          />
        </Modal>
      )}
    </div>
  )
}
