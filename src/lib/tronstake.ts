// TRON Stake 2.0 for Kailah Wallet: freeze TRX for resources + voting power,
// vote for a Super Representative to earn (~3–5%/yr, set by the network),
// claim rewards (24h cooldown), unstake (fixed 14-day wait), withdraw.
//
// Same security spine as every TRON action: the node builds the unsigned
// transaction, the wallet decodes the raw bytes with its own protobuf reader
// (tron.ts) and REFUSES to sign on any mismatch with the user's request.
// Build-time validation on the node's side (live-verified: it rejects votes
// exceeding TRON Power before anything is signed) plus fail-closed decoding
// means a wrong assumption can only ever block an action, never mis-sign one.
//
// Honesty requirements carried into the UI: unstaking takes a fixed 14 days
// before withdrawal; rewards require voting (staking alone earns nothing);
// staking for ENERGY also makes USDT sends cheaper — often free.

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  assertNoTronInFlight,
  assertTronEnvelope,
  decodeTronRawTx,
  hexAddrToBase58,
  tronCall,
  type PreparedTronSend,
  type TronChainConfig,
  type TronKey,
} from './tron'

// Through tron.ts's tronCall, paced with every other TRON request: a local
// fetch here skipped the pacing that keeps TronGrid's keyless limit from
// suspending the wallet (bug audit 2026-10-27, BM22; review 2026-10-28).
async function stakeCall<T>(chain: TronChainConfig, path: string, body: unknown): Promise<T> {
  try {
    return await tronCall<T>(chain, path, body)
  } catch (e) {
    // Node validation errors are long Java class names + reason — keep the reason.
    if (e instanceof Error && /^class [^:]+:/.test(e.message)) throw new Error(e.message.replace(/^class [^:]+:\s*/, ''))
    throw e
  }
}

// ---------------------------------------------------------------------------
// Stake state.

export type TronResource = 'BANDWIDTH' | 'ENERGY'

export interface TronStakeView {
  /** sun staked per resource (Stake 2.0 only) */
  stakedBandwidth: bigint
  stakedEnergy: bigint
  /** whole-TRX voting power: total from stake, used by votes, spare */
  powerTotal: bigint
  powerUsed: bigint
  /** current votes */
  votes: { address: string; count: bigint }[]
  /** claimable voting reward in sun */
  unclaimedReward: bigint
  /** unstakes waiting out the 14 days */
  pendingUnfreezes: { amount: bigint; availableAtMs: number; withdrawable: boolean }[]
}

interface GetAccountStake {
  address?: string
  frozenV2?: { type?: 'ENERGY' | 'TRON_POWER'; amount?: number }[]
  unfrozenV2?: { unfreeze_amount?: number; unfreeze_expire_time?: number }[]
  votes?: { vote_address?: string; vote_count?: number }[]
}

export async function fetchTronStake(
  chain: TronChainConfig,
  address: string,
): Promise<TronStakeView> {
  const [acc, reward] = await Promise.all([
    stakeCall<GetAccountStake>(chain, '/wallet/getaccount', { address, visible: true }),
    stakeCall<{ reward?: number }>(chain, '/wallet/getReward', { address, visible: true }).catch(
      () => ({ reward: 0 }),
    ),
  ])
  let stakedBandwidth = 0n
  let stakedEnergy = 0n
  for (const f of acc.frozenV2 ?? []) {
    const amt = BigInt(f.amount ?? 0)
    // absent type = BANDWIDTH; TRON_POWER entries exist but are legacy-only
    if (f.type === 'ENERGY') stakedEnergy += amt
    else if (f.type === undefined) stakedBandwidth += amt
  }
  const votes = (acc.votes ?? [])
    .filter((v) => v.vote_address !== undefined)
    .map((v) => {
      const raw = v.vote_address as string
      return {
        address: raw.startsWith('41') && raw.length === 42 ? (hexAddrToBase58(raw) ?? raw) : raw,
        count: BigInt(v.vote_count ?? 0),
      }
    })
  const powerTotal = (stakedBandwidth + stakedEnergy) / 1_000_000n
  const powerUsed = votes.reduce((s, v) => s + v.count, 0n)
  const now = Date.now()
  const pendingUnfreezes = (acc.unfrozenV2 ?? [])
    .filter((u) => (u.unfreeze_amount ?? 0) > 0)
    .map((u) => ({
      amount: BigInt(u.unfreeze_amount ?? 0),
      availableAtMs: u.unfreeze_expire_time ?? 0,
      withdrawable: (u.unfreeze_expire_time ?? 0) <= now,
    }))
  return {
    stakedBandwidth,
    stakedEnergy,
    powerTotal,
    powerUsed,
    votes,
    unclaimedReward: BigInt(reward.reward ?? 0),
    pendingUnfreezes,
  }
}

// ---------------------------------------------------------------------------
// Super Representatives to vote for.

export interface TronWitness {
  address: string
  /** display label derived from the SR's published URL */
  label: string
  voteCount: number
}

export async function fetchTronWitnesses(chain: TronChainConfig): Promise<TronWitness[]> {
  const r = await stakeCall<{ witnesses?: { address?: string; voteCount?: number; url?: string }[] }>(
    chain,
    '/wallet/listwitnesses',
    { visible: true },
  )
  return (r.witnesses ?? [])
    .filter((w) => w.address !== undefined && (w.voteCount ?? 0) > 0)
    .sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))
    .slice(0, 20)
    .map((w) => {
      // Nile returns hex (41…) addresses even with visible:true — normalize so
      // the UI shows T… addresses and votes verify against decoded bytes.
      const raw = w.address as string
      const address = raw.startsWith('41') && raw.length === 42 ? (hexAddrToBase58(raw) ?? raw) : raw
      // The hostname is self-published by the SR, so a lookalike can brand
      // itself as anyone; the short address beside it is what to verify.
      const shortAddr = `${address.slice(0, 4)}…${address.slice(-4)}`
      let label = address
      try {
        const host = new URL(w.url ?? '').hostname.replace(/^www\./, '')
        if (host) label = `${host} · ${shortAddr}`
      } catch {
        // keep address as label
      }
      return { address, label, voteCount: w.voteCount ?? 0 }
    })
}

// ---------------------------------------------------------------------------
// Prepared actions. All reuse PreparedTronSend so broadcastTronSend signs and
// sends them identically (txID recomputed from raw bytes, decode-verified).

export type TronStakeAction = 'freeze' | 'vote' | 'claim' | 'unfreeze' | 'withdraw'

export interface PreparedTronStake extends PreparedTronSend {
  action: TronStakeAction
  resource: TronResource | null
  votes: { address: string; count: bigint }[] | null
}

const MISMATCH =
  'The transaction the network node returned does not match your request — refusing to sign it. Nothing was sent and your coins are untouched.'

interface BuildResult {
  raw_data?: unknown
  raw_data_hex?: string
  txID?: string
}

async function finish(
  chain: TronChainConfig,
  key: TronKey,
  action: TronStakeAction,
  r: BuildResult,
  verify: (d: ReturnType<typeof decodeTronRawTx>) => boolean,
  extras: { resource?: TronResource | null; votes?: { address: string; count: bigint }[] | null; amount?: bigint },
): Promise<PreparedTronStake> {
  if (!r.raw_data_hex) throw new Error(MISMATCH)
  const decoded = decodeTronRawTx(r.raw_data_hex)
  assertTronEnvelope(decoded, 0n) // stake ops are bandwidth-only: fee_limit stays 0
  // one TRON transaction in flight at a time, stake actions included
  await assertNoTronInFlight(chain)
  if (decoded.contracts.length !== 1 || decoded.contracts[0]?.owner !== key.address || !verify(decoded)) {
    throw new Error(MISMATCH)
  }
  const computedId = bytesToHex(sha256(hexToBytes(r.raw_data_hex)))
  if (r.txID !== undefined && r.txID !== computedId) throw new Error(MISMATCH)
  return {
    chain,
    asset: 'trx',
    to: key.address,
    amount: extras.amount ?? 0n,
    estimatedFeeSun: 270_000n, // bandwidth-only actions; shown as "~0.27 TRX or free"
    feeLimitSun: 0n,
    createsAccount: false,
    rawDataHex: r.raw_data_hex,
    rawData: r.raw_data,
    txID: computedId,
    expiration: Number(decoded.expiration),
    timestamp: Number(decoded.timestamp),
    action,
    resource: extras.resource ?? null,
    votes: extras.votes ?? null,
  }
}

export async function prepareFreeze(
  chain: TronChainConfig,
  key: TronKey,
  amount: bigint,
  resource: TronResource,
): Promise<PreparedTronStake> {
  if (amount < 1_000_000n) throw new Error('Stake at least 1 TRX.')
  const r = await stakeCall<BuildResult>(chain, '/wallet/freezebalancev2', {
    owner_address: key.address,
    frozen_balance: Number(amount),
    resource,
    visible: true,
  })
  return finish(chain, key, 'freeze', r, (d) => {
    const c = d.contracts[0]!
    return c.type === 'FreezeBalanceV2Contract' && c.amount === amount && c.resource === resource
  }, { resource, amount })
}

export async function prepareUnfreeze(
  chain: TronChainConfig,
  key: TronKey,
  amount: bigint,
  resource: TronResource,
): Promise<PreparedTronStake> {
  const r = await stakeCall<BuildResult>(chain, '/wallet/unfreezebalancev2', {
    owner_address: key.address,
    unfreeze_balance: Number(amount),
    resource,
    visible: true,
  })
  return finish(chain, key, 'unfreeze', r, (d) => {
    const c = d.contracts[0]!
    return c.type === 'UnfreezeBalanceV2Contract' && c.amount === amount && c.resource === resource
  }, { resource, amount })
}

export async function prepareVote(
  chain: TronChainConfig,
  key: TronKey,
  votes: { address: string; count: bigint }[],
): Promise<PreparedTronStake> {
  if (votes.length === 0 || votes.some((v) => v.count <= 0n)) {
    throw new Error('Nothing to vote with — stake TRX first.')
  }
  const r = await stakeCall<BuildResult>(chain, '/wallet/votewitnessaccount', {
    owner_address: key.address,
    votes: votes.map((v) => ({ vote_address: v.address, vote_count: Number(v.count) })),
    visible: true,
  })
  return finish(chain, key, 'vote', r, (d) => {
    const c = d.contracts[0]!
    if (c.type !== 'VoteWitnessContract' || c.votes === null || c.votes.length !== votes.length) {
      return false
    }
    return votes.every((v, i) => c.votes![i]!.address === v.address && c.votes![i]!.count === v.count)
  }, { votes })
}

export async function prepareClaimReward(
  chain: TronChainConfig,
  key: TronKey,
): Promise<PreparedTronStake> {
  const r = await stakeCall<BuildResult>(chain, '/wallet/withdrawbalance', {
    owner_address: key.address,
    visible: true,
  })
  return finish(chain, key, 'claim', r, (d) => d.contracts[0]!.type === 'WithdrawBalanceContract', {})
}

export async function prepareWithdrawUnfrozen(
  chain: TronChainConfig,
  key: TronKey,
): Promise<PreparedTronStake> {
  const r = await stakeCall<BuildResult>(chain, '/wallet/withdrawexpireunfreeze', {
    owner_address: key.address,
    visible: true,
  })
  return finish(
    chain,
    key,
    'withdraw',
    r,
    (d) => d.contracts[0]!.type === 'WithdrawExpireUnfreezeContract',
    {},
  )
}
