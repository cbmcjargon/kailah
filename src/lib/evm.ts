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
import { agoText, evmInFlightBlock, recordPending, type EvmAttemptStatus } from './pending'
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
  color: string
  faucets?: { name: string; url: string; note?: string }[]
}

export const EVM_CHAINS: Record<EvmChainId, EvmChainConfig> = {
  base: {
    id: 'base',
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
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
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
      chain.rpcs.map((url) => http(url, { timeout: 15_000 })),
      { rank: false },
    ),
  })
  clients.set(chain.id, client)
  return client
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

export async function fetchDetectedTokens(
  chain: EvmChainConfig,
  address: Hex,
): Promise<DetectedToken[]> {
  if (chain.blockscoutBase === undefined) return []
  const res = await fetch(`${chain.blockscoutBase}/addresses/${address}/tokens?type=ERC-20`)
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

function blockscoutBase(chain: EvmChainConfig): string | undefined {
  return chain.blockscoutBase
}

function toEpoch(ts: string | null | undefined): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export async function fetchEvmHistory(chain: EvmChainConfig, address: Hex): Promise<EvmTx[]> {
  const base = blockscoutBase(chain)
  if (base === undefined) return []
  const me = address.toLowerCase()
  const out: EvmTx[] = []

  const [transfersRes, txsRes] = await Promise.allSettled([
    fetch(`${base}/addresses/${address}/token-transfers?type=ERC-20`).then((r) =>
      r.ok ? (r.json() as Promise<{ items?: BsTransferItem[] }>) : Promise.reject(new Error(String(r.status))),
    ),
    fetch(`${base}/addresses/${address}/transactions`).then((r) =>
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
      if (value === 0n || !t.transaction_hash) continue
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
      if (value === 0n || !t.hash) continue // contract calls (incl. our USDC sends) carry 0 ETH
      const from = (t.from?.hash ?? '').toLowerCase()
      const to = (t.to?.hash ?? '').toLowerCase()
      const direction = from === me && to === me ? 'self' : from === me ? 'out' : 'in'
      out.push({
        hash: t.hash,
        direction,
        amount: direction === 'out' ? -value : value,
        asset: 'gas',
        time: toEpoch(t.timestamp),
        counterparty: direction === 'out' ? (t.to?.hash ?? null) : (t.from?.hash ?? null),
        pending: t.timestamp == null,
      })
    }
  }

  out.sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER))
  return out.slice(0, 100)
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

  const [balances, fees, pendingNonce] = await Promise.all([
    getEvmBalances(chain, key.address),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: key.address, blockTag: 'pending' }),
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
    throw new Error(
      block.reason === 'pending'
        ? `A send from ${agoText(p.ts)} (to ${p.to.slice(0, 8)}…) is still waiting to confirm on ${chain.networkName}. Wait for it to confirm before sending again — sending now could pay twice.`
        : `Couldn't check whether your send from ${agoText(p.ts)} (to ${p.to.slice(0, 8)}…) is still waiting on ${chain.networkName}. Try again in a moment — sending without knowing could pay twice.`,
    )
  }
  // Headroom on the market fee so a small gas-price move can't strand the tx —
  // then a hard ceiling, because both numbers come from the RPC: without one a
  // tampered fee API could have a MAX send hand nearly the whole balance to
  // the block producer as priority fee. 1000/100 gwei sit far above any honest
  // market on all five chains while bounding a 21k-gas send to ~0.021 ETH.
  const MAX_FEE_PER_GAS = 1_000_000_000_000n // 1000 gwei
  const MAX_PRIORITY_PER_GAS = 100_000_000_000n // 100 gwei
  const rawPriority = fees.maxPriorityFeePerGas
  const rawMax = (fees.maxFeePerGas * 15n) / 10n
  const maxFeePerGas = rawMax > MAX_FEE_PER_GAS ? MAX_FEE_PER_GAS : rawMax
  const maxPriorityFeePerGas =
    rawPriority > MAX_PRIORITY_PER_GAS ? MAX_PRIORITY_PER_GAS : rawPriority

  if (asset === 'token') {
    // Custom tokens re-read their live balance from their own contract; the
    // pinned token's balance came with the batch read above.
    const tokenContract = customToken?.address ?? chain.token.address
    const symbol = customToken?.symbol ?? chain.token.symbol
    const decimals = customToken?.decimals ?? chain.token.decimals
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
    // transfer this wallet shouldn't sign blind anyway.
    const gasLimit = (gas * 12n) / 10n
    if (gasLimit > 400_000n) {
      throw new Error(
        'This transfer demands an unusually large amount of gas — refusing to prepare it.',
      )
    }
    const feeWei = gasLimit * maxFeePerGas
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

  // Native ETH send. 21k covers an externally-owned recipient; a contract
  // wallet (a Safe, say) runs a receive hook and needs more — a hardcoded
  // 21k would simply revert and burn the fee on every attempt.
  let gasLimit = 21_000n
  if (balances.gas > 0n) {
    const code = await client.getCode({ address: to }).catch(() => undefined)
    if (code !== undefined && code !== '0x') {
      const est = await client.estimateGas({ account: key.address, to, value: 1n })
      gasLimit = (est * 12n) / 10n
      if (gasLimit > 400_000n) {
        throw new Error(
          'That recipient contract demands an unusually large amount of gas — refusing to prepare the send.',
        )
      }
    }
  }
  const feeWei = gasLimit * maxFeePerGas
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
    await client.getTransactionReceipt({ hash: hash as Hex })
    return 'mined'
  } catch (e) {
    return e instanceof TransactionReceiptNotFoundError ? 'pending' : 'unreachable'
  }
}

export async function broadcastEvmSend(key: EvmKey, prepared: PreparedEvmSend): Promise<string> {
  const client = getEvmClient(prepared.chain)
  const signed = await key.account.signTransaction({
    type: 'eip1559',
    ...prepared.request,
  })
  // The hash is a pure function of the signed bytes: record the attempt
  // BEFORE broadcasting so even a timed-out send leaves a trace the next
  // prepare can check against the chain.
  const hash = keccak256(signed)
  recordPending({
    kind: 'evm',
    chainId: prepared.chain.chainId,
    nonce: prepared.request.nonce,
    hash,
    to: prepared.to,
    ts: Date.now(),
  })
  await client.sendRawTransaction({ serializedTransaction: signed })
  return hash
}

// ---------------------------------------------------------------------------
// QR / pasted-text parsing for the EVM send form. Accepts a bare 0x address or
// an EIP-681 URI (ethereum:0x...[@chainId][/transfer?address=0x...][?...]);
// explains wrong-family addresses instead of rejecting them as gibberish.

export function parseEvmScanned(text: string, expectedChainId?: number): { address: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('The scanned code was empty.')
  let candidate = trimmed

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
      const recipient = new URLSearchParams(query ?? '').get('address')
      if (recipient === null || !isValidEvmAddress(recipient)) {
        throw new Error('That token-payment code names no valid recipient address.')
      }
      return { address: getAddress(recipient) }
    }
    candidate = target!
  } else {
    candidate = candidate.split('?')[0]!
  }

  if (isValidEvmAddress(candidate)) return { address: getAddress(candidate) }

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
