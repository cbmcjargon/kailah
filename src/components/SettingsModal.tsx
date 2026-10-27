import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { HardwareAccountRecord, NetMode } from '../lib/types'
import { CHAINS } from '../lib/networks'
import { NETWORK_LABELS, PRACTICE_TWINS, REAL_NETWORKS, type RealNetworkId } from '../lib/netprefs'
import { shortAddress } from '../lib/format'
import { csvExportHint } from '../lib/csvexport'
import { unlockVault } from '../lib/vault'
import Modal from './Modal'
import WordGrid from './WordGrid'
import EraseForm from './EraseForm'
import ModeToggle from './ModeToggle'
import { biometricErrorMessage } from '../lib/biometric'
import { IconBack, IconBell, IconDownload, IconFaceId, IconLock, IconShield, IconWarning } from './Icons'

interface SettingsModalProps {
  mode: NetMode
  onRequestModeChange: (mode: NetMode) => void
  onLock: () => void
  onErase: () => void
  onClose: () => void
  bioAvailable: boolean
  bioEnrolled: boolean
  onEnableBiometric: () => Promise<void>
  onDisableBiometric: () => void
  notifyEnabled: boolean
  notifyPermission: NotificationPermission
  onToggleNotify: (on: boolean) => Promise<void>
  /** export the shown networks' transaction history as one CSV file */
  onExportCsv: () => void
  /** names of the networks the export covers (shown, this mode, with history); empty disables it */
  csvNetworks: string[]
  /** Ledger accounts on this wallet (all modes) */
  hwRecords: HardwareAccountRecord[]
  onAddHardware: () => void
  onRemoveHardware: (id: string) => void
  /** 'networks' opens scrolled to Networks shown (the dashboard's "N hidden — show") */
  initialSection: 'networks' | null
  /** real-mode networks the dashboard shows (all of them while undecided) */
  shownNetworks: readonly RealNetworkId[]
  /** false while an existing or restored wallet hasn't picked yet */
  networksDecided: boolean
  /** networks known to hold funds right now — hiding one takes a second tap */
  fundedNetworks: readonly RealNetworkId[]
  onSetNetworkShown: (id: RealNetworkId, show: boolean) => void
}

// Labels come from netprefs' static table, not the engine configs: importing
// lib/evm|sol|tron here would pull those engines into the App chunk.
const networkInfo = (id: RealNetworkId) => NETWORK_LABELS[id]

/** "Bitcoin, Base, Solana and TRON" — the networks with a practice twin. */
const PRACTICE_CAPABLE = (() => {
  const names = REAL_NETWORKS.filter((id) => Object.values(PRACTICE_TWINS).includes(id)).map(
    (id) => networkInfo(id).name,
  )
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('')
})()

type View = 'main' | 'reveal' | 'erase'

const REVEAL_SECONDS = 60

export default function SettingsModal({
  mode,
  onRequestModeChange,
  onLock,
  onErase,
  onClose,
  bioAvailable,
  bioEnrolled,
  onEnableBiometric,
  onDisableBiometric,
  notifyEnabled,
  notifyPermission,
  onToggleNotify,
  onExportCsv,
  csvNetworks,
  hwRecords,
  onAddHardware,
  onRemoveHardware,
  initialSection,
  shownNetworks,
  networksDecided,
  fundedNetworks,
  onSetNetworkShown,
}: SettingsModalProps) {
  const [view, setView] = useState<View>('main')
  // removing takes a second tap on the same row
  const [armedRemove, setArmedRemove] = useState<string | null>(null)
  // so does hiding a network that holds funds
  const [armedHide, setArmedHide] = useState<RealNetworkId | null>(null)
  const networksRef = useRef<HTMLElement>(null)

  // Opened from the dashboard's hidden-networks link: land on the toggles.
  // (Runs after Modal's own initial focus — child effects run first.)
  useEffect(() => {
    if (initialSection !== 'networks') return
    const section = networksRef.current
    section?.scrollIntoView({ block: 'start' })
    section?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [initialSection])

  const toggleNetwork = (id: RealNetworkId) => {
    if (!shownNetworks.includes(id)) {
      setArmedHide(null)
      onSetNetworkShown(id, true)
      return
    }
    if (shownNetworks.length === 1) return
    if (fundedNetworks.includes(id) && armedHide !== id) {
      setArmedHide(id)
      return
    }
    setArmedHide(null)
    onSetNetworkShown(id, false)
  }
  const [bioBusy, setBioBusy] = useState(false)
  const [bioError, setBioError] = useState<string | null>(null)
  const [notifyBusy, setNotifyBusy] = useState(false)

  const handleBiometricToggle = async () => {
    if (bioBusy) return
    setBioError(null)
    if (bioEnrolled) {
      onDisableBiometric()
      return
    }
    setBioBusy(true)
    try {
      await onEnableBiometric()
    } catch (e) {
      setBioError(biometricErrorMessage(e))
    } finally {
      setBioBusy(false)
    }
  }

  const handleNotifyToggle = async () => {
    if (notifyBusy) return
    setNotifyBusy(true)
    try {
      await onToggleNotify(!notifyEnabled)
    } finally {
      setNotifyBusy(false)
    }
  }

  // reveal-phrase state — the mnemonic lives only in this component's memory
  const [revealPassword, setRevealPassword] = useState('')
  const [revealError, setRevealError] = useState<string | null>(null)
  const [revealBusy, setRevealBusy] = useState(false)
  const [phrase, setPhrase] = useState<string | null>(null)
  const [phraseShown, setPhraseShown] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS)

  const hidePhrase = () => {
    setPhrase(null)
    setPhraseShown(false)
    setRevealPassword('')
    setSecondsLeft(REVEAL_SECONDS)
  }

  // auto-hide countdown once the phrase is on screen
  useEffect(() => {
    if (phrase === null) return
    setSecondsLeft(REVEAL_SECONDS)
    const started = Date.now()
    const iv = window.setInterval(() => {
      const left = REVEAL_SECONDS - Math.floor((Date.now() - started) / 1000)
      if (left <= 0) {
        setPhrase(null)
        setPhraseShown(false)
        setRevealPassword('')
      } else {
        setSecondsLeft(left)
      }
    }, 1000)
    return () => window.clearInterval(iv)
  }, [phrase])

  const handleReveal = async (e: FormEvent) => {
    e.preventDefault()
    if (revealBusy || revealPassword === '') return
    setRevealBusy(true)
    setRevealError(null)
    try {
      const m = await unlockVault(revealPassword)
      setPhrase(m)
      setPhraseShown(false)
    } catch {
      setRevealError('Wrong password')
    } finally {
      setRevealBusy(false)
    }
  }

  const closeAll = () => {
    hidePhrase()
    onClose()
  }

  return (
    <Modal
      title={view === 'main' ? 'Settings' : view === 'reveal' ? 'Recovery phrase' : 'Erase wallet'}
      onClose={closeAll}
    >
      {view === 'main' && (
        <div className="stack settings-stack">
          <section className="settings-section">
            <h3 className="settings-heading">Security</h3>
            <button type="button" className="settings-row" onClick={() => setView('reveal')}>
              <span>Reveal recovery phrase</span>
              <span className="settings-row-hint">Password required</span>
            </button>
            <button
              type="button"
              className="settings-row"
              onClick={() => {
                closeAll()
                onLock()
              }}
            >
              <span className="settings-row-with-icon">
                <IconLock size={16} />
                Lock now
              </span>
              <span className="settings-row-hint">Auto-locks after 15 min idle</span>
            </button>
            {bioAvailable && (
              <button
                type="button"
                className="settings-row"
                onClick={() => void handleBiometricToggle()}
                disabled={bioBusy}
                aria-pressed={bioEnrolled}
              >
                <span className="settings-row-with-icon">
                  <IconFaceId size={16} />
                  Face ID / fingerprint unlock
                </span>
                <span className="settings-row-hint">
                  {bioBusy ? 'Follow the prompt…' : bioEnrolled ? 'On — tap to turn off' : 'Off — tap to set up'}
                </span>
              </button>
            )}
            {bioAvailable && (
              <p className="text-tertiary">
                Uses your device&rsquo;s screen lock — face, fingerprint, or its passcode
                fallback. Revealing the recovery phrase always requires your wallet password.
              </p>
            )}
            {bioError !== null && (
              <p className="form-error" role="alert">
                {bioError}
              </p>
            )}
            <button
              type="button"
              className="settings-row settings-row-danger"
              onClick={() => setView('erase')}
            >
              <span>Erase wallet</span>
              <span className="settings-row-hint">Requires typing DELETE</span>
            </button>
          </section>

          <section className="settings-section" ref={networksRef}>
            <h3 className="settings-heading">Networks shown</h3>
            {REAL_NETWORKS.map((id) => {
              const info = networkInfo(id)
              const on = shownNetworks.includes(id)
              const hint = !on
                ? 'Hidden'
                : armedHide === id
                  ? 'Tap again to hide'
                  : shownNetworks.length === 1
                    ? 'Shown · keep at least one'
                    : 'Shown'
              return (
                <button
                  key={id}
                  type="button"
                  className={`settings-row net-row ${armedHide === id ? 'settings-row-danger' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleNetwork(id)}
                >
                  <span className="settings-row-with-icon">
                    <span className="net-dot" style={{ backgroundColor: info.color }} aria-hidden="true" />
                    {info.name}
                    <span className="net-assets">{info.assets}</span>
                  </span>
                  <span className="settings-row-hint net-state">
                    {hint}
                    <span className="net-switch" aria-hidden="true" />
                  </span>
                </button>
              )
            })}
            {armedHide !== null && (
              <p className="form-error" role="status">
                {networkInfo(armedHide).name} holds funds. Hidden, they stay safe on-chain but out of
                sight and out of your total.
              </p>
            )}
            <p className="text-tertiary">
              Hidden networks aren&rsquo;t checked at all: no balance lookups, no payment alerts,
              and they&rsquo;re left out of your total. Coins sent to a hidden network are safe
              on-chain but stay hidden until you show it again here. Hiding never moves or deletes
              anything — your 12 words still control every network.
            </p>
            <p className="text-tertiary">
              Practice mode shows the test network of each one shown here ({PRACTICE_CAPABLE} have
              one). Ledger accounts always show.
            </p>
            {!networksDecided && (
              <p className="text-tertiary">
                Everything shows for now. The first time this wallet opens in real mode it checks
                each network once and keeps showing every one with funds or history.
              </p>
            )}
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Hardware wallets</h3>
            {hwRecords.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`settings-row ${armedRemove === r.id ? 'settings-row-danger' : ''}`}
                onClick={() => {
                  if (armedRemove === r.id) {
                    setArmedRemove(null)
                    onRemoveHardware(r.id)
                  } else {
                    setArmedRemove(r.id)
                  }
                }}
              >
                <span className="settings-row-with-icon">
                  <IconShield size={16} />
                  {CHAINS[r.chain].name} · Ledger
                </span>
                <span className="settings-row-hint">
                  {armedRemove === r.id ? 'Tap again to remove' : `${shortAddress(r.verifiedAddress)} · Remove`}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="settings-row"
              onClick={() => {
                closeAll()
                onAddHardware()
              }}
            >
              <span className="settings-row-with-icon">
                <IconShield size={16} />
                Add a Ledger account
              </span>
              <span className="settings-row-hint">Bitcoin · Litecoin</span>
            </button>
            <p className="text-tertiary">
              Coins on a Ledger are controlled by the Ledger&rsquo;s own recovery phrase, not by this
              wallet&rsquo;s 12 words. This wallet keeps only the account&rsquo;s public key, so
              removing an account here never touches the device or its coins.
            </p>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Notifications</h3>
            <button
              type="button"
              className="settings-row"
              onClick={() => void handleNotifyToggle()}
              disabled={notifyBusy}
              aria-pressed={notifyEnabled}
            >
              <span className="settings-row-with-icon">
                <IconBell size={16} />
                Payment alerts
              </span>
              <span className="settings-row-hint">{notifyEnabled ? 'On' : 'Off'}</span>
            </button>
            {notifyEnabled && notifyPermission !== 'granted' && (
              <p className="text-tertiary">
                System notifications are blocked for this site, so alerts will only appear inside
                the app. Allow notifications in your browser settings to get them on your lock
                screen.
              </p>
            )}
            <p className="text-tertiary">
              Alerts fire while the wallet is open — it has no server watching your addresses.
            </p>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Data</h3>
            <button
              type="button"
              className="settings-row"
              onClick={onExportCsv}
              disabled={csvNetworks.length === 0}
            >
              <span className="settings-row-with-icon">
                <IconDownload size={16} />
                Export transactions (CSV)
              </span>
              <span className="settings-row-hint">
                {csvExportHint(csvNetworks)}
              </span>
            </button>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Network mode</h3>
            <div className="settings-mode-row">
              <ModeToggle mode={mode} onChange={onRequestModeChange} />
              <p className="text-tertiary">
                Practice uses worthless test networks. Real moves actual money.
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Account paths</h3>
            <p className="text-tertiary">
              Each chain rotates fresh receive and change addresses under one HD account. Restore
              this phrase in any standard wallet at these account paths and every address comes
              back.
            </p>
            <ul className="path-list">
              {Object.values(CHAINS).map((c) => (
                <li key={c.id} className="path-row">
                  <span>{c.name}</span>
                  <span className="mono text-secondary">{c.accountPath}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">About</h3>
            <p className="text-tertiary">
              Kailah Wallet is a self-custody hobby build: keys are generated and stored only on
              this device, encrypted with your password. Standard HD accounts with fresh addresses
              per chain, no servers of its own. Keep amounts small and your phrase on paper.
            </p>
          </section>
        </div>
      )}

      {view === 'reveal' && (
        <div className="stack">
          <button
            type="button"
            className="btn btn-ghost btn-small self-start"
            onClick={() => {
              hidePhrase()
              setView('main')
            }}
          >
            <IconBack size={16} />
            Back
          </button>

          {phrase === null ? (
            <form className="stack" onSubmit={handleReveal} noValidate>
              <p className="text-secondary">
                Enter your password to reveal the 12 words that control this wallet.
              </p>
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  className="input"
                  value={revealPassword}
                  onChange={(e) => setRevealPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={revealBusy}
                />
              </label>
              {revealError && (
                <p className="form-error" role="alert">
                  {revealError}
                </p>
              )}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={revealBusy || revealPassword === ''}
              >
                {revealBusy ? 'Checking…' : 'Reveal phrase'}
              </button>
            </form>
          ) : (
            <div className="stack">
              <div className="warning-box" role="alert">
                <IconWarning size={20} />
                <div>
                  <strong>Anyone with these words controls the money.</strong>
                  <p>Never share them or type them into a website.</p>
                </div>
              </div>
              <WordGrid
                words={phrase.split(' ')}
                revealed={phraseShown}
                onReveal={() => setPhraseShown(true)}
              />
              <p className="text-tertiary" aria-live="polite">
                Hides automatically in {secondsLeft}s.
              </p>
              <button type="button" className="btn btn-secondary" onClick={hidePhrase}>
                Hide now
              </button>
            </div>
          )}
        </div>
      )}

      {view === 'erase' && (
        <div className="stack">
          <button
            type="button"
            className="btn btn-ghost btn-small self-start"
            onClick={() => setView('main')}
          >
            <IconBack size={16} />
            Back
          </button>
          {hwRecords.length > 0 && (
            <p className="text-secondary">
              Your Ledger accounts are removed from this browser too. The Ledger and the coins it
              holds are not affected — add the accounts again from the device any time.
            </p>
          )}
          <EraseForm
            onCancel={() => setView('main')}
            onConfirm={() => {
              closeAll()
              onErase()
            }}
          />
        </div>
      )}
    </Modal>
  )
}
