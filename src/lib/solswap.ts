// Jupiter swap engine — SOL ↔ USDC on Solana mainnet, via the aggregator's
// keyless lite API (live-verified 2026-07-27: CORS *, no key, quote + swap).
//
// SECURITY CORE — never sign a server-built transaction blind. Jupiter's
// /swap endpoint returns a fully-formed versioned transaction. Before the
// wallet signs it, this module:
//   1. decodes it (micro-sol-signer) and refuses unless it needs exactly one
//      signature and the fee payer is our own address;
//   2. walks every instruction: programs must be on a fixed allow-list,
//      token/system instructions on a per-program allow-list (no Approve,
//      SetAuthority, Assign, Burn…), the wallet's seed-derived stake accounts
//      must appear nowhere (lookup tables are resolved first), and the
//      priority fee is computed from the ComputeBudget instructions
//      themselves — one signature authorizes every instruction in a Solana
//      message, and the simulation below only diffs two balances, so it
//      cannot see an authority grant that moves nothing at simulation time;
//   3. runs it through the RPC's simulateTransaction (sigVerify off) and
//      reads OUR account's simulated post-balances;
//   4. refuses unless the simulated SOL/USDC deltas match the quote within
//      fee + rent bounds.
// Signing is byte-exact (verified: the message bytes are untouched by
// signTx), so the transaction that was simulated is the one broadcast.
// A failed broadcast is re-quoted from scratch — never blind-retried.
// Residual trust: the on-chain slippage floor lives inside the Jupiter
// program's route arguments, which this module does not decode — a hostile
// route is still bounded by the simulated deltas at preparation time.

import * as solLib from 'micro-sol-signer'
import { base58 } from '@scure/base'
import {
  assertNoSolInFlight,
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
const JUP_BASE = 'https://lite-api.jup.ag/swap/v1'
/** 0.5% — shown on the review screen, enforced on-chain by the route. */
export const SWAP_SLIPPAGE_BPS = 50

const FRIENDLY_NET =
  "Couldn't reach the swap service right now. Your coins are safe; try again in a few minutes."

interface JupQuoteResponse {
  inAmount?: string
  outAmount?: string
  otherAmountThreshold?: string
  priceImpactPct?: string
  error?: string
}

export interface SwapQuote {
  direction: SwapDirection
  /** smallest units of the input asset (lamports / USDC units) */
  inAmount: bigint
  outAmount: bigint
  /** worst case after slippage — what the route enforces on-chain */
  minOutAmount: bigint
  priceImpactPct: number
  /** verbatim quoteResponse — required by the swap-build endpoint */
  raw: unknown
}

async function jupFetch(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(FRIENDLY_NET)
  }
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

export async function getSwapQuote(
  chain: SolChainConfig,
  direction: SwapDirection,
  amount: bigint,
): Promise<SwapQuote> {
  if (!chain.mainnet) throw new Error('Swapping is only available on Solana mainnet.')
  if (amount <= 0n) throw new Error('Enter an amount to swap.')
  const inputMint = direction === 'sol-to-usdc' ? SOL_WRAPPED_MINT : chain.usdc.mint
  const outputMint = direction === 'sol-to-usdc' ? chain.usdc.mint : SOL_WRAPPED_MINT
  const q = (await jupFetch(
    `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amount}&slippageBps=${SWAP_SLIPPAGE_BPS}&swapMode=ExactIn`,
  )) as JupQuoteResponse
  if (!q.inAmount || !q.outAmount || !q.otherAmountThreshold) {
    throw new Error('The swap service returned an incomplete quote — try again.')
  }
  return {
    direction,
    inAmount: BigInt(q.inAmount),
    outAmount: BigInt(q.outAmount),
    minOutAmount: BigInt(q.otherAmountThreshold),
    priceImpactPct: Number(q.priceImpactPct ?? '0'),
    raw: q,
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
  /** the exact bytes that were simulated; signing does not alter them */
  txBase64: string
}

interface JupSwapResponse {
  swapTransaction?: string
  simulationError?: { error?: string } | null
  error?: string
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
const ALLOWED_TOKEN_IX = new Set([
  1, // InitializeAccount
  3, // Transfer
  9, // CloseAccount (wSOL unwrap; lamport destination must be us, checked below)
  12, // TransferChecked
  16, // InitializeAccount2
  17, // SyncNative
  18, // InitializeAccount3
  21, // GetAccountDataSize
  22, // InitializeImmutableOwner
])
const TOKEN_IX_CLOSE = 9
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
  const res = await solRpc<{ value: ({ data?: unknown } | null)[] }>(chain, 'getMultipleAccounts', [
    tableAddrs,
    { encoding: 'base64' },
  ])
  const tables = (res.value ?? []).map((acc) => {
    const data = acc?.data
    const b64 = Array.isArray(data) ? (data[0] as string | undefined) : undefined
    if (typeof b64 !== 'string') throw new Error(MISMATCH)
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    // on-chain lookup-table layout: 56-byte metadata, then 32-byte addresses
    if (bytes.length < 56 || (bytes.length - 56) % 32 !== 0) throw new Error(MISMATCH)
    const out: string[] = []
    for (let off = 56; off < bytes.length; off += 32) {
      out.push(base58.encode(bytes.subarray(off, off + 32)))
    }
    return out
  })
  if (tables.length !== lookups.length) throw new Error(MISMATCH)
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
 * Enforce the program/instruction allow-lists and compute the priority fee
 * from the transaction's own ComputeBudget instructions (never from the swap
 * service's self-reported number). Throws MISMATCH on anything unexpected.
 */
async function verifySwapInstructions(
  chain: SolChainConfig,
  owner: string,
  decoded: DecodedSwapTx,
): Promise<{ priorityFeeLamports: bigint }> {
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

  for (const ix of instructions) {
    // program ids must live in the static keys (the runtime enforces the same)
    const program = ix.programIdx !== undefined ? staticKeys[ix.programIdx] : undefined
    if (program === undefined || !SWAP_ALLOWED_PROGRAMS.has(program)) throw new Error(MISMATCH)
    const d = ix.data ?? new Uint8Array()

    if (SWAP_TOKEN_PROGRAMS.includes(program)) {
      if (d.length === 0 || !ALLOWED_TOKEN_IX.has(d[0]!)) throw new Error(MISMATCH)
      if (d[0] === TOKEN_IX_CLOSE && accountAt(ix.keys?.[1]) !== owner) throw new Error(MISMATCH)
    } else if (program === solLib.SYS_PROGRAM) {
      if (d.length < 4 || !ALLOWED_SYSTEM_IX.has(u32le(d, 0))) throw new Error(MISMATCH)
    } else if (program === COMPUTE_BUDGET_PROGRAM) {
      if (d.length === 0) throw new Error(MISMATCH)
      if (d[0] === 2 && d.length >= 5) unitLimit = BigInt(u32le(d, 1))
      if (d[0] === 3 && d.length >= 9) unitPriceMicro = u64le(d, 1)
    }
  }

  // ceil(units × price / 1e6); without a limit instruction the runtime cap
  // (1.4M units) bounds the worst case.
  const units = unitLimit ?? 1_400_000n
  const priorityFeeLamports = (units * unitPriceMicro + 999_999n) / 1_000_000n
  if (priorityFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) throw new Error(MISMATCH)
  return { priorityFeeLamports }
}

export async function prepareSwap(
  chain: SolChainConfig,
  owner: string,
  quote: SwapQuote,
): Promise<PreparedSwap> {
  if (!chain.mainnet) throw new Error('Swapping is only available on Solana mainnet.')
  await assertNoSolInFlight(chain)

  const sw = (await jupFetch(`${JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  })) as JupSwapResponse
  if (!sw.swapTransaction) throw new Error(FRIENDLY_NET)
  if (sw.simulationError?.error) {
    throw new Error(`The swap can't execute right now: ${sw.simulationError.error}`)
  }
  const txBase64 = sw.swapTransaction

  // 1. Structural checks: one signature, and it's ours.
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

  // 2. Instruction-level checks; the fee comes from the bytes themselves.
  const { priorityFeeLamports } = await verifySwapInstructions(chain, owner, decoded)
  const feeLamports = 5000n + priorityFeeLamports

  // 3. Current balances, then simulate and diff our own accounts.
  const ata = solUsdcAta(chain, owner)
  const [solBefore, usdcBefore, ataRentRes] = await Promise.all([
    getSolBalance(chain, owner),
    // getAccountInfo, not getTokenAccountBalance (public RPCs gate "indexed"
    // methods). value:null means the ATA truly doesn't exist; a fetch failure
    // throws and fails the whole prepare — it must NOT read as "missing", or
    // an existing balance would inflate the perceived swap output below.
    solRpc<{ value: { data?: unknown } | null }>(chain, 'getAccountInfo', [
      ata,
      { encoding: 'base64' },
    ]).then((r) => (r.value === null ? null : tokenAmountFromBase64(r.value.data))),
    solRpc<number>(chain, 'getMinimumBalanceForRentExemption', [165]).catch(() => null),
  ])
  const ataMissing = usdcBefore === null
  const ataRent = ataRentRes != null ? BigInt(ataRentRes) : ATA_RENT_FALLBACK

  const sim = await solRpc<SimResult>(chain, 'simulateTransaction', [
    txBase64,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'jsonParsed', addresses: [owner, ata] },
    },
  ])
  if (sim.value.err != null) {
    const tail = (sim.value.logs ?? []).slice(-2).join(' · ')
    throw new Error(
      `The swap fails in simulation, so it was not signed or sent.${tail ? ` (${tail})` : ''}`,
    )
  }
  const solAfter = BigInt(sim.value.accounts?.[0]?.lamports ?? 0)
  const usdcAfter = tokenAmountFrom(sim.value.accounts?.[1])
  const solDelta = solAfter - solBefore
  const usdcDelta = usdcAfter - (usdcBefore ?? 0n)

  // 4. The simulated outcome must honor the quote.
  if (quote.direction === 'sol-to-usdc') {
    const maxSolCost =
      quote.inAmount + feeLamports + (ataMissing ? ataRent : 0n) + FEE_ROUNDING_SLACK
    if (usdcDelta < quote.minOutAmount || solDelta < -maxSolCost) {
      throw new Error(MISMATCH)
    }
  } else {
    const minSolGain = quote.minOutAmount - feeLamports - FEE_ROUNDING_SLACK
    if (usdcDelta < -quote.inAmount || solDelta < minSolGain) {
      throw new Error(MISMATCH)
    }
  }

  return {
    chain,
    direction: quote.direction,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    minOutAmount: quote.minOutAmount,
    priceImpactPct: quote.priceImpactPct,
    feeLamports,
    simulatedSolDelta: solDelta,
    simulatedUsdcDelta: usdcDelta,
    txBase64,
  }
}

export async function broadcastSwap(key: SolKey, prepared: PreparedSwap): Promise<string> {
  const [txid, signed] = solLib.signTx(key.privateKey, prepared.txBase64)
  recordPending({ kind: 'sol', chainId: prepared.chain.id, signature: txid, ts: Date.now() })
  try {
    return await solRpc<string>(prepared.chain, 'sendTransaction', [
      signed,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])
  } catch (e) {
    // carries the known signature so the UI can check whether this attempt
    // landed before allowing a retry (see SolBroadcastError)
    throw new SolBroadcastError(e instanceof Error ? e.message : String(e), txid)
  }
}
