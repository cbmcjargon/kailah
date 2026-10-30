// EVM engine for Kailah Wallet: USDC + ETH accounts on Base, Ethereum mainnet
// and Arbitrum One (plus a Base Sepolia practice twin).
//
// Deliberately self-contained and separate from the audited UTXO stack —
// account-based chains share nothing with PSBT/gap-scan logic. Same 12-word
// seed, standard Ethereum path m/44'/60'/0'/0/0, one address per wallet
// (account chains have no address rotation; reuse is the platform norm).
//
// Live-verified groundwork (2026-07-23, from the wallet origin, CORS *):
//   RPCs   https://mainnet.base.org , https://base-rpc.publicnode.com (8453)
//          https://sepolia.base.org (84532)
//   USDC   Base   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
//          Sepolia 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals)
//   History https://base(-sepolia).blockscout.com/api/v2 token-transfers
//
// Money safety: amounts are bigint smallest-units (USDC 6dp, ETH wei);
// transactions are signed locally with an explicit pinned chainId and
// broadcast as raw bytes; the private key is held as bytes we can zero.

import { deriveNodeWiped } from './keys'
import {
  agoText,
  dropPending,
  EarlierSendLanded,
  evmInFlightBlock,
  evmReplacementFloor,
  markPendingFailed,
  recordPending,
  type EvmAttemptStatus,
  type PendingEvm,
} from './pending'
import { recordSentTo } from './sentlog'
import { formatEvmAmount } from './units'
import { bytesToHex } from '@noble/hashes/utils'
import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  getAddress,
  encodeFunctionData,
  type PublicClient,
  type Hex,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Transport,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { NetMode } from './types'

// display helpers shared with the Solana and TRON engines (see units.ts)
export { evmToUsd, formatEvmAmount } from './units'

export type EvmChainId = 'base' | 'base-sepolia' | 'ethereum' | 'arbitrum' | 'bnb'

export interface EvmChainConfig {
  id: EvmChainId
  name: string
  /** short network name used in user-facing copy ("pick the X network") */
  networkName: string
  /** honest per-network fee expectation, shown on the send form */
  feeNote: string
  mainnet: boolean
  chainId: number
  rpcs: string[]
  /** Blockscout API root for history; absent → no keyless explorer API
   *  exists for this chain (BNB) and history/detection are honestly skipped */
  blockscoutBase?: string
  explorerTx: (hash: string) => string
  explorerAddr: (addr: string) => string
  token: {
    address: Hex
    symbol: string
    decimals: number
    /** Coinbase spot symbol for USD display */
    priceSymbol: string
    coingeckoId: string
  }
  gas: { symbol: string; decimals: 18; priceSymbol: string }
  /** show the gas coin as the card's headline asset (BNB) */
  gasPrimary?: boolean
  /**
   * Rollup family, for fees an L1 chain doesn't have: 'op' (Base) charges an
   * L1 data fee on top of gas; 'arbitrum' prices L1 data as extra L2 gas, so
   * even a plain transfer needs more than 21 000 (bug audit 2026-10-27).
   */
  l2?: 'op' | 'arbitrum'
  color: string
  faucets?: { name: string; url: string; note?: string }[]
}

export const EVM_CHAINS: Record<EvmChainId, EvmChainConfig> = {
  base: {
    id: 'base',
    l2: 'op',
    name: 'Base',
    networkName: 'Base',
    feeNote: 'Network fees are paid in ETH on Base — usually well under a cent.',
    mainnet: true,
    chainId: 8453,
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    blockscoutBase: 'https://base.blockscout.com/api/v2',
    explorerTx: (h) => `https://base.blockscout.com/tx/${h}`,
    explorerAddr: (a) => `https://base.blockscout.com/address/${a}`,
    token: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      decimals: 6,
      priceSymbol: 'USDC',
      coingeckoId: 'usd-coin',
    },
    gas: { symbol: 'ETH', decimals: 18, priceSymbol: 'ETH' },
    color: '#0052ff',
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    networkName: 'Ethereum',
    feeNote:
      'Fees are paid in ETH on Ethereum mainnet and can run to several dollars when the network is busy — the exact cost shows before you confirm.',
    mainnet: true,
    chainId: 1,
    // Pocket Network's public gateway replaced cloudflare-eth.com (2026-10-30),
    // which by then answered only eth_chainId: as the second RPC it left
    // Ethereum with no backup and turned the first RPC's clean refusal of a
    // send into "may still go through" (submitEvmTx). Pocket answers every call
    // the wallet makes, passes a node's refusal on in its own words, and allows
    // both sites and the extension. npm run check:health catches the next one.
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.api.pocket.network'],
    blockscoutBase: 'https://eth.blockscout.com/api/v2',
    explorerTx: (h) => `https://eth.blockscout.com/tx/${h}`,
    explorerAddr: (a) => `https://eth.blockscout.com/address/${a}`,
    token: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      priceSymbol: 'USDC',
      coingeckoId: 'usd-coin',
    },
    gas: { symbol: 'ETH', decimals: 18, priceSymbol: 'ETH' },
    color: '#627eea',
  },
  arbitrum: {
    id: 'arbitrum',
    l2: 'arbitrum',
    name: 'Arbitrum',
    networkName: 'Arbitrum One',
    feeNote: 'Network fees are paid in ETH on Arbitrum — typically a fraction of a cent.',
    mainnet: true,
    chainId: 42161,
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    blockscoutBase: 'https://arbitrum.blockscout.com/api/v2',
    explorerTx: (h) => `https://arbitrum.blockscout.com/tx/${h}`,
    explorerAddr: (a) => `https://arbitrum.blockscout.com/address/${a}`,
    token: {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      decimals: 6,
      priceSymbol: 'USDC',
      coingeckoId: 'usd-coin',
    },
    gas: { symbol: 'ETH', decimals: 18, priceSymbol: 'ETH' },
    color: '#28a0f0',
  },
  bnb: {
    id: 'bnb',
    name: 'BNB Chain',
    networkName: 'BNB Smart Chain',
    feeNote: 'Network fees are paid in BNB — typically a cent or two.',
    mainnet: true,
    chainId: 56,
    // live-verified 2026-07-28 from the wallet origin: both CORS *, chainId 0x38
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    // Deliberately no blockscoutBase: BscScan requires API keys and Blockscout
    // does not host BNB Chain — balances/sends are RPC-native, history is
    // honestly absent rather than faked.
    explorerTx: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddr: (a) => `https://bscscan.com/address/${a}`,
    token: {
      // Binance-Peg USDC — live-verified decimals()=18 (unlike 6 elsewhere!)
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      decimals: 18,
      priceSymbol: 'USDC',
      coingeckoId: 'usd-coin',
    },
    gas: { symbol: 'BNB', decimals: 18, priceSymbol: 'BNB' },
    gasPrimary: true,
    color: '#F0B90B',
  },
  'base-sepolia': {
    id: 'base-sepolia',
    l2: 'op',
    name: 'Base (practice)',
    networkName: 'Base Sepolia',
    feeNote: 'Practice network — fees are paid in worthless test ETH.',
    mainnet: false,
    chainId: 84532,
    rpcs: ['https://sepolia.base.org'],
    blockscoutBase: 'https://base-sepolia.blockscout.com/api/v2',
    explorerTx: (h) => `https://base-sepolia.blockscout.com/tx/${h}`,
    explorerAddr: (a) => `https://base-sepolia.blockscout.com/address/${a}`,
    token: {
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      symbol: 'USDC',
      decimals: 6,
      priceSymbol: 'USDC',
      coingeckoId: 'usd-coin',
    },
    gas: { symbol: 'ETH', decimals: 18, priceSymbol: 'ETH' },
    color: '#0052ff',
    faucets: [
      {
        name: 'Circle faucet (test USDC)',
        url: 'https://faucet.circle.com/',
        note: 'pick Base Sepolia; free sign-in required',
      },
      {
        name: 'Base Sepolia ETH faucets',
        url: 'https://docs.base.org/docs/tools/network-faucets/',
        note: 'a little ETH pays the network fee',
      },
    ],
  },
}

export function evmChainsForMode(mode: NetMode): EvmChainConfig[] {
  const all = Object.values(EVM_CHAINS)
  return mode === 'practice' ? all.filter((c) => !c.mainnet) : all.filter((c) => c.mainnet)
}

// ---------------------------------------------------------------------------
// Keys. One Ethereum account per seed at the standard path; the same address
// is used on every EVM chain (that is how account chains work).

export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0"

export interface EvmKey {
  address: Hex
  account: PrivateKeyAccount
  /** wipe the raw private-key bytes (the viem account's inner copy is a JS
   *  string and shares the mnemonic's unzeroable-string caveat) */
  zero: () => void
}

export function deriveEvmKey(mnemonic: string): EvmKey {
  // step-wise derivation: seed, root and intermediates wiped as it goes
  const node = deriveNodeWiped(mnemonic, EVM_DERIVATION_PATH)
  if (!node.privateKey) throw new Error('Could not derive an Ethereum key from this phrase.')
  const pk = node.privateKey
  const account = privateKeyToAccount(`0x${bytesToHex(pk)}` as Hex)
  return {
    address: account.address,
    account,
    zero: () => {
      pk.fill(0)
      node.wipePrivateData()
    },
  }
}

// ---------------------------------------------------------------------------
// RPC client with failover (viem fallback transport).

const clients = new Map<EvmChainId, PublicClient>()

/** RPC deadlines, and how long an RPC that hung is passed over; tests shorten them. */
export const evmTuning = { rpcTimeoutMs: 15_000, rpcDownMs: 60_000, explorerTimeoutMs: 20_000 }
const rpcDownUntil = new Map<string, number>()

/**
 * One RPC of a chain's list. Once it hung or couldn't be reached it is
 * passed over for rpcDownMs while another of the chain's RPCs is available:
 * viem's fallback asks the list in order on every call, and a hanging first
 * RPC cost every call its full timeout (bug audit 2026-10-27, BL22). Passing
 * over throws a plain error, which the fallback answers with the next RPC.
 */
function pausableHttp(url: string, all: readonly string[]): Transport {
  const base = http(url, { timeout: evmTuning.rpcTimeoutMs })
  const live = (u: string) => Date.now() >= (rpcDownUntil.get(u) ?? 0)
  return ((opts) => {
    const t = base(opts)
    const request = async (args: Parameters<typeof t.request>[0]) => {
      if (!live(url) && all.some((u) => u !== url && live(u))) throw new Error('RPC passed over after it hung')
      try {
        return await t.request(args)
      } catch (e) {
        const name = (e as { name?: unknown } | null)?.name
        const status = (e as { status?: unknown } | null)?.status
        if (name === 'TimeoutError' || (name === 'HttpRequestError' && status === undefined)) {
          rpcDownUntil.set(url, Date.now() + evmTuning.rpcDownMs)
        }
        throw e
      }
    }
    return { ...t, request: request as typeof t.request }
  }) as Transport
}

export function getEvmClient(chain: EvmChainConfig): PublicClient {
  const existing = clients.get(chain.id)
  if (existing) return existing
  const client = createPublicClient({
    // No CCIP-read: a hostile detected-token contract could otherwise answer
    // balanceOf with an OffchainLookup revert and have viem fetch an
    // attacker URL (leaking the address). Production CSP blocks it anyway;
    // this keeps dev builds honest too.
    ccipRead: false,
    transport: fallback(
      chain.rpcs.map((url) => pausableHttp(url, chain.rpcs)),
      { rank: false },
    ),
  })
  clients.set(chain.id, client)
  return client
}

/** A gas-limit ceiling for the chain: Arbitrum's gas includes the L1 data, which swings with L1 prices. */
function gasCapFor(chain: EvmChainConfig, cap: bigint): bigint {
  return chain.l2 === 'arbitrum' ? cap * 8n : cap
}

/** OP-stack GasPriceOracle predeploy: the L1 data fee a transaction will pay. */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const GAS_PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getL1FeeUpperBound',
    stateMutability: 'view',
    inputs: [{ name: '_unsignedTxSize', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
/** Unsigned EIP-1559 transaction sizes, generous: a native send and a token transfer. */
const NATIVE_TX_BYTES = 130n
const TOKEN_TX_BYTES = 200n

/**
 * The L1 data fee an OP-stack chain adds to a transaction of this size, with
 * half again as headroom for L1 prices moving before it lands; null when the
 * oracle can't be read. The txpool checks balance ≥ value + gas × fee cap +
 * this, so MAX that left it out was always refused (bug audit 2026-10-27, BM13).
 */
async function opL1FeeWei(client: PublicClient, size: bigint): Promise<bigint | null> {
  try {
    const fee = await client.readContract({
      address: GAS_PRICE_ORACLE,
      abi: GAS_PRICE_ORACLE_ABI,
      functionName: 'getL1FeeUpperBound',
      args: [size],
    })
    return (fee * 3n + 1n) / 2n
  } catch {
    return null
  }
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export interface EvmBalances {
  /** token units (USDC: 6 decimals) */
  token: bigint
  /** wei */
  gas: bigint
}

/** Per-network UI state held by App (null balances = not yet loaded). */
export interface EvmUiState {
  token: bigint | null
  gas: bigint | null
  /** detected custom ERC-20 holdings (sanitized; best-effort) */
  others: DetectedToken[]
  txs: EvmTx[]
  /**
   * The last refresh's history or token lookup failed, so an empty list
   * doesn't mean "nothing here" (bug audit 2026-10-27, BM8)
   */
  lookupFailed?: boolean
  /** the balance above is fresh and its history is still being read: nothing can be concluded yet */
  historyPending?: boolean
  loading: boolean
  error: string | null
}

export async function getEvmBalances(chain: EvmChainConfig, address: Hex): Promise<EvmBalances> {
  const client = getEvmClient(chain)
  const [gas, token] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: chain.token.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ])
  return { token, gas }
}

// ---------------------------------------------------------------------------
// Detected custom tokens. Anyone can airdrop an ERC-20 to any address, and
// scammers do — with token names like "Telegram @…Bot" or fake URLs baiting
// the holder into a phishing site (live-verified on the test address). So:
// symbols are sanitized to a strict charset before display, impostors of the
// pinned USDC are excluded by contract (not by name), custom tokens are never
// priced in USD, and the UI carries a standing warning. Sending one is a
// plain ERC-20 transfer — this wallet never signs approvals.

export interface DetectedToken {
  address: Hex
  /** display-safe symbol; when `unnamed`, show the contract address instead */
  symbol: string
  unnamed: boolean
  decimals: number
  balance: bigint
}

/** Tickers of the wallet's built-in assets; a custom token may not wear one. */
const IMPOSTOR_SYMBOLS = new Set(['USDC', 'USDT', 'ETH', 'BNB', 'WETH', 'USDBC'])

/** Strict allow-list sanitation — anything suspicious becomes "unnamed". */
export function sanitizeTokenSymbol(raw: string | null | undefined): {
  symbol: string
  unnamed: boolean
} {
  const t = (raw ?? '').trim()
  if (
    /^[A-Za-z0-9$._-]{1,10}$/.test(t) &&
    // domain-shaped names ("claim.site") are bait; a single letter after a
    // dot ("USDC.e", the common bridged-token style) is fine
    !/\.[A-Za-z]{2,}$/.test(t) &&
    // a detected token wearing a built-in's ticker is an impostor by
    // definition — the real one is pinned by contract address
    !IMPOSTOR_SYMBOLS.has(t.toUpperCase())
  ) {
    return { symbol: t, unnamed: false }
  }
  return { symbol: 'Unnamed token', unnamed: true }
}

interface BsTokenHolding {
  value?: string
  token?: {
    address?: string | null
    address_hash?: string | null
    symbol?: string | null
    decimals?: string | null
  }
}

const DETECTED_TOKEN_CAP = 12

/**
 * A read from the block explorer, with a deadline. Browsers can wait minutes
 * on a host that accepts a request and never answers, which kept a card
 * loading while Arbitrum's explorer crawled (review 2026-10-30). A lookup
 * that times out reads as any other failed lookup: "couldn't tell" (BM8).
 */
function explorerGet(url: string): Promise<Response> {
  return fetch(url, {
    signal:
      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(evmTuning.explorerTimeoutMs)
        : undefined,
  })
}

export async function fetchDetectedTokens(
  chain: EvmChainConfig,
  address: Hex,
): Promise<DetectedToken[]> {
  if (chain.blockscoutBase === undefined) return []
  const res = await explorerGet(`${chain.blockscoutBase}/addresses/${address}/tokens?type=ERC-20`)
  if (!res.ok) throw new Error(`token detection failed (${res.status})`)
  const body = (await res.json()) as { items?: BsTokenHolding[] }
  const seen = new Set<string>()
  const out: DetectedToken[] = []
  for (const item of body.items ?? []) {
    const rawAddr = item.token?.address_hash ?? item.token?.address ?? ''
    if (!isValidEvmAddress(rawAddr)) continue
    const addr = getAddress(rawAddr)
    const key = addr.toLowerCase()
    if (key === chain.token.address.toLowerCase() || seen.has(key)) continue
    const balance = BigInt(item.value ?? '0')
    if (balance <= 0n) continue
    seen.add(key)
    const dec = Number.parseInt(item.token?.decimals ?? '', 10)
    const { symbol, unnamed } = sanitizeTokenSymbol(item.token?.symbol)
    out.push({
      address: addr,
      symbol,
      unnamed,
      decimals: Number.isFinite(dec) && dec >= 0 && dec <= 36 ? dec : 0,
      balance,
    })
  }
  out.sort((a, b) =>
    a.unnamed !== b.unnamed ? (a.unnamed ? 1 : -1) : a.symbol.localeCompare(b.symbol),
  )
  return out.slice(0, DETECTED_TOKEN_CAP)
}

// ---------------------------------------------------------------------------
// History via Blockscout (keyless, CORS-open). Token transfers + native txs,
// merged newest-first. Failure here never blocks balances — history is
// best-effort and the UI shows what it gets.

export interface EvmTx {
  hash: string
  direction: 'in' | 'out' | 'self'
  /** smallest units of `asset` */
  amount: bigint
  asset: 'token' | 'gas'
  /** set on custom-ERC-20 rows: sanitized symbol + decimals for display */
  tokenSymbol?: string
  tokenDecimals?: number
  time: number | null
  counterparty: string | null
  pending: boolean
  /** the transaction reverted: nothing moved but its fee (bug audit 2026-10-27, BL15) */
  failed?: true
}

interface BsTransferItem {
  transaction_hash?: string
  timestamp?: string | null
  from?: { hash?: string }
  to?: { hash?: string }
  total?: { value?: string; decimals?: string | null }
  /** Blockscout has shipped both spellings across versions */
  token?: { address?: string; address_hash?: string; symbol?: string | null; decimals?: string | null }
}

interface BsTxItem {
  hash?: string
  timestamp?: string | null
  from?: { hash?: string }
  to?: { hash?: string } | null
  value?: string
  status?: string
}

/** a transaction hash as the explorer links expect it; anything else from the API is dropped */
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/

function blockscoutBase(chain: EvmChainConfig): string | undefined {
  return chain.blockscoutBase
}

function toEpoch(ts: string | null | undefined): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** `partial`: one of the explorer's two lists couldn't be read, so rows may be missing. */
export type EvmHistory = EvmTx[] & { partial?: true }

export async function fetchEvmHistory(chain: EvmChainConfig, address: Hex): Promise<EvmHistory> {
  const base = blockscoutBase(chain)
  if (base === undefined) return []
  const me = address.toLowerCase()
  const out: EvmTx[] = []

  const [transfersRes, txsRes] = await Promise.allSettled([
    explorerGet(`${base}/addresses/${address}/token-transfers?type=ERC-20`).then((r) =>
      r.ok ? (r.json() as Promise<{ items?: BsTransferItem[] }>) : Promise.reject(new Error(String(r.status))),
    ),
    explorerGet(`${base}/addresses/${address}/transactions`).then((r) =>
      r.ok ? (r.json() as Promise<{ items?: BsTxItem[] }>) : Promise.reject(new Error(String(r.status))),
    ),
  ])

  if (transfersRes.status === 'fulfilled') {
    for (const t of transfersRes.value.items ?? []) {
      const tokenAddr = (t.token?.address_hash ?? t.token?.address ?? '').toLowerCase()
      const isPinned = tokenAddr === chain.token.address.toLowerCase()
      const from = (t.from?.hash ?? '').toLowerCase()
      const to = (t.to?.hash ?? '').toLowerCase()
      const value = BigInt(t.total?.value ?? '0')
      // the hash becomes an explorer link: only a real 32-byte hash gets through
      if (value === 0n || !t.transaction_hash || !EVM_HASH.test(t.transaction_hash)) continue
      const direction = from === me && to === me ? 'self' : from === me ? 'out' : 'in'
      const row: EvmTx = {
        hash: t.transaction_hash,
        direction,
        amount: direction === 'out' ? -value : value,
        asset: 'token',
        time: toEpoch(t.timestamp),
        counterparty: direction === 'out' ? (t.to?.hash ?? null) : (t.from?.hash ?? null),
        pending: t.timestamp == null,
      }
      if (!isPinned) {
        // Custom-token row: sanitized symbol only (airdrop names are hostile).
        const dec = Number.parseInt(t.total?.decimals ?? t.token?.decimals ?? '', 10)
        row.tokenSymbol = sanitizeTokenSymbol(t.token?.symbol).symbol
        row.tokenDecimals = Number.isFinite(dec) && dec >= 0 && dec <= 36 ? dec : 0
      }
      out.push(row)
    }
  }

  if (txsRes.status === 'fulfilled') {
    for (const t of txsRes.value.items ?? []) {
      const value = BigInt(t.value ?? '0')
      if (value === 0n || !t.hash || !EVM_HASH.test(t.hash)) continue // contract calls (incl. our USDC sends) carry 0 ETH
      const from = (t.from?.hash ?? '').toLowerCase()
      const to = (t.to?.hash ?? '').toLowerCase()
      const direction = from === me && to === me ? 'self' : from === me ? 'out' : 'in'
      // Blockscout's status "error": the transaction reverted, so no value
      // moved (an incoming one never arrived at all)
      const failed = t.status === 'error'
      if (failed && direction === 'in') continue
      out.push({
        hash: t.hash,
        direction,
        amount: direction === 'out' ? -value : value,
        asset: 'gas',
        time: toEpoch(t.timestamp),
        counterparty: direction === 'out' ? (t.to?.hash ?? null) : (t.from?.hash ?? null),
        pending: t.timestamp == null,
        ...(failed && { failed: true as const }),
      })
    }
  }

  // An explorer that couldn't answer leaves no way to tell "no history"
  // from "history unread": say so instead of returning an empty list (bug
  // audit 2026-10-27, BM8: the first network pick hid a used network).
  const partial = transfersRes.status === 'rejected' || txsRes.status === 'rejected'
  if (out.length === 0 && partial) {
    throw new Error(`Couldn't read the ${chain.name} history right now.`)
  }
  out.sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER))
  const rows: EvmHistory = out.slice(0, 100)
  // A list with rows missing is a failed lookup too: the card says so and the
  // next poll tries again, rather than keeping it until the balance moves.
  if (partial) rows.partial = true
  return rows
}

// ---------------------------------------------------------------------------
// Sending. Two phases, mirroring the UTXO modals: prepare (estimate, validate,
// show the user exact costs) then broadcast (sign locally, send raw bytes).

export interface EvmSendArgs {
  chain: EvmChainConfig
  key: EvmKey
  to: string
  /** smallest units of the chosen asset */
  amount: bigint
  asset: 'token' | 'gas'
  /** set to send a detected custom ERC-20 instead of the pinned token */
  customToken?: DetectedToken
  sendMax?: boolean
  /**
   * Nonce of a previous attempt whose broadcast failed ambiguously (a timeout
   * can hide a transaction that actually reached the mempool). Re-signing at
   * the SAME nonce makes the old attempt and the retry mutually exclusive —
   * one replaces the other — so a landed first attempt can never be joined by
   * a second payment. A fresh pending nonce here would do the opposite.
   */
  reuseNonce?: number
}

export interface PreparedEvmSend {
  chain: EvmChainConfig
  asset: 'token' | 'gas'
  /** present when this send moves a custom ERC-20 */
  customToken?: DetectedToken
  to: Hex
  /** the recipient is a contract: tokens sent to one are lost unless it can hold them */
  recipientIsContract: boolean
  amount: bigint
  /** total network fee in wei (gasLimit x maxFeePerGas, the worst case) */
  feeWei: bigint
  request: {
    to: Hex
    value: bigint
    data: Hex | undefined
    gas: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    nonce: number
    chainId: number
  }
}

export function isValidEvmAddress(addr: string): boolean {
  if (!isAddress(addr, { strict: false })) return false
  // A mixed-case address carries an EIP-55 checksum — the ONLY integrity
  // check a 0x address has — so verify it instead of silently re-checksumming
  // a mistyped character into a different (almost certainly unowned) address.
  // All-lowercase / all-uppercase inputs carry no checksum and stay accepted.
  const hexPart = addr.slice(2)
  const mixedCase = /[a-f]/.test(hexPart) && /[A-F]/.test(hexPart)
  return mixedCase ? isAddress(addr, { strict: true }) : true
}

export async function prepareEvmSend(args: EvmSendArgs): Promise<PreparedEvmSend> {
  const { chain, key, asset, customToken } = args
  if (!isValidEvmAddress(args.to)) {
    throw new Error(`"${args.to}" is not a valid address on ${chain.networkName}.`)
  }
  const to = getAddress(args.to)
  const client = getEvmClient(chain)

  const [balances, fees, pendingNonce, minedCount] = await Promise.all([
    getEvmBalances(chain, key.address),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: key.address, blockTag: 'pending' }),
    args.reuseNonce !== undefined ? client.getTransactionCount({ address: key.address, blockTag: 'latest' }) : null,
  ])
  const nonce = args.reuseNonce ?? pendingNonce

  // One send in flight per chain. A recorded attempt still sitting in the
  // mempool means a second send would pay twice; refuse unless this IS the
  // same-nonce retry that replaces it. Unknown-to-the-network attempts are
  // forgotten, confirmed ones dropped.
  const block = await evmInFlightBlock(chain.chainId, args.reuseNonce, (hash) =>
    evmAttemptStatus(chain, hash),
  )
  if (block !== null) {
    const p = block.entry
    const what = `Your send from ${agoText(p.ts)} (to ${p.to.slice(0, 8)}…) on ${chain.networkName}`
    if (block.reason === 'landed') throw new EarlierSendLanded(p, what)
    if (block.reason === 'mined') {
      throw new EvmNonceSettled(`${what} went through after all — there is nothing more to send.`)
    }
    if (block.reason === 'reverted') {
      throw new EvmNonceSettled(
        `${what} reached the network but failed there, so nothing was paid (its network fee was spent). You can start a new send.`,
      )
    }
    if (block.reason === 'pending') throw new EvmSendWaiting(p, what)
    throw new Error(
      `Couldn't check whether your send from ${agoText(p.ts)} (to ${p.to.slice(0, 8)}…) is still waiting on ${chain.networkName}. Try again in a moment — sending without knowing could pay twice.`,
    )
  }
  // A retry re-signs at the earlier attempt's nonce. If the chain has used
  // it already, and no attempt on record read as mined above (another
  // transaction from this account, or a status read that failed), a retry
  // can only be refused with "nonce too low", over and over. Say so and let
  // the form take a fresh nonce; the records stay, so the checks above still
  // guard them (bug audit 2026-10-27, BM14).
  if (args.reuseNonce !== undefined && minedCount !== null && minedCount > args.reuseNonce) {
    throw new EvmNonceSettled(
      `Your earlier send's place in line on ${chain.networkName} has already been used, by that send or by another transaction from this account. Check your history before sending again.`,
    )
  }
  // Headroom on the market fee so a small gas-price move can't strand the tx —
  // then a hard ceiling, because both numbers come from the RPC: without one a
  // tampered fee API could have a MAX send hand nearly the whole balance to
  // the block producer as priority fee. 1000/100 gwei sit far above any honest
  // market on all five chains while bounding a 21k-gas send to ~0.021 ETH.
  const MAX_FEE_PER_GAS = 1_000_000_000_000n // 1000 gwei
  const MAX_PRIORITY_PER_GAS = 100_000_000_000n // 100 gwei
  let rawPriority = fees.maxPriorityFeePerGas
  let rawMax = (fees.maxFeePerGas * 15n) / 10n
  // A same-nonce retry only replaces the earlier attempt if it outbids it;
  // at the market rate a node that holds the first attempt would refuse the
  // second as underpriced, and the two would not be mutually exclusive.
  const floor = args.reuseNonce !== undefined ? evmReplacementFloor(chain.chainId, args.reuseNonce) : null
  if (floor !== null) {
    if (floor.maxFeePerGas > MAX_FEE_PER_GAS || floor.maxPriorityFeePerGas > MAX_PRIORITY_PER_GAS) {
      throw new Error(
        'Replacing the earlier attempt would need a fee above the wallet\u2019s ceiling. Wait for it to confirm or drop out, then send again.',
      )
    }
    if (floor.maxFeePerGas > rawMax) rawMax = floor.maxFeePerGas
    if (floor.maxPriorityFeePerGas > rawPriority) rawPriority = floor.maxPriorityFeePerGas
  }
  const maxFeePerGas = rawMax > MAX_FEE_PER_GAS ? MAX_FEE_PER_GAS : rawMax
  const maxPriorityFeePerGas =
    rawPriority > MAX_PRIORITY_PER_GAS ? MAX_PRIORITY_PER_GAS : rawPriority
  // Tokens handed to a contract are gone unless it was built to hold them;
  // handed to the token's own contract, or to nobody, they always are.
  // A failed lookup is not "no code": the contract warnings and the gas
  // estimate for a contract recipient depend on it (bug audit 2026-10-27,
  // BL20). An EIP-7702 account carries only a delegation (0xef0100 and an
  // address): it has a key behind it, so it is a wallet, not a contract.
  const recipientCode = await client.getCode({ address: to }).catch(() => {
    throw new Error(`Couldn't check the recipient on ${chain.networkName} right now. Try again in a moment.`)
  })
  const recipientHasCode = recipientCode !== undefined && recipientCode !== '0x'
  const recipientIsContract = recipientHasCode && !/^0xef0100[0-9a-f]{40}$/i.test(recipientCode)

  if (asset === 'token') {
    // Custom tokens re-read their live balance from their own contract; the
    // pinned token's balance came with the batch read above.
    const tokenContract = customToken?.address ?? chain.token.address
    const symbol = customToken?.symbol ?? chain.token.symbol
    const decimals = customToken?.decimals ?? chain.token.decimals
    if (to.toLowerCase() === tokenContract.toLowerCase()) {
      throw new Error(
        `That is the ${symbol} token's own contract address, not a wallet. ${symbol} sent there is lost for good.`,
      )
    }
    if (/^0x0{40}$/i.test(to)) {
      throw new Error('That is the zero address. Anything sent there is lost for good.')
    }
    const tokenBalance = customToken
      ? await client.readContract({
          address: tokenContract,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [key.address],
        })
      : balances.token
    const amount = args.sendMax === true ? tokenBalance : args.amount
    if (amount <= 0n) throw new Error('Nothing to send.')
    if (amount > tokenBalance) {
      throw new Error(
        `Insufficient ${symbol}: you have ${formatEvmAmount(tokenBalance, decimals)}.`,
      )
    }
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] })
    let gas: bigint
    try {
      gas = await client.estimateGas({
        account: key.address,
        to: tokenContract,
        data,
      })
    } catch (e) {
      if (customToken) {
        // Plenty of scam airdrops deliberately block transfers so holders
        // visit the scammer's site instead. Say so plainly.
        throw new Error(
          `This token's contract refused the transfer. Some airdropped tokens are ` +
            `deliberately non-transferable scams — if you weren't expecting this token, ignore it.`,
        )
      }
      throw e
    }
    // The estimate is RPC-supplied too; cap it. Honest ERC-20 transfers run
    // ~50-150k gas — a demand beyond 400k is a hostile RPC or a token whose
    // transfer this wallet shouldn't sign blind anyway. Arbitrum counts the
    // L1 data as gas, which can pass 400k while L1 is expensive, so it gets
    // more room (bug audit 2026-10-27, BL21); the fee ceilings still bound
    // what any of it can cost.
    const gasLimit = (gas * 12n) / 10n
    if (gasLimit > gasCapFor(chain, 400_000n)) {
      throw new Error(
        'This transfer demands an unusually large amount of gas — refusing to prepare it.',
      )
    }
    const l1Fee = chain.l2 === 'op' ? ((await opL1FeeWei(client, TOKEN_TX_BYTES)) ?? 0n) : 0n
    const feeWei = gasLimit * maxFeePerGas + l1Fee
    if (feeWei > balances.gas) {
      throw new Error(
        `Not enough ${chain.gas.symbol} for the network fee (~${formatEvmAmount(feeWei, 18)} ${chain.gas.symbol} needed, ` +
          `you have ${formatEvmAmount(balances.gas, 18)}). Send a little ${chain.gas.symbol} on ${chain.networkName} to your address first.`,
      )
    }
    return {
      chain,
      asset,
      ...(customToken !== undefined && { customToken }),
      to,
      recipientIsContract,
      amount,
      feeWei,
      request: {
        to: tokenContract,
        value: 0n,
        data,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        chainId: chain.chainId,
      },
    }
  }

  // Native send. Every one is estimated: a contract wallet (a Safe, say) runs
  // a receive hook, and Arbitrum prices L1 data as extra L2 gas — a plain
  // transfer there needs ~21.5k, so the old hardcoded 21 000 failed every
  // ETH send on Arbitrum (bug audit 2026-10-27, BH2). An estimate of exactly
  // 21 000 (an ordinary account on an L1 chain) is used as is; anything more
  // gets 20 % headroom.
  if (/^0x0{40}$/i.test(to)) {
    throw new Error('That is the zero address. Anything sent there is lost for good.')
  }
  let gasLimit = 21_000n
  if (balances.gas > 0n) {
    const est = await client.estimateGas({ account: key.address, to, value: 1n }).catch((e: unknown) => {
      // a revert is the recipient contract's answer, not a network hiccup:
      // "try again in a moment" sent people round in circles (review 2026-10-28)
      const said = [(e as { shortMessage?: unknown } | null)?.shortMessage, e instanceof Error ? e.message : String(e)].join(' ')
      if (/execution reverted/i.test(said)) {
        throw new Error(
          `That address is a contract that refused ${chain.gas.symbol} in a test run, so the send would fail on the network. Nothing was sent.`,
        )
      }
      return null
    })
    if (est === null) {
      if (recipientHasCode || chain.l2 === 'arbitrum') {
        throw new Error(`Couldn't work out the network fee for this send on ${chain.networkName} right now. Try again in a moment.`)
      }
    } else if (est > 21_000n || recipientHasCode) {
      gasLimit = (est * 12n) / 10n
      if (gasLimit > gasCapFor(chain, 400_000n)) {
        throw new Error(
          'That recipient contract demands an unusually large amount of gas — refusing to prepare the send.',
        )
      }
    }
  }
  let l1Fee = 0n
  if (chain.l2 === 'op') {
    const fee = await opL1FeeWei(client, NATIVE_TX_BYTES)
    if (fee === null && args.sendMax === true) {
      throw new Error(
        `Couldn't read ${chain.networkName}'s data fee right now, so MAX can't leave the right amount for it. Try again in a moment, or send a little less than your whole balance.`,
      )
    }
    l1Fee = fee ?? 0n
  }
  const feeWei = gasLimit * maxFeePerGas + l1Fee
  const amount = args.sendMax === true ? balances.gas - feeWei : args.amount
  if (amount <= 0n) throw new Error('Nothing to send after the network fee.')
  if (amount + feeWei > balances.gas) {
    throw new Error(
      `Insufficient ${chain.gas.symbol}: amount plus the ~${formatEvmAmount(feeWei, 18)} ${chain.gas.symbol} fee exceeds your balance.`,
    )
  }
  return {
    chain,
    asset,
    to,
    recipientIsContract,
    amount,
    feeWei,
    request: {
      to,
      value: amount,
      data: undefined,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId: chain.chainId,
    },
  }
}

/**
 * Ask the network about a recorded attempt. Only viem's explicit "not found"
 * results mean not-found; every other failure (timeout, HTTP error, RPC
 * error) is 'unreachable', which the ledger treats as blocking.
 */
export async function evmAttemptStatus(
  chain: EvmChainConfig,
  hash: string,
): Promise<EvmAttemptStatus> {
  const client = getEvmClient(chain)
  try {
    await client.getTransaction({ hash: hash as Hex })
  } catch (e) {
    return e instanceof TransactionNotFoundError ? 'unknown-to-network' : 'unreachable'
  }
  try {
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex })
    // a reverted transaction used its nonce and its fee, but paid nothing
    return receipt.status === 'reverted' ? 'reverted' : 'mined'
  } catch (e) {
    return e instanceof TransactionReceiptNotFoundError ? 'pending' : 'unreachable'
  }
}

/**
 * The attempt a same-nonce retry meant to replace has settled on chain
 * (mined, or reverted): the nonce is used, so the retry must not reuse it.
 * The send form clears its retry nonce on this.
 */
export class EvmNonceSettled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvmNonceSettled'
  }
}

/**
 * An earlier send is still waiting to be confirmed. It holds new sends back
 * until it confirms or the network drops it — which can take hours, not the
 * "ten minutes" the old message promised — so the send form offers to
 * replace it: the same nonce at a higher fee (evmReplacementFloor), so only
 * one of the two can ever go through (bug audit 2026-10-27, BM15).
 */
export class EvmSendWaiting extends Error {
  readonly entry: PendingEvm
  constructor(entry: PendingEvm, what: string) {
    super(
      `${what} is still waiting to be confirmed. A new send now could pay twice. Wait for it, or replace it: ` +
        'the replacement takes its place at a higher fee, so only one of the two can ever go through.',
    )
    this.name = 'EvmSendWaiting'
    this.entry = entry
  }
}

/** A broadcast that did not go out cleanly. `definite`: every node asked refused it, so nothing at all was taken. */
export class EvmBroadcastError extends Error {
  readonly definite: boolean
  constructor(message: string, definite: boolean) {
    super(message)
    this.name = 'EvmBroadcastError'
    this.definite = definite
  }
}

/** The node already holds exactly this transaction. */
const EVM_KNOWN = /already known|known transaction|already imported|alreadyknown|same hash|already exists/i
/** The node validated the bytes and refused them: this attempt was not taken. Allow-list only. */
const EVM_REFUSED =
  /insufficient funds|intrinsic gas too low|gas limit|exceeds block gas limit|invalid sender|invalid signature|fee cap|less than block base fee|transaction underpriced|nonce too low|nonce too high|tx type not supported|transaction type not supported|invalid chain ?id|chain ?id mismatch|oversized data|exceeds the configured cap/i

type EvmSubmit = { kind: 'accepted' } | { kind: 'refused'; reason: string } | { kind: 'unclear'; reason: string }

/**
 * Hand the signed bytes to each of the chain's RPCs in turn, keeping every
 * answer (bug audit 2026-10-27, BM1). viem's fallback transport threw only
 * the LAST RPC's error, so a first RPC that took the transaction and then
 * timed out, followed by a second that answered a JSON 429, read as "the
 * node refused it" and erased the double-pay record. Now: accepted or
 * "already known" anywhere → accepted; refused (allow-listed reasons) by
 * EVERY RPC asked → refused; anything else → unclear.
 */
async function submitEvmTx(chain: EvmChainConfig, signed: Hex): Promise<EvmSubmit> {
  const refusals: string[] = []
  let unclear: string | null = null
  for (const url of chain.rpcs) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signed] }),
        signal:
          typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
      })
    } catch {
      unclear ??= 'no answer from the network'
      continue
    }
    let body: { result?: unknown; error?: { message?: unknown } } | null = null
    try {
      body = (await res.json()) as { result?: unknown; error?: { message?: unknown } } | null
    } catch {
      unclear ??= `HTTP ${res.status}`
      continue
    }
    if (typeof body?.result === 'string') return { kind: 'accepted' }
    const msg = typeof body?.error?.message === 'string' ? body.error.message : ''
    if (EVM_KNOWN.test(msg)) return { kind: 'accepted' }
    if (msg !== '' && EVM_REFUSED.test(msg)) {
      refusals.push(msg)
      continue
    }
    unclear ??= msg !== '' ? msg : `HTTP ${res.status}`
  }
  if (unclear === null && refusals.length > 0) return { kind: 'refused', reason: refusals[0]! }
  return { kind: 'unclear', reason: unclear ?? 'no answer from the network' }
}

/**
 * What a person reads of an error from the EVM stack. viem's messages run to
 * several lines — the RPC's URL, the request body (a signed transaction, on
 * a broadcast), the library version — and the send form showed them all
 * (bug audit 2026-10-27, BL13): keep viem's headline, in plain words where
 * it is a common one, and never a URL or a long hex blob.
 */
export function evmErrorText(e: unknown, chain?: EvmChainConfig): string {
  // The wallet's own warnings are whole as written: a lost broadcast whose
  // reason mentioned a timeout read "Your coins are safe; try again", and
  // the 200-character cap cut "still waiting" and "went through after all"
  // mid-sentence (review 2026-10-28).
  if (
    e instanceof EvmBroadcastError ||
    e instanceof EvmSendWaiting ||
    e instanceof EvmNonceSettled ||
    e instanceof EarlierSendLanded
  ) {
    return e.message
  }
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage
  const raw = typeof short === 'string' && short !== '' ? short : e instanceof Error ? e.message : String(e)
  const head = (raw.split('\n')[0] ?? '').trim()
  const where = chain !== undefined ? ` ${chain.networkName}` : ''
  if (/HTTP request failed|fetch failed|failed to fetch|load failed|timed? ?out|took too long|network ?error/i.test(head)) {
    return `Couldn't reach the${where} network right now. Your coins are safe; try again in a moment.`
  }
  if (/execution reverted/i.test(head)) {
    return 'The contract refused this transfer in a test run, so it would fail on the network. Nothing was sent.'
  }
  return head.replace(/https?:\/\/\S+/g, 'the network').replace(/0x[0-9a-fA-F]{80,}/g, '0x…').slice(0, 200) || 'Something went wrong'
}

function evmRefusalText(reason: string, chain: EvmChainConfig): string {
  if (/insufficient funds/i.test(reason)) {
    return `The network refused it: there isn't enough ${chain.gas.symbol} for the amount plus the network fee. Nothing was sent.`
  }
  if (/intrinsic gas too low|gas limit/i.test(reason)) {
    return `The network refused it: the transaction's gas limit is too low for ${chain.networkName}. Nothing was sent.`
  }
  if (/nonce too low/i.test(reason)) {
    return 'The network refused it: an earlier transaction from this account already used its place in line (its nonce). Nothing more was sent.'
  }
  if (/underpriced|fee cap|base fee/i.test(reason)) {
    return `The network refused it: the fee was too low for ${chain.networkName} right now. Nothing was sent.`
  }
  return `The network refused it (${reason.slice(0, 120)}). Nothing was sent.`
}

export async function broadcastEvmSend(key: EvmKey, prepared: PreparedEvmSend): Promise<string> {
  const signed = await key.account.signTransaction({
    type: 'eip1559',
    ...prepared.request,
  })
  // The hash is a pure function of the signed bytes: record the attempt
  // BEFORE broadcasting so even a timed-out send leaves a trace the next
  // prepare can check against the chain.
  const hash = keccak256(signed)
  const entry = {
    kind: 'evm' as const,
    chainId: prepared.chain.chainId,
    nonce: prepared.request.nonce,
    hash,
    to: prepared.to,
    ts: Date.now(),
    maxFeePerGas: prepared.request.maxFeePerGas.toString(),
    maxPriorityFeePerGas: prepared.request.maxPriorityFeePerGas.toString(),
  }
  recordPending(entry)
  const outcome = await submitEvmTx(prepared.chain, signed)
  // The send log trusts an address the wallet has paid, or may have: never
  // one whose send every node refused (bug audit 2026-10-27, BL19).
  if (outcome.kind !== 'refused') recordSentTo(prepared.chain.id, prepared.to)
  if (outcome.kind === 'accepted') return hash
  if (outcome.kind === 'refused') {
    // every node asked validated it and said no: nothing was taken
    dropPending(entry)
    throw new EvmBroadcastError(evmRefusalText(outcome.reason, prepared.chain), true)
  }
  markPendingFailed(entry)
  throw new EvmBroadcastError(
    `The network didn't confirm it received this send (${outcome.reason.slice(0, 100)}). It may still go through.`,
    false,
  )
}

// ---------------------------------------------------------------------------
// QR / pasted-text parsing for the EVM send form. Accepts a bare 0x address or
// an EIP-681 URI (ethereum:0x...[@chainId][/transfer?address=0x...][?...]);
// explains wrong-family addresses instead of rejecting them as gibberish.

/**
 * An EIP-681 number in smallest units: an integer, or a decimal with an
 * exponent ("2.014e18") that comes out whole. undefined when absent; throws
 * when it isn't one.
 */
function eip681Units(raw: string | null): bigint | undefined {
  if (raw === null || raw === '') return undefined
  const m = /^(\d{1,80})(?:\.(\d{1,80}))?(?:[eE]\+?(\d{1,2}))?$/.exec(raw)
  if (m === null) throw new Error("That payment code's amount isn't a valid number.")
  const frac = m[2] ?? ''
  const digits = m[1]! + frac
  const shift = Number(m[3] ?? '0') - frac.length
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift)
  const keep = digits.length + shift
  if (!/^0*$/.test(digits.slice(Math.max(0, keep)))) {
    throw new Error("That payment code's amount isn't a whole number of units.")
  }
  return keep > 0 ? BigInt(digits.slice(0, keep)) : 0n
}

/**
 * A scanned address or EIP-681 payment request. A token request names the
 * token contract (`token`) and its amount in that token's smallest units; a
 * plain request's `value` is wei. Both used to come back as the address
 * alone, so the form kept whatever asset it was on and no amount (bug audit
 * 2026-10-27, BM16).
 */
export function parseEvmScanned(
  text: string,
  expectedChainId?: number,
): { address: string; token?: Hex; amount?: bigint } {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('The scanned code was empty.')
  let candidate = trimmed
  let amount: bigint | undefined

  // EIP-681: ethereum:[pay-]<target>[@chainId][/<function>][?params]
  const uri = /^ethereum:(?:pay-)?([^@?/]+)(?:@(\d+))?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(trimmed)
  if (uri) {
    const [, target, chainIdStr, fn, query] = uri
    if (
      chainIdStr !== undefined &&
      expectedChainId !== undefined &&
      chainIdStr !== String(expectedChainId)
    ) {
      throw new Error(
        `That payment code is for a different network (chain id ${chainIdStr}) — open the matching network's send form before scanning it.`,
      )
    }
    if (fn !== undefined && fn !== '') {
      // Function form: the target is a CONTRACT, not the recipient. Only the
      // ERC-20 `transfer` request form is understood, and its real recipient
      // is the `address` parameter — filling the contract in as the recipient
      // would send the funds to the token contract itself, irrecoverably.
      if (fn.toLowerCase() !== 'transfer') {
        throw new Error("That payment code asks for a contract call this wallet doesn't support.")
      }
      const params = new URLSearchParams(query ?? '')
      const recipient = params.get('address')
      if (recipient === null || !isValidEvmAddress(recipient)) {
        throw new Error('That token-payment code names no valid recipient address.')
      }
      if (!isValidEvmAddress(target!)) throw new Error('That token-payment code names no valid token contract.')
      const units = eip681Units(params.get('uint256'))
      return { address: getAddress(recipient), token: getAddress(target!), ...(units !== undefined && { amount: units }) }
    }
    candidate = target!
    amount = eip681Units(new URLSearchParams(query ?? '').get('value'))
  } else {
    candidate = candidate.split('?')[0]!
  }

  if (isValidEvmAddress(candidate)) return { address: getAddress(candidate), ...(amount !== undefined && { amount }) }

  const lower = candidate.toLowerCase()
  if (
    lower.startsWith('bc1') ||
    lower.startsWith('tb1') ||
    lower.startsWith('ltc1') ||
    lower.startsWith('bitcoin:') ||
    lower.startsWith('dogecoin:') ||
    lower.startsWith('litecoin:') ||
    candidate.startsWith('D')
  ) {
    throw new Error(
      "That looks like a Bitcoin-family address. USDC lives on Base — ask for the recipient's 0x address.",
    )
  }
  throw new Error("That code doesn't contain a valid 0x address.")
}
