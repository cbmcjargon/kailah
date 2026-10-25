// The unlocked wallet, loaded as its own chunk once the vault opens: the
// shell (Shell.tsx) renders the welcome, onboarding and lock screens without
// it and owns the session lifecycle. The UTXO stack ships in this chunk; the
// EVM, Solana and TRON engines each arrive as further chunks when the
// dashboard first renders their cards (src/engines).
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import type {
  AccountKeys,
  ChainConfig,
  ChainId,
  HardwareAccountKeys,
  HardwareAccountRecord,
  NetMode,
  PricePoint,
  WatchAccountKeys,
} from './lib/types'
import { CHAINS, chainsForMode } from './lib/networks'
import { deriveAccount } from './lib/keys'
import { scanAccount } from './lib/scanner'
import {
  forgetStateSnapshot,
  loadStateSnapshot,
  saveStateSnapshot,
  snapshotMatchesAccount,
} from './lib/statecache'
import { forget as forgetAddrCache } from './lib/addrcache'
import {
  hardwareAccount,
  hardwareSlotKey,
  loadHardwareRecords,
  saveHardwareRecords,
} from './lib/hwaccount'
import type { EvmChainConfig, EvmChainId, EvmKey, EvmUiState } from './lib/evm'
import { formatEvmAmount } from './lib/units'

import { txsToCsv } from './lib/csvexport'
import { getClient } from './lib/api'
import { fetchPrices, fetchPriceHistory } from './lib/prices'
import { formatCoin } from './lib/format'
import { biometricAvailable, disableBiometric, enrollBiometric, hasBiometricVault } from './lib/biometric'
import { IS_EXTENSION } from './platform'
import {
  notificationPermission,
  notifyPrefEnabled,
  requestNotificationPermission,
  setNotifyPref,
  showSystemNotification,
} from './lib/notify'
import type { TronChainConfig, TronChainId, TronKey, TronUiState } from './lib/tron'
import type { SolChainConfig, SolChainId, SolKey, SolUiState } from './lib/sol'
import { loadEvm, loadSol, loadTron, useEngine } from './engines'
import {
  decideShown,
  engineShown,
  isNetworkShown,
  loadNetworkPrefs,
  networksForMode,
  REAL_NETWORKS,
  realNetworkActivity,
  saveNetworkPrefs,
  type NetworkPrefs,
  type RealNetworkId,
} from './lib/netprefs'
import Toasts, { type ToastItem } from './components/Toast'
import Dashboard from './components/Dashboard'
import SettingsModal from './components/SettingsModal'
import RealModeConfirm from './components/RealModeConfirm'
import ChunkBoundary, { ModalFailed, ModalPending } from './components/ChunkBoundary'
import {
  downloadTextFile,
  errMessage,
  initialChainStates,
  MODE_STORAGE_KEY, STORAGE_NUDGE_KEY,
  REAL_ACK_STORAGE_KEY,
  storageGet,
  storageSet,
  yyyymmdd,
  type ChainStates,
} from './components/ui'

// Ledger import: the device protocols are their own chunk, fetched when it opens.
const HardwareImportModal = lazy(() => import('./components/HardwareImportModal'))

/** A slot never scanned yet (a just-added hardware account has no initial entry). */
const EMPTY_SLOT = { account: null, loading: false, error: null }
const PRICE_REFRESH_MS = 60 * 1000
const PRICE_SYMBOLS = [
  ...Object.values(CHAINS).flatMap((c) => (c.priceSymbol !== undefined ? [c.priceSymbol] : [])),
  'USDC',
  'ETH',
  'BNB',
  'SOL',
  'TRX',
  'USDT',
]

// Engine state starts empty and is seeded with every chain of the engine when
// its chunk loads (useEngine's onLoad), before anything can read it.
const initialSolStates = (chains: Record<SolChainId, SolChainConfig>): Record<SolChainId, SolUiState> => {
  const out = {} as Record<SolChainId, SolUiState>
  for (const id of Object.keys(chains) as SolChainId[]) {
    out[id] = {
      balance: null,
      usdcBalance: null,
      stakeAccounts: [],
      txs: [],
      loading: false,
      error: null,
    }
  }
  return out
}

const initialTronStates = (chains: Record<TronChainId, TronChainConfig>): Record<TronChainId, TronUiState> => {
  const out = {} as Record<TronChainId, TronUiState>
  for (const id of Object.keys(chains) as TronChainId[]) {
    out[id] = { balance: null, usdtBalance: null, txs: [], loading: false, error: null }
  }
  return out
}

const initialEvmStates = (chains: Record<EvmChainId, EvmChainConfig>): Record<EvmChainId, EvmUiState> => {
  const out = {} as Record<EvmChainId, EvmUiState>
  for (const id of Object.keys(chains) as EvmChainId[]) {
    out[id] = { token: null, gas: null, others: [], txs: [], loading: false, error: null }
  }
  return out
}

/** The chains of a list that the dashboard shows — the only ones ever scanned or polled. */
function shownIn<T extends { id: string }>(chains: readonly T[], prefs: NetworkPrefs | null): T[] {
  return chains.filter((c) => isNetworkShown(prefs, c.id))
}

function readStoredMode(): NetMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'real' ? 'real' : 'practice'
  } catch {
    return 'practice'
  }
}

/** The shell's handle on an unlocked session (Shell.tsx calls it on lock and erase). */
export interface WalletSession {
  /** zero every key this session derived and orphan every in-flight scan */
  wipe: () => void
}

interface AppProps {
  mnemonic: string
  sessionRef: Ref<WalletSession>
  onLock: () => void
  onErase: () => void
}

export default function App({ mnemonic, sessionRef, onLock, onErase }: AppProps) {
  const [mode, setMode] = useState<NetMode>(readStoredMode)
  const [chainStates, setChainStates] = useState<ChainStates>(initialChainStates)
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  // the dashboard's "N networks hidden — show" opens Settings at that section
  const [settingsSection, setSettingsSection] = useState<'networks' | null>(null)
  const [realConfirmOpen, setRealConfirmOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [bioAvailable, setBioAvailable] = useState(false)
  const [bioEnrolled, setBioEnrolled] = useState(hasBiometricVault)
  const [notifyEnabled, setNotifyEnabled] = useState(notifyPrefEnabled)
  const [notifyPermission, setNotifyPermission] = useState(notificationPermission)

  useEffect(() => {
    let alive = true
    void biometricAvailable().then((ok) => {
      if (alive) setBioAvailable(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  const toastSeqRef = useRef(0)
  const pushToast = useCallback((title: string, body: string) => {
    const id = ++toastSeqRef.current
    setToasts((t) => [...t.slice(-3), { id, title, body }])
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, 7000)
  }, [])

  const notifyEnabledRef = useRef(notifyEnabled)
  notifyEnabledRef.current = notifyEnabled

  // Derive HD accounts for ALL chains once per unlock so mode switching is
  // instant. Secrets live only in this memo (zeroed on lock/erase) + the
  // shell's mnemonic state — never in storage.
  const accounts = useMemo<Record<ChainId, AccountKeys>>(() => {
    const out = {} as Record<ChainId, AccountKeys>
    for (const chain of Object.values(CHAINS)) out[chain.id] = deriveAccount(mnemonic, chain)
    return out
  }, [mnemonic])

  const accountsRef = useRef(accounts)
  accountsRef.current = accounts

  // Hardware (Ledger) accounts: public records from the encrypted store
  // (opened by the shell before this mounts), loaded on unlock, dropped on
  // lock. docs/hardware-signing.md §5.
  const [hwRecords, setHwRecords] = useState<HardwareAccountRecord[]>(loadHardwareRecords)
  const hwRecordsRef = useRef(hwRecords)
  hwRecordsRef.current = hwRecords
  const hwAccounts = useMemo<HardwareAccountKeys[]>(() => {
    const out: HardwareAccountKeys[] = []
    for (const r of hwRecords) {
      try {
        out.push(hardwareAccount(r))
      } catch {
        // invalid records never reach the screen (load already filters them)
      }
    }
    return out
  }, [hwRecords])
  const hwAccountsRef = useRef(hwAccounts)
  hwAccountsRef.current = hwAccounts
  const [hwImportOpen, setHwImportOpen] = useState(false)

  // Networks shown (lib/netprefs.ts), from the encrypted store the shell
  // opened before this mounted. null = undecided: every network shows. Scan
  // loops read the ref, so a toggle never re-polls the other networks.
  const [netPrefs, setNetPrefs] = useState<NetworkPrefs | null>(loadNetworkPrefs)
  const netPrefsRef = useRef(netPrefs)
  netPrefsRef.current = netPrefs

  // The EVM, Solana and TRON engines are chunks of their own (src/engines),
  // requested as this first renders — but only an engine with a network shown
  // in this mode: one whose networks are all hidden is never fetched and
  // never derives a key, until one of them is shown. Each key is derived once
  // its engine has loaded; until then (or if it can't load) its cards show a
  // placeholder. The refs give the stable refresh callbacks below the loaded
  // library.
  const [evmStates, setEvmStates] = useState(() => ({}) as Record<EvmChainId, EvmUiState>)
  const evm = useEngine(
    loadEvm,
    (lib) => setEvmStates(initialEvmStates(lib.EVM_CHAINS)),
    engineShown(netPrefs, 'evm', mode),
  )
  const evmRef = useRef(evm.lib)
  evmRef.current = evm.lib
  const [solStates, setSolStates] = useState(() => ({}) as Record<SolChainId, SolUiState>)
  const sol = useEngine(
    loadSol,
    (lib) => setSolStates(initialSolStates(lib.SOL_CHAINS)),
    engineShown(netPrefs, 'sol', mode),
  )
  const solRef = useRef(sol.lib)
  solRef.current = sol.lib
  const [tronStates, setTronStates] = useState(() => ({}) as Record<TronChainId, TronUiState>)
  const tron = useEngine(
    loadTron,
    (lib) => setTronStates(initialTronStates(lib.TRON_CHAINS)),
    engineShown(netPrefs, 'tron', mode),
  )
  const tronRef = useRef(tron.lib)
  tronRef.current = tron.lib

  // One Ethereum-style key per seed for the USDC-on-Base engine.
  const evmKey = useMemo<EvmKey | null>(
    () => (evm.lib === null ? null : evm.lib.deriveEvmKey(mnemonic)),
    [evm.lib, mnemonic],
  )
  const evmKeyRef = useRef(evmKey)
  evmKeyRef.current = evmKey

  const evmStatesRef = useRef(evmStates)
  evmStatesRef.current = evmStates
  const evmSeqRef = useRef<Partial<Record<EvmChainId, number>>>({})

  // One ed25519 key per seed for the Solana engine (Phantom-standard path).
  const solKey = useMemo<SolKey | null>(
    () => (sol.lib === null ? null : sol.lib.deriveSolKey(mnemonic)),
    [sol.lib, mnemonic],
  )
  const solKeyRef = useRef(solKey)
  solKeyRef.current = solKey

  const solStatesRef = useRef(solStates)
  solStatesRef.current = solStates
  const solSeqRef = useRef<Partial<Record<SolChainId, number>>>({})

  // One secp256k1 key per seed for the TRON engine (TronLink-standard path).
  const tronKey = useMemo<TronKey | null>(
    () => (tron.lib === null ? null : tron.lib.deriveTronKey(mnemonic)),
    [tron.lib, mnemonic],
  )
  const tronKeyRef = useRef(tronKey)
  tronKeyRef.current = tronKey

  const tronStatesRef = useRef(tronStates)
  tronStatesRef.current = tronStates
  const tronSeqRef = useRef<Partial<Record<TronChainId, number>>>({})

  // Latest scanned state, so stable callbacks (CSV export) can read it.
  const chainStatesRef = useRef(chainStates)
  chainStatesRef.current = chainStates

  const modeRef = useRef(mode)
  modeRef.current = mode

  // ---- account scans -------------------------------------------------------
  // Monotonic per-chain sequence numbers: a resolution only lands if it is
  // still the newest scan for that chain, so a slow stale response can't
  // overwrite a fresher one, and nothing writes after lock/erase (which
  // advance the map, orphaning every in-flight scan).
  const balanceSeqRef = useRef<Partial<Record<string, number>>>({})
  // last known total (confirmed + pending) per chain, for received-coin alerts
  const lastTotalsRef = useRef<Partial<Record<string, bigint>>>({})
  // manual refresh pressed while a scan was in flight → run a real scan after
  const pendingManualScanRef = useRef<Partial<Record<string, boolean>>>({})
  // stable self-reference so the finally-handler can relaunch without a
  // stale-closure copy of the callback
  const refreshSlotRef = useRef<((key: string) => void) | null>(null)
  // scanning is heavier than a balance call — never overlap scans per chain
  const scanInFlightRef = useRef<Partial<Record<string, boolean>>>({})
  // Set when a manual refresh piggybacks on an in-flight silent scan, so that
  // scan's failure is surfaced instead of staying quiet.
  const escalatedRef = useRef<Partial<Record<string, boolean>>>({})

  // Orphans every in-flight scan by advancing (never resetting) the per-chain
  // sequence numbers — a reset would let a pre-lock response reuse a fresh
  // session's sequence number and land after re-unlock.
  const orphanBalanceFetches = useCallback(() => {
    // every UTXO slot: the seed chains plus any hardware account ever scanned
    for (const id of new Set([...Object.keys(CHAINS), ...Object.keys(balanceSeqRef.current)])) {
      balanceSeqRef.current[id] = (balanceSeqRef.current[id] ?? 0) + 1
    }
    // engine chains: every one ever refreshed (only those can have a fetch in flight)
    for (const id of Object.keys(evmSeqRef.current) as EvmChainId[]) {
      evmSeqRef.current[id] = (evmSeqRef.current[id] ?? 0) + 1
    }
    for (const id of Object.keys(solSeqRef.current) as SolChainId[]) {
      solSeqRef.current[id] = (solSeqRef.current[id] ?? 0) + 1
    }
    for (const id of Object.keys(tronSeqRef.current) as TronChainId[]) {
      tronSeqRef.current[id] = (tronSeqRef.current[id] ?? 0) + 1
    }
    scanInFlightRef.current = {}
    escalatedRef.current = {}
    pendingManualScanRef.current = {}
  }, [])

  // One UTXO account's scan, by slot key: a ChainId for the seed account,
  // 'hw:<id>' for a hardware account. Same quick-mode, snapshot and alert
  // rules for both; the slot only decides which public keys get scanned.
  const resolveSlot = useCallback(
    (key: string): { chain: ChainConfig; account: WatchAccountKeys; label: string } | null => {
      if (key in CHAINS) {
        const chain = CHAINS[key as ChainId]
        const account = accountsRef.current?.[chain.id]
        return account === undefined ? null : { chain, account, label: chain.name }
      }
      const hw = hwAccountsRef.current.find((a) => hardwareSlotKey(a.record) === key)
      if (hw === undefined) return null
      const chain = CHAINS[hw.chain]
      return { chain, account: hw, label: `${chain.name} · Ledger` }
    },
    [],
  )

  const refreshSlot = useCallback(
    (key: string, opts?: { silent?: boolean; quick?: boolean }) => {
      const slot = resolveSlot(key)
      if (slot === null) return
      const { chain, account, label } = slot
      // Don't overlap scans for the same chain (protects the BlockCypher free
      // tier). A manual press during an in-flight scan shows a spinner and,
      // instead of being absorbed (a quick background poll may conclude
      // "unchanged" and deliver nothing, which read as "refresh does not
      // work"), queues a real full scan to run the moment the current one
      // settles. Silent polls never queue — they just skip.
      if (scanInFlightRef.current[key] === true) {
        if (opts?.silent !== true) {
          escalatedRef.current[key] = true
          pendingManualScanRef.current[key] = true
          setChainStates((s) => ({
            ...s,
            [key]: { ...(s[key] ?? EMPTY_SLOT), loading: true, error: null },
          }))
        }
        return
      }
      scanInFlightRef.current[key] = true
      const seq = (balanceSeqRef.current[key] ?? 0) + 1
      balanceSeqRef.current[key] = seq
      const isCurrent = () => balanceSeqRef.current[key] === seq
      if (opts?.silent !== true) {
        setChainStates((s) => ({
          ...s,
          [key]: { ...(s[key] ?? EMPTY_SLOT), loading: true, error: null },
        }))
      }
      // Background polls run in quick mode: a cheap change check that reuses
      // the previous state when nothing moved (critical for the DOGE budget).
      // A restored SNAPSHOT (incomplete.utxos) is display-only: it lacks the
      // utxos/raw txs that power Speed-up, and a quick pass that says
      // "unchanged" would keep it forever — which is exactly wrong for a
      // stuck tx (its balance never changes until it confirms; live bug:
      // the Speed up button vanished after unlock). Esplora chains are cheap,
      // so they take the full scan and get their data back; only DOGE keeps
      // the snapshot shortcut — BlockCypher's budget matters there, and DOGE
      // has no RBF, so nothing bumpable is ever lost.
      const baseline = chainStatesRef.current[key]?.account ?? undefined
      const snapshotOnly = baseline?.incomplete?.utxos === true
      const budgetChain = chain.providers[0]?.kind === 'blockcypher'
      const prevAccount =
        opts?.quick === true && baseline !== undefined && (!snapshotOnly || budgetChain)
          ? baseline
          : undefined
      scanAccount(account, getClient(chain), prevAccount !== undefined ? { quickCheckAgainst: prevAccount } : undefined)
        .then((state) => {
          if (!isCurrent()) return
          // A scan that couldn't reach every funded address may report a total
          // that is too low; don't record it or fire a "received" alert, or the
          // next healthy scan's rebound reads as fake incoming money.
          if (state.incomplete?.balance === true) {
            setChainStates((s) => ({
              ...s,
              [key]: { account: state, loading: false, error: null },
            }))
            return
          }
          const total = state.balance.confirmed + state.balance.unconfirmed
          const prev = lastTotalsRef.current[key]
          lastTotalsRef.current[key] = total
          if (prev !== undefined && total > prev) {
            const msg = `Received ${formatCoin(total - prev, chain.decimals)} ${chain.ticker}`
            pushToast(label, msg)
            // The OS notification stays generic on purpose — it can surface on a
            // locked screen, so the exact amount lives only in the in-app toast.
            if (notifyEnabledRef.current) {
              void showSystemNotification('Kailah Wallet', `You received ${chain.ticker} — open the app to view`)
            }
          }
          escalatedRef.current[key] = false
          saveStateSnapshot(key, state)
          setChainStates((s) => ({
            ...s,
            [key]: { account: state, loading: false, error: null },
          }))
        })
        .catch((e: unknown) => {
          if (!isCurrent()) return
          const escalated = escalatedRef.current[key] === true
          escalatedRef.current[key] = false
          if (opts?.silent === true && !escalated) {
            // Background poll failures stay quiet, but never leave a spinner
            // stranded: a silent poll may have superseded a manual refresh.
            setChainStates((s) =>
              s[key]?.loading ? { ...s, [key]: { ...(s[key] ?? EMPTY_SLOT), loading: false } } : s,
            )
            return
          }
          setChainStates((s) => ({
            ...s,
            [key]: { ...(s[key] ?? EMPTY_SLOT), loading: false, error: errMessage(e) },
          }))
        })
        .finally(() => {
          // Only release the guard for the CURRENT session. An orphaned pre-lock
          // scan settling after re-unlock must not clear the fresh session's
          // guard object (lock/erase installs a new one via orphanBalanceFetches).
          if (isCurrent()) {
            scanInFlightRef.current[key] = false
            // A manual refresh arrived mid-scan: honor it now with a real
            // (non-quick) scan so the user's tap always produces fresh data.
            if (pendingManualScanRef.current[key] === true) {
              pendingManualScanRef.current[key] = false
              refreshSlotRef.current?.(key)
            }
          }
        })
    },
    [pushToast, resolveSlot],
  )
  refreshSlotRef.current = refreshSlot

  const refreshChain = useCallback(
    (chain: ChainConfig, opts?: { silent?: boolean; quick?: boolean }) => refreshSlot(chain.id, opts),
    [refreshSlot],
  )
  const refreshHw = useCallback(
    (account: HardwareAccountKeys, opts?: { silent?: boolean; quick?: boolean }) =>
      refreshSlot(hardwareSlotKey(account.record), opts),
    [refreshSlot],
  )

  // ---- EVM (USDC on Base) refresh ------------------------------------------
  const refreshEvm = useCallback(
    (chain: EvmChainConfig, opts?: { silent?: boolean; quick?: boolean }) => {
      const lib = evmRef.current
      const key = evmKeyRef.current
      if (lib === null || key === null) return
      const seq = (evmSeqRef.current[chain.id] ?? 0) + 1
      evmSeqRef.current[chain.id] = seq
      const isCurrent = () => evmSeqRef.current[chain.id] === seq
      if (opts?.silent !== true) {
        setEvmStates((s) => ({
          ...s,
          [chain.id]: { ...s[chain.id], loading: true, error: null },
        }))
      }
      lib.getEvmBalances(chain, key.address)
        .then(async (b) => {
          if (!isCurrent()) return
          const prev = evmStatesRef.current[chain.id]
          const changed = prev.token !== b.token || prev.gas !== b.gas
          if (prev.token !== null && b.token > prev.token) {
            const msg = `Received ${formatEvmAmount(b.token - prev.token, chain.token.decimals)} ${chain.token.symbol}`
            pushToast(chain.name, msg)
            if (notifyEnabledRef.current) {
              void showSystemNotification(
                'Kailah Wallet',
                `You received ${chain.token.symbol} — open the app to view`,
              )
            }
          }
          // Quick + unchanged → keep the current history (no extra requests).
          let txs = prev.txs
          let others = prev.others
          if (opts?.quick !== true || changed || prev.txs.length === 0) {
            const [txsRes, othersRes] = await Promise.allSettled([
              lib.fetchEvmHistory(chain, key.address),
              lib.fetchDetectedTokens(chain, key.address),
            ])
            // both are best-effort; balances stand on their own
            if (txsRes.status === 'fulfilled') txs = txsRes.value
            if (othersRes.status === 'fulfilled') others = othersRes.value
          }
          if (!isCurrent()) return
          setEvmStates((s) => ({
            ...s,
            [chain.id]: { token: b.token, gas: b.gas, others, txs, loading: false, error: null },
          }))
        })
        .catch((e: unknown) => {
          if (!isCurrent()) return
          setEvmStates((s) => ({
            ...s,
            [chain.id]: {
              ...s[chain.id],
              loading: false,
              error: opts?.silent === true ? s[chain.id].error : errMessage(e),
            },
          }))
        })
    },
    [pushToast],
  )

  // ---- Solana refresh ------------------------------------------------------
  const refreshSol = useCallback(
    (chain: SolChainConfig, opts?: { silent?: boolean; quick?: boolean }) => {
      const lib = solRef.current
      const key = solKeyRef.current
      if (lib === null || key === null) return
      const seq = (solSeqRef.current[chain.id] ?? 0) + 1
      solSeqRef.current[chain.id] = seq
      const isCurrent = () => solSeqRef.current[chain.id] === seq
      if (opts?.silent !== true) {
        setSolStates((s) => ({
          ...s,
          [chain.id]: { ...s[chain.id], loading: true, error: null },
        }))
      }
      Promise.all([
        lib.getSolBalance(chain, key.address),
        lib.getSolUsdcBalance(chain, key.address).catch(() => null),
      ])
        .then(async ([balance, usdcBalance]) => {
          if (!isCurrent()) return
          const prev = solStatesRef.current[chain.id]
          const changed =
            prev.balance !== balance || (usdcBalance !== null && prev.usdcBalance !== usdcBalance)
          if (prev.balance !== null && balance > prev.balance) {
            const msg = `Received ${lib.formatSol(balance - prev.balance)} SOL`
            pushToast(chain.name, msg)
            if (notifyEnabledRef.current) {
              void showSystemNotification('Kailah Wallet', 'You received SOL — open the app to view')
            }
          }
          if (
            prev.usdcBalance !== null &&
            usdcBalance !== null &&
            usdcBalance > prev.usdcBalance
          ) {
            const msg = `Received ${lib.formatSolUsdc(chain, usdcBalance - prev.usdcBalance)} USDC`
            pushToast(chain.name, msg)
            if (notifyEnabledRef.current) {
              void showSystemNotification('Kailah Wallet', 'You received USDC — open the app to view')
            }
          }
          let txs = prev.txs
          let stakeAccounts = prev.stakeAccounts
          if (opts?.quick !== true || changed || prev.txs.length === 0) {
            const [txsRes, stakeRes] = await Promise.allSettled([
              lib.fetchSolHistory(chain, key.address),
              lib.fetchStakeAccounts(chain, key.address),
            ])
            // both are best-effort; balances stand on their own
            if (txsRes.status === 'fulfilled') txs = txsRes.value
            if (stakeRes.status === 'fulfilled') stakeAccounts = stakeRes.value
          }
          if (!isCurrent()) return
          setSolStates((s) => ({
            ...s,
            [chain.id]: {
              balance,
              usdcBalance: usdcBalance ?? s[chain.id].usdcBalance,
              stakeAccounts,
              txs,
              loading: false,
              error: null,
            },
          }))
        })
        .catch((e: unknown) => {
          if (!isCurrent()) return
          setSolStates((s) => ({
            ...s,
            [chain.id]: {
              ...s[chain.id],
              loading: false,
              error: opts?.silent === true ? s[chain.id].error : errMessage(e),
            },
          }))
        })
    },
    [pushToast],
  )

  // ---- TRON refresh --------------------------------------------------------
  const refreshTron = useCallback(
    (chain: TronChainConfig, opts?: { silent?: boolean; quick?: boolean }) => {
      const lib = tronRef.current
      const key = tronKeyRef.current
      if (lib === null || key === null) return
      const seq = (tronSeqRef.current[chain.id] ?? 0) + 1
      tronSeqRef.current[chain.id] = seq
      const isCurrent = () => tronSeqRef.current[chain.id] === seq
      if (opts?.silent !== true) {
        setTronStates((s) => ({
          ...s,
          [chain.id]: { ...s[chain.id], loading: true, error: null },
        }))
      }
      Promise.all([
        lib.getTronBalance(chain, key.address),
        lib.getTronUsdtBalance(chain, key.address).catch(() => null),
      ])
        .then(async ([balance, usdtBalance]) => {
          if (!isCurrent()) return
          const prev = tronStatesRef.current[chain.id]
          const changed =
            prev.balance !== balance || (usdtBalance !== null && prev.usdtBalance !== usdtBalance)
          if (prev.balance !== null && balance > prev.balance) {
            pushToast(chain.name, `Received ${lib.formatTron(balance - prev.balance)} TRX`)
            if (notifyEnabledRef.current) {
              void showSystemNotification('Kailah Wallet', 'You received TRX — open the app to view')
            }
          }
          if (prev.usdtBalance !== null && usdtBalance !== null && usdtBalance > prev.usdtBalance) {
            pushToast(chain.name, `Received ${lib.formatTronUsdt(chain, usdtBalance - prev.usdtBalance)} USDT`)
            if (notifyEnabledRef.current) {
              void showSystemNotification('Kailah Wallet', 'You received USDT — open the app to view')
            }
          }
          let txs = prev.txs
          if (opts?.quick !== true || changed || prev.txs.length === 0) {
            try {
              txs = await lib.fetchTronHistory(chain, key.address)
            } catch {
              // history is best-effort
            }
          }
          if (!isCurrent()) return
          setTronStates((s) => ({
            ...s,
            [chain.id]: {
              balance,
              usdtBalance: usdtBalance ?? s[chain.id].usdtBalance,
              txs,
              loading: false,
              error: null,
            },
          }))
        })
        .catch((e: unknown) => {
          if (!isCurrent()) return
          setTronStates((s) => ({
            ...s,
            [chain.id]: {
              ...s[chain.id],
              loading: false,
              error: opts?.silent === true ? s[chain.id].error : errMessage(e),
            },
          }))
        })
    },
    [pushToast],
  )

  const refreshAll = useCallback(() => {
    const prefs = netPrefsRef.current
    for (const chain of shownIn(chainsForMode(modeRef.current), prefs)) refreshChain(chain)
    // Ledger accounts always show — the chooser governs the seed networks only
    for (const hw of hwAccountsRef.current) {
      if (chainsForMode(modeRef.current).some((c) => c.id === hw.chain)) refreshHw(hw)
    }
    for (const chain of shownIn(evmRef.current?.evmChainsForMode(modeRef.current) ?? [], prefs)) refreshEvm(chain)
    for (const chain of shownIn(solRef.current?.solChainsForMode(modeRef.current) ?? [], prefs)) refreshSol(chain)
    for (const chain of shownIn(tronRef.current?.tronChainsForMode(modeRef.current) ?? [], prefs)) refreshTron(chain)
  }, [refreshChain, refreshHw, refreshEvm, refreshSol, refreshTron])

  // A UTXO chain's first scan of the session (unlock, mode change, unhide):
  // hydrate from the persisted snapshot first — balances render instantly
  // and the follow-up scan runs in quick mode (a handful of requests,
  // critical for DOGE's hourly BlockCypher budget; the scanner escalates to a
  // full walk on its own when the quick pass detects a change).
  const startChain = useCallback(
    (chain: ChainConfig) => {
      const account = accountsRef.current[chain.id]
      let hasSnapshot = chainStatesRef.current[chain.id]?.account != null
      if (!hasSnapshot) {
        const snap = loadStateSnapshot(chain.id)
        // Only hydrate a snapshot whose every address re-derives from this
        // wallet's keys — a tampered or foreign-wallet snapshot is discarded.
        if (snap !== null && snapshotMatchesAccount(snap, account)) {
          hasSnapshot = true
          // Write the ref synchronously too: refreshChain reads its quick-mode
          // baseline through the ref in this same tick, before React re-renders.
          chainStatesRef.current = {
            ...chainStatesRef.current,
            [chain.id]: { account: snap, loading: false, error: null },
          }
          setChainStates((s) => ({
            ...s,
            [chain.id]: { account: snap, loading: false, error: null },
          }))
        }
      }
      refreshChain(chain, hasSnapshot ? { quick: true } : undefined)
    },
    [refreshChain],
  )

  // scan the shown UTXO networks on unlock and on mode change. Hidden ones
  // are never scanned; showing one starts its own refresh
  // (handleSetNetworkShown), so the choice is read through the ref here.
  useEffect(() => {
    for (const chain of shownIn(chainsForMode(mode), netPrefsRef.current)) startChain(chain)
  }, [mode, accounts, startChain])

  // Each engine's shown accounts scan as soon as its chunk has loaded (that
  // is when its key appears), and again on mode change — never re-polling
  // the UTXO chains when an engine lands. An engine first loaded by showing
  // one of its networks lands here too.
  useEffect(() => {
    if (evm.lib === null || evmKey === null) return
    for (const chain of shownIn(evm.lib.evmChainsForMode(mode), netPrefsRef.current)) refreshEvm(chain)
  }, [mode, evm.lib, evmKey, refreshEvm])
  useEffect(() => {
    if (sol.lib === null || solKey === null) return
    for (const chain of shownIn(sol.lib.solChainsForMode(mode), netPrefsRef.current)) refreshSol(chain)
  }, [mode, sol.lib, solKey, refreshSol])
  useEffect(() => {
    if (tron.lib === null || tronKey === null) return
    for (const chain of shownIn(tron.lib.tronChainsForMode(mode), netPrefsRef.current)) refreshTron(chain)
  }, [mode, tron.lib, tronKey, refreshTron])

  // An undecided wallet (one that predates the chooser, or a restore) picks
  // its networks once its first real-mode scan of all nine has answered:
  // the defaults plus every network with funds or history, plus any whose
  // scan couldn't tell (an engine that failed to load counts as that).
  // Never hides funds the user already holds.
  useEffect(() => {
    if (mode !== 'real' || netPrefs !== null) return
    const shown = decideShown(
      realNetworkActivity(
        { utxo: chainStates, evm: evmStates, sol: solStates, tron: tronStates },
        { evm: evm.failed, sol: sol.failed, tron: tron.failed },
      ),
    )
    if (shown === null || netPrefsRef.current !== null) return
    const prefs = saveNetworkPrefs(shown)
    netPrefsRef.current = prefs
    setNetPrefs(prefs)
    const hidden = REAL_NETWORKS.length - prefs.shown.length
    if (hidden > 0) {
      pushToast(
        'Networks',
        `${hidden} ${hidden === 1 ? 'network with no funds or history is' : 'networks with no funds or history are'} now hidden and not checked. Show ${hidden === 1 ? 'it' : 'them'} any time in Settings › Networks shown.`,
      )
    }
  }, [
    mode,
    netPrefs,
    chainStates,
    evmStates,
    solStates,
    tronStates,
    evm.failed,
    sol.failed,
    tron.failed,
    pushToast,
  ])

  // Hardware accounts get their own effect: adding or removing one must not
  // re-poll every other chain (DOGE's BlockCypher budget).
  useEffect(() => {
    // This mode's chains only: same snapshot-then-quick rule,
    // their snapshots keyed by slot, validated against their own public keys.
    for (const hw of hwAccounts) {
      if (!chainsForMode(mode).some((c) => c.id === hw.chain)) continue
      const key = hardwareSlotKey(hw.record)
      let hasSnapshot = chainStatesRef.current[key]?.account != null
      if (!hasSnapshot) {
        const snap = loadStateSnapshot(key)
        if (snap !== null && snapshotMatchesAccount(snap, hw)) {
          hasSnapshot = true
          chainStatesRef.current = { ...chainStatesRef.current, [key]: { account: snap, loading: false, error: null } }
          setChainStates((s) => ({ ...s, [key]: { account: snap, loading: false, error: null } }))
        }
      }
      refreshHw(hw, hasSnapshot ? { quick: true } : undefined)
    }
  }, [mode, hwAccounts, refreshHw])

  // background polling while unlocked, so received coins surface as alerts.
  // BlockCypher (DOGE) polls slower to stay far inside its free-tier limits.
  useEffect(() => {
    // hidden networks are not polled at all (DOGE's budget, every provider's quota)
    const poll = (kind: 'esplora' | 'blockcypher') => {
      for (const chain of shownIn(chainsForMode(modeRef.current), netPrefsRef.current)) {
        if (chain.providers[0]?.kind === kind) refreshChain(chain, { silent: true, quick: true })
      }
      // hardware accounts are BTC/LTC only — esplora, the fast cadence
      if (kind === 'esplora') {
        for (const hw of hwAccountsRef.current) {
          if (chainsForMode(modeRef.current).some((c) => c.id === hw.chain)) {
            refreshHw(hw, { silent: true, quick: true })
          }
        }
      }
    }
    // engines whose chunk hasn't loaded yet have nothing to poll
    const pollEvm = () => {
      const prefs = netPrefsRef.current
      for (const chain of shownIn(evmRef.current?.evmChainsForMode(modeRef.current) ?? [], prefs)) {
        refreshEvm(chain, { silent: true, quick: true })
      }
      for (const chain of shownIn(solRef.current?.solChainsForMode(modeRef.current) ?? [], prefs)) {
        refreshSol(chain, { silent: true, quick: true })
      }
      for (const chain of shownIn(tronRef.current?.tronChainsForMode(modeRef.current) ?? [], prefs)) {
        refreshTron(chain, { silent: true, quick: true })
      }
    }
    const fast = window.setInterval(() => {
      poll('esplora')
      pollEvm()
    }, 60_000)
    // DOGE: 10-minute quick polls keep steady-state usage around two dozen
    // requests/hour — far inside BlockCypher's ~100/hour free tier.
    const slow = window.setInterval(() => poll('blockcypher'), 600_000)
    return () => {
      window.clearInterval(fast)
      window.clearInterval(slow)
    }
  }, [refreshChain, refreshHw, refreshEvm, refreshSol, refreshTron])

  // ---- prices: on unlock + every 60s while unlocked ------------------------
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchPrices(PRICE_SYMBOLS)
        .then((p) => {
          if (!cancelled) setPrices((prev) => ({ ...prev, ...p }))
        })
        .catch(() => {
          /* keep last known prices */
        })
    }
    load()
    const iv = window.setInterval(load, PRICE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
  }, [])

  // ---- 7-day price history for sparklines: fetched once per unlock ----------
  useEffect(() => {
    let cancelled = false
    for (const symbol of PRICE_SYMBOLS) {
      fetchPriceHistory(symbol)
        .then((pts) => {
          if (!cancelled) setPriceHistory((prev) => ({ ...prev, [symbol]: pts }))
        })
        .catch(() => {
          /* sparkline renders empty on failure */
        })
    }
    return () => {
      cancelled = true
    }
  }, [])

  // ---- end of session ------------------------------------------------------
  // The shell (Shell.tsx) locks and erases. It calls wipe() first: every key
  // this session derived is zeroed and every in-flight scan orphaned, so
  // nothing lands after the vault closes; the rest of this state unmounts.
  // An engine never loaded (all its networks hidden) never derived a key:
  // its ref is null and there is nothing to zero.
  const wipe = useCallback(() => {
    for (const acc of Object.values(accountsRef.current)) acc.zero()
    evmKeyRef.current?.zero()
    solKeyRef.current?.zero()
    tronKeyRef.current?.zero()
    for (const hw of hwAccountsRef.current) hw.zero()
    orphanBalanceFetches()
    lastTotalsRef.current = {}
  }, [orphanBalanceFetches])
  useImperativeHandle(sessionRef, () => ({ wipe }), [wipe])

  // ---- persistent storage ------------------------------------------------
  // The vault is only as durable as the browser lets it be: without a
  // persistence grant, Safari in particular may evict a site's storage after
  // a week or so of not opening it. Nothing is stolen (it's ciphertext), but
  // a user who never wrote their words down would be locked out for good.
  // Ask once per unlock; if the browser declines (or lacks the API), nudge.
  const [storageNudge, setStorageNudge] = useState(false)
  useEffect(() => {
    // The extension holds "unlimitedStorage", which exempts its storage from
    // eviction; persist() still reports false there, so the nudge (and its
    // home-screen advice) would be wrong.
    if (IS_EXTENSION) return
    if (storageGet(STORAGE_NUDGE_KEY) === '1') return
    let cancelled = false
    const check = async () => {
      try {
        const sm = navigator.storage
        if (sm === undefined || typeof sm.persist !== 'function') {
          if (!cancelled) setStorageNudge(true)
          return
        }
        const already = typeof sm.persisted === 'function' ? await sm.persisted() : false
        const granted = already || (await sm.persist())
        if (!cancelled) setStorageNudge(!granted)
      } catch {
        if (!cancelled) setStorageNudge(true)
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [])
  const dismissStorageNudge = useCallback(() => {
    storageSet(STORAGE_NUDGE_KEY, '1')
    setStorageNudge(false)
  }, [])

  // ---- mode switching ------------------------------------------------------
  const applyMode = useCallback((next: NetMode) => {
    setMode(next)
    storageSet(MODE_STORAGE_KEY, next)
  }, [])

  const requestModeChange = useCallback(
    (next: NetMode) => {
      if (next === modeRef.current) return
      if (next === 'real' && storageGet(REAL_ACK_STORAGE_KEY) !== '1') {
        setRealConfirmOpen(true)
        return
      }
      applyMode(next)
    },
    [applyMode],
  )

  // ---- biometric + notification settings ----------------------------------
  const mnemonicRef = useRef(mnemonic)
  mnemonicRef.current = mnemonic

  const handleEnableBiometric = useCallback(async () => {
    await enrollBiometric(mnemonicRef.current)
    setBioEnrolled(true)
  }, [])

  const handleDisableBiometric = useCallback(() => {
    disableBiometric()
    setBioEnrolled(false)
  }, [])

  const handleToggleNotify = useCallback(async (on: boolean) => {
    if (on) {
      const permission = await requestNotificationPermission()
      setNotifyPermission(permission)
    }
    setNotifyPref(on)
    setNotifyEnabled(on)
  }, [])

  // ---- networks shown -------------------------------------------------------
  // Hiding just stops scanning and polling (in-flight scans settle unseen).
  // Showing starts a normal refresh of whatever appeared in the current mode —
  // in practice mode that is the test twin, if any. An engine not loaded yet
  // loads now (its `wanted` flips on this render) and its effect above runs
  // the first scan.
  const handleSetNetworkShown = useCallback(
    (id: RealNetworkId, show: boolean) => {
      const before = netPrefsRef.current
      const current = before?.shown ?? REAL_NETWORKS
      const next = show ? [...current, id] : current.filter((x) => x !== id)
      if (next.length === 0) return // at least one network stays shown
      const prefs = saveNetworkPrefs(next)
      netPrefsRef.current = prefs
      setNetPrefs(prefs)
      const m = modeRef.current
      const appeared = (c: { id: string }) =>
        !isNetworkShown(before, c.id) && isNetworkShown(prefs, c.id)
      for (const chain of chainsForMode(m).filter(appeared)) startChain(chain)
      for (const chain of (evmRef.current?.evmChainsForMode(m) ?? []).filter(appeared)) refreshEvm(chain)
      for (const chain of (solRef.current?.solChainsForMode(m) ?? []).filter(appeared)) refreshSol(chain)
      for (const chain of (tronRef.current?.tronChainsForMode(m) ?? []).filter(appeared)) refreshTron(chain)
    },
    [startChain, refreshEvm, refreshSol, refreshTron],
  )

  // ---- hardware accounts: add / remove ------------------------------------
  // Storage writes stay outside state updaters (StrictMode may run those twice).
  const handleHardwareAdded = useCallback((rec: HardwareAccountRecord) => {
    const next = [...hwRecordsRef.current.filter((r) => r.id !== rec.id), rec]
    saveHardwareRecords(next)
    setHwRecords(next)
  }, [])

  const handleHardwareRemove = useCallback((id: string) => {
    const rec = hwRecordsRef.current.find((r) => r.id === id)
    if (rec === undefined) return
    const next = hwRecordsRef.current.filter((r) => r.id !== id)
    saveHardwareRecords(next)
    const key = hardwareSlotKey(rec)
    const acct = hwAccountsRef.current.find((a) => a.record.id === id)
    // its cached view of the chain goes too (public data, but this account's map)
    forgetStateSnapshot(key)
    if (acct !== undefined) forgetAddrCache(acct.xpubs.xpub)
    balanceSeqRef.current[key] = (balanceSeqRef.current[key] ?? 0) + 1
    setChainStates((s) => {
      const copy = { ...s }
      delete copy[key]
      return copy
    })
    setHwRecords(next)
  }, [])

  // ---- CSV export: one combined file for all visible chains with history ----
  // A single download (browsers block multiple downloads from one gesture);
  // each chain is its own labelled section so the tickers stay unambiguous.
  const handleExportCsv = useCallback(() => {
    const stamp = yyyymmdd()
    const sections: string[] = []
    for (const chain of shownIn(chainsForMode(modeRef.current), netPrefsRef.current)) {
      const txs = chainStatesRef.current[chain.id]?.account?.txs ?? []
      if (txs.length === 0) continue
      sections.push(`${chain.name} (${chain.ticker})\n${txsToCsv(chain, txs)}`)
    }
    for (const hw of hwAccountsRef.current) {
      const chain = CHAINS[hw.chain]
      if (!chainsForMode(modeRef.current).some((c) => c.id === chain.id)) continue
      const txs = chainStatesRef.current[hardwareSlotKey(hw.record)]?.account?.txs ?? []
      if (txs.length === 0) continue
      sections.push(`${chain.name} · Ledger (${chain.ticker})\n${txsToCsv(chain, txs)}`)
    }
    if (sections.length === 0) return
    downloadTextFile(`kailah-transactions-${stamp}.csv`, sections.join('\n\n'))
  }, [])

  // ---- render --------------------------------------------------------------
  const modeHwAccounts = hwAccounts.filter((a) => chainsForMode(mode).some((c) => c.id === a.chain))
  const csvAvailable =
    shownIn(chainsForMode(mode), netPrefs).some((c) => (chainStates[c.id]?.account?.txs.length ?? 0) > 0) ||
    modeHwAccounts.some((a) => (chainStates[hardwareSlotKey(a.record)]?.account?.txs.length ?? 0) > 0)

  // counted from netprefs' own id lists: an engine that never loaded has no chain configs here
  const hiddenCount = networksForMode(mode).filter((id) => !isNetworkShown(netPrefs, id)).length
  // real networks known to hold something — hiding one of these takes a second tap
  const realActivity = realNetworkActivity({
    utxo: chainStates,
    evm: evmStates,
    sol: solStates,
    tron: tronStates,
  })
  const fundedNetworks = REAL_NETWORKS.filter((id) => realActivity[id] === 'funded')

  return (
    <>
      <Dashboard
        storageNudge={storageNudge}
        onDismissStorageNudge={dismissStorageNudge}
        mode={mode}
        chains={shownIn(chainsForMode(mode), netPrefs)}
        accounts={accounts}
        hwAccounts={modeHwAccounts}
        chainStates={chainStates}
        evm={evm}
        evmChains={shownIn(evm.lib?.evmChainsForMode(mode) ?? [], netPrefs)}
        evmKey={evmKey}
        evmStates={evmStates}
        sol={sol}
        solChains={shownIn(sol.lib?.solChainsForMode(mode) ?? [], netPrefs)}
        solKey={solKey}
        solStates={solStates}
        tron={tron}
        tronChains={shownIn(tron.lib?.tronChainsForMode(mode) ?? [], netPrefs)}
        tronKey={tronKey}
        tronStates={tronStates}
        hiddenCount={hiddenCount}
        onShowHidden={() => {
          setSettingsSection('networks')
          setSettingsOpen(true)
        }}
        prices={prices}
        priceHistory={priceHistory}
        onRequestModeChange={requestModeChange}
        onRefreshChain={refreshChain}
        onRefreshHw={refreshHw}
        onAddHardware={() => setHwImportOpen(true)}
        onRefreshEvm={refreshEvm}
        onRefreshSol={refreshSol}
        onRefreshTron={refreshTron}
        onRefreshAll={refreshAll}
        onLock={onLock}
        onOpenSettings={() => {
          setSettingsSection(null)
          setSettingsOpen(true)
        }}
      />
      {settingsOpen && (
        <SettingsModal
          mode={mode}
          onRequestModeChange={requestModeChange}
          onLock={onLock}
          onErase={onErase}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
          shownNetworks={netPrefs?.shown ?? REAL_NETWORKS}
          networksDecided={netPrefs !== null}
          fundedNetworks={fundedNetworks}
          onSetNetworkShown={handleSetNetworkShown}
          bioAvailable={bioAvailable}
          bioEnrolled={bioEnrolled}
          onEnableBiometric={handleEnableBiometric}
          onDisableBiometric={handleDisableBiometric}
          notifyEnabled={notifyEnabled}
          notifyPermission={notifyPermission}
          onToggleNotify={handleToggleNotify}
          onExportCsv={handleExportCsv}
          csvAvailable={csvAvailable}
          hwRecords={hwRecords}
          onAddHardware={() => setHwImportOpen(true)}
          onRemoveHardware={handleHardwareRemove}
        />
      )}
      {hwImportOpen && (
        <ChunkBoundary fallback={<ModalFailed onClose={() => setHwImportOpen(false)} />}>
          <Suspense fallback={<ModalPending onClose={() => setHwImportOpen(false)} />}>
            <HardwareImportModal
              mode={mode}
              existing={hwRecords}
              onAdded={handleHardwareAdded}
              onClose={() => setHwImportOpen(false)}
            />
          </Suspense>
        </ChunkBoundary>
      )}
      {realConfirmOpen && (
        <RealModeConfirm
          onConfirm={() => {
            storageSet(REAL_ACK_STORAGE_KEY, '1')
            setRealConfirmOpen(false)
            applyMode('real')
          }}
          onCancel={() => setRealConfirmOpen(false)}
        />
      )}
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </>
  )
}
