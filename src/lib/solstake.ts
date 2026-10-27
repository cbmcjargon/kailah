// Native Solana staking for Kailah Wallet.
//
// micro-sol-signer has no stake-program bindings, so the four instructions
// this module needs (Initialize, DelegateStake, Deactivate, Withdraw) are
// encoded by hand against the program's documented bincode layout — a u32 LE
// discriminant followed by fixed-width fields — and verified two ways in
// scripts/check-solstake.mjs: on-chain simulation of every flow against the
// live cluster, plus a REAL create+delegate broadcast on devnet.
//
// Stake accounts are derived with createAccountWithSeed from the wallet's own
// key (seeds "kailah:stake:0..7"), so:
//   - every transaction needs only the wallet's one signature (no ephemeral
//     stake keypairs to manage or back up), and
//   - the accounts are recoverable forever from the 12 words alone — other
//     wallets (Phantom etc.) also find them, since the wallet key is both
//     staker and withdrawer authority.
//
// Money honesty: activation and deactivation take effect at epoch boundaries
// (an epoch is roughly two days); rewards arrive each epoch and compound into
// the stake automatically; withdrawing requires deactivating first and
// waiting out the epoch. All of that is stated in the UI, not hidden.

import { sha256 } from '@noble/hashes/sha2'
import { recordPending, type PendingSol } from './pending'
import { base58 } from '@scure/base'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import * as solLib from 'micro-sol-signer'
import { formatSol, getSolBalance, solRpc, type SolChainConfig, type SolKey,
  assertNoSolInFlight,
  blockHeightOf,
  submitSolTx,
} from './sol'

export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111'
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111'
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111'
const SYSVAR_STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111'
const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111'

export const STAKE_ACCOUNT_SIZE = 200
/** Rent-exempt minimum for a 200-byte stake account (live-verified fallback). */
const STAKE_RENT_FALLBACK = 2_282_880n
/** Rent-exempt minimum for the 0-byte main account. */
const MAIN_RENT_FALLBACK = 890_880n
export const MAX_STAKE_ACCOUNTS = 8

const seedFor = (index: number) => `kailah:stake:${index}`

/**
 * createWithSeed address: sha256(base || seed || programId), plain hash (this
 * is NOT a PDA — the address stays on-curve, which is fine because only the
 * system program ever signs for it at creation).
 */
export function stakeAccountAddress(owner: string, index: number): string {
  const h = sha256(
    concatBytes(base58.decode(owner), utf8ToBytes(seedFor(index)), base58.decode(STAKE_PROGRAM)),
  )
  return base58.encode(h)
}

// ---------------------------------------------------------------------------
// Hand-built stake-program instructions.

interface IxKey {
  address: string
  sign: boolean
  write: boolean
}
interface Instruction {
  program: string
  keys: IxKey[]
  data: Uint8Array
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, v, true)
  return b
}

/** Initialize: authorized {staker, withdrawer} + zeroed lockup. */
export function stakeInitializeIx(stakeAccount: string, authority: string): Instruction {
  const data = concatBytes(
    u32le(0),
    base58.decode(authority), // staker
    base58.decode(authority), // withdrawer
    new Uint8Array(8), // lockup.unix_timestamp = 0
    new Uint8Array(8), // lockup.epoch = 0
    new Uint8Array(32), // lockup.custodian = none
  )
  return {
    program: STAKE_PROGRAM,
    keys: [
      { address: stakeAccount, sign: false, write: true },
      { address: SYSVAR_RENT, sign: false, write: false },
    ],
    data,
  }
}

export function stakeDelegateIx(
  stakeAccount: string,
  voteAccount: string,
  authority: string,
): Instruction {
  return {
    program: STAKE_PROGRAM,
    keys: [
      { address: stakeAccount, sign: false, write: true },
      { address: voteAccount, sign: false, write: false },
      { address: SYSVAR_CLOCK, sign: false, write: false },
      { address: SYSVAR_STAKE_HISTORY, sign: false, write: false },
      { address: STAKE_CONFIG, sign: false, write: false },
      { address: authority, sign: true, write: false },
    ],
    data: u32le(2),
  }
}

export function stakeDeactivateIx(stakeAccount: string, authority: string): Instruction {
  return {
    program: STAKE_PROGRAM,
    keys: [
      { address: stakeAccount, sign: false, write: true },
      { address: SYSVAR_CLOCK, sign: false, write: false },
      { address: authority, sign: true, write: false },
    ],
    data: u32le(5),
  }
}

export function stakeWithdrawIx(
  stakeAccount: string,
  recipient: string,
  authority: string,
  lamports: bigint,
): Instruction {
  return {
    program: STAKE_PROGRAM,
    keys: [
      { address: stakeAccount, sign: false, write: true },
      { address: recipient, sign: false, write: true },
      { address: SYSVAR_CLOCK, sign: false, write: false },
      { address: SYSVAR_STAKE_HISTORY, sign: false, write: false },
      { address: authority, sign: true, write: false },
    ],
    data: concatBytes(u32le(4), u64le(lamports)),
  }
}

// ---------------------------------------------------------------------------
// Reading stake state — one getMultipleAccounts call for all seed slots.

export type StakeState = 'activating' | 'active' | 'deactivating' | 'withdrawable'

export interface StakeAccountView {
  index: number
  address: string
  /** total lamports in the account (stake + rent + accrued rewards) */
  lamports: bigint
  state: StakeState
  /** vote account currently delegated to (null when undelegated) */
  validator: string | null
}

interface ParsedStakeAccount {
  lamports?: number
  owner?: string
  data?: {
    parsed?: {
      type?: string
      info?: {
        stake?: {
          delegation?: {
            voter?: string
            activationEpoch?: string
            deactivationEpoch?: string
          } | null
        } | null
      }
    }
  }
}

const U64_MAX_DEC = '18446744073709551615'

export async function fetchStakeAccounts(
  chain: SolChainConfig,
  owner: string,
): Promise<StakeAccountView[]> {
  const addresses = Array.from({ length: MAX_STAKE_ACCOUNTS }, (_, i) =>
    stakeAccountAddress(owner, i),
  )
  const [accountsRes, epochRes] = await Promise.all([
    solRpc<{ value: (ParsedStakeAccount | null)[] }>(chain, 'getMultipleAccounts', [
      addresses,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]),
    solRpc<{ epoch: number }>(chain, 'getEpochInfo', [{ commitment: 'confirmed' }]),
  ])
  const epoch = BigInt(epochRes.epoch)
  const out: StakeAccountView[] = []
  accountsRes.value.forEach((acc, index) => {
    if (acc == null) return
    // Slot addresses derive from public seeds, so anyone can dust them with
    // a plain transfer; a system-owned account there is not a stake and
    // must neither render as one nor count as a used slot.
    if (acc.owner !== STAKE_PROGRAM) return
    const delegation = acc.data?.parsed?.info?.stake?.delegation
    let state: StakeState = 'withdrawable'
    let validator: string | null = null
    if (delegation != null) {
      validator = delegation.voter ?? null
      const act = BigInt(delegation.activationEpoch ?? '0')
      const deact = delegation.deactivationEpoch ?? U64_MAX_DEC
      // Deactivated in the epoch it was activated in, a stake never took
      // effect, and is withdrawable at once (the stake program's rule; it
      // showed as winding down, bug audit 2026-10-27, BL26).
      if (deact !== U64_MAX_DEC && (BigInt(deact) < epoch || BigInt(deact) === act)) state = 'withdrawable'
      else if (deact !== U64_MAX_DEC) state = 'deactivating'
      else if (act >= epoch) state = 'activating'
      else state = 'active'
    }
    out.push({
      index,
      address: addresses[index]!,
      lamports: BigInt(acc.lamports ?? 0),
      state,
      validator,
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// Validators to delegate to.

export interface ValidatorOption {
  votePubkey: string
  /** percentage of rewards the validator keeps */
  commission: number
  /** total SOL staked with it — a rough proxy for being established */
  activatedSol: number
}

export async function fetchValidators(chain: SolChainConfig): Promise<ValidatorOption[]> {
  const r = await solRpc<{
    current: { votePubkey: string; commission: number; activatedStake: number }[]
  }>(chain, 'getVoteAccounts', [{ commitment: 'confirmed' }])
  return r.current
    .filter((v) => v.commission <= 10)
    .sort((a, b) => b.activatedStake - a.activatedStake)
    .slice(0, 20)
    .map((v) => ({
      votePubkey: v.votePubkey,
      commission: v.commission,
      activatedSol: Math.round(v.activatedStake / 1e9),
    }))
}

// ---------------------------------------------------------------------------
// Flows. Every prepared action carries the exact amounts shown at review;
// broadcasts sign fresh bytes; failures re-prepare (blockhash), never retry.

export interface PreparedStakeAction {
  chain: SolChainConfig
  kind: 'create' | 'deactivate' | 'withdraw'
  stakeAccount: string
  /** the blockhash's last valid block height: when this attempt can no longer land */
  lastValidBlockHeight: number
  /** delegated lamports for create; withdrawn lamports for withdraw; 0 else */
  amount: bigint
  rentLamports: bigint
  feeLamports: bigint
  validator: string | null
  unsigned: string
}

export async function getMinimumStake(chain: SolChainConfig): Promise<bigint> {
  const min = await solRpc<{ value: number }>(chain, 'getStakeMinimumDelegation', [
    { commitment: 'confirmed' },
  ]).then(
    (r) => BigInt(r.value),
    () => 1_000_000_000n,
  )
  return min
}

/**
 * First seed slot with no account at all. A slot someone dusted with a plain
 * transfer is system-owned (so it isn't a stake and fetchStakeAccounts hides
 * it) but createAccountWithSeed can't be run over a funded address either —
 * such slots are skipped, not reused.
 */
async function emptyStakeSlotIndex(chain: SolChainConfig, owner: string): Promise<number> {
  const addresses = Array.from({ length: MAX_STAKE_ACCOUNTS }, (_, i) =>
    stakeAccountAddress(owner, i),
  )
  const res = await solRpc<{ value?: (object | null)[] }>(chain, 'getMultipleAccounts', [
    addresses,
    { encoding: 'base64', commitment: 'confirmed' },
  ])
  return (res.value ?? []).findIndex((v) => v === null)
}

export async function prepareCreateStake(
  chain: SolChainConfig,
  key: SolKey,
  amount: bigint,
  votePubkey: string,
): Promise<PreparedStakeAction> {
  await assertNoSolInFlight(chain)
  const [freeSlot, minStake, balance, rentRes, mainRentRes, bh] = await Promise.all([
    emptyStakeSlotIndex(chain, key.address),
    getMinimumStake(chain),
    getSolBalance(chain, key.address),
    solRpc<number>(chain, 'getMinimumBalanceForRentExemption', [STAKE_ACCOUNT_SIZE]).catch(
      () => null,
    ),
    solRpc<number>(chain, 'getMinimumBalanceForRentExemption', [0]).catch(() => null),
    solRpc<{ value: { blockhash: string; lastValidBlockHeight?: unknown } }>(chain, 'getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]),
  ])
  const index = freeSlot
  if (index < 0) {
    throw new Error(
      `All ${MAX_STAKE_ACCOUNTS} stake slots are in use. Withdraw a finished stake to free one.`,
    )
  }
  const rent = rentRes != null ? BigInt(rentRes) : STAKE_RENT_FALLBACK
  const mainRent = mainRentRes != null ? BigInt(mainRentRes) : MAIN_RENT_FALLBACK
  const fee = 5000n
  if (amount < minStake) {
    throw new Error(
      `Solana's minimum stake is ${formatSol(minStake)} SOL — enter at least that much.`,
    )
  }
  const totalCost = amount + rent + fee
  if (totalCost + mainRent > balance) {
    throw new Error(
      `Staking ${formatSol(amount)} SOL needs ${formatSol(totalCost)} SOL total ` +
        `(amount + account deposit + fee) while keeping your account above its ` +
        `${formatSol(mainRent)} SOL minimum. You have ${formatSol(balance)} SOL.`,
    )
  }

  const stakeAccount = stakeAccountAddress(key.address, index)
  const instructions = [
    solLib.sys.createAccountWithSeed({
      payer: key.address,
      newAccount: stakeAccount,
      baseAccount: key.address,
      base: key.address,
      seed: seedFor(index),
      amount: amount + rent,
      space: BigInt(STAKE_ACCOUNT_SIZE),
      programAddress: STAKE_PROGRAM,
    }),
    stakeInitializeIx(stakeAccount, key.address),
    stakeDelegateIx(stakeAccount, votePubkey, key.address),
  ]
  const unsigned = solLib.createTx(key.address, instructions, bh.value.blockhash)
  return {
    chain,
    kind: 'create',
    lastValidBlockHeight: blockHeightOf(bh.value.lastValidBlockHeight),
    stakeAccount,
    amount,
    rentLamports: rent,
    feeLamports: fee,
    validator: votePubkey,
    unsigned,
  }
}

export async function prepareDeactivate(
  chain: SolChainConfig,
  key: SolKey,
  account: StakeAccountView,
): Promise<PreparedStakeAction> {
  await assertNoSolInFlight(chain)
  const bh = await solRpc<{ value: { blockhash: string; lastValidBlockHeight?: unknown } }>(chain, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])
  const unsigned = solLib.createTx(
    key.address,
    [stakeDeactivateIx(account.address, key.address)],
    bh.value.blockhash,
  )
  return {
    chain,
    kind: 'deactivate',
    lastValidBlockHeight: blockHeightOf(bh.value.lastValidBlockHeight),
    stakeAccount: account.address,
    amount: 0n,
    rentLamports: 0n,
    feeLamports: 5000n,
    validator: account.validator,
    unsigned,
  }
}

export async function prepareWithdraw(
  chain: SolChainConfig,
  key: SolKey,
  shown: StakeAccountView,
): Promise<PreparedStakeAction> {
  // The account as it is now, not as the dashboard last saw it: rewards or a
  // top-up change its balance, and the epoch may have moved (BL26).
  const account = (await fetchStakeAccounts(chain, key.address)).find((a) => a.address === shown.address)
  if (account === undefined) throw new Error('That stake account is no longer there — it may have been withdrawn already.')
  if (account.state !== 'withdrawable') {
    throw new Error(
      'This stake is still cooling down — withdrawing works after the current epoch ends (up to ~2 days).',
    )
  }
  await assertNoSolInFlight(chain)
  const bh = await solRpc<{ value: { blockhash: string; lastValidBlockHeight?: unknown } }>(chain, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])
  // Withdraw everything: the account closes and rent comes back too.
  const unsigned = solLib.createTx(
    key.address,
    [stakeWithdrawIx(account.address, key.address, key.address, account.lamports)],
    bh.value.blockhash,
  )
  return {
    chain,
    kind: 'withdraw',
    lastValidBlockHeight: blockHeightOf(bh.value.lastValidBlockHeight),
    stakeAccount: account.address,
    amount: account.lamports,
    rentLamports: 0n,
    feeLamports: 5000n,
    validator: account.validator,
    unsigned,
  }
}

export async function broadcastStakeAction(
  key: SolKey,
  prepared: PreparedStakeAction,
): Promise<string> {
  const [txid, signed] = solLib.signTx(key.privateKey, prepared.unsigned)
  // recorded BEFORE the send: a create-stake whose answer is lost must not
  // be rebuilt into a second stake (audit 2026-10-26, L12)
  const entry: PendingSol = {
    kind: 'sol',
    chainId: prepared.chain.id,
    signature: txid,
    ts: Date.now(),
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  }
  recordPending(entry)
  return submitSolTx(prepared.chain, txid, signed, entry)
}
