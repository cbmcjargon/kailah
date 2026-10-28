// The app shell: welcome, onboarding and lock screens, and the session
// lifecycle (unlock, lock, auto-lock, erase). Everything behind the lock
// screen is App.tsx, a chunk of its own fetched when an unlock starts, and the
// onboarding flows are chunks too — so the first screen waits only for React
// and this file, never for a chain engine (src/engines).
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { clearSecureStore, lockSecureStore, unlockSecureStore } from './lib/securestore'
import { clearTipCache } from './lib/scanner'
import { clearStateCache } from './lib/statecache'
import { clearAll as clearAddrCache } from './lib/addrcache'
import { forgetLedgerDevices } from './lib/ledger/transport'
import { hasVault, clearVault, VAULT_STORAGE_KEY } from './lib/vault'
import { clearProviderPref } from './lib/providerpref'
import { disableBiometric } from './lib/biometric'
import { setNotifyPref } from './lib/notify'
import type { WalletSession } from './App'
import Welcome from './components/Welcome'
import LockScreen from './components/LockScreen'
import ChunkBoundary, { reloadPage } from './components/ChunkBoundary'
import { LogoMark, Spinner } from './components/Icons'
import {
  MODE_STORAGE_KEY,
  REAL_ACK_STORAGE_KEY,
  STORAGE_NUDGE_KEY,
  storageGet,
  storageRemove,
  storageSet,
} from './components/ui'

type VaultUiState = 'none' | 'locked' | 'unlocked'
type OnboardScreen = 'welcome' | 'create' | 'restore'

const AUTO_LOCK_MS = 15 * 60 * 1000

const loadApp = () => import('./App')
const App = lazy(loadApp)
const CreateFlow = lazy(() => import('./components/CreateFlow'))
const RestoreFlow = lazy(() => import('./components/RestoreFlow'))

/** Fetch the wallet chunk while the vault opens (the key derivation takes a moment anyway). */
function preloadApp(): void {
  // a failure resurfaces, with a way out, when the wallet renders
  loadApp().catch(() => undefined)
}

/**
 * Ends the Ledger session, if any. The Ledger code is its own chunk, pulled in
 * by the hardware-account modals; a session can only exist after it has run,
 * and then this import resolves from memory. If it never loaded (or cannot
 * load, offline) there is no session to close.
 */
function closeLedgerSession(): Promise<void> {
  return import('./lib/ledger').then(
    (ledger) => ledger.closeLedgerSession(),
    () => undefined,
  )
}

// The scan caches are encrypted under a seed-derived key: open them before
// anything reads them. A failure here must never keep the user out — the
// caches just come up empty and a cold scan runs.
async function openCaches(m: string): Promise<void> {
  try {
    await unlockSecureStore(m)
  } catch {
    lockSecureStore()
  }
}

export default function Shell() {
  const [vaultState, setVaultState] = useState<VaultUiState>(() =>
    hasVault() ? 'locked' : 'none',
  )
  const [screen, setScreen] = useState<OnboardScreen>('welcome')
  // Secrets live only here (until lock/erase) and in the unlocked wallet's
  // derived keys — never in storage.
  const [mnemonic, setMnemonic] = useState<string | null>(null)

  // The unlocked wallet's handle on its own secrets: wipe() zeroes every key
  // it derived. Null while its chunk loads (no keys exist yet) and once locked.
  const sessionRef = useRef<WalletSession | null>(null)
  // Every key the wallet derives, recorded as it is derived (App): zeroed on
  // lock, erase, and a render error, even one before the wallet first mounted
  // (whose unmount wipe never runs; review 2026-10-28).
  const derivedKeysRef = useRef(new Set<{ zero: () => void }>())
  const zeroDerived = useCallback(() => {
    for (const k of derivedKeysRef.current) k.zero()
    derivedKeysRef.current = new Set()
  }, [])
  // Erase starts a new epoch; an unlock that began before it opens nothing
  // (the erased wallet reopened when its slow unlock finished after the
  // erase; bug audit 2026-10-27, BL40).
  const eraseEpochRef = useRef(0)
  const unlockEpochRef = useRef(0)

  // ---- lock / erase --------------------------------------------------------
  const lock = useCallback(() => {
    sessionRef.current?.wipe()
    zeroDerived()
    void closeLedgerSession()
    lockSecureStore()
    setMnemonic(null)
    setVaultState('locked')
  }, [])

  const erase = useCallback(() => {
    eraseEpochRef.current += 1
    clearVault()
    disableBiometric()
    // The address map is xpub-keyed and would otherwise reveal the erased
    // wallet's full derivation + on-chain history to later device inspection.
    clearAddrCache()
    clearTipCache()
    clearProviderPref()
    clearStateCache()
    // every kailah.sec.* blob, the networks-shown choice (netprefs) included
    clearSecureStore()
    setNotifyPref(false)
    sessionRef.current?.wipe()
    zeroDerived()
    // Hardware accounts: their records went with clearSecureStore(); drop the
    // device handle and this origin's permission to every granted Ledger.
    void closeLedgerSession().then(() => forgetLedgerDevices())
    storageRemove(MODE_STORAGE_KEY)
    storageRemove(REAL_ACK_STORAGE_KEY)
    storageRemove(STORAGE_NUDGE_KEY)
    setMnemonic(null)
    setVaultState('none')
    setScreen('welcome')
  }, [])

  // ---- another window of the wallet erased or replaced it -----------------
  // Several windows share one storage. If another erases the wallet, this
  // one must not keep its keys and go on writing the erased wallet's caches
  // back; if the vault was replaced, this window's keys belong to the old
  // one. Lock (bug audit 2026-10-27, BM11). If another sets one up while
  // this window has none open, this one shows its lock screen: its welcome
  // screen's Create or Restore would have saved over it (review 2026-10-28;
  // createVault refuses that too).
  const mnemonicRef = useRef(mnemonic)
  mnemonicRef.current = mnemonic
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== VAULT_STORAGE_KEY) return
      if (!hasVault()) {
        sessionRef.current?.wipe()
        zeroDerived()
        void closeLedgerSession()
        lockSecureStore()
        setMnemonic(null)
        setVaultState('none')
        setScreen('welcome')
        return
      }
      if (e.key === VAULT_STORAGE_KEY && e.oldValue !== null && e.newValue !== e.oldValue) lock()
      else if (e.key === VAULT_STORAGE_KEY && e.oldValue === null && mnemonicRef.current === null) {
        setVaultState('locked')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [lock])

  // ---- auto-lock after 15 min without pointer / key / touch activity -------
  // Runs for the whole unlocked state, including while the wallet chunk loads.
  useEffect(() => {
    if (vaultState !== 'unlocked') return
    let lastActivity = Date.now()
    // A backgrounded PWA's timers don't run, so an overdue lock must win any
    // race on resume: the first tap after hours away locks instead of
    // resetting the idle clock, and becoming visible checks immediately.
    const overdue = () => Date.now() - lastActivity >= AUTO_LOCK_MS
    const bump = () => {
      if (overdue()) {
        lock()
        return
      }
      lastActivity = Date.now()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && overdue()) lock()
    }
    const events: (keyof WindowEventMap)[] = [
      'pointerdown',
      'pointermove',
      'keydown',
      'touchstart',
    ]
    for (const ev of events) window.addEventListener(ev, bump, { passive: true })
    document.addEventListener('visibilitychange', onVisible)
    const iv = window.setInterval(() => {
      if (overdue()) lock()
    }, 10_000)
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(iv)
    }
  }, [vaultState, lock])

  // ---- onboarding completion -----------------------------------------------
  // The wallet reads its network mode from storage when it opens.
  const handleCreated = useCallback(async (m: string) => {
    storageSet(MODE_STORAGE_KEY, 'practice') // practice by default for brand-new wallets
    await openCaches(m)
    // A fresh seed has no funds or history anywhere: its networks are decided
    // at once (lib/netprefs.ts), before the wallet mounts and picks which
    // engines to load. A restore stays undecided until it has looked. The
    // module comes with the wallet chunk, keeping it off the welcome screen;
    // if it can't load, the wallet can't either, and undecided shows all.
    try {
      const { saveNetworkPrefs, DEFAULT_SHOWN } = await import('./lib/netprefs')
      saveNetworkPrefs(DEFAULT_SHOWN)
    } catch {
      // undecided: every network shows
    }
    setMnemonic(m)
    setVaultState('unlocked')
  }, [])

  const handleRestored = useCallback(async (m: string) => {
    if (storageGet(MODE_STORAGE_KEY) === null) storageSet(MODE_STORAGE_KEY, 'practice')
    await openCaches(m)
    setMnemonic(m)
    setVaultState('unlocked')
  }, [])

  const handleUnlocked = useCallback(async (m: string) => {
    const epoch = unlockEpochRef.current
    const erased = () => epoch !== eraseEpochRef.current || !hasVault()
    if (erased()) return
    await openCaches(m)
    if (erased()) {
      lockSecureStore()
      return
    }
    setMnemonic(m)
    setVaultState('unlocked')
  }, [])
  const handleUnlockStart = useCallback(() => {
    unlockEpochRef.current = eraseEpochRef.current
    preloadApp()
  }, [])

  // ---- render --------------------------------------------------------------
  if (vaultState === 'none') {
    if (screen === 'create' || screen === 'restore') {
      const back = (
        <button type="button" className="btn btn-ghost" onClick={() => setScreen('welcome')}>
          Back
        </button>
      )
      return (
        <ChunkBoundary fallback={<ChunkScreen failed action={back} />}>
          <Suspense fallback={<ChunkScreen failed={false} action={back} />}>
            {screen === 'create' ? (
              <CreateFlow onComplete={handleCreated} onBack={() => setScreen('welcome')} />
            ) : (
              <RestoreFlow onComplete={handleRestored} onBack={() => setScreen('welcome')} />
            )}
          </Suspense>
        </ChunkBoundary>
      )
    }
    return (
      <Welcome
        onCreate={() => {
          preloadApp()
          setScreen('create')
        }}
        onRestore={() => {
          preloadApp()
          setScreen('restore')
        }}
      />
    )
  }

  if (vaultState === 'locked' || mnemonic === null) {
    return <LockScreen onUnlockStart={handleUnlockStart} onUnlocked={handleUnlocked} onErase={erase} />
  }

  const lockButton = (
    <button type="button" className="btn btn-ghost" onClick={lock}>
      Lock
    </button>
  )
  return (
    <ChunkBoundary fallback={<ChunkScreen failed action={lockButton} />} onError={zeroDerived}>
      <Suspense fallback={<ChunkScreen failed={false} action={lockButton} />}>
        <App mnemonic={mnemonic} sessionRef={sessionRef} derivedKeys={derivedKeysRef.current} onLock={lock} onErase={erase} />
      </Suspense>
    </ChunkBoundary>
  )
}

/** Full-screen state while a screen's chunk loads, or after it failed to. */
function ChunkScreen({ failed, action }: { failed: boolean; action: ReactNode }) {
  return (
    <div className="onboard-screen lock-screen">
      <div className="onboard-hero">
        <LogoMark size={56} />
        <h1 className="onboard-title">Kailah Wallet</h1>
      </div>
      {failed ? (
        <div className="stack">
          <p className="form-error" role="alert">
            This screen didn’t load. Check your connection, then reload the page — nothing in your
            wallet changes.
          </p>
          <button type="button" className="btn btn-primary" onClick={reloadPage}>
            Reload
          </button>
          {action}
        </div>
      ) : (
        <div className="stack">
          <div className="modal-state" role="status" aria-label="Loading">
            <Spinner size={28} />
          </div>
          {action}
        </div>
      )}
    </div>
  )
}
