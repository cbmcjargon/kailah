// Which networks the dashboard shows — and therefore which ones get scanned
// and polled at all. A hidden network costs no provider requests (DOGE's
// BlockCypher budget is the one that matters), fires no payment alerts and
// stays out of the portfolio total. Coins that arrive on a hidden network
// stay hidden until the user shows it again; nothing moves or is lost.
//
// The choice is made over the nine real-mode networks. Practice mode mirrors
// it: a test network shows when its real twin does. Hardware accounts are not
// governed here (they are an explicit add, removed under Hardware wallets).
//
// Storage: the list of shown networks says which chains this wallet uses, so
// it lives in the encrypted secure store ('netprefs' → kailah.sec.netprefs):
// ciphertext while locked, keyed to this seed (another wallet's blob never
// decrypts, so each wallet keeps its own choice), cleared by erase with every
// other kailah.sec.* blob.
//
// No stored choice means "undecided": every network shows, exactly as before
// this feature. A brand-new wallet decides at once (DEFAULT_SHOWN). An
// existing or restored wallet decides after its first real-mode scan of all
// nine (decideShown): the defaults plus every network with funds or history,
// plus every network whose scan could not tell — never hide funds the user
// already holds.
//
// Engines: the EVM, Solana and TRON code are chunks of their own
// (src/engines), and an engine whose every network is hidden in the current
// mode is never loaded at all (engineShown) — no chunk, no key derived. This
// module only names chain ids, so it pulls no engine into the shell or App
// chunk; check-netprefs.mjs proves the ids and labels match the engines.

import type { AccountState, NetMode } from './types'
import type { EvmChainId, EvmUiState } from './evm'
import type { SolChainId, SolUiState } from './sol'
import type { TronChainId, TronUiState } from './tron'
import { secureGet, secureSet } from './securestore'

export type RealNetworkId =
  | 'btc'
  | 'doge'
  | 'ltc'
  | 'base'
  | 'ethereum'
  | 'arbitrum'
  | 'bnb'
  | 'sol'
  | 'tron'

/** Every real-mode network, in dashboard order. */
export const REAL_NETWORKS: readonly RealNetworkId[] = [
  'btc',
  'doge',
  'ltc',
  'base',
  'ethereum',
  'arbitrum',
  'bnb',
  'sol',
  'tron',
]

/** A new wallet starts with Bitcoin plus one stablecoin network. */
export const DEFAULT_SHOWN: readonly RealNetworkId[] = ['btc', 'base']

/** Practice network → the real network whose choice it mirrors. */
export const PRACTICE_TWINS: Readonly<Record<string, RealNetworkId>> = {
  'btc-testnet': 'btc',
  'base-sepolia': 'base',
  'sol-devnet': 'sol',
  'tron-nile': 'tron',
}

/** Every network of a mode, any engine, in dashboard order. */
export function networksForMode(mode: NetMode): readonly string[] {
  return mode === 'real' ? REAL_NETWORKS : Object.keys(PRACTICE_TWINS)
}

/** Settings' row for each real network: name, brand color, the assets its card shows. */
export const NETWORK_LABELS: Readonly<Record<RealNetworkId, { name: string; color: string; assets: string }>> = {
  btc: { name: 'Bitcoin', color: '#f7931a', assets: 'BTC' },
  doge: { name: 'Dogecoin', color: '#cba135', assets: 'DOGE' },
  ltc: { name: 'Litecoin', color: '#345d9d', assets: 'LTC' },
  base: { name: 'Base', color: '#0052ff', assets: 'USDC · ETH' },
  ethereum: { name: 'Ethereum', color: '#627eea', assets: 'USDC · ETH' },
  arbitrum: { name: 'Arbitrum', color: '#28a0f0', assets: 'USDC · ETH' },
  bnb: { name: 'BNB Chain', color: '#F0B90B', assets: 'BNB · USDC' },
  sol: { name: 'Solana', color: '#9945ff', assets: 'SOL · USDC' },
  tron: { name: 'TRON', color: '#ff0013', assets: 'TRX · USDT' },
}

export type ChunkEngine = 'evm' | 'sol' | 'tron'

/** The networks each engine chunk serves, by mode. */
export const ENGINE_NETWORKS: Readonly<Record<ChunkEngine, Readonly<Record<NetMode, readonly string[]>>>> = {
  evm: { real: ['base', 'ethereum', 'arbitrum', 'bnb'], practice: ['base-sepolia'] },
  sol: { real: ['sol'], practice: ['sol-devnet'] },
  tron: { real: ['tron'], practice: ['tron-nile'] },
}

/**
 * Should this engine's chunk load? Only when at least one network it serves
 * shows in this mode. (Undecided shows everything, so every engine loads.)
 */
export function engineShown(prefs: NetworkPrefs | null, engine: ChunkEngine, mode: NetMode): boolean {
  return ENGINE_NETWORKS[engine][mode].some((id) => isNetworkShown(prefs, id))
}

export interface NetworkPrefs {
  v: 1
  /** real-mode networks shown, in REAL_NETWORKS order; never empty */
  shown: RealNetworkId[]
}

const NAME = 'netprefs'

export function isRealNetworkId(id: string): id is RealNetworkId {
  return (REAL_NETWORKS as readonly string[]).includes(id)
}

/** The stored choice, or null when this wallet hasn't decided (or the blob is bad). */
export function loadNetworkPrefs(): NetworkPrefs | null {
  const v = secureGet(NAME) as Partial<NetworkPrefs> | undefined
  if (v === undefined || v === null || typeof v !== 'object' || v.v !== 1) return null
  if (!Array.isArray(v.shown)) return null
  const shown = REAL_NETWORKS.filter((id) => (v.shown as unknown[]).includes(id))
  // a bad record must never hide anything: undecided shows every network
  return shown.length > 0 ? { v: 1, shown } : null
}

/** Persist a choice (normalized to dashboard order) and return it. Throws on an empty list. */
export function saveNetworkPrefs(shown: Iterable<RealNetworkId>): NetworkPrefs {
  const set = new Set(shown)
  const prefs: NetworkPrefs = { v: 1, shown: REAL_NETWORKS.filter((id) => set.has(id)) }
  if (prefs.shown.length === 0) throw new Error('At least one network stays shown.')
  secureSet(NAME, prefs)
  return prefs
}

/**
 * Is this chain (any engine's id, real or practice) on the dashboard? Practice
 * networks mirror their real twin; when no shown network has a practice twin,
 * practice shows all of them rather than an empty dashboard.
 */
export function isNetworkShown(prefs: NetworkPrefs | null, id: string): boolean {
  if (prefs === null) return true
  const twin = PRACTICE_TWINS[id]
  if (twin === undefined) return isRealNetworkId(id) && prefs.shown.includes(id)
  return (
    prefs.shown.includes(twin) ||
    !Object.values(PRACTICE_TWINS).some((t) => prefs.shown.includes(t))
  )
}

// ---------------------------------------------------------------------------
// What a scan said about one network, for the undecided wallet's first pick
// and for the "this one holds funds" check before hiding.
//
//   funded  — a balance of any asset the card shows (or a stake account, or
//             staked or unstaking TRX)
//   used    — no balance, but history (a used address, an activated TRON
//             account)
//   unused  — the scan completed: zero everywhere, no history
//   unknown — the scan failed or was partial, or a history, token or stake
//             lookup failed; can't tell, so it stays shown
//   pending — no answer yet

export type NetworkActivity = 'funded' | 'used' | 'unused' | 'unknown' | 'pending'

/** The UTXO engine's per-slot UI state (components/ui.ts ChainUiState). */
interface UtxoSlice {
  account: AccountState | null
  loading: boolean
  error: string | null
}

export function utxoActivity(s: UtxoSlice | undefined): NetworkActivity {
  if (s === undefined || s.loading) return 'pending'
  const a = s.account
  if (a === null) return s.error !== null ? 'unknown' : 'pending'
  if (a.balance.confirmed + a.balance.unconfirmed > 0n) return 'funded'
  if (a.incomplete?.balance === true) return 'unknown'
  // a used address is history even when its transactions didn't load (BM8)
  if (a.txs.length > 0 || a.addresses.some((x) => x.used)) return 'used'
  return s.error !== null ? 'unknown' : 'unused'
}

export function evmActivity(s: EvmUiState | undefined): NetworkActivity {
  if (s === undefined || s.loading) return 'pending'
  if (s.token === null || s.gas === null) return s.error !== null ? 'unknown' : 'pending'
  if (s.token > 0n || s.gas > 0n || s.others.some((t) => t.balance > 0n)) return 'funded'
  if (s.txs.length > 0) return 'used'
  // a history or token lookup that failed can't say "nothing here" (BM8)
  if (s.lookupFailed === true) return 'unknown'
  return s.error !== null ? 'unknown' : 'unused'
}

export function solActivity(s: SolUiState | undefined): NetworkActivity {
  if (s === undefined || s.loading) return 'pending'
  if (s.balance === null) return s.error !== null ? 'unknown' : 'pending'
  if (s.balance > 0n || (s.usdcBalance ?? 0n) > 0n || s.stakeAccounts.length > 0) return 'funded'
  // the USDC lookup is separate and may fail on its own (usdcBalance stays null)
  if (s.usdcBalance === null) return 'unknown'
  if (s.txs.length > 0) return 'used'
  // nor can a history or stake lookup that failed (BM8)
  if (s.lookupFailed === true) return 'unknown'
  return s.error !== null ? 'unknown' : 'unused'
}

export function tronActivity(s: TronUiState | undefined): NetworkActivity {
  if (s === undefined || s.loading) return 'pending'
  if (s.balance === null) return s.error !== null ? 'unknown' : 'pending'
  // staked or unstaking TRX is the holder's (BM8)
  if (s.balance > 0n || (s.usdtBalance ?? 0n) > 0n || (s.staked ?? 0n) > 0n) return 'funded'
  if (s.usdtBalance === null) return 'unknown'
  // an account that exists on chain has history, listed or not: only a
  // transaction activates one (staking and votes aren't listed)
  if (s.txs.length > 0 || s.activated === true) return 'used'
  return s.error !== null ? 'unknown' : 'unused'
}

/**
 * Every real network's activity from the four engines' UI state. An engine
 * whose chunk failed to load can't answer: its networks are 'unknown' (kept).
 */
export function realNetworkActivity(
  states: {
    utxo: Readonly<Record<string, UtxoSlice | undefined>>
    evm: Readonly<Partial<Record<EvmChainId, EvmUiState>>>
    sol: Readonly<Partial<Record<SolChainId, SolUiState>>>
    tron: Readonly<Partial<Record<TronChainId, TronUiState>>>
  },
  failed: Readonly<Partial<Record<ChunkEngine, boolean>>> = {},
): Record<RealNetworkId, NetworkActivity> {
  const evm = (s: EvmUiState | undefined) => (failed.evm === true ? 'unknown' : evmActivity(s))
  return {
    btc: utxoActivity(states.utxo.btc),
    doge: utxoActivity(states.utxo.doge),
    ltc: utxoActivity(states.utxo.ltc),
    base: evm(states.evm.base),
    ethereum: evm(states.evm.ethereum),
    arbitrum: evm(states.evm.arbitrum),
    bnb: evm(states.evm.bnb),
    sol: failed.sol === true ? 'unknown' : solActivity(states.sol.sol),
    tron: failed.tron === true ? 'unknown' : tronActivity(states.tron.tron),
  }
}

/**
 * An undecided wallet's pick once every network has answered: the defaults,
 * every network with funds or history, and every one that couldn't tell.
 * Null while any network is still pending.
 */
export function decideShown(
  activity: Readonly<Record<RealNetworkId, NetworkActivity>>,
): RealNetworkId[] | null {
  if (REAL_NETWORKS.some((id) => activity[id] === 'pending')) return null
  return REAL_NETWORKS.filter((id) => DEFAULT_SHOWN.includes(id) || activity[id] !== 'unused')
}
