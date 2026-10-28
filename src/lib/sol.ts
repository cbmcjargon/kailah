// Solana engine for Kailah Wallet: native SOL on mainnet + devnet practice.
//
// Third, self-contained engine beside the UTXO and EVM stacks. Solana is an
// account-model chain on ed25519 keys: derivation is SLIP-0010 (hardened-only
// HMAC-SHA512 chain) at the Phantom-standard path m/44'/501'/0'/0', so the
// same 12 words restore this account in Phantom/Solflare. Signing uses
// micro-sol-signer — the @scure/@noble family, same trust base as the rest
// of the wallet.
//
// Live-verified groundwork (2026-07-24, from the wallet origin):
//   mainnet RPC  https://solana-rpc.publicnode.com     (CORS *, 200)
//   devnet RPC   https://api.devnet.solana.com         (CORS ok, 200; airdrop!)
//   (api.mainnet-beta.solana.com now 403s third-party use — rejected)
//
// Money safety: lamports are bigint; the base fee is protocol-flat 5000
// lamports/signature; sends leaving a dust remainder below rent-exemption are
// rejected with advice (Solana would refuse them anyway); failed broadcasts
// must re-prepare (fresh blockhash), never blind-retry.

import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'
import { mnemonicToSeedSync } from '@scure/bip39'
import { normalizeMnemonic } from './keys'
import * as solLib from 'micro-sol-signer'
import { formatEvmAmount } from './units'
import { formatCoin } from './format'
import {
  agoText,
  dropPending,
  dismissLanded,
  EarlierSendLanded,
  markPendingFailed,
  markPendingSent,
  pendingSol,
  recordPending,
  SOL_TTL_HARD_MS,
  solInFlightBlock,
  type PendingSol,
} from './pending'
import { recordSentTo } from './sentlog'
import type { NetMode } from './types'

export type SolChainId = 'sol' | 'sol-devnet'

export interface SolChainConfig {
  id: SolChainId
  name: string
  networkName: string
  feeNote: string
  mainnet: boolean
  rpcs: string[]
  explorerTx: (sig: string) => string
  explorerAddr: (addr: string) => string
  decimals: 9
  priceSymbol: string
  coingeckoId: string
  color: string
  /** SPL USDC on this cluster */
  usdc: { mint: string; decimals: number; symbol: string; priceSymbol: string }
}

export const SOL_CHAINS: Record<SolChainId, SolChainConfig> = {
  sol: {
    id: 'sol',
    name: 'Solana',
    networkName: 'Solana',
    feeNote: 'Network fees on Solana are a flat ~0.000005 SOL — effectively free.',
    mainnet: true,
    rpcs: ['https://solana-rpc.publicnode.com'],
    explorerTx: (s) => `https://explorer.solana.com/tx/${s}`,
    explorerAddr: (a) => `https://explorer.solana.com/address/${a}`,
    decimals: 9,
    priceSymbol: 'SOL',
    coingeckoId: 'solana',
    color: '#9945ff',
    usdc: {
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
      symbol: 'USDC',
      priceSymbol: 'USDC',
    },
  },
  'sol-devnet': {
    id: 'sol-devnet',
    name: 'Solana (practice)',
    networkName: 'Solana devnet',
    feeNote: 'Practice network — fees are paid in worthless test SOL.',
    mainnet: false,
    rpcs: ['https://api.devnet.solana.com'],
    explorerTx: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
    explorerAddr: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
    decimals: 9,
    priceSymbol: 'SOL',
    coingeckoId: 'solana',
    color: '#9945ff',
    usdc: {
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      decimals: 6,
      symbol: 'USDC',
      priceSymbol: 'USDC',
    },
  },
}

export function solChainsForMode(mode: NetMode): SolChainConfig[] {
  const all = Object.values(SOL_CHAINS)
  return mode === 'practice' ? all.filter((c) => !c.mainnet) : all.filter((c) => c.mainnet)
}

// ---------------------------------------------------------------------------
// Keys — SLIP-0010 ed25519 (hardened-only), Phantom path m/44'/501'/0'/0'.

const HARDENED = 0x80000000

/** SLIP-0010 ed25519 master+child derivation; every index is hardened. */
export function slip10Ed25519(seed: Uint8Array, path: number[]): Uint8Array {
  let i = hmac(sha512, utf8ToBytes('ed25519 seed'), seed)
  let key = i.slice(0, 32)
  let chainCode = i.slice(32)
  i.fill(0) // the master I holds key‖chaincode — wipe every copy we replace
  for (const index of path) {
    const data = new Uint8Array(1 + 32 + 4)
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, (index + HARDENED) >>> 0, false)
    i = hmac(sha512, chainCode, data)
    key.fill(0) // superseded parent key
    data.fill(0) // held a copy of the parent key
    chainCode.fill(0)
    key = i.slice(0, 32)
    chainCode = i.slice(32)
    i.fill(0)
  }
  chainCode.fill(0)
  return key
}

export const SOL_DERIVATION_PATH = "m/44'/501'/0'/0'"
/**
 * Practice mode signs with a different key, at BIP44's testnet coin type (1,
 * as Bitcoin's own testnet accounts do): a Solana message carries nothing
 * that names its cluster except the blockhash, which comes from the RPC, so a
 * hostile devnet RPC handing out a mainnet blockhash could otherwise get a
 * mainnet-valid signature from the real key (audit 2026-10-26, H3). No
 * mainnet wallet derives Solana at coin type 1, so this key never holds real
 * coins.
 */
export const SOL_PRACTICE_PATH = "m/44'/1'/0'/0'"

export interface SolKey {
  address: string
  privateKey: Uint8Array
  zero: () => void
}

export function deriveSolKey(mnemonic: string, accountIndex = 0, practice = false): SolKey {
  // normalized like every other engine's derivation (keys.ts), so a phrase
  // typed with capitals or extra spaces can never yield a different key here
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic))
  const privateKey = slip10Ed25519(seed, [44, practice ? 1 : 501, accountIndex, 0])
  seed.fill(0)
  return {
    address: solLib.getAddress(privateKey),
    privateKey,
    zero: () => privateKey.fill(0),
  }
}

export function isValidSolAddress(addr: string): boolean {
  try {
    solLib.validateAddress(addr)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC with failover across the config's rpc list.

interface RpcError {
  message?: string
}

export async function solRpc<T>(
  chain: SolChainConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  return rpc(chain, method, params)
}

async function rpc<T>(chain: SolChainConfig, method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown
  for (const url of chain.rpcs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        // Hard deadline: a black-holed RPC must fail over in seconds, not
        // hang for the browser's minute-plus connect timeout. (Older Safari
        // lacks AbortSignal.timeout — degrade to no deadline there.)
        signal:
          typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
            ? AbortSignal.timeout(15_000)
            : undefined,
      })
      const body = (await res.json()) as { result?: T; error?: RpcError }
      if (body.error) {
        throw new Error(body.error.message ?? `${chain.name} RPC error`)
      }
      return body.result as T
    } catch (e) {
      lastErr = e
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
  if (lastErr instanceof TypeError || /load failed|failed to fetch|networkerror|timed? ?out|abort/i.test(detail)) {
    // no answer at all: for a read that's harmless; a broadcast reads
    // `unreachable` as "it may have gone out" (submitSolTx)
    throw Object.assign(
      new Error(`Couldn't reach the ${chain.networkName} network right now. Your coins are safe; try again in a few minutes.`),
      { unreachable: true },
    )
  }
  throw new Error(detail)
}

export async function getSolBalance(chain: SolChainConfig, address: string): Promise<bigint> {
  const r = await rpc<{ value: number }>(chain, 'getBalance', [
    address,
    { commitment: 'confirmed' },
  ])
  return BigInt(r.value)
}

// ---------------------------------------------------------------------------
// SPL USDC. Tokens don't live on the wallet address itself — they live in a
// derived "associated token account" (ATA), a deterministic program address
// per (owner, mint). We derive it locally (never trusting the RPC for it) and
// read balances by owner+mint so even oddly-created token accounts show up.

/** The wallet's associated token account for this cluster's USDC. */
export function solUsdcAta(chain: SolChainConfig, owner: string): string {
  return solLib.tokenAddress({
    mint: chain.usdc.mint,
    owner,
    tokenProgram: solLib.TOKEN_PROGRAM,
  })
}

/**
 * USDC balance = the derived ATA's amount. Deliberately NOT the indexer-style
 * getTokenAccountsByOwner: publicnode's free mainnet RPC doesn't serve that
 * method (verified 2026-07-27 — it hangs), and reading the ATA directly means
 * the displayed balance always equals what a send can actually spend.
 */
/** u64 LE token amount at bytes 64..72 of a base64 SPL token account. */
export function tokenAmountFromBase64(data: unknown): bigint {
  const b64 = Array.isArray(data) ? (data[0] as string | undefined) : undefined
  if (typeof b64 !== 'string') return 0n
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (bytes.length < 72) return 0n
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[64 + i]!)
  return v
}

export async function getSolUsdcBalance(chain: SolChainConfig, owner: string): Promise<bigint> {
  const ata = solUsdcAta(chain, owner)
  // getAccountInfo, not getTokenAccountBalance: public mainnet RPCs now gate
  // "indexed" methods behind personal tokens, and a missing account comes back
  // as value:null here — cleanly distinct from network trouble, which throws.
  const r = await rpc<{ value: { data?: unknown } | null }>(chain, 'getAccountInfo', [
    ata,
    { encoding: 'base64' },
  ])
  if (r.value === null) return 0n // no token account yet = zero balance
  return tokenAmountFromBase64(r.value.data)
}

interface AccountInfoResult {
  value: { owner: string } | null
}

/** a base58 ed25519 signature (64 bytes), as the explorer links expect it */
const SOL_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

/** SPL token program ids — an address owned by either is a token account. */
const TOKEN_PROGRAM_IDS: string[] = [solLib.TOKEN_PROGRAM, solLib.TOKEN_PROGRAM2022]

// ---------------------------------------------------------------------------
// History: recent signatures, then a bounded number of parsed transactions to
// derive each one's net effect on our account from pre/post balances.

export interface SolTx {
  signature: string
  direction: 'in' | 'out' | 'self'
  /** signed lamports (out includes the fee) */
  amount: bigint
  /** signed USDC smallest-units; non-zero marks this as a USDC transfer */
  usdcAmount: bigint
  time: number | null
  counterparty: string | null
  failed: boolean
}

interface SigInfo {
  signature: string
  blockTime: number | null
  err: unknown
}

interface TokenBalanceEntry {
  owner?: string
  mint?: string
  uiTokenAmount?: { amount?: string }
}

interface ParsedTxMeta {
  preBalances?: number[]
  postBalances?: number[]
  preTokenBalances?: TokenBalanceEntry[]
  postTokenBalances?: TokenBalanceEntry[]
}

interface ParsedTxResult {
  blockTime?: number | null
  meta?: ParsedTxMeta | null
  transaction?: { message?: { accountKeys?: { pubkey?: string }[] } }
}

/** Bounded per-refresh: 1 signatures call + up to this many detail fetches. */
const HISTORY_DETAIL_LIMIT = 8

/** Net USDC change for one owner across a parsed tx's token-balance lists. */
function usdcDeltaFor(meta: ParsedTxMeta | null | undefined, mint: string, owner: string): bigint {
  const sum = (entries: TokenBalanceEntry[] | undefined) => {
    let v = 0n
    for (const e of entries ?? []) {
      if (e.owner === owner && e.mint === mint) v += BigInt(e.uiTokenAmount?.amount ?? '0')
    }
    return v
  }
  return sum(meta?.postTokenBalances) - sum(meta?.preTokenBalances)
}

export async function fetchSolHistory(chain: SolChainConfig, address: string): Promise<SolTx[]> {
  // USDC transfers touch the token account, not necessarily the wallet address
  // (incoming ones touch only the ATA) — so gather signatures from both.
  const ata = solUsdcAta(chain, address)
  const [ownerSigs, ataSigs] = await Promise.all([
    rpc<SigInfo[]>(chain, 'getSignaturesForAddress', [
      address,
      { limit: 15, commitment: 'confirmed' },
    ]),
    rpc<SigInfo[]>(chain, 'getSignaturesForAddress', [
      ata,
      { limit: 10, commitment: 'confirmed' },
    ]).catch(() => [] as SigInfo[]),
  ])
  const seen = new Set<string>()
  const sigs: SigInfo[] = []
  for (const s of [...ownerSigs, ...ataSigs]) {
    // the signature becomes an explorer link: only a real one gets through
    if (typeof s.signature !== 'string' || !SOL_SIGNATURE.test(s.signature)) continue
    if (seen.has(s.signature)) continue
    seen.add(s.signature)
    sigs.push(s)
  }
  sigs.sort((a, b) => (b.blockTime ?? Number.MAX_SAFE_INTEGER) - (a.blockTime ?? Number.MAX_SAFE_INTEGER))

  const out: SolTx[] = []
  for (const s of sigs.slice(0, HISTORY_DETAIL_LIMIT)) {
    try {
      const tx = await rpc<ParsedTxResult | null>(chain, 'getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ])
      const keys = tx?.transaction?.message?.accountKeys ?? []
      const pre = tx?.meta?.preBalances ?? []
      const post = tx?.meta?.postBalances ?? []
      const myIndex = keys.findIndex((k) => k.pubkey === address)
      if (pre.length !== post.length) continue
      const delta =
        myIndex < 0 ? 0n : BigInt(post[myIndex] ?? 0) - BigInt(pre[myIndex] ?? 0)
      const usdcDelta = usdcDeltaFor(tx?.meta, chain.usdc.mint, address)
      if (myIndex < 0 && usdcDelta === 0n) continue
      // Counterparty: for USDC moves, the owner whose USDC changed the other
      // way; otherwise the account with the largest opposite lamport change.
      let counterparty: string | null = null
      if (usdcDelta !== 0n) {
        const owners = new Set<string>()
        for (const e of [
          ...(tx?.meta?.preTokenBalances ?? []),
          ...(tx?.meta?.postTokenBalances ?? []),
        ]) {
          if (e.owner && e.owner !== address && e.mint === chain.usdc.mint) owners.add(e.owner)
        }
        for (const o of owners) {
          const d = usdcDeltaFor(tx?.meta, chain.usdc.mint, o)
          if ((usdcDelta < 0n && d > 0n) || (usdcDelta > 0n && d < 0n)) {
            counterparty = o
            break
          }
        }
      } else {
        let best = 0n
        for (let k = 0; k < keys.length; k++) {
          if (k === myIndex) continue
          const d = BigInt(post[k] ?? 0) - BigInt(pre[k] ?? 0)
          if ((delta < 0n && d > best) || (delta > 0n && d < best)) {
            best = d
            counterparty = keys[k]?.pubkey ?? null
          }
        }
      }
      const main = usdcDelta !== 0n ? usdcDelta : delta
      out.push({
        signature: s.signature,
        direction: main === 0n ? 'self' : main < 0n ? 'out' : 'in',
        amount: delta,
        usdcAmount: usdcDelta,
        time: tx?.blockTime ?? s.blockTime ?? null,
        counterparty,
        failed: s.err != null,
      })
    } catch {
      // one unparseable tx never blocks the list
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Sending.

/** Protocol base fee: flat per-signature. */
export const SOL_BASE_FEE = 5000n
/** Rent-exempt minimum for a 0-data system account (lamports). */
const RENT_EXEMPT_MIN_FALLBACK = 890_880n

export type SolAsset = 'sol' | 'usdc'

export interface PreparedSolSend {
  chain: SolChainConfig
  asset: SolAsset
  to: string
  /** the blockhash's last valid block height: when this attempt can no longer land */
  lastValidBlockHeight: number
  /** Solana Pay extras carried by the transaction, shown on the review */
  reference: string[]
  memo: string | null
  /** lamports for SOL sends, USDC smallest-units for USDC sends */
  amount: bigint
  feeLamports: bigint
  /** one-time rent paid to create the recipient's USDC account (0 if it exists) */
  rentLamports: bigint
  /** unsigned tx (micro-sol-signer TxData) ready for signTx */
  unsigned: string
  blockhash: string
}

/** SPL Memo program: a note the recipient (a merchant, an exchange) matches the payment by. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
/** Solana Pay caps memos; the program allows more, but a note this long is not a payment reference. */
const MEMO_MAX_BYTES = 256

export interface SolSendArgs {
  chain: SolChainConfig
  key: SolKey
  asset?: SolAsset
  to: string
  amount: bigint
  sendMax?: boolean
  /** Solana Pay `reference` keys: read-only accounts the recipient looks the payment up by */
  reference?: string[]
  /** Solana Pay `memo`: attached as an SPL Memo instruction */
  memo?: string
}

/** Byte size of an SPL token account — rent-exemption lookup key. */
const TOKEN_ACCOUNT_SIZE = 165

export async function prepareSolSend(args: SolSendArgs): Promise<PreparedSolSend> {
  const { chain, key } = args
  const asset: SolAsset = args.asset ?? 'sol'
  await assertNoSolInFlight(chain)
  if (!isValidSolAddress(args.to)) {
    throw new Error(`"${args.to}" is not a valid Solana address.`)
  }
  if (args.to === key.address) {
    throw new Error('That is your own address — sending to yourself only burns the fee.')
  }

  const extras = payExtras(args)
  const [balance, blockhashRes, rentMinRes, toInfo] = await Promise.all([
    getSolBalance(chain, key.address),
    rpc<{ value: { blockhash: string; lastValidBlockHeight?: unknown } }>(chain, 'getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]),
    rpc<number>(chain, 'getMinimumBalanceForRentExemption', [0]).catch(() => null),
    rpc<AccountInfoResult>(chain, 'getAccountInfo', [args.to, { encoding: 'base64' }]),
  ])
  const lastValidBlockHeight = blockHeightOf(blockhashRes.value.lastValidBlockHeight)
  // The same trap the USDC path guards: a token account or a program's
  // account is not a wallet, and SOL sent there is at best hard to recover.
  assertWalletDestination(toInfo)
  const rentMin = rentMinRes != null ? BigInt(rentMinRes) : RENT_EXEMPT_MIN_FALLBACK
  const fee = SOL_BASE_FEE

  if (asset === 'usdc') {
    return prepareUsdcSend(args, balance, blockhashRes.value.blockhash, lastValidBlockHeight, rentMin)
  }

  const amount = args.sendMax === true ? balance - fee : args.amount
  if (amount <= 0n) throw new Error('Nothing to send after the network fee.')
  if (amount + fee > balance) {
    throw new Error(
      `Insufficient SOL: amount plus the ${formatSol(fee)} SOL fee exceeds your balance.`,
    )
  }
  const remainder = balance - amount - fee
  if (remainder > 0n && remainder < rentMin) {
    throw new Error(
      `That amount would leave less than the ${formatSol(rentMin)} SOL minimum Solana requires ` +
        `an account to hold. Send a bit less, or use Max to send everything.`,
    )
  }
  // An address that doesn't exist yet is created by this transfer, and the
  // network refuses to create one below the rent-exempt minimum
  // ("InsufficientFundsForRent", after signing; bug audit 2026-10-27, BM18).
  if (toInfo.value == null && amount < rentMin) {
    throw new Error(
      `That address has never held SOL, and Solana won't open it with less than ${formatCoin(rentMin, 9)} SOL. ` +
        `Send at least that much.`,
    )
  }

  const instruction = solLib.sys.transferSol({
    source: key.address,
    destination: args.to,
    amount,
  })
  const unsigned = solLib.createTx(
    key.address,
    // Solana Pay puts the memo immediately before the transfer; its
    // validator (and so the merchant) doesn't credit it after (bug audit
    // 2026-10-27, BM19)
    [...memoInstructions(key.address, extras.memo), withReference(instruction, extras.reference)],
    blockhashRes.value.blockhash,
  )

  return {
    chain,
    asset: 'sol',
    to: args.to,
    lastValidBlockHeight,
    reference: extras.reference,
    memo: extras.memo,
    amount,
    feeLamports: fee,
    rentLamports: 0n,
    unsigned,
    blockhash: blockhashRes.value.blockhash,
  }
}

/**
 * How long a reviewed Solana transaction stays confirmable. Its blockhash
 * lasts ~60-90 s; a review left open longer is prepared again before it is
 * signed, instead of failing with a lapsed blockhash (bug audit 2026-10-27,
 * BM17).
 */
export const SOL_REVIEW_FRESH_MS = 45_000

/** A token account, a program's account: not a wallet. The system program owns plain wallets. */
function assertWalletDestination(toInfo: AccountInfoResult): void {
  if (toInfo.value && toInfo.value.owner !== solLib.SYS_PROGRAM) {
    throw new Error(
      TOKEN_PROGRAM_IDS.includes(toInfo.value.owner)
        ? 'That address is a token account, not a wallet. Ask the recipient for their wallet address.'
        : 'That address belongs to a program, not to a person. Ask the recipient for their wallet address.',
    )
  }
}

/** Validate the Solana Pay extras a scan may have carried. */
function payExtras(args: SolSendArgs): { reference: string[]; memo: string | null } {
  const reference = args.reference ?? []
  if (reference.length > 4 || !reference.every(isValidSolAddress)) {
    throw new Error('That payment request carries a reference this wallet cannot attach.')
  }
  const memo = args.memo ?? null
  if (memo !== null && (utf8ToBytes(memo).length > MEMO_MAX_BYTES || /[\u0000-\u001f\u007f]/.test(memo))) {
    throw new Error('That payment request carries a memo this wallet cannot attach.')
  }
  return { reference, memo: memo === '' ? null : memo }
}

type SolIx = { program: string; keys: { address: string; sign: boolean; write: boolean }[]; data: Uint8Array }

/** Solana Pay references ride on the transfer as read-only, non-signing accounts. */
function withReference<T extends SolIx>(ix: T, reference: string[]): T {
  if (reference.length === 0) return ix
  return { ...ix, keys: [...ix.keys, ...reference.map((address) => ({ address, sign: false, write: false }))] }
}

/** The SPL Memo instruction for a Solana Pay memo (the payer signs it). */
function memoInstructions(signer: string, memo: string | null): SolIx[] {
  if (memo === null) return []
  return [{ program: MEMO_PROGRAM, keys: [{ address: signer, sign: true, write: false }], data: utf8ToBytes(memo) }]
}

/** A block height from the RPC, or the largest safe integer if it didn't say (hold the record by the clock). */
export function blockHeightOf(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : Number.MAX_SAFE_INTEGER
}

async function prepareUsdcSend(
  args: SolSendArgs,
  solBalance: bigint,
  blockhash: string,
  lastValidBlockHeight: number,
  rentMin: bigint,
): Promise<PreparedSolSend> {
  const { chain, key } = args
  const symbol = chain.usdc.symbol

  // Guard the classic trap: pasting a token-account address instead of the
  // owner's wallet address would send tokens somewhere only recoverable by
  // experts. Also learn whether the recipient's USDC account exists yet.
  const recipientAta = solUsdcAta(chain, args.to)
  const [available, toInfo, ataInfo, rentAtaRes] = await Promise.all([
    getSolUsdcBalance(chain, key.address),
    rpc<AccountInfoResult>(chain, 'getAccountInfo', [args.to, { encoding: 'base64' }]),
    rpc<AccountInfoResult>(chain, 'getAccountInfo', [recipientAta, { encoding: 'base64' }]),
    rpc<number>(chain, 'getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_SIZE]).catch(
      () => null,
    ),
  ])
  if (toInfo.value && TOKEN_PROGRAM_IDS.includes(toInfo.value.owner)) {
    throw new Error(
      "That address is a token account, not a wallet. Ask the recipient for their main Solana address — the wallet routes the tokens correctly from there.",
    )
  }
  // The same trap generalizes: any program-owned account (a stake account, a
  // PDA) has no key that could ever sign for the derived token account, so
  // USDC sent "to" it is burned. Only wallets (system-owned) and addresses
  // that don't exist yet (unfunded wallets) are valid destinations.
  if (toInfo.value && toInfo.value.owner !== solLib.SYS_PROGRAM) {
    throw new Error(
      `That address belongs to a program on Solana (for example a stake account), not to a wallet — ${symbol} sent there could never be spent. Ask for the recipient's main Solana address.`,
    )
  }

  const amount = args.sendMax === true ? available : args.amount
  if (amount <= 0n) throw new Error(`Enter a ${symbol} amount to send.`)
  if (amount > available) {
    throw new Error(
      `Insufficient ${symbol}: you have ${formatSolUsdc(chain, available)} ${symbol}.`,
    )
  }

  const createsAccount = ataInfo.value == null
  const rent = createsAccount
    ? rentAtaRes != null
      ? BigInt(rentAtaRes)
      : 2_039_280n
    : 0n
  const fee = SOL_BASE_FEE
  if (solBalance < fee + rent) {
    throw new Error(
      createsAccount
        ? `Sending ${symbol} to a first-time holder needs ${formatSol(fee + rent)} SOL ` +
          `(network fee plus a one-time account deposit), but you only have ${formatSol(solBalance)} SOL.`
        : `You need ${formatSol(fee)} SOL for the network fee, but you only have ${formatSol(solBalance)} SOL.`,
    )
  }
  const solRemainder = solBalance - fee - rent
  if (solRemainder > 0n && solRemainder < rentMin) {
    throw new Error(
      `This send would leave your SOL below the ${formatSol(rentMin)} SOL minimum Solana ` +
        `requires an account to hold. Top up SOL first.`,
    )
  }

  const senderAta = solUsdcAta(chain, key.address)
  const instructions = []
  if (createsAccount) {
    instructions.push(
      solLib.associatedToken.createAssociatedTokenIdempotent({
        payer: key.address,
        ata: recipientAta,
        owner: args.to,
        mint: chain.usdc.mint,
      }),
    )
  }
  instructions.push(
    solLib.token.transferChecked({
      source: senderAta,
      mint: chain.usdc.mint,
      destination: recipientAta,
      authority: key.address,
      amount,
      decimals: chain.usdc.decimals,
    }),
  )
  const extras = payExtras(args)
  const last = instructions.length - 1
  const transfer = instructions[last]
  if (transfer !== undefined) instructions[last] = withReference(transfer, extras.reference)
  // the memo immediately before the transfer, as in the SOL path
  instructions.splice(last, 0, ...memoInstructions(key.address, extras.memo))
  const unsigned = solLib.createTx(key.address, instructions, blockhash)

  return {
    chain,
    asset: 'usdc',
    to: args.to,
    lastValidBlockHeight,
    reference: extras.reference,
    memo: extras.memo,
    amount,
    feeLamports: fee,
    rentLamports: rent,
    unsigned,
    blockhash,
  }
}

/**
 * Thrown when a broadcast fails after the transaction was signed. Unlike EVM,
 * a Solana retry with a fresh blockhash does NOT replace the first attempt —
 * both stay valid until the first blockhash expires (~60-90s) — so the UI
 * must check `signature` (known before broadcast: it IS the txid) with
 * solTxSeen before letting the user send again.
 */
export class SolBroadcastError extends Error {
  readonly signature: string
  /** the signed bytes (base64), so the SAME attempt can be sent again — never a new one */
  readonly signed: string
  constructor(message: string, signature: string, signed: string) {
    super(message)
    this.name = 'SolBroadcastError'
    this.signature = signature
    this.signed = signed
  }
}

/** The attempt's blockhash has expired: it can never land, and a fresh one is safe. */
export class SolExpiredError extends Error {
  constructor() {
    super('That attempt has expired on the network and did not go through.')
    this.name = 'SolExpiredError'
  }
}

type SolSubmitOutcome = 'landed' | 'expired' | 'refused' | 'unclear'

/** What a failed sendTransaction means. Unrecognised failures count as "may have gone out". */
function solSubmitOutcome(e: unknown): SolSubmitOutcome {
  if ((e as { unreachable?: unknown } | null)?.unreachable === true) return 'unclear'
  const msg = e instanceof Error ? e.message : String(e)
  if (/already (been )?processed/i.test(msg)) return 'landed'
  if (/blockhash not found|block height exceeded/i.test(msg)) return 'expired'
  // preflight: the RPC simulated it and refused before forwarding it anywhere
  if (/transaction simulation failed|insufficient funds|insufficientfunds|invalid transaction|signature verification|could not be decoded|accountnotfound|account not found/i.test(msg)) {
    return 'refused'
  }
  return 'unclear'
}

function solRefusalText(msg: string): string {
  if (/insufficientfundsforrent|insufficient funds for rent/i.test(msg)) {
    return "an account would be left below Solana's minimum balance for an account (rent)."
  }
  if (/insufficient (funds|lamports)|insufficientfundsforfee|custom program error: 0x1\b/i.test(msg)) {
    return "there isn't enough SOL for this plus the network fee."
  }
  return `${msg.slice(0, 140).replace(/[.\s]+$/, '')}.`
}

/**
 * Hand signed bytes to the network: the one path for sends, swaps, stake
 * actions and resends (bug audit 2026-10-27, BH1). "Already processed" means
 * an earlier try landed: success. A preflight refusal of a first broadcast
 * took nothing: the record goes and a plain error says so. A refused RESEND
 * keeps it: its test run can fail because the first try already landed (a
 * swap's slippage, a spent balance) or on a node that lags, and says nothing
 * about the first try (review 2026-10-28). An expired blockhash can't land
 * now — but an earlier try may have landed before it expired, so the chain
 * is asked before the wallet says "did not go through". No answer, or one
 * the wallet doesn't recognise: the record stays, marked failed, and the
 * same bytes can be sent again (SolBroadcastError).
 */
export async function submitSolTx(
  chain: SolChainConfig,
  signature: string,
  signed: string,
  entry?: PendingSol,
): Promise<string> {
  const resend = entry?.failed === true
  const sent = (): string => {
    if (resend) markPendingSent(entry)
    return signature
  }
  try {
    await rpc<string>(chain, 'sendTransaction', [signed, { encoding: 'base64', preflightCommitment: 'confirmed' }])
    return sent()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const outcome = solSubmitOutcome(e)
    // "already processed" says it landed, not that it worked
    const landedAs = async () => {
      const st = await solTxStatus(chain, signature).catch(() => null)
      if (st === 'failed') {
        if (entry !== undefined) dropPending(entry)
        throw new Error(SOL_LANDED_FAILED)
      }
      return sent()
    }
    if (outcome === 'landed') return landedAs()
    if (outcome === 'expired') {
      const seen = await solTxSeen(chain, signature).catch(() => null)
      if (seen === true) return landedAs()
      // "Blockhash not found" from one RPC is expired only once the chain's
      // height has passed the blockhash's last valid height: a lagging node
      // says it too (bug audit 2026-10-27, BM17). With no height on record,
      // only the ledger's hard limit says so; "passed" on no evidence let a
      // lagging node end the hold on a resend (review 2026-10-28).
      const lvbh = entry?.lastValidBlockHeight
      const passed =
        entry === undefined
          ? true
          : lvbh === undefined || lvbh === Number.MAX_SAFE_INTEGER
            ? Date.now() - entry.ts >= SOL_TTL_HARD_MS
            : await solBlockHeight(chain).then((h) => h > lvbh, () => false)
      if (seen === false && passed) {
        if (entry !== undefined) dropPending(entry)
        throw new SolExpiredError()
      }
      if (entry !== undefined) markPendingFailed(entry)
      throw new SolBroadcastError(
        seen === false
          ? "The network node didn't recognise this transaction's window, though the chain says it is still open, so it may yet go through. The wallet holds new sends until it knows."
          : "The transaction's network window closed, and the wallet couldn't ask whether it landed first.",
        signature,
        signed,
      )
    }
    if (outcome === 'refused') {
      if (resend) {
        throw new SolBroadcastError(
          `The network refused this second try in its test run: ${solRefusalText(msg)} The first try may still go through, so new sends on ${chain.networkName} wait until its window closes.`,
          signature,
          signed,
        )
      }
      if (entry !== undefined) dropPending(entry)
      throw new Error(`The network refused this transaction: ${solRefusalText(msg)} Nothing was sent.`)
    }
    if (entry !== undefined) markPendingFailed(entry)
    throw new SolBroadcastError(
      `The network didn't confirm it received this transaction (${msg.slice(0, 80)}). It may still go through.`,
      signature,
      signed,
    )
  }
}

/**
 * Send the SAME signed bytes again after a failed broadcast. Sending twice is
 * harmless (same signature, the network keeps one); building a fresh
 * transaction is what could pay twice. "Already processed" means the first
 * try did land; an expired blockhash that the chain never saw means it never
 * will.
 */
export async function rebroadcastSol(chain: SolChainConfig, signature: string, signed: string): Promise<string> {
  const entry = pendingSol(chain.id).find((p) => p.signature === signature)
  return submitSolTx(chain, signature, signed, entry)
}

/**
 * The chain's current block height, for the ledger's expiry by blockhash
 * validity — from getEpochInfo: publicnode answers getBlockHeight with the
 * SLOT (~22 million higher on mainnet), which made every attempt look
 * expired (bug audit 2026-10-27, BM2).
 */
export function solBlockHeight(chain: SolChainConfig): Promise<number> {
  return rpc<{ blockHeight?: unknown }>(chain, 'getEpochInfo', [{ commitment: 'confirmed' }]).then((r) => {
    const h = r?.blockHeight
    if (typeof h !== 'number' || !Number.isSafeInteger(h)) throw new Error('bad block height')
    return h
  })
}

/** True once the network reports the signature at any confirmation level. */
/**
 * Where an attempt stands: landed and did what it said ('ok'), landed but
 * failed there ('failed': only its fee was spent; bug audit 2026-10-27,
 * BL25 — it used to read as a success), or not on the network ('unseen').
 * A failed lookup throws.
 */
export async function solTxStatus(chain: SolChainConfig, signature: string): Promise<'ok' | 'failed' | 'unseen'> {
  const r = await rpc<{ value?: ({ err?: unknown } | null)[] }>(chain, 'getSignatureStatuses', [
    [signature],
    { searchTransactionHistory: true },
  ])
  const st = r.value?.[0] ?? null
  if (st === null) return 'unseen'
  return st.err != null ? 'failed' : 'ok'
}

/**
 * Back from a failed broadcast: where the attempt stands, as solTxStatus.
 * Once the form shows the answer (it went through, or it failed on chain),
 * the record has done its job; kept, the next send repeated the news as "it
 * went through after all" or a one-off refusal (review 2026-10-28).
 */
export async function settleSolAttempt(chain: SolChainConfig, signature: string): Promise<'ok' | 'failed' | 'unseen'> {
  const status = await solTxStatus(chain, signature)
  if (status !== 'unseen') {
    for (const p of pendingSol(chain.id)) if (p.signature === signature) dropPending(p)
  }
  return status
}

/** The message for an attempt that landed but failed on chain. */
export const SOL_LANDED_FAILED =
  'The transaction reached the network but failed there, so nothing was sent; only its network fee was spent. You can try again.'

export async function solTxSeen(chain: SolChainConfig, signature: string): Promise<boolean> {
  const r = await rpc<{ value?: (object | null)[] }>(chain, 'getSignatureStatuses', [
    [signature],
    { searchTransactionHistory: true },
  ])
  return (r.value?.[0] ?? null) !== null
}

/**
 * Refuse a new send while a recent attempt on this chain is neither seen by
 * the network nor expired: its blockhash is still valid, so it could land
 * alongside the new one (unlike EVM, a fresh blockhash is not a nonce).
 * Seen → fine (dropped); expired → dead (pruned by the ledger's TTL).
 */
export async function assertNoSolInFlight(chain: SolChainConfig): Promise<void> {
  const block = await solInFlightBlock(
    chain.id,
    (signature) => solTxSeen(chain, signature),
    () => solBlockHeight(chain),
  )
  if (block === null) return
  const p = block.entry
  if (block.reason === 'landed') {
    // landed, but failed there: nothing was paid, so say that instead (BL25)
    if ((await solTxStatus(chain, p.signature).catch(() => null)) === 'failed') {
      dismissLanded(p)
      throw new Error(`Your transaction from ${agoText(p.ts)} on ${chain.networkName} reached the network but failed there, so nothing was paid (its network fee was spent). You can go ahead now.`)
    }
    throw new EarlierSendLanded(
      p,
      `Your transaction from ${agoText(p.ts)}${p.to !== undefined ? ` (to ${p.to.slice(0, 8)}…)` : ''} on ${chain.networkName}`,
    )
  }
  throw new Error(
    block.reason === 'pending'
      ? `A send from ${agoText(p.ts)} may still go through — its network window hasn't closed. Wait a minute, then try again; sending now could pay twice.`
      : `Couldn't check whether your send from ${agoText(p.ts)} went through. Wait a minute and try again — sending without knowing could pay twice.`,
  )
}

export async function broadcastSolSend(key: SolKey, prepared: PreparedSolSend): Promise<string> {
  const [txid, signed] = solLib.signTx(key.privateKey, prepared.unsigned)
  // recorded BEFORE the send so even a timed-out attempt leaves a trace
  const entry: PendingSol = {
    kind: 'sol',
    chainId: prepared.chain.id,
    signature: txid,
    to: prepared.to,
    ts: Date.now(),
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  }
  recordPending(entry)
  // the send log trusts an address paid, or maybe paid: not one the network
  // refused, nor an attempt that expired unseen (bug audit 2026-10-27, BL19)
  try {
    const sig = await submitSolTx(prepared.chain, txid, signed, entry)
    recordSentTo(prepared.chain.id, prepared.to)
    return sig
  } catch (e) {
    if (e instanceof SolBroadcastError) recordSentTo(prepared.chain.id, prepared.to)
    throw e
  }
}

/** Devnet only: free test SOL straight from the cluster — no captcha, no site. */
export async function requestDevnetAirdrop(address: string): Promise<string> {
  return rpc<string>(SOL_CHAINS['sol-devnet'], 'requestAirdrop', [address, 1_000_000_000])
}

// ---------------------------------------------------------------------------
// Display + QR parsing.

export function formatSol(v: bigint): string {
  return formatEvmAmount(v, 9)
}

export function formatSolUsdc(chain: SolChainConfig, v: bigint): string {
  return formatEvmAmount(v, chain.usdc.decimals)
}

/**
 * A Solana Pay amount (a plain decimal, already checked) in the asset's
 * smallest units. More decimal places than the asset has make the request
 * invalid: rounding would leave the payment short (bug audit 2026-10-27, BH6).
 */
export function solPayUnits(raw: string, decimals: number, symbol: string): bigint {
  const [whole = '', frac = ''] = raw.split('.')
  if (frac.length > decimals) {
    throw new Error(`That payment request asks for more decimal places than ${symbol} has (${decimals}).`)
  }
  return BigInt((whole === '' ? '0' : whole) + frac.padEnd(decimals, '0'))
}

/** Bare base58 address or a Solana Pay URI (solana:<address>?amount=…). */
export function parseSolScanned(text: string): {
  address: string
  /** lamports — set only for plain SOL requests (no spl-token parameter) */
  amount?: bigint
  /** Solana Pay spl-token parameter: the mint the amount is denominated in */
  splToken?: string
  /** the token-denominated amount, as its original decimal string */
  tokenAmount?: string
  /** Solana Pay `reference` keys (the recipient matches the payment by them) */
  reference?: string[]
  /** Solana Pay `memo` */
  memo?: string
} {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('The scanned code was empty.')
  let candidate = trimmed
  let amount: bigint | undefined
  let splToken: string | undefined
  let tokenAmount: string | undefined
  let reference: string[] | undefined
  let memo: string | undefined
  const uri = /^solana:([^?]+)(?:\?(.*))?$/i.exec(trimmed)
  if (uri) {
    candidate = uri[1]!
    const q = new URLSearchParams(uri[2] ?? '')
    // A merchant that set these may not credit a payment without them.
    const refs = q.getAll('reference')
    if (refs.length > 0) {
      if (refs.length > 4 || !refs.every(isValidSolAddress)) {
        throw new Error('That payment request carries a reference this wallet cannot attach.')
      }
      reference = refs
    }
    const m = q.get('memo')
    if (m !== null && m !== '') {
      if (utf8ToBytes(m).length > MEMO_MAX_BYTES || /[\u0000-\u001f\u007f]/.test(m)) {
        throw new Error('That payment request carries a memo this wallet cannot attach.')
      }
      memo = m
    }
    // The amount is exact: a merchant credits a payment only when it is
    // paid to the last unit, so a malformed amount, or one with more
    // decimal places than the asset has, makes the request invalid instead
    // of being rounded or dropped (bug audit 2026-10-27, BH6).
    const raw = q.get('amount') ?? ''
    if (raw !== '' && !/^(\d+\.?\d*|\.\d+)$/.test(raw)) {
      throw new Error("That payment request's amount isn't a valid number.")
    }
    const hasAmount = raw !== ''
    const spl = q.get('spl-token')
    if (spl !== null) {
      // Per Solana Pay, `amount` is then denominated in THAT token, not SOL —
      // treating it as SOL would autofill e.g. a 100-USDC request as 100 SOL.
      splToken = spl
      if (hasAmount) tokenAmount = raw
    } else if (hasAmount) {
      const v = solPayUnits(raw, 9, 'SOL')
      if (v > 0n) amount = v
    }
  }
  if (isValidSolAddress(candidate)) {
    return {
      address: candidate,
      ...(amount !== undefined && { amount }),
      ...(splToken !== undefined && { splToken }),
      ...(tokenAmount !== undefined && { tokenAmount }),
      ...(reference !== undefined && { reference }),
      ...(memo !== undefined && { memo }),
    }
  }
  if (/^0x/i.test(candidate)) {
    throw new Error("That's an Ethereum-style address — Solana addresses don't start with 0x.")
  }
  if (/^(bc1|tb1|ltc1|bitcoin:|dogecoin:|litecoin:)/i.test(candidate) || candidate.startsWith('D')) {
    throw new Error("That looks like a Bitcoin-family address, not a Solana address.")
  }
  throw new Error("That code doesn't contain a valid Solana address.")
}

/** Per-chain UI state held by App (null balance = not yet loaded). */
export interface SolUiState {
  balance: bigint | null
  usdcBalance: bigint | null
  /** seed-derived stake accounts (solstake.ts); best-effort like history */
  stakeAccounts: import('./solstake').StakeAccountView[]
  txs: SolTx[]
  /** the last refresh's history or stake lookup failed (bug audit 2026-10-27, BM8) */
  lookupFailed?: boolean
  loading: boolean
  error: string | null
}
