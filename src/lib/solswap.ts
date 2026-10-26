// Jupiter swap engine — SOL ↔ USDC on Solana mainnet, via Jupiter Swap V2
// /build (keyless; live-verified 2026-10-25: CORS allowed, no key). The old
// keyless lite-api /swap/v1 is deprecated and being phased out.
//
// SECURITY CORE — never sign a server-built transaction blind. /build returns
// the quote and the INSTRUCTIONS; this module assembles the transaction
// itself and checks the exact bytes it will sign:
//   1. the build's shape: version 0, no "other" or tip instructions, and no
//      signer but our own address anywhere;
//   2. lookup tables come from the chain, and Jupiter's list of each table
//      must agree with it; the wallet compiles the v0 message with its own
//      blockhash and a compute-unit limit it measures by simulation (1.2×);
//   3. walks every instruction of the compiled bytes: programs must be on a
//      fixed allow-list, token/system instructions on a per-program
//      allow-list (no Approve, SetAuthority, Assign, Burn…), the wallet's
//      seed-derived stake accounts must appear nowhere, and the priority fee
//      is computed from the ComputeBudget instructions themselves — one
//      signature authorizes every instruction in a Solana message, and the
//      simulation below only diffs two balances, so it cannot see an
//      authority grant that moves nothing at simulation time;
//   4. exactly one Jupiter instruction, one of the four exact-in swap
//      variants (layouts from the program's on-chain IDL), whose decoded
//      fields must say what we asked: our input amount, the quoted output,
//      our slippage, Kailah's 0.5% fee into Kailah's fee account (exactly;
//      never more, never elsewhere), no positive-slippage share, and our
//      address as the transfer authority; the guaranteed minimum shown and
//      enforced below is computed from those decoded fields;
//   5. simulates the final bytes (sigVerify off), reads OUR account's and the
//      fee account's simulated post-balances, and refuses unless the fee
//      account gains exactly 0.5% and the SOL/USDC deltas honor that minimum
//      within fee + rent bounds.
// Signing is byte-exact (verified: the message bytes are untouched by
// signTx), so the transaction that was simulated is the one broadcast.
// A failed broadcast is re-quoted from scratch — never blind-retried.

import * as solLib from 'micro-sol-signer'
import { base58, base64 } from '@scure/base'
import {
  assertNoSolInFlight,
  blockHeightOf,
  getSolBalance,
  SolBroadcastError,
  solRpc,
  solUsdcAta,
  tokenAmountFromBase64,
  type SolChainConfig,
  type SolKey,
} from './sol'
import { MAX_STAKE_ACCOUNTS, stakeAccountAddress } from './solstake'
import { recordPending } from './pending'

export type SwapDirection = 'sol-to-usdc' | 'usdc-to-sol'

export const SOL_WRAPPED_MINT = 'So11111111111111111111111111111111111111112'
const JUP_BASE = 'https://api.jup.ag/swap/v2'
/** 0.5% — shown on the review screen, enforced on-chain by the route. */
export const SWAP_SLIPPAGE_BPS = 50
/**
 * Kailah's swap fee: 0.5%, paid in USDC to the developer and shown on the form
 * and the review screen. Jupiter takes it inside the swap (from the USDC
 * output when selling SOL, from the USDC input when buying SOL) and charges
 * no fee of its own on /build.
 */
export const SWAP_FEE_BPS = 50
/** The developer's fee wallet and its USDC token account (checked on-chain 2026-10-25). */
export const SWAP_FEE_WALLET = 'BpmzmuZieAHqCm8s183T9c397K46YqsEQKbyyNo4Wo8b'
export const SWAP_FEE_ACCOUNT = 'F5VXwGCmbct91xohG4CTqiXg25d23zYNQav1pB5eH2oF'

/**
 * The fee a wallet pays: none for the fee wallet itself. Its USDC account IS
 * the fee account, so a fee would only move its own coins in a circle, and the
 * fee check could not tell the swap's output from the fee (a swap from the fee
 * wallet was refused that way, 2026-10-25).
 */
export function swapFeeBpsFor(chain: SolChainConfig, owner: string): number {
  return solUsdcAta(chain, owner) === SWAP_FEE_ACCOUNT ? 0 : SWAP_FEE_BPS
}
/** A build older than this is rebuilt before preparing (its blockhash lives ~60 s). */
const BUILD_MAX_AGE_MS = 30_000

const FRIENDLY_NET =
  "Couldn't reach the swap service right now. Your coins are safe; try again in a few minutes."
const FRIENDLY_BUSY =
  'The swap service is busy right now (too many requests). Your coins are safe; try again in a minute.'

/** One instruction as /build returns it. Everything is checked before use. */
interface JupIx {
  programId?: unknown
  accounts?: unknown
  data?: unknown
}

interface JupBuildResponse {
  inputMint?: string
  outputMint?: string
  inAmount?: string
  outAmount?: string
  otherAmountThreshold?: string
  swapMode?: string
  slippageBps?: number
  priceImpactPct?: string
  computeBudgetInstructions?: JupIx[]
  setupInstructions?: JupIx[]
  swapInstruction?: JupIx
  cleanupInstruction?: JupIx | null
  otherInstructions?: JupIx[]
  tipInstruction?: JupIx | null
  addressesByLookupTableAddress?: Record<string, unknown>
  transactionVersion?: number | string
  error?: string
}

export interface SwapQuote {
  direction: SwapDirection
  /** smallest units of the input asset (lamports / USDC units) */
  inAmount: bigint
  /** what the user receives, already net of Kailah's fee */
  outAmount: bigint
  /** worst case after slippage — what the route enforces on-chain */
  minOutAmount: bigint
  priceImpactPct: number
  /** the fee rate this wallet pays (0 for the fee wallet itself) */
  feeBps: number
  /** Kailah's fee in USDC units, estimated from the quote (the review shows the simulated one) */
  estimatedFee: bigint
  /** the address the instructions were built for */
  taker: string
  /** Date.now() when built; prepareSwap rebuilds a stale one */
  builtAt: number
  /** verbatim /build response — the instructions prepareSwap assembles */
  build: JupBuildResponse
}

async function jupFetch(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(FRIENDLY_NET)
  }
  if (res.status === 429) throw new Error(FRIENDLY_BUSY)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(FRIENDLY_NET)
  }
  const err = (body as { error?: string }).error
  if (!res.ok || err) {
    if (err && /route|no.*path/i.test(err)) {
      throw new Error('No swap route is available for that amount right now — try a different amount.')
    }
    throw new Error(err ? `The swap service refused: ${err}` : FRIENDLY_NET)
  }
  return body
}

/**
 * Kailah's fee in USDC units. Selling SOL, it is 0.5% of the gross USDC output,
 * of which the user keeps `usdcToUser`. Buying SOL, it is 0.5% of the USDC
 * input. Jupiter rounds down (measured by simulation, 2026-10-25).
 */
function expectedSwapFee(
  direction: SwapDirection,
  usdcIn: bigint,
  usdcToUser: bigint,
  feeBps: number,
): bigint {
  if (feeBps === 0) return 0n
  const bps = BigInt(feeBps)
  if (direction === 'usdc-to-sol') return (usdcIn * bps) / 10_000n
  // gross = user + fee and fee = floor(gross × bps / 10000)
  const gross = (usdcToUser * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps)
  return (gross * bps) / 10_000n
}

/**
 * Quote AND instructions for `taker` in one /build call. The figures here are
 * for the form; prepareSwap re-derives everything it relies on from the
 * transaction it assembles.
 */
export async function getSwapQuote(
  chain: SolChainConfig,
  direction: SwapDirection,
  amount: bigint,
  taker: string,
): Promise<SwapQuote> {
  if (!chain.mainnet) throw new Error('Swapping is only available on Solana mainnet.')
  if (amount <= 0n) throw new Error('Enter an amount to swap.')
  const inputMint = direction === 'sol-to-usdc' ? SOL_WRAPPED_MINT : chain.usdc.mint
  const outputMint = direction === 'sol-to-usdc' ? chain.usdc.mint : SOL_WRAPPED_MINT
  const feeBps = swapFeeBpsFor(chain, taker)
  const b = (await jupFetch(
    `${JUP_BASE}/build?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amount}&taker=${taker}&slippageBps=${SWAP_SLIPPAGE_BPS}` +
      (feeBps > 0 ? `&platformFeeBps=${feeBps}&feeAccount=${SWAP_FEE_ACCOUNT}` : ''),
  )) as JupBuildResponse
  if (!b.inAmount || !b.outAmount || !b.otherAmountThreshold || !b.swapInstruction) {
    throw new Error('The swap service returned an incomplete quote — try again.')
  }
  if (b.inputMint !== inputMint || b.outputMint !== outputMint || b.inAmount !== amount.toString()) {
    throw new Error(MISMATCH)
  }
  const outAmount = BigInt(b.outAmount)
  return {
    direction,
    inAmount: BigInt(b.inAmount),
    outAmount,
    minOutAmount: BigInt(b.otherAmountThreshold),
    // Jupiter reports a fraction ("0.001" = 0.1%); the form shows percent.
    priceImpactPct: Number(b.priceImpactPct ?? '0') * 100,
    feeBps,
    estimatedFee: expectedSwapFee(direction, amount, outAmount, feeBps),
    taker,
    builtAt: Date.now(),
    build: b,
  }
}

// ---------------------------------------------------------------------------
// Build + verify.

export interface PreparedSwap {
  chain: SolChainConfig
  direction: SwapDirection
  inAmount: bigint
  outAmount: bigint
  minOutAmount: bigint
  priceImpactPct: number
  /** base + priority fee the transaction will pay (lamports) */
  feeLamports: bigint
  /** simulated net changes to OUR account — the proof behind the review screen */
  simulatedSolDelta: bigint
  simulatedUsdcDelta: bigint
  /** Kailah's fee in USDC units, as the simulation paid it into the fee account */
  swapFee: bigint
  /** the fee rate charged (0 when the fee wallet swaps for itself) */
  swapFeeBps: number
  /** the exact bytes that were simulated; signing does not alter them */
  txBase64: string
  /** the blockhash's last valid block height: when this attempt can no longer land */
  lastValidBlockHeight: number
}

/** An instruction in micro-sol-signer's encoder form. */
interface TxIx {
  program: string
  keys: { address: string; sign: boolean; write: boolean }[]
  data: Uint8Array
}

/** Decoded arguments of the one Jupiter swap instruction. */
interface JupiterSwapArgs {
  inAmount: bigint
  quotedOutAmount: bigint
  slippageBps: number
  platformFeeBps: number
  positiveSlippageBps: number
  /** the account in the instruction's user_transfer_authority slot */
  authority: string
  /** the user's source and destination token accounts, their mints and token programs */
  sourceAccount: string
  destinationAccount: string
  sourceMint: string
  destinationMint: string
  sourceTokenProgram: string
  destinationTokenProgram: string
  /** the account in the platform-fee slot (a route account when there is no fee) */
  feeAccount: string | undefined
}

function isAddress(a: unknown): a is string {
  if (typeof a !== 'string') return false
  try {
    solLib.validateAddress(a)
    return true
  } catch {
    return false
  }
}

/** Check one /build instruction and convert it; anything malformed is a mismatch. */
function toTxIx(ix: JupIx | null | undefined): TxIx {
  if (!ix || !isAddress(ix.programId) || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') {
    throw new Error(MISMATCH)
  }
  const keys = (ix.accounts as unknown[]).map((a) => {
    const m = a as { pubkey?: unknown; isSigner?: unknown; isWritable?: unknown } | null
    if (!m || !isAddress(m.pubkey) || typeof m.isSigner !== 'boolean' || typeof m.isWritable !== 'boolean') {
      throw new Error(MISMATCH)
    }
    return { address: m.pubkey, sign: m.isSigner, write: m.isWritable }
  })
  let data: Uint8Array
  try {
    data = Uint8Array.from(atob(ix.data), (c) => c.charCodeAt(0))
  } catch {
    throw new Error(MISMATCH)
  }
  return { program: ix.programId, keys, data }
}

/** The runtime's ceiling, and the probe limit before the real one is measured. */
const CU_LIMIT_MAX = 1_400_000
/** Jupiter routes use up to four; more than this is not a swap we recognize. */
const MAX_LOOKUP_TABLES = 8

function computeUnitLimitIx(units: number): TxIx {
  const data = new Uint8Array(5)
  data[0] = 2 // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true)
  return { program: COMPUTE_BUDGET_PROGRAM, keys: [], data }
}

/**
 * Compile a v0 transaction. Every account other than the fee payer, a signer
 * or a program id goes through a lookup table when one holds it (the runtime
 * requires those three kinds to be static keys). Writability is a per-message
 * property, so each account's flag is the OR across all instructions.
 */
function compileSwapTx(
  owner: string,
  blockhash: string,
  instructions: TxIx[],
  tables: Map<string, string[]>,
): string {
  const pinned = new Set<string>([owner])
  const writable = new Set<string>()
  for (const ix of instructions) {
    pinned.add(ix.program)
    for (const k of ix.keys) {
      if (k.sign) pinned.add(k.address)
      if (k.write) writable.add(k.address)
    }
  }
  const ref = new Map<string, string>()
  for (const [table, addrs] of tables) {
    addrs.forEach((a, i) => {
      if (!ref.has(a)) ref.set(a, `${table}:${i}`)
    })
  }
  const compiled = instructions.map((ix) => ({
    program: ix.program,
    keys: ix.keys.map((k) => ({
      address: pinned.has(k.address) ? k.address : (ref.get(k.address) ?? k.address),
      sign: k.sign,
      write: writable.has(k.address),
    })),
    data: ix.data,
  }))
  const bytes = solLib.Transaction.encode({
    msg: { version: 0, feePayer: owner, blockhash, instructions: compiled },
    signatures: {},
  } as unknown as Parameters<typeof solLib.Transaction.encode>[0])
  return base64.encode(bytes)
}

interface RawInstruction {
  programIdx?: number
  keys?: number[]
  data?: Uint8Array
}

interface RawLookup {
  account?: string
  writableIndexes?: number[]
  readonlyIndexes?: number[]
}

interface DecodedSwapTx {
  signatures: unknown[]
  msg?: {
    data?: {
      header?: { requiredSignatures?: number }
      keys?: string[]
      instructions?: RawInstruction[]
      /** v0 address-table lookups; absent on legacy messages */
      ALT?: RawLookup[]
    }
  }
}

interface SimAccount {
  lamports?: number
  data?: unknown
}

interface SimResult {
  value: {
    err: unknown
    logs?: string[]
    accounts?: (SimAccount | null)[]
    unitsConsumed?: number
  }
}

/** Token amount from a simulated account in either encoding the RPC uses. */
function tokenAmountFrom(acc: SimAccount | null | undefined): bigint {
  if (!acc) return 0n
  const data = acc.data as
    | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
    | [string, string]
    | undefined
  if (Array.isArray(data)) {
    // base64 SPL token account layout: amount is a u64 LE at bytes 64..72
    const bytes = Uint8Array.from(atob(data[0] ?? ''), (c) => c.charCodeAt(0))
    if (bytes.length < 72) return 0n
    let v = 0n
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[64 + i]!)
    return v
  }
  return BigInt(data?.parsed?.info?.tokenAmount?.amount ?? '0')
}

/** Rent for a token account, used as the allowed cost of a first-time ATA. */
const ATA_RENT_FALLBACK = 2_039_280n

/**
 * The chain rounds the priority fee UP when charging while the swap service
 * reports it un-rounded — observed live as exactly +1 lamport on a
 * first-time swap, where the cost bound has zero slack and the mismatch gate
 * wrongly refused an honest transaction. Tolerate dust-level rounding only:
 * 1000 lamports is ~$0.0001 and far below anything an attack would move.
 */
const FEE_ROUNDING_SLACK = 1_000n

const MISMATCH =
  'The transaction the swap service returned does not match its quote — refusing to sign it. Nothing was sent and your coins are untouched.'

// ---------------------------------------------------------------------------
// Instruction-level verification (step 2 of the security core).

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const SWAP_TOKEN_PROGRAMS: string[] = [solLib.TOKEN_PROGRAM, solLib.TOKEN_PROGRAM2022]
const SWAP_ALLOWED_PROGRAMS = new Set<string>([
  COMPUTE_BUDGET_PROGRAM,
  solLib.SYS_PROGRAM,
  ...SWAP_TOKEN_PROGRAMS,
  solLib.ASSOCIATED_TOKEN_PROGRAM,
  JUPITER_V6_PROGRAM,
])
// SPL-token instructions a swap legitimately uses. Everything else — above
// all Approve(4), SetAuthority(6), Burn(8), ApproveChecked(13) — is refused:
// those change nothing the simulation can see.
// Transfer(3) and TransferChecked(12) are NOT here: the owner's one signature
// would authorize a transfer out of ANY token account the owner holds, and
// the simulation diff only watches SOL and USDC (audit 2026-10-26). Jupiter
// moves tokens by CPI inside its own program, never as a top-level transfer.
const ALLOWED_TOKEN_IX = new Set([
  1, // InitializeAccount (its owner must be us, checked below)
  9, // CloseAccount (wSOL unwrap; lamport destination must be us, checked below)
  16, // InitializeAccount2 (owner in the data; must be us)
  17, // SyncNative
  18, // InitializeAccount3 (owner in the data; must be us)
  21, // GetAccountDataSize
  22, // InitializeImmutableOwner
])
const TOKEN_IX_CLOSE = 9
const TOKEN_IX_INIT = 1
const TOKEN_IX_INIT2 = 16
const TOKEN_IX_INIT3 = 18
const SYSTEM_IX_TRANSFER = 2
const ATA_IX_CREATE = 0
const ATA_IX_CREATE_IDEMPOTENT = 1
// System-program instructions a swap legitimately uses (wSOL wrap). Assign /
// AssignWithSeed would hand one of our accounts to another program.
const ALLOWED_SYSTEM_IX = new Set([0, 2, 3]) // CreateAccount, Transfer, CreateAccountWithSeed
/** Nobody pays more than this to prioritize a swap (0.01 SOL). */
const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n

function u32le(d: Uint8Array, off: number): number {
  return (d[off]! | (d[off + 1]! << 8) | (d[off + 2]! << 16)) + d[off + 3]! * 0x1000000
}

function u64le(d: Uint8Array, off: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[off + i]!)
  return v
}

function u16le(d: Uint8Array, off: number): number {
  return d[off]! | (d[off + 1]! << 8)
}

/**
 * The exact-in swap instructions of the Jupiter v6 program, keyed by their
 * 8-byte Anchor discriminator (sha256("global:<name>")), with the slots of
 * the accounts the gate pins. Layouts are from the program's on-chain IDL
 * (read 2026-10-25 and again 2026-10-26): the v2 forms start with in_amount
 * u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16,
 * positive_slippage_bps u16, then the route plan. Only the v2 forms are
 * accepted: the older `route` / `shared_accounts_route` put their fields
 * AFTER the route plan, so a decoder has to read them from the end, while
 * the program reads from the front and ignores trailing bytes — a build
 * could show the gate honest numbers and the program hostile ones (audit
 * 2026-10-26). Every other Jupiter instruction (exact-out, token-ledger,
 * claim…) is refused. The fee account has no named slot in the v2 forms; it
 * is the first account after their named ones (measured live, 2026-10-25).
 */
interface JupiterVariant {
  shared: boolean
  authority: number
  source: number
  destination: number
  sourceMint: number
  destinationMint: number
  sourceTokenProgram: number
  destinationTokenProgram: number
  fee: number
}
const JUPITER_SWAPS: Record<string, JupiterVariant> = {
  // route_v2
  bb64facc31c4af14: { shared: false, authority: 0, source: 1, destination: 2, sourceMint: 3, destinationMint: 4, sourceTokenProgram: 5, destinationTokenProgram: 6, fee: 10 },
  // shared_accounts_route_v2
  d19853937cfed8e9: { shared: true, authority: 1, source: 2, destination: 5, sourceMint: 6, destinationMint: 7, sourceTokenProgram: 8, destinationTokenProgram: 9, fee: 12 },
}

function decodeJupiterSwap(d: Uint8Array, keys: string[]): JupiterSwapArgs {
  if (d.length < 8) throw new Error(MISMATCH)
  const disc = Array.from(d.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  const variant = JUPITER_SWAPS[disc]
  if (variant === undefined) throw new Error(MISMATCH)
  const head = 8 + (variant.shared ? 1 : 0) // the shared form carries an id: u8 first
  if (d.length < head + 22 + 4) throw new Error(MISMATCH)
  const slot = (i: number): string => {
    const k = keys[i]
    if (k === undefined) throw new Error(MISMATCH)
    return k
  }
  return {
    inAmount: u64le(d, head),
    quotedOutAmount: u64le(d, head + 8),
    slippageBps: u16le(d, head + 16),
    platformFeeBps: u16le(d, head + 18),
    positiveSlippageBps: u16le(d, head + 20),
    authority: slot(variant.authority),
    sourceAccount: slot(variant.source),
    destinationAccount: slot(variant.destination),
    sourceMint: slot(variant.sourceMint),
    destinationMint: slot(variant.destinationMint),
    sourceTokenProgram: slot(variant.sourceTokenProgram),
    destinationTokenProgram: slot(variant.destinationTokenProgram),
    feeAccount: keys[variant.fee],
  }
}

/** Lookup-table contents from the chain: a 56-byte header, then 32-byte addresses. */
async function loadLookupTables(chain: SolChainConfig, tableAddrs: string[]): Promise<string[][]> {
  if (tableAddrs.length === 0) return []
  const res = await solRpc<{ value: ({ data?: unknown } | null)[] }>(chain, 'getMultipleAccounts', [
    tableAddrs,
    { encoding: 'base64' },
  ])
  const tables = (res.value ?? []).map((acc) => {
    const data = acc?.data
    const b64 = Array.isArray(data) ? (data[0] as string | undefined) : undefined
    if (typeof b64 !== 'string') throw new Error(MISMATCH)
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    if (bytes.length < 56 || (bytes.length - 56) % 32 !== 0) throw new Error(MISMATCH)
    const out: string[] = []
    for (let off = 56; off < bytes.length; off += 32) {
      out.push(base58.encode(bytes.subarray(off, off + 32)))
    }
    return out
  })
  if (tables.length !== tableAddrs.length) throw new Error(MISMATCH)
  return tables
}

/**
 * Full account list of a decoded message: static keys, then every lookup
 * table's writable addresses, then their readonly addresses — the index space
 * instructions reference. Table contents come from the chain, not the swap
 * service. Any shape surprise throws (fail closed).
 */
async function resolveAccountList(
  chain: SolChainConfig,
  staticKeys: string[],
  lookups: RawLookup[],
): Promise<string[]> {
  if (lookups.length === 0) return staticKeys
  const tableAddrs = lookups.map((l) => l.account)
  if (tableAddrs.some((a) => typeof a !== 'string')) throw new Error(MISMATCH)
  const tables = await loadLookupTables(chain, tableAddrs as string[])
  const pick = (tableIdx: number, idxs: number[] | undefined): string[] =>
    (idxs ?? []).map((i) => {
      const addr = tables[tableIdx]![i]
      if (addr === undefined) throw new Error(MISMATCH)
      return addr
    })
  return [
    ...staticKeys,
    ...lookups.flatMap((l, t) => pick(t, l.writableIndexes)),
    ...lookups.flatMap((l, t) => pick(t, l.readonlyIndexes)),
  ]
}

/**
 * Enforce the program/instruction allow-lists, decode the one Jupiter swap
 * instruction, and compute the priority fee from the transaction's own
 * ComputeBudget instructions (never from the swap service's self-reported
 * number). Throws MISMATCH on anything unexpected.
 */
async function verifySwapInstructions(
  chain: SolChainConfig,
  owner: string,
  decoded: DecodedSwapTx,
): Promise<{ priorityFeeLamports: bigint; jupiter: JupiterSwapArgs }> {
  const msgData = decoded.msg?.data
  const staticKeys = msgData?.keys
  const instructions = msgData?.instructions
  if (!staticKeys || !instructions || instructions.length === 0) throw new Error(MISMATCH)

  const accounts = await resolveAccountList(chain, staticKeys, msgData.ALT ?? [])
  const accountAt = (i: number | undefined): string => {
    const a = i !== undefined ? accounts[i] : undefined
    if (a === undefined) throw new Error(MISMATCH)
    return a
  }

  // The wallet's stake accounts derive from public seeds, so anyone can
  // compute them — and their balances are not in the simulated set. A swap
  // has no business referencing them at all.
  for (let i = 0; i < MAX_STAKE_ACCOUNTS; i++) {
    if (accounts.includes(stakeAccountAddress(owner, i))) throw new Error(MISMATCH)
  }

  let unitLimit: bigint | null = null
  let unitPriceMicro = 0n
  let jupiter: JupiterSwapArgs | null = null

  for (const ix of instructions) {
    // program ids must live in the static keys (the runtime enforces the same)
    const program = ix.programIdx !== undefined ? staticKeys[ix.programIdx] : undefined
    if (program === undefined || !SWAP_ALLOWED_PROGRAMS.has(program)) throw new Error(MISMATCH)
    const d = ix.data ?? new Uint8Array()

    if (program === JUPITER_V6_PROGRAM) {
      // exactly one, and it must be an exact-in swap whose fields we check
      if (jupiter !== null) throw new Error(MISMATCH)
      jupiter = decodeJupiterSwap(d, (ix.keys ?? []).map(accountAt))
    } else if (program === COMPUTE_BUDGET_PROGRAM) {
      if (d.length === 0) throw new Error(MISMATCH)
      if (d[0] === 2 && d.length >= 5) unitLimit = BigInt(u32le(d, 1))
      if (d[0] === 3 && d.length >= 9) unitPriceMicro = u64le(d, 1)
    } else {
      assertHelperInstruction(owner, program, d, (i) => accountAt(ix.keys?.[i]))
    }
  }

  // ceil(units × price / 1e6); without a limit instruction the runtime cap
  // (1.4M units) bounds the worst case.
  const units = unitLimit ?? 1_400_000n
  const priorityFeeLamports = (units * unitPriceMicro + 999_999n) / 1_000_000n
  if (priorityFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) throw new Error(MISMATCH)
  if (jupiter === null) throw new Error(MISMATCH)
  return { priorityFeeLamports, jupiter }
}

/**
 * A setup/cleanup instruction (token, system or ATA program) may only move
 * value between the owner's own accounts. Run on the build's instructions
 * before anything is assembled, and again on the compiled bytes.
 */
function assertHelperInstruction(
  owner: string,
  program: string,
  d: Uint8Array,
  keyAt: (i: number) => string,
): void {
  const wsolAta = solLib.tokenAddress({ mint: SOL_WRAPPED_MINT, owner, tokenProgram: solLib.TOKEN_PROGRAM })
  if (SWAP_TOKEN_PROGRAMS.includes(program)) {
    if (d.length === 0 || !ALLOWED_TOKEN_IX.has(d[0]!)) throw new Error(MISMATCH)
    if (d[0] === TOKEN_IX_CLOSE && keyAt(1) !== owner) throw new Error(MISMATCH)
    // A token account opened in this transaction belongs to us: one
    // initialized for someone else and funded by our System Transfer would
    // hand them the lamports (InitializeAccount names the owner as account
    // 2; InitializeAccount2/3 carry it in the data).
    if (d[0] === TOKEN_IX_INIT && keyAt(2) !== owner) throw new Error(MISMATCH)
    if ((d[0] === TOKEN_IX_INIT2 || d[0] === TOKEN_IX_INIT3) && (d.length !== 33 || base58.encode(d.subarray(1)) !== owner)) {
      throw new Error(MISMATCH)
    }
  } else if (program === solLib.SYS_PROGRAM) {
    if (d.length < 4 || !ALLOWED_SYSTEM_IX.has(u32le(d, 0))) throw new Error(MISMATCH)
    // Lamports leave our account only into our own wSOL account (the wrap)
    // or back to us; a transfer to anyone else within the slippage band
    // would hide in the balance diff.
    if (u32le(d, 0) === SYSTEM_IX_TRANSFER) {
      const to = keyAt(1)
      if (to !== owner && to !== wsolAta) throw new Error(MISMATCH)
    }
  } else if (program === solLib.ASSOCIATED_TOKEN_PROGRAM) {
    // create / create-idempotent only, and the account must be ours: we pay
    // the rent, so an account for someone else would be a gift.
    const kind = d.length === 0 ? ATA_IX_CREATE : d.length === 1 ? d[0] : -1
    if (kind !== ATA_IX_CREATE && kind !== ATA_IX_CREATE_IDEMPOTENT) throw new Error(MISMATCH)
    if (keyAt(2) !== owner) throw new Error(MISMATCH)
  } else {
    throw new Error(MISMATCH)
  }
}

/**
 * The decoded Jupiter swap must say exactly what we asked for: the amounts,
 * slippage and fee fields, AND which accounts move — the swap must take the
 * input from our own account of the input mint and deliver to our own
 * account of the output mint. Without that a route could spend a different
 * token we hold (the balance diff only watches SOL and USDC) and deliver
 * exactly the floor (audit 2026-10-26).
 */
function assertSwapArgs(jupiter: JupiterSwapArgs, owner: string, q: SwapQuote, chain: SolChainConfig): void {
  const inputMint = q.direction === 'sol-to-usdc' ? SOL_WRAPPED_MINT : chain.usdc.mint
  const outputMint = q.direction === 'sol-to-usdc' ? chain.usdc.mint : SOL_WRAPPED_MINT
  const ataOf = (mint: string) => solLib.tokenAddress({ mint, owner, tokenProgram: solLib.TOKEN_PROGRAM })
  if (
    jupiter.authority !== owner ||
    jupiter.sourceAccount !== ataOf(inputMint) ||
    jupiter.destinationAccount !== ataOf(outputMint) ||
    jupiter.sourceMint !== inputMint ||
    jupiter.destinationMint !== outputMint ||
    jupiter.sourceTokenProgram !== solLib.TOKEN_PROGRAM ||
    jupiter.destinationTokenProgram !== solLib.TOKEN_PROGRAM ||
    jupiter.inAmount !== q.inAmount ||
    jupiter.quotedOutAmount !== q.outAmount ||
    jupiter.slippageBps !== SWAP_SLIPPAGE_BPS ||
    // exactly this wallet's fee, into Kailah's fee account: never more, never elsewhere
    jupiter.platformFeeBps !== q.feeBps ||
    (q.feeBps > 0 && jupiter.feeAccount !== SWAP_FEE_ACCOUNT) ||
    jupiter.positiveSlippageBps !== 0
  ) {
    throw new Error(MISMATCH)
  }
}

/**
 * A route through a third token (SOL → USD1 → USDC, say) has Jupiter create
 * the owner's account for that token in setup and never close it, stranding
 * its rent (~0.002 SOL) in an account the wallet doesn't show — and tripping
 * the SOL-cost bound, which refused such routes. For each one that doesn't
 * exist yet, a CloseAccount after the swap (which has emptied it) returns the
 * rent to the owner. Accounts that already exist are the owner's and stay.
 */
async function intermediateCloses(chain: SolChainConfig, owner: string, setup: TxIx[]): Promise<TxIx[]> {
  const created: { ata: string; tokenProgram: string }[] = []
  for (const ix of setup) {
    if (ix.program !== solLib.ASSOCIATED_TOKEN_PROGRAM) continue
    const kind = ix.data.length === 0 ? ATA_IX_CREATE : ix.data.length === 1 ? ix.data[0] : -1
    if (kind !== ATA_IX_CREATE && kind !== ATA_IX_CREATE_IDEMPOTENT) continue
    // payer, account, wallet, mint, system program, token program
    const [, ata, wallet, mint, , tokenProgram] = ix.keys.map((k) => k.address)
    if (wallet !== owner || mint === SOL_WRAPPED_MINT || mint === chain.usdc.mint) continue
    if (
      ata === undefined ||
      mint === undefined ||
      tokenProgram === undefined ||
      !SWAP_TOKEN_PROGRAMS.includes(tokenProgram) ||
      solLib.tokenAddress({ mint, owner, tokenProgram }) !== ata
    ) {
      throw new Error(MISMATCH)
    }
    if (!created.some((c) => c.ata === ata)) created.push({ ata, tokenProgram })
  }
  if (created.length === 0) return []
  const res = await solRpc<{ value?: unknown[] }>(chain, 'getMultipleAccounts', [
    created.map((c) => c.ata),
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ])
  if (!Array.isArray(res.value) || res.value.length !== created.length) throw new Error(FRIENDLY_NET)
  return created
    .filter((_, i) => res.value![i] === null)
    .map(({ ata, tokenProgram }) => ({
      program: tokenProgram,
      keys: [
        { address: ata, sign: false, write: true },
        { address: owner, sign: false, write: true }, // the rent comes back here
        { address: owner, sign: true, write: false },
      ],
      data: new Uint8Array([TOKEN_IX_CLOSE]),
    }))
}

/** Simulate (sigVerify off); a failing simulation stops the swap before signing. */
async function simulateSwap(
  chain: SolChainConfig,
  txBase64: string,
  addresses?: string[],
): Promise<SimResult> {
  const sim = await solRpc<SimResult>(chain, 'simulateTransaction', [
    txBase64,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      ...(addresses ? { accounts: { encoding: 'jsonParsed', addresses } } : {}),
    },
  ])
  if (sim.value.err != null) {
    const tail = (sim.value.logs ?? []).slice(-2).join(' · ')
    throw new Error(
      `The swap fails in simulation, so it was not signed or sent.${tail ? ` (${tail})` : ''}`,
    )
  }
  return sim
}

export async function prepareSwap(
  chain: SolChainConfig,
  owner: string,
  quote: SwapQuote,
): Promise<PreparedSwap> {
  if (!chain.mainnet) throw new Error('Swapping is only available on Solana mainnet.')
  await assertNoSolInFlight(chain)
  if (quote.taker !== owner) throw new Error(MISMATCH)
  // The rate comes from the owner, never from the quote object alone.
  const feeBps = swapFeeBpsFor(chain, owner)
  if (quote.feeBps !== feeBps) throw new Error(MISMATCH)
  // The route was priced when it was built; rebuild one that has gone stale.
  const q =
    Date.now() - quote.builtAt > BUILD_MAX_AGE_MS
      ? await getSwapQuote(chain, quote.direction, quote.inAmount, owner)
      : quote
  const b = q.build

  // 1. The build's shape: v0, no "other" or tip instructions, no foreign signer.
  if (Number(b.transactionVersion) !== 0) throw new Error(MISMATCH)
  if ((b.otherInstructions ?? []).length !== 0 || (b.tipInstruction ?? null) !== null) {
    throw new Error(MISMATCH)
  }
  // Jupiter sets only the unit price; the wallet sets the unit limit itself.
  const priceIxs = (b.computeBudgetInstructions ?? []).map(toTxIx)
  if (
    priceIxs.length > 1 ||
    priceIxs.some((ix) => ix.program !== COMPUTE_BUDGET_PROGRAM || ix.data[0] !== 3 || ix.data.length !== 9)
  ) {
    throw new Error(MISMATCH)
  }
  const setupIxs = (b.setupInstructions ?? []).map(toTxIx)
  const swapIx = toTxIx(b.swapInstruction)
  const body = [
    ...setupIxs,
    swapIx,
    ...(b.cleanupInstruction ? [toTxIx(b.cleanupInstruction)] : []),
  ]
  for (const ix of [...priceIxs, ...body]) {
    if (ix.keys.some((k) => k.sign && k.address !== owner)) throw new Error(MISMATCH)
  }
  // Refuse a route that doesn't say what we asked, and any helper
  // instruction that moves value to anyone but us, before anything is
  // simulated (step 5 checks the same again on the compiled bytes).
  if (swapIx.program !== JUPITER_V6_PROGRAM) throw new Error(MISMATCH)
  assertSwapArgs(decodeJupiterSwap(swapIx.data, swapIx.keys.map((k) => k.address)), owner, q, chain)
  for (const ix of body) {
    if (ix === swapIx) continue
    if (ix.program === JUPITER_V6_PROGRAM || ix.program === COMPUTE_BUDGET_PROGRAM) throw new Error(MISMATCH)
    assertHelperInstruction(owner, ix.program, ix.data, (i) => {
      const k = ix.keys[i]
      if (k === undefined) throw new Error(MISMATCH)
      return k.address
    })
  }
  body.push(...(await intermediateCloses(chain, owner, setupIxs)))

  // 2. Lookup tables come from the chain; Jupiter's list must agree with it.
  const listed = b.addressesByLookupTableAddress ?? {}
  const tableAddrs = Object.keys(listed)
  if (tableAddrs.length > MAX_LOOKUP_TABLES || !tableAddrs.every(isAddress)) throw new Error(MISMATCH)
  const onChain = await loadLookupTables(chain, tableAddrs)
  const tables = new Map<string, string[]>()
  tableAddrs.forEach((t, i) => {
    const claimed = listed[t]
    const actual = onChain[i]!
    if (!Array.isArray(claimed) || claimed.length > actual.length || claimed.some((a, j) => a !== actual[j])) {
      throw new Error(MISMATCH)
    }
    // compile against the entries Jupiter listed (a verified prefix of the
    // chain's), never against entries only the RPC vouches for
    tables.set(t, actual.slice(0, claimed.length))
  })

  // 3. Assemble it ourselves: measure the compute units, then set a 1.2× limit.
  const latest = await solRpc<{ value: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(
    chain,
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
  )
  const blockhash = latest.value.blockhash
  if (!isAddress(blockhash)) throw new Error(FRIENDLY_NET)
  const lastValidBlockHeight = blockHeightOf(latest.value.lastValidBlockHeight)
  const assemble = (units: number) =>
    compileSwapTx(owner, blockhash, [computeUnitLimitIx(units), ...priceIxs, ...body], tables)
  let probe: string
  try {
    probe = assemble(CU_LIMIT_MAX)
  } catch {
    throw new Error(MISMATCH)
  }
  const used = (await simulateSwap(chain, probe)).value.unitsConsumed
  const limit =
    typeof used === 'number' && used > 0 ? Math.min(CU_LIMIT_MAX, Math.ceil(used * 1.2)) : CU_LIMIT_MAX
  const txBase64 = assemble(limit)

  // 4. Structural checks on the exact bytes: one signature, and it's ours.
  let decoded: DecodedSwapTx
  try {
    const bytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0))
    decoded = solLib.TransactionRaw.decode(bytes) as unknown as DecodedSwapTx
  } catch {
    throw new Error(MISMATCH)
  }
  const header = decoded.msg?.data?.header
  const feePayer = decoded.msg?.data?.keys?.[0]
  if (decoded.signatures.length !== 1 || header?.requiredSignatures !== 1 || feePayer !== owner) {
    throw new Error(MISMATCH)
  }

  // 5. Instruction-level checks; the fee comes from the bytes themselves, and
  //    the Jupiter instruction must say exactly what we asked for.
  const { priorityFeeLamports, jupiter } = await verifySwapInstructions(chain, owner, decoded)
  const feeLamports = 5000n + priorityFeeLamports
  assertSwapArgs(jupiter, owner, q, chain)
  // The floor the program enforces, from the decoded route itself. Jupiter's
  // own figure may round it up by one unit; anything else is a mismatch.
  const minOutAmount = (jupiter.quotedOutAmount * BigInt(10_000 - jupiter.slippageBps)) / 10_000n
  const reportedMin = BigInt(b.otherAmountThreshold ?? '0')
  if (reportedMin < minOutAmount || reportedMin > minOutAmount + 1n) throw new Error(MISMATCH)

  // 6. Current balances, then simulate the final bytes and diff our own accounts.
  const ata = solUsdcAta(chain, owner)
  // getAccountInfo, not getTokenAccountBalance (public RPCs gate "indexed"
  // methods). value:null means the account truly doesn't exist; a fetch
  // failure throws and fails the whole prepare — it must NOT read as
  // "missing", or an existing balance would inflate a delta below.
  const tokenBalance = (address: string) =>
    solRpc<{ value: { data?: unknown } | null }>(chain, 'getAccountInfo', [
      address,
      { encoding: 'base64' },
    ]).then((r) => (r.value === null ? null : tokenAmountFromBase64(r.value.data)))
  const charged = feeBps > 0
  // Lamports the unwrap hands back beyond this swap's own wrap: a wSOL
  // account the owner already had (its rent plus whatever was in it).
  const wsolLamports = solRpc<{ value: { lamports?: unknown } | null }>(chain, 'getAccountInfo', [
    solLib.tokenAddress({ mint: SOL_WRAPPED_MINT, owner, tokenProgram: solLib.TOKEN_PROGRAM }),
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ]).then((r) => (r.value === null || typeof r.value.lamports !== 'number' ? 0n : BigInt(r.value.lamports)))
  const [solBefore, usdcBefore, feeBefore, ataRentRes, wsolBefore] = await Promise.all([
    getSolBalance(chain, owner),
    tokenBalance(ata),
    charged ? tokenBalance(SWAP_FEE_ACCOUNT) : Promise.resolve(0n),
    solRpc<number>(chain, 'getMinimumBalanceForRentExemption', [165]).catch(() => null),
    wsolLamports,
  ])
  const ataMissing = usdcBefore === null
  const ataRent = ataRentRes != null ? BigInt(ataRentRes) : ATA_RENT_FALLBACK
  // The fee account must exist; a swap that pays a missing one would fail.
  if (feeBefore === null) {
    throw new Error('Swaps are unavailable right now. Your coins are safe; nothing was signed.')
  }

  const sim = await simulateSwap(chain, txBase64, charged ? [owner, ata, SWAP_FEE_ACCOUNT] : [owner, ata])
  const solAfter = BigInt(sim.value.accounts?.[0]?.lamports ?? 0)
  const usdcAfter = tokenAmountFrom(sim.value.accounts?.[1])
  const solDelta = solAfter - solBefore
  const usdcDelta = usdcAfter - (usdcBefore ?? 0n)
  const swapFee = charged ? tokenAmountFrom(sim.value.accounts?.[2]) - feeBefore : 0n

  // 7. Kailah's fee must be exactly the rate (±1 unit for rounding), into its
  //    account: of the gross USDC output when selling SOL, of the USDC input
  //    when buying. The fee wallet itself pays none (feeBps 0).
  if (charged) {
    const expectedFee =
      q.direction === 'sol-to-usdc'
        ? ((usdcDelta + swapFee) * BigInt(feeBps)) / 10_000n
        : (q.inAmount * BigInt(feeBps)) / 10_000n
    if (swapFee <= 0n || swapFee < expectedFee - 1n || swapFee > expectedFee + 1n) {
      throw new Error(MISMATCH)
    }
  }

  // 8. The simulated outcome must honor the decoded floor, and the input
  //    side must move by exactly the input: spending LESS of the shown asset
  //    means the route took something else instead (audit 2026-10-26).
  if (q.direction === 'sol-to-usdc') {
    const maxSolCost = q.inAmount + feeLamports + (ataMissing ? ataRent : 0n) + FEE_ROUNDING_SLACK
    const minSolCost = q.inAmount + feeLamports - wsolBefore - FEE_ROUNDING_SLACK
    if (usdcDelta < minOutAmount || solDelta < -maxSolCost || solDelta > -minSolCost) {
      throw new Error(MISMATCH)
    }
  } else {
    const minSolGain = minOutAmount - feeLamports - FEE_ROUNDING_SLACK
    if (usdcDelta !== -q.inAmount || solDelta < minSolGain) {
      throw new Error(MISMATCH)
    }
  }

  return {
    chain,
    direction: q.direction,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    minOutAmount,
    priceImpactPct: q.priceImpactPct,
    feeLamports,
    simulatedSolDelta: solDelta,
    simulatedUsdcDelta: usdcDelta,
    swapFee,
    swapFeeBps: feeBps,
    txBase64,
    lastValidBlockHeight,
  }
}

export async function broadcastSwap(key: SolKey, prepared: PreparedSwap): Promise<string> {
  const [txid, signed] = solLib.signTx(key.privateKey, prepared.txBase64)
  recordPending({
    kind: 'sol',
    chainId: prepared.chain.id,
    signature: txid,
    ts: Date.now(),
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  })
  try {
    return await solRpc<string>(prepared.chain, 'sendTransaction', [
      signed,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])
  } catch (e) {
    // carries the known signature so the UI can check whether this attempt
    // landed before allowing a retry (see SolBroadcastError)
    throw new SolBroadcastError(e instanceof Error ? e.message : String(e), txid, signed)
  }
}
