// TRON engine for Kailah Wallet: TRX + USDT-TRC20 on mainnet, Nile practice.
//
// Fourth self-contained engine. TRON is an account-model chain on secp256k1
// (same curve as Bitcoin/Ethereum): BIP44 path m/44'/195'/0'/0/0 (TronLink/
// Ledger standard), address = base58check(0x41 || keccak256(pubkey)[12..]).
//
// Live-verified groundwork (2026-08-01, from the wallet origin, CORS *):
//   mainnet  https://api.trongrid.io   (getaccount, /v1 history, createtransaction)
//   practice https://nile.trongrid.io  (same surface; TetherToken at TXYZopYR…)
//
// SECURITY CORE — the node builds unsigned transactions (createtransaction /
// triggersmartcontract), and this wallet NEVER signs those bytes blind:
// a hand-rolled protobuf reader decodes raw_data_hex and the wallet refuses
// to sign unless the decoded contract says EXACTLY what the user asked
// (type, owner, recipient, amount — and for USDT, the contract address and
// the calldata WE built ourselves, byte for byte). The transaction id is
// sha256(raw bytes), recomputed locally, signed with our own key.
//
// Fee honesty: TRX transfers ride free daily bandwidth (~2/day) or burn
// ~0.27 TRX; paying a brand-new address burns ~1.1 TRX extra to create it;
// USDT transfers burn energy (commonly 5–30 TRX) unless energy is staked —
// the send flow estimates this live and shows it before confirmation.

import { deriveNodeWiped } from './keys'
import { createBase58check } from '@scure/base'
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { formatEvmAmount } from './units'
import type { NetMode } from './types'
import { recordSentTo } from './sentlog'
import {
  agoText,
  dismissLanded,
  dropPending,
  EarlierSendLanded,
  markPendingFailed,
  markPendingSent,
  pendingTron,
  recordPending,
  tronInFlightBlock,
  type PendingTron,
} from './pending'

const b58check = createBase58check(sha256)

export type TronChainId = 'tron' | 'tron-nile'

export interface TronChainConfig {
  id: TronChainId
  name: string
  networkName: string
  feeNote: string
  mainnet: boolean
  api: string
  explorerTx: (id: string) => string
  explorerAddr: (addr: string) => string
  decimals: 6
  priceSymbol: string
  color: string
  usdt: { contract: string; decimals: number; symbol: string; priceSymbol: string }
}

export const TRON_CHAINS: Record<TronChainId, TronChainConfig> = {
  tron: {
    id: 'tron',
    name: 'TRON',
    networkName: 'TRON',
    feeNote:
      'TRX sends ride free daily bandwidth (about two a day) or burn ~0.27 TRX. USDT sends burn energy — the exact cost shows before you confirm.',
    mainnet: true,
    api: 'https://api.trongrid.io',
    explorerTx: (t) => `https://tronscan.org/#/transaction/${t}`,
    explorerAddr: (a) => `https://tronscan.org/#/address/${a}`,
    decimals: 6,
    priceSymbol: 'TRX',
    color: '#ff0013',
    usdt: {
      contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      decimals: 6,
      symbol: 'USDT',
      priceSymbol: 'USDT',
    },
  },
  'tron-nile': {
    id: 'tron-nile',
    name: 'TRON (practice)',
    networkName: 'TRON Nile testnet',
    feeNote: 'Practice network — fees are paid in worthless test TRX.',
    mainnet: false,
    api: 'https://nile.trongrid.io',
    explorerTx: (t) => `https://nile.tronscan.org/#/transaction/${t}`,
    explorerAddr: (a) => `https://nile.tronscan.org/#/address/${a}`,
    decimals: 6,
    priceSymbol: 'TRX',
    color: '#ff0013',
    usdt: {
      // TetherToken on Nile — live-verified via wallet/getcontract
      contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
      decimals: 6,
      symbol: 'USDT',
      priceSymbol: 'USDT',
    },
  },
}

export function tronChainsForMode(mode: NetMode): TronChainConfig[] {
  const all = Object.values(TRON_CHAINS)
  return mode === 'practice' ? all.filter((c) => !c.mainnet) : all.filter((c) => c.mainnet)
}

// ---------------------------------------------------------------------------
// Keys + addresses.

export const TRON_DERIVATION_PATH = "m/44'/195'/0'/0/0"
/**
 * Practice mode (Nile) signs with a different key, at BIP44's testnet coin
 * type: the node builds the raw transaction and nothing the wallet can check
 * binds it to Nile (its ref_block is the node's word), so a hostile Nile node
 * could otherwise get a mainnet-valid signature from the real key (audit
 * 2026-10-26, H3). No mainnet wallet derives TRON at coin type 1.
 */
export const TRON_PRACTICE_PATH = "m/44'/1'/0'/0/0"

export interface TronKey {
  address: string
  privateKey: Uint8Array
  zero: () => void
}

export function tronAddressFromPublicKey(uncompressedPub: Uint8Array): string {
  // keccak over the 64-byte point (skip the 0x04 prefix), take the low 20.
  const hash = keccak_256(uncompressedPub.slice(1))
  const payload = new Uint8Array(21)
  payload[0] = 0x41
  payload.set(hash.slice(12), 1)
  return b58check.encode(payload)
}

export function deriveTronKey(mnemonic: string, practice = false): TronKey {
  // step-wise derivation: seed, root and intermediates wiped as it goes
  const node = deriveNodeWiped(mnemonic, practice ? TRON_PRACTICE_PATH : TRON_DERIVATION_PATH)
  if (!node.privateKey) throw new Error('TRON key derivation failed')
  const privateKey = new Uint8Array(node.privateKey)
  node.wipePrivateData() // we keep only our copy
  const pub = secp256k1.getPublicKey(privateKey, false)
  const address = tronAddressFromPublicKey(pub)
  return {
    address,
    privateKey,
    zero: () => privateKey.fill(0),
  }
}

export function isValidTronAddress(addr: string): boolean {
  try {
    const decoded = b58check.decode(addr)
    return decoded.length === 21 && decoded[0] === 0x41
  } catch {
    return false
  }
}

/** T… base58check → 21-byte hex (41…), the node's non-visible form. */
export function tronAddressToHex(addr: string): string {
  return bytesToHex(b58check.decode(addr))
}

// ---------------------------------------------------------------------------
// HTTP helper.

/**
 * Keyless TronGrid allows ~3 requests a second per IP (its /v1/accounts
 * history endpoints one a second) and suspends a caller that goes over for
 * several seconds; the wallet's own refresh fired four at once and lost a
 * history half to a 429 (bug audit 2026-10-27, BM22). Every request to a
 * host now waits its turn, `gapMs` apart, and a /v1 request also waits
 * `v1GapMs` after the last /v1 one (tests set both to 0).
 */
export const tronTuning = { gapMs: 350, v1GapMs: 1_000 }
const tronLast = new Map<string, number>()
const tronQueues = new Map<string, Promise<void>>()

function tronTurn(lane: string, gapMs: number): Promise<void> {
  const turn = (tronQueues.get(lane) ?? Promise.resolve()).then(async () => {
    const wait = (tronLast.get(lane) ?? 0) + gapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    tronLast.set(lane, Date.now())
  })
  tronQueues.set(lane, turn)
  return turn
}

/** One request to the chain's node API, paced (tronTurn) with every other TRON request; tronstake.ts sends through it too. */
export async function tronCall<T>(chain: TronChainConfig, path: string, body?: unknown): Promise<T> {
  if (path.startsWith('/v1/')) await tronTurn(`${chain.api} /v1`, tronTuning.v1GapMs)
  await tronTurn(chain.api, tronTuning.gapMs)
  let res: Response
  try {
    res = await fetch(chain.api + path, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal:
        typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(15_000)
          : undefined,
    })
  } catch {
    throw new Error(
      `Couldn't reach the ${chain.networkName} network right now. Your coins are safe; try again in a few minutes.`,
    )
  }
  // TronGrid's keyless limit answers 429 and suspends the caller for a few
  // seconds; say so in plain words (bug audit 2026-10-27, BM22)
  if (res.status === 429) {
    throw Object.assign(
      new Error(`The ${chain.networkName} data service is busy (too many requests just now). Your coins are safe; try again in a few seconds.`),
      { rateLimited: true },
    )
  }
  let json: T & { Error?: string; error?: string }
  try {
    json = (await res.json()) as T & { Error?: string; error?: string }
  } catch {
    throw new Error(`${chain.name} API error (HTTP ${res.status})`)
  }
  const err = json.Error ?? json.error
  if (!res.ok || err) {
    throw new Error(err ?? `${chain.name} API error (HTTP ${res.status})`)
  }
  return json
}

// ---------------------------------------------------------------------------
// Balances.

interface GetAccountResult {
  balance?: number
  address?: string
  /** "Contract" for a smart contract's account */
  type?: string
  frozenV2?: { amount?: number }[]
  unfrozenV2?: { unfreeze_amount?: number }[]
  /** Stake 1.0, still on accounts that staked before 2023 */
  frozen?: { frozen_balance?: number }[]
  account_resource?: { frozen_balance_for_energy?: { frozen_balance?: number } }
}

/** One getaccount read for the card: liquid TRX, TRX staked or unstaking, and whether the account exists. */
export interface TronAccountView {
  balance: bigint
  /**
   * Staked (Stake 2.0, and legacy Stake 1.0) plus unstaking TRX: still the
   * holder's, not spendable. The balance alone left it out of the card, the
   * portfolio and the networks-shown check (bug audit 2026-10-27, BM8/BM9).
   */
  staked: bigint
  /** the account exists on chain: only an incoming transaction activates one, so it has history */
  activated: boolean
}

export async function getTronAccount(chain: TronChainConfig, address: string): Promise<TronAccountView> {
  const r = await tronCall<GetAccountResult>(chain, '/wallet/getaccount', { address, visible: true })
  const sun = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? BigInt(Math.trunc(v)) : 0n)
  let staked = sun(r.account_resource?.frozen_balance_for_energy?.frozen_balance)
  for (const f of r.frozenV2 ?? []) staked += sun(f.amount)
  for (const u of r.unfrozenV2 ?? []) staked += sun(u.unfreeze_amount)
  for (const f of r.frozen ?? []) staked += sun(f.frozen_balance)
  // A never-used account comes back as {} — that is a genuine zero.
  return { balance: BigInt(r.balance ?? 0), staked, activated: typeof r.address === 'string' && r.address !== '' }
}

export async function getTronBalance(chain: TronChainConfig, address: string): Promise<bigint> {
  const r = await tronCall<GetAccountResult>(chain, '/wallet/getaccount', {
    address,
    visible: true,
  })
  // A never-used account comes back as {} — that is a genuine zero.
  return BigInt(r.balance ?? 0)
}

interface ConstantResult {
  constant_result?: unknown
  energy_used?: number
  result?: { result?: boolean; message?: string }
  transaction?: { ret?: { ret?: string }[] }
}

/**
 * USDT held by an address, read from the token contract itself. TronGrid's
 * /v1/accounts answers `data: []` for an address that holds USDT but was
 * never activated (TRC-20 transfers don't activate an account) — the usual
 * first deposit from an exchange — and the wallet showed 0 (bug audit
 * 2026-10-27, BH4). A constant call works for inactive owners.
 */
export async function getTronUsdtBalance(
  chain: TronChainConfig,
  address: string,
): Promise<bigint> {
  const r = await tronCall<ConstantResult>(chain, '/wallet/triggerconstantcontract', {
    owner_address: address,
    contract_address: chain.usdt.contract,
    function_selector: 'balanceOf(address)',
    parameter: tronAddressToHex(address).slice(2).padStart(64, '0'),
    visible: true,
  })
  const hex = Array.isArray(r.constant_result) ? r.constant_result[0] : undefined
  if (r.result?.result === false || typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`Couldn't read the ${chain.usdt.symbol} balance on ${chain.networkName} right now.`)
  }
  return BigInt('0x' + hex)
}

/** What the chain charges (sun): per unit of energy, per byte of bandwidth; plus the account-creation fees. */
interface TronPrices {
  energySun: bigint
  bandwidthSun: bigint
  createAccountSun: bigint
}
const PRICE_TTL_MS = 10 * 60_000
const priceCache = new Map<string, { at: number; p: TronPrices }>()

/** Forget the cached chain prices (tests; a parameter change shows up within 10 minutes anyway). */
export function clearTronPriceCache(): void {
  priceCache.clear()
}

/** Live chain parameters (cached 10 min); the old code assumed 420 sun per energy unit, the chain charges 100. */
async function tronPrices(chain: TronChainConfig): Promise<TronPrices> {
  const hit = priceCache.get(chain.id)
  if (hit !== undefined && Date.now() - hit.at < PRICE_TTL_MS) return hit.p
  const r = await tronCall<{ chainParameter?: { key?: string; value?: number }[] }>(chain, '/wallet/getchainparameters')
  const param = (k: string): bigint | null => {
    const v = r.chainParameter?.find((x) => x.key === k)?.value
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  }
  const energySun = param('getEnergyFee')
  const bandwidthSun = param('getTransactionFee')
  if (energySun === null || bandwidthSun === null || energySun === 0n) {
    throw new Error(`Couldn't read the ${chain.networkName} network's fees right now.`)
  }
  const createAccountSun =
    (param('getCreateNewAccountFeeInSystemContract') ?? 1_000_000n) + (param('getCreateAccountFee') ?? 100_000n)
  const p = { energySun, bandwidthSun, createAccountSun }
  priceCache.set(chain.id, { at: Date.now(), p })
  return p
}

/**
 * The account's spare bandwidth and energy right now. A transaction takes
 * its bandwidth from ONE pool, staked first, else the daily free allowance,
 * else it burns TRX for all of it: the pools are never combined, so the
 * larger one is what a send can count on (adding them read 200 + 200 spare
 * as covering a 270-byte send; review 2026-10-28).
 */
async function tronFreeResources(chain: TronChainConfig, address: string): Promise<{ bandwidth: bigint; energy: bigint }> {
  const r = await tronCall<{
    freeNetLimit?: number
    freeNetUsed?: number
    NetLimit?: number
    NetUsed?: number
    EnergyLimit?: number
    EnergyUsed?: number
  }>(chain, '/wallet/getaccountresource', { address, visible: true })
  const n = (v: number | undefined) => BigInt(typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0)
  const spare = (limit: number | undefined, used: number | undefined) => {
    const d = n(limit) - n(used)
    return d > 0n ? d : 0n
  }
  return {
    bandwidth: (() => {
      const free = spare(r.freeNetLimit, r.freeNetUsed)
      const staked = spare(r.NetLimit, r.NetUsed)
      return free > staked ? free : staked
    })(),
    energy: spare(r.EnergyLimit, r.EnergyUsed),
  }
}

// ---------------------------------------------------------------------------
// Minimal protobuf reader — just enough to decode protocol.Transaction.raw and
// refuse to sign anything that doesn't match the user's intent. Unknown
// fields are skipped structurally; unknown WIRE TYPES abort (fail closed).

interface PbField {
  num: number
  wire: number
  varint?: bigint
  bytes?: Uint8Array
}

function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  let p = pos
  for (;;) {
    if (p >= buf.length) throw new Error('truncated varint')
    const b = buf[p]!
    value |= BigInt(b & 0x7f) << shift
    p += 1
    if ((b & 0x80) === 0) break
    shift += 7n
    if (shift > 70n) throw new Error('varint too long')
  }
  return { value, next: p }
}

function readFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = []
  let p = 0
  while (p < buf.length) {
    const tag = readVarint(buf, p)
    const num = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    p = tag.next
    if (wire === 0) {
      const v = readVarint(buf, p)
      out.push({ num, wire, varint: v.value })
      p = v.next
    } else if (wire === 2) {
      const len = readVarint(buf, p)
      const start = len.next
      const end = start + Number(len.value)
      if (end > buf.length) throw new Error('truncated length-delimited field')
      out.push({ num, wire, bytes: buf.slice(start, end) })
      p = end
    } else if (wire === 5) {
      out.push({ num, wire })
      p += 4
    } else if (wire === 1) {
      out.push({ num, wire })
      p += 8
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
  }
  return out
}

const CONTRACT_TYPE_TRANSFER = 1n
const CONTRACT_TYPE_TRIGGER = 31n
// Stake 2.0 family (protocol.Transaction.Contract.ContractType values)
const CONTRACT_TYPE_VOTE = 4n
const CONTRACT_TYPE_WITHDRAW_REWARD = 13n
const CONTRACT_TYPE_FREEZE_V2 = 54n
const CONTRACT_TYPE_UNFREEZE_V2 = 55n
const CONTRACT_TYPE_WITHDRAW_UNFREEZE = 56n

export type TronContractType =
  | 'TransferContract'
  | 'TriggerSmartContract'
  | 'VoteWitnessContract'
  | 'WithdrawBalanceContract'
  | 'FreezeBalanceV2Contract'
  | 'UnfreezeBalanceV2Contract'
  | 'WithdrawExpireUnfreezeContract'
  | 'other'

export interface DecodedTronTx {
  expiration: bigint
  /** when the node built it (unix ms, the node's clock): expiration − timestamp is the transaction's window */
  timestamp: bigint
  feeLimit: bigint
  contracts: {
    type: TronContractType
    /** T… addresses */
    owner: string | null
    to: string | null
    amount: bigint
    contractAddress: string | null
    dataHex: string | null
    /** TriggerSmartContract: TRX attached to the call — must be 0 for USDT */
    callValue: bigint
    /** TriggerSmartContract: TRC-10 amount/id attached — must be 0 for USDT */
    callTokenValue: bigint
    tokenId: bigint
    /** freeze/unfreeze: which resource the stake buys */
    resource: 'BANDWIDTH' | 'ENERGY' | null
    /** vote: SR address + vote count pairs */
    votes: { address: string; count: bigint }[] | null
  }[]
}

function addrFromBytes(b: Uint8Array | undefined): string | null {
  if (!b || b.length !== 21 || b[0] !== 0x41) return null
  return b58check.encode(b)
}

const UNEXPECTED =
  'The transaction bytes the node returned contain unexpected or duplicate fields — refusing to sign them. Nothing was sent.'

/**
 * Deny-by-default field reader: every present field must be in `spec` with
 * the expected wire type, and may appear at most once. Protobuf lets a
 * hostile node ADD fields an allow-by-omission decoder never sees (they still
 * get signed and executed), or REPEAT one — TRON's Java stack resolves
 * duplicate scalars last-wins, so a first-wins read here would verify a
 * different value than the chain executes. Both games end in this throw.
 */
function fieldsOnce(fields: PbField[], spec: Record<number, number>): Map<number, PbField> {
  const out = new Map<number, PbField>()
  for (const f of fields) {
    if (spec[f.num] !== f.wire || out.has(f.num)) throw new Error(UNEXPECTED)
    out.set(f.num, f)
  }
  return out
}

const TYPE_BY_ENUM = new Map<bigint, TronContractType>([
  [CONTRACT_TYPE_TRANSFER, 'TransferContract'],
  [CONTRACT_TYPE_TRIGGER, 'TriggerSmartContract'],
  [CONTRACT_TYPE_VOTE, 'VoteWitnessContract'],
  [CONTRACT_TYPE_WITHDRAW_REWARD, 'WithdrawBalanceContract'],
  [CONTRACT_TYPE_FREEZE_V2, 'FreezeBalanceV2Contract'],
  [CONTRACT_TYPE_UNFREEZE_V2, 'UnfreezeBalanceV2Contract'],
  [CONTRACT_TYPE_WITHDRAW_UNFREEZE, 'WithdrawExpireUnfreezeContract'],
])

/** Allowed inner fields per contract type (field number → wire type). */
const INNER_SPEC: Record<string, Record<number, number>> = {
  TransferContract: { 1: 2, 2: 2, 3: 0 }, // owner, to, amount
  TriggerSmartContract: { 1: 2, 2: 2, 3: 0, 4: 2, 5: 0, 6: 0 }, // owner, contract, call_value, data, call_token_value, token_id
  WithdrawBalanceContract: { 1: 2 }, // owner
  FreezeBalanceV2Contract: { 1: 2, 2: 0, 3: 0 }, // owner, frozen_balance, resource
  UnfreezeBalanceV2Contract: { 1: 2, 2: 0, 3: 0 }, // owner, unfreeze_balance, resource
  WithdrawExpireUnfreezeContract: { 1: 2 }, // owner
}

function decodeContract(bytes: Uint8Array): DecodedTronTx['contracts'][number] {
  // Transaction.Contract: 1 type, 2 parameter (Any). provider(3),
  // ContractName(4) and Permission_id(5) never appear on wallet-requested
  // transactions — Permission_id especially would switch which account
  // authority the signature exercises — so their presence is refusal.
  const c = fieldsOnce(readFields(bytes), { 1: 0, 2: 2 })
  const typeField = c.get(1)
  const paramField = c.get(2)
  if (typeField?.varint === undefined || !paramField?.bytes) throw new Error(UNEXPECTED)
  const type = TYPE_BY_ENUM.get(typeField.varint) ?? 'other'

  const empty = {
    owner: null,
    to: null,
    amount: 0n,
    contractAddress: null,
    dataHex: null,
    callValue: 0n,
    callTokenValue: 0n,
    tokenId: 0n,
    resource: null,
    votes: null,
  }
  // Unknown contract type: nothing to model — every verify path rejects it.
  if (type === 'other') return { type, ...empty }

  // google.protobuf.Any: 1 type_url, 2 value. The url must agree with the
  // type enum, or the node is labelling one contract while encoding another.
  const any = fieldsOnce(readFields(paramField.bytes), { 1: 2, 2: 2 })
  const typeUrl = new TextDecoder().decode(any.get(1)?.bytes ?? new Uint8Array())
  const valueBytes = any.get(2)?.bytes
  if (!valueBytes || !typeUrl.endsWith(`/protocol.${type}`)) throw new Error(UNEXPECTED)

  if (type === 'VoteWitnessContract') {
    // owner(1) at most once; votes(2) legitimately repeated
    let owner: string | null = null
    let ownerSeen = false
    const votes: { address: string; count: bigint }[] = []
    for (const f of readFields(valueBytes)) {
      if (f.num === 1 && f.wire === 2 && !ownerSeen) {
        ownerSeen = true
        owner = addrFromBytes(f.bytes)
      } else if (f.num === 2 && f.wire === 2 && f.bytes) {
        const vf = fieldsOnce(readFields(f.bytes), { 1: 2, 2: 0 })
        const addr = addrFromBytes(vf.get(1)?.bytes)
        if (addr === null) throw new Error(UNEXPECTED)
        votes.push({ address: addr, count: vf.get(2)?.varint ?? 0n })
      } else {
        throw new Error(UNEXPECTED)
      }
    }
    return { type, ...empty, owner, votes }
  }

  const inner = fieldsOnce(readFields(valueBytes), INNER_SPEC[type]!)
  const isStakeAmount =
    type === 'TransferContract' ||
    type === 'FreezeBalanceV2Contract' ||
    type === 'UnfreezeBalanceV2Contract'
  return {
    type,
    ...empty,
    owner: addrFromBytes(inner.get(1)?.bytes),
    to: type === 'TransferContract' ? addrFromBytes(inner.get(2)?.bytes) : null,
    // TransferContract amount, FreezeV2 frozen_balance and UnfreezeV2
    // unfreeze_balance all live in fields 2/3 with the same varint shape
    amount: isStakeAmount ? (inner.get(type === 'TransferContract' ? 3 : 2)?.varint ?? 0n) : 0n,
    contractAddress: type === 'TriggerSmartContract' ? addrFromBytes(inner.get(2)?.bytes) : null,
    dataHex:
      type === 'TriggerSmartContract' ? bytesToHex(inner.get(4)?.bytes ?? new Uint8Array()) : null,
    callValue: type === 'TriggerSmartContract' ? (inner.get(3)?.varint ?? 0n) : 0n,
    callTokenValue: type === 'TriggerSmartContract' ? (inner.get(5)?.varint ?? 0n) : 0n,
    tokenId: type === 'TriggerSmartContract' ? (inner.get(6)?.varint ?? 0n) : 0n,
    resource:
      type === 'FreezeBalanceV2Contract' || type === 'UnfreezeBalanceV2Contract'
        ? decodeResource(inner.get(3)?.varint ?? 0n)
        : null,
  }
}

/** protocol.ResourceCode: 0 BANDWIDTH, 1 ENERGY; anything else is not something this wallet asked for. */
function decodeResource(v: bigint): 'BANDWIDTH' | 'ENERGY' {
  if (v === 0n) return 'BANDWIDTH'
  if (v === 1n) return 'ENERGY'
  throw new Error(UNEXPECTED)
}

/** Decode protocol.Transaction.raw (the exact bytes that get signed). */
export function decodeTronRawTx(rawHex: string): DecodedTronTx {
  const fields = readFields(hexToBytes(rawHex))
  const out: DecodedTronTx = { expiration: 0n, timestamp: 0n, feeLimit: 0n, contracts: [] }
  // protocol.Transaction.raw: 1 ref_block_bytes, 3 ref_block_num,
  // 4 ref_block_hash, 8 expiration, 11 contract (repeated), 14 timestamp,
  // 18 fee_limit. Anything else — data/memo(10), scripts(12), auths(9) — is
  // nothing a wallet-requested transaction carries, so it is refused rather
  // than signed unseen.
  const TOP_SPEC: Record<number, number> = { 1: 2, 3: 0, 4: 2, 8: 0, 14: 0, 18: 0 }
  const seen = new Set<number>()
  for (const f of fields) {
    if (f.num === 11) {
      if (f.wire !== 2 || !f.bytes) throw new Error(UNEXPECTED)
      out.contracts.push(decodeContract(f.bytes))
      continue
    }
    if (TOP_SPEC[f.num] !== f.wire || seen.has(f.num)) throw new Error(UNEXPECTED)
    seen.add(f.num)
    if (f.num === 8) out.expiration = f.varint ?? 0n
    if (f.num === 14) out.timestamp = f.varint ?? 0n
    if (f.num === 18) out.feeLimit = f.varint ?? 0n
  }
  return out
}

/**
 * How far ahead a transaction's expiration may sit. The node sets ~60 s;
 * the chain's own maximum is 24 h, which is how long a captured signature
 * would stay replayable. Ten minutes leaves room for clock skew and bounds
 * the in-flight ledger's hold to the same (audit 2026-10-26, M4).
 */
export const TRON_MAX_EXPIRATION_MS = 10 * 60_000

/**
 * Envelope checks shared by every signing path: fee_limit must be exactly
 * what the flow pins (0 for bandwidth-only contracts — an inflated limit is
 * budget a hostile node could burn as energy), and expiration must sit
 * within TRON_MAX_EXPIRATION_MS of now. A device clock that runs fast would
 * make a fresh transaction look expired, so the past is tolerated by the
 * same margin: the chain refuses anything truly expired anyway.
 */
export function assertTronEnvelope(decoded: DecodedTronTx, feeLimit: bigint): void {
  if (decoded.feeLimit !== feeLimit) throw new Error(UNEXPECTED)
  const now = Date.now()
  if (
    decoded.expiration <= BigInt(now - TRON_MAX_EXPIRATION_MS) ||
    decoded.expiration > BigInt(now + TRON_MAX_EXPIRATION_MS)
  ) {
    // most often this device's clock, so say so (bug audit 2026-10-27, BM3)
    throw new Error(CLOCK_OR_NODE)
  }
}

const CLOCK_OR_NODE =
  "The transaction's expiry is more than 10 minutes away from this device's clock. If the clock is wrong, set it to update automatically and try again; otherwise the network node is misbehaving. Nothing was signed."

// ---------------------------------------------------------------------------
// Sending.

export type TronAsset = 'trx' | 'usdt'

export interface PreparedTronSend {
  chain: TronChainConfig
  asset: TronAsset
  to: string
  /** sun for TRX; USDT smallest-units for USDT */
  amount: bigint
  /** estimated network burn in sun (bandwidth / energy), display-only */
  estimatedFeeSun: bigint
  /** hard cap the transaction commits to (USDT only; 0 for TRX) */
  feeLimitSun: bigint
  /** true when the recipient account does not exist yet (TRX burns ~1.1 extra) */
  createsAccount: boolean
  /** the recipient is a smart contract: what it receives is lost unless it was built to hold it */
  recipientIsContract?: boolean
  /** the exact bytes to sign (verified by our own decoder) */
  rawDataHex: string
  /** verbatim node response pieces needed to broadcast */
  rawData: unknown
  txID: string
  /** the transaction's own expiration (unix ms), from the verified bytes */
  expiration: number
  /** when the node built it (unix ms), from the verified bytes; 0 when absent */
  timestamp: number
}

/**
 * How long a reviewed TRON transaction stays confirmable: the node builds it
 * to expire a minute after it was made, so a review left open longer is
 * built again before it is signed instead of failing as expired (bug audit
 * 2026-10-27, BL32).
 */
export const TRON_REVIEW_FRESH_MS = 45_000

/** True once the node knows this transaction (pool or chain). A failed call throws. */
export async function tronTxSeen(chain: TronChainConfig, txid: string): Promise<boolean> {
  const r = await tronCall<{ txID?: unknown }>(chain, '/wallet/gettransactionbyid', { value: txid, visible: true })
  return typeof r.txID === 'string'
}

/**
 * Where a transaction stands: known and not failed ('ok': a TRX transfer
 * carries no contract result), in a block but failed there ('failed': a
 * USDT send out of energy spent its fee and moved nothing), or unknown to
 * the node. "Seen" alone read a failed USDT send as "went through" (review
 * 2026-10-28). A failed lookup throws.
 */
export async function tronTxStatus(chain: TronChainConfig, txid: string): Promise<'ok' | 'failed' | 'unseen'> {
  const r = await tronCall<{ txID?: unknown; ret?: { contractRet?: unknown }[] }>(chain, '/wallet/gettransactionbyid', {
    value: txid,
    visible: true,
  })
  if (typeof r.txID !== 'string') return 'unseen'
  const ret = r.ret?.[0]?.contractRet
  return typeof ret === 'string' && ret !== 'SUCCESS' ? 'failed' : 'ok'
}

/** The message for an attempt that reached a block but failed there. */
const TRON_LANDED_FAILED =
  'reached the network but failed there, so nothing was paid (its network fee was spent). You can go ahead now.'

/**
 * Refuse a new TRON send or stake while a recent attempt on this chain is
 * neither seen by the node nor past its own expiration: TRON has no nonce,
 * so a rebuilt transaction would land beside the first if the first's
 * answer was merely lost (audit 2026-10-26, H2).
 */
export async function assertNoTronInFlight(chain: TronChainConfig): Promise<void> {
  const block = await tronInFlightBlock(chain.id, (txid) => tronTxSeen(chain, txid))
  if (block === null) return
  if (block.reason === 'landed') {
    // in a block, but failed there: nothing was paid, so say that instead
    if ((await tronTxStatus(chain, block.entry.txid).catch(() => null)) === 'failed') {
      dismissLanded(block.entry)
      throw new Error(`Your transaction from ${agoText(block.entry.ts)} on ${chain.networkName} ${TRON_LANDED_FAILED}`)
    }
    throw new EarlierSendLanded(
      block.entry,
      `Your transaction from ${agoText(block.entry.ts)} (to ${block.entry.to.slice(0, 8)}…) on ${chain.networkName}`,
    )
  }
  throw new Error(
    block.reason === 'pending'
      ? `A transaction from ${agoText(block.entry.ts)} may still go through — its window hasn't closed. Wait a few minutes, then try again; sending now could pay twice.`
      : `Couldn't check whether your transaction from ${agoText(block.entry.ts)} went through. Wait a minute and try again — sending without knowing could pay twice.`,
  )
}

const MISMATCH =
  'The transaction the network node returned does not match your request — refusing to sign it. Nothing was sent and your coins are untouched.'

/** Bandwidth a plain TRX transfer uses (bytes). */
const TRX_TRANSFER_BYTES = 270n
/** Bandwidth a USDT transfer uses (bytes). */
const USDT_TRANSFER_BYTES = 350n
/** Energy assumed when the free estimate call fails: a transfer to a fresh holder, the costly case. */
const USDT_ENERGY_FALLBACK = 131_000n
/** fee_limit floor and ceiling for USDT sends (the limit itself is sized from the estimate). */
const USDT_FEE_LIMIT_MIN_SUN = 30_000_000n
const USDT_FEE_LIMIT_MAX_SUN = 150_000_000n

interface CreateTxResult {
  raw_data?: unknown
  raw_data_hex?: string
  txID?: string
  Error?: string
}

function verifyTxId(rawHex: string, claimed: string | undefined): string {
  const computed = bytesToHex(sha256(hexToBytes(rawHex)))
  if (claimed !== undefined && claimed !== computed) throw new Error(MISMATCH)
  return computed
}

export async function prepareTronSend(
  chain: TronChainConfig,
  key: TronKey,
  asset: TronAsset,
  to: string,
  requested: bigint,
  /** sendMax: everything (TRX: after this send's own network costs); `requested` is ignored (BL33) */
  opts?: { sendMax?: boolean },
): Promise<PreparedTronSend> {
  const sendMax = opts?.sendMax === true
  let amount = requested
  if (!isValidTronAddress(to)) {
    throw new Error(`"${to}" is not a valid TRON address (they start with T).`)
  }
  if (to === key.address) {
    throw new Error('That is your own address — sending to yourself only burns fees.')
  }
  // Where nothing comes back: the zero address, and the USDT contract itself
  // (tokens sent to their own contract are stuck there for good; bug audit
  // 2026-10-27, BM23)
  if (tronAddressToHex(to).toLowerCase() === '41' + '0'.repeat(40)) {
    throw new Error('That is the zero address. Anything sent there is lost for good.')
  }
  if (to === chain.usdt.contract) {
    throw new Error(`That is the ${chain.usdt.symbol} token contract itself, not a wallet. Anything sent there is lost for good.`)
  }
  if (!sendMax && amount <= 0n) throw new Error('Enter an amount to send.')
  await assertNoTronInFlight(chain)

  const [balance, usdtBalance, toAccount, prices, free] = await Promise.all([
    getTronBalance(chain, key.address),
    asset === 'usdt' ? getTronUsdtBalance(chain, key.address) : Promise.resolve(0n),
    tronCall<GetAccountResult>(chain, '/wallet/getaccount', { address: to, visible: true }),
    tronPrices(chain),
    tronFreeResources(chain, key.address),
  ])
  const createsAccount = toAccount.address === undefined
  const recipientIsContract = toAccount.type === 'Contract'

  if (asset === 'trx') {
    // Creating the recipient's account burns the creation fees instead of
    // bandwidth; otherwise bandwidth is free while the account has some
    // spare (free daily or staked), and burned at the chain's price if not.
    const feeEstimate = createsAccount
      ? prices.createAccountSun
      : free.bandwidth >= TRX_TRANSFER_BYTES
        ? 0n
        : TRX_TRANSFER_BYTES * prices.bandwidthSun
    if (sendMax) {
      amount = balance - feeEstimate
      if (amount <= 0n) throw new Error(`Nothing to send after the ~${formatTron(feeEstimate)} TRX network cost.`)
    }
    if (amount + feeEstimate > balance) {
      throw new Error(
        `Insufficient TRX: amount plus ~${formatTron(feeEstimate)} TRX in network costs exceeds your ${formatTron(balance)} TRX.`,
      )
    }
    const r = await tronCall<CreateTxResult>(chain, '/wallet/createtransaction', {
      owner_address: key.address,
      to_address: to,
      amount: Number(amount),
      visible: true,
    })
    if (!r.raw_data_hex) throw new Error(MISMATCH)
    const decoded = decodeTronRawTx(r.raw_data_hex)
    assertTronEnvelope(decoded, 0n)
    const c = decoded.contracts[0]
    if (
      decoded.contracts.length !== 1 ||
      c === undefined ||
      c.type !== 'TransferContract' ||
      c.owner !== key.address ||
      c.to !== to ||
      c.amount !== amount
    ) {
      throw new Error(MISMATCH)
    }
    return {
      chain,
      asset,
      to,
      amount,
      estimatedFeeSun: feeEstimate,
      feeLimitSun: 0n,
      createsAccount,
      recipientIsContract,
      rawDataHex: r.raw_data_hex,
      rawData: r.raw_data,
      txID: verifyTxId(r.raw_data_hex, r.txID),
      expiration: Number(decoded.expiration),
      timestamp: Number(decoded.timestamp),
    }
  }

  // USDT: build the calldata ourselves — transfer(address,uint256).
  if (sendMax) {
    amount = usdtBalance
    if (amount <= 0n) throw new Error(`There is no ${chain.usdt.symbol} to send.`)
  }
  if (amount > usdtBalance) {
    throw new Error(
      `Insufficient ${chain.usdt.symbol}: you have ${formatTronUsdt(chain, amount > usdtBalance ? usdtBalance : amount)} ${chain.usdt.symbol}.`,
    )
  }
  const toHex20 = tronAddressToHex(to).slice(2) // drop the 41 prefix
  const param = toHex20.padStart(64, '0') + amount.toString(16).padStart(64, '0')
  const calldata = 'a9059cbb' + param

  // Energy from a free test run of the transfer. A run the contract refuses
  // would fail on chain and still burn TRX: refuse it now. If the test run
  // can't be made at all, assume the costly case (a fresh recipient).
  let energy = USDT_ENERGY_FALLBACK
  let est: ConstantResult | null = null
  try {
    est = await tronCall<ConstantResult>(chain, '/wallet/triggerconstantcontract', {
      owner_address: key.address,
      contract_address: chain.usdt.contract,
      function_selector: 'transfer(address,uint256)',
      parameter: param,
      visible: true,
    })
  } catch {
    est = null
  }
  if (est !== null) {
    const ret = est.transaction?.ret?.[0]?.ret
    if (est.result?.result === false || (ret !== undefined && ret !== 'SUCCESS')) {
      throw new Error(
        `The ${chain.usdt.symbol} contract refused this transfer in a test run, so it would fail on the network and still cost TRX. Nothing was sent.`,
      )
    }
    if (typeof est.energy_used === 'number' && Number.isSafeInteger(est.energy_used) && est.energy_used > 0) {
      energy = BigInt(est.energy_used)
    }
  }
  // TRX burns only for the energy and bandwidth the account doesn't have
  // spare (staking for energy makes USDT sends cheap, often free), at the
  // chain's own prices (bug audit 2026-10-27, BH3: the old code charged 420
  // sun per energy unit when the chain charges 100, and ignored staking).
  const energyShort = energy > free.energy ? energy - free.energy : 0n
  const energyBurn = energyShort * prices.energySun
  const bandwidthBurn = free.bandwidth >= USDT_TRANSFER_BYTES ? 0n : USDT_TRANSFER_BYTES * prices.bandwidthSun
  const estimatedFeeSun = energyBurn + bandwidthBurn
  // Past the ceiling the network is abnormally expensive.
  if ((energyBurn * 3n + 1n) / 2n > USDT_FEE_LIMIT_MAX_SUN) {
    throw new Error(
      `Sending ${chain.usdt.symbol} would cost about ${formatTron(estimatedFeeSun)} TRX in network fees right now, which is unusually high. Try again later.`,
    )
  }
  // fee_limit caps ALL the energy the call may use, staked energy included
  // (java-tron: the smaller of what the account has and fee_limit / price),
  // so it is sized from all of it at the chain's price, half again, never
  // below 30 TRX nor above the ceiling. Sized from the burned part alone, a
  // partly staked account ran out of energy at a higher price (review
  // 2026-10-28).
  const energyCostSun = energy * prices.energySun
  if (energyCostSun > USDT_FEE_LIMIT_MAX_SUN) {
    throw new Error(
      `Energy on ${chain.networkName} is unusually expensive right now, so this ${chain.usdt.symbol} send could run out of it and fail. Try again later.`,
    )
  }
  const sized = (energyCostSun * 3n + 1n) / 2n
  const feeLimitSun =
    sized > USDT_FEE_LIMIT_MAX_SUN ? USDT_FEE_LIMIT_MAX_SUN : sized > USDT_FEE_LIMIT_MIN_SUN ? sized : USDT_FEE_LIMIT_MIN_SUN
  if (balance < estimatedFeeSun) {
    throw new Error(
      `Sending ${chain.usdt.symbol} burns about ${formatTron(estimatedFeeSun)} TRX in network fees now. ` +
        `You have ${formatTron(balance)} TRX — top up a little TRX first` +
        (free.energy > 0n ? '.' : ', or stake TRX for energy to make USDT sends cheaper.'),
    )
  }

  const r = await tronCall<{ transaction?: CreateTxResult; result?: { result?: boolean } }>(
    chain,
    '/wallet/triggersmartcontract',
    {
      owner_address: key.address,
      contract_address: chain.usdt.contract,
      function_selector: 'transfer(address,uint256)',
      parameter: param,
      fee_limit: Number(feeLimitSun),
      call_value: 0,
      visible: true,
    },
  )
  const tx = r.transaction
  if (!tx?.raw_data_hex) throw new Error(MISMATCH)
  const decoded = decodeTronRawTx(tx.raw_data_hex)
  assertTronEnvelope(decoded, feeLimitSun)
  const c = decoded.contracts[0]
  if (
    decoded.contracts.length !== 1 ||
    c === undefined ||
    c.type !== 'TriggerSmartContract' ||
    c.owner !== key.address ||
    c.contractAddress !== chain.usdt.contract ||
    c.dataHex !== calldata ||
    // transfer() is non-payable, so any attached TRX/TRC-10 value is a
    // hostile rider the calldata compare alone would never see
    c.callValue !== 0n ||
    c.callTokenValue !== 0n ||
    c.tokenId !== 0n
  ) {
    throw new Error(MISMATCH)
  }
  return {
    chain,
    asset,
    to,
    amount,
    estimatedFeeSun,
    feeLimitSun,
    createsAccount,
    recipientIsContract,
    rawDataHex: tx.raw_data_hex,
    rawData: tx.raw_data,
    txID: verifyTxId(tx.raw_data_hex, tx.txID),
    expiration: Number(decoded.expiration),
    timestamp: Number(decoded.timestamp),
  }
}

/** The exact body a TRON broadcast posts: kept so "Send again" re-sends the SAME signed transaction. */
export interface TronBroadcastBody {
  raw_data: unknown
  raw_data_hex: string
  txID: string
  signature: string[]
  visible: true
}

/**
 * A broadcast with no definite answer: it may have gone out. Carries the
 * signed body, so the UI can re-send the same transaction (which can't pay
 * twice) instead of building a new one (which could).
 */
export class TronBroadcastError extends Error {
  readonly body: TronBroadcastBody
  constructor(message: string, body: TronBroadcastBody) {
    super(message)
    this.name = 'TronBroadcastError'
    this.body = body
  }
}

/** The attempt's window closed and the chain never saw it: it can't land, so a new send is safe. */
export class TronExpiredError extends Error {
  constructor() {
    super('That attempt expired on the network without going through. You can send again.')
    this.name = 'TronExpiredError'
  }
}

/** Extra hold beyond the transaction's own window, on this device's clock. */
const TRON_HOLD_MARGIN_MS = 30_000

function nodeMessage(r: { message?: string; code?: string }): string {
  let detail = r.message ?? r.code ?? 'the node rejected the transaction'
  try {
    // node messages arrive hex-encoded
    detail = new TextDecoder().decode(hexToBytes(detail))
  } catch {
    // keep as-is
  }
  return detail
}

/**
 * Post a signed TRON transaction: the one path for a first broadcast and a
 * resend (bug audit 2026-10-27, BH1). Accepted, or DUP_TRANSACTION_ERROR
 * (the node already holds it — a lost answer to an earlier try), is
 * success. An expiry error asks the chain whether it landed before calling
 * it dead. Any other answer to a first broadcast is a refusal: nothing was
 * taken, the record goes. A refused RESEND keeps it: the refusal is about
 * the resend, and the first try may be its very reason (the balance it
 * spent). No answer at all: the record stays, marked failed, and the error
 * carries the body to resend.
 */
async function postTronBroadcast(
  chain: TronChainConfig,
  body: TronBroadcastBody,
  entry: PendingTron | undefined,
): Promise<string> {
  const resend = entry?.failed === true
  let r: { result?: boolean; code?: string; message?: string }
  try {
    r = await tronCall<{ result?: boolean; code?: string; message?: string }>(chain, '/wallet/broadcasttransaction', body)
  } catch {
    if (entry !== undefined) markPendingFailed(entry)
    throw new TronBroadcastError(
      "The network didn't confirm it received this transaction. It may still go through.",
      body,
    )
  }
  const sent = (): string => {
    if (resend) markPendingSent(entry)
    return body.txID
  }
  // java-tron's code is DUP_TRANSACTION_ERROR (api.proto Return.response_code);
  // checking for DUP_TRANSACTION read "I already have it" as a refusal and
  // dropped the record of a send that was on its way (review 2026-10-28)
  if (r.result === true || r.code === 'DUP_TRANSACTION_ERROR' || r.code === 'DUP_TRANSACTION') return sent()
  const detail = nodeMessage(r)
  if (r.code === 'TRANSACTION_EXPIRATION_ERROR' || /expired/i.test(detail)) {
    const status = await tronTxStatus(chain, body.txID).catch(() => null)
    if (status === 'ok') return sent()
    if (status === 'failed') {
      if (entry !== undefined) dropPending(entry)
      throw new Error(`The transaction ${TRON_LANDED_FAILED}`)
    }
    if (status === 'unseen') {
      if (entry !== undefined) dropPending(entry)
      throw new TronExpiredError()
    }
    if (entry !== undefined) markPendingFailed(entry)
    throw new TronBroadcastError(
      "The transaction's network window closed, and the wallet couldn't ask whether it landed first.",
      body,
    )
  }
  if (resend) {
    throw new TronBroadcastError(
      `The network refused this second try (${detail}). The first try may still go through, so new sends on ${chain.networkName} wait until the wallet can tell.`,
      body,
    )
  }
  // The node answered a first broadcast with a rejection, so nothing was
  // taken: the record would only block the user for nothing.
  if (entry !== undefined) dropPending(entry)
  throw new Error(`The network refused this transaction: ${detail}. Nothing was sent.`)
}

export async function broadcastTronSend(
  key: TronKey,
  prepared: PreparedTronSend,
): Promise<string> {
  // txID = sha256(raw bytes) — recomputed at prepare; sign exactly that.
  const digest = hexToBytes(prepared.txID)
  // The hold runs on THIS device's clock: the transaction's own window
  // (expiration − timestamp, both the node's clock) from now, plus a margin
  // (bug audit 2026-10-27, BM3: comparing the node's expiration with a clock
  // running fast dropped the record the moment it was written). Nothing
  // checks the timestamp, though, and a node that set it just short of the
  // expiration shrank the hold to the margin while the transaction stayed
  // valid for minutes: the hold also lasts to the expiration itself, on
  // this clock, whichever ends later (review 2026-10-28).
  const now = Date.now()
  const windowMs =
    prepared.timestamp !== undefined && prepared.timestamp > 0
      ? Math.min(
          Math.max(prepared.expiration - prepared.timestamp, prepared.expiration - now, 0),
          TRON_MAX_EXPIRATION_MS,
        )
      : TRON_MAX_EXPIRATION_MS
  const entry: PendingTron = {
    kind: 'tron',
    chainId: prepared.chain.id,
    txid: prepared.txID,
    to: prepared.to,
    expiration: prepared.expiration,
    holdUntil: now + windowMs + TRON_HOLD_MARGIN_MS,
    ts: now,
  }
  // recorded BEFORE the send so even a timed-out attempt leaves a trace
  recordPending(entry)
  const sig = secp256k1.sign(digest, key.privateKey)
  const signature = bytesToHex(sig.toCompactRawBytes()) + (sig.recovery === 1 ? '01' : '00')
  // the send log trusts an address paid, or maybe paid: not one the node
  // refused, nor an attempt that expired unseen (bug audit 2026-10-27, BL19)
  try {
    const txid = await postTronBroadcast(
      prepared.chain,
      {
        raw_data: prepared.rawData,
        raw_data_hex: prepared.rawDataHex,
        txID: prepared.txID,
        signature: [signature],
        visible: true,
      },
      entry,
    )
    recordSentTo(prepared.chain.id, prepared.to)
    return txid
  } catch (e) {
    if (e instanceof TronBroadcastError) recordSentTo(prepared.chain.id, prepared.to)
    throw e
  }
}

/** "Send again" after a failed broadcast: the SAME signed transaction, never a new one. */
export function rebroadcastTron(chain: TronChainConfig, err: TronBroadcastError): Promise<string> {
  const entry = pendingTron(chain.id).find((p) => p.txid === err.body.txID)
  return postTronBroadcast(chain, err.body, entry)
}

// ---------------------------------------------------------------------------
// History: native transfers + TRC20 USDT transfers, merged newest-first.

export interface TronTx {
  id: string
  direction: 'in' | 'out' | 'self'
  /** signed; sun for trx rows, USDT units for usdt rows */
  amount: bigint
  asset: TronAsset
  time: number | null
  counterparty: string | null
  failed: boolean
}

interface V1TxContractValue {
  amount?: number
  owner_address?: string
  to_address?: string
  /** TriggerSmartContract: the contract called and its call data */
  contract_address?: string
  data?: string
}

/** a transaction id as the explorer links expect it; anything else from the API is dropped (BL35) */
const TRON_TXID = /^[0-9a-f]{64}$/i

interface V1Tx {
  txID?: string
  ret?: { contractRet?: string }[]
  block_timestamp?: number
  raw_data?: { contract?: { type?: string; parameter?: { value?: V1TxContractValue } }[] }
}

interface V1Trc20Tx {
  transaction_id?: string
  from?: string
  to?: string
  value?: string
  block_timestamp?: number
  token_info?: { address?: string }
}

export function hexAddrToBase58(hex: string | undefined): string | null {
  if (!hex || hex.length !== 42 || !hex.startsWith('41')) return null
  try {
    return b58check.encode(hexToBytes(hex))
  } catch {
    return null
  }
}

/**
 * Recent TRX and USDT transfers. A half that fails (a rate limit, say)
 * keeps that half's rows from `prev`, so a refresh doesn't empty them (bug
 * audit 2026-10-27, BM22); both failing is an error. Zero-value transfers
 * are poisoning bait, not history (BM24).
 */
/** A row for this address's own USDT transfer that the chain ran and refused, or null. */
function failedUsdtSend(chain: TronChainConfig, address: string, t: V1Tx): TronTx | null {
  const contract = t.raw_data?.contract?.[0]
  const ret = t.ret?.[0]?.contractRet
  if (contract?.type !== 'TriggerSmartContract' || ret === undefined || ret === 'SUCCESS') return null
  const v = contract.parameter?.value
  const owner = hexAddrToBase58(v?.owner_address) ?? v?.owner_address
  const target = hexAddrToBase58(v?.contract_address) ?? v?.contract_address
  if (owner !== address || target !== chain.usdt.contract) return null
  const m = /^a9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/i.exec(v?.data ?? '')
  if (m === null) return null
  return {
    id: t.txID!,
    direction: 'out',
    amount: -BigInt('0x' + m[2]!),
    asset: 'usdt',
    time: t.block_timestamp != null ? Math.floor(t.block_timestamp / 1000) : null,
    counterparty: hexAddrToBase58('41' + m[1]!),
    failed: true,
  }
}

export async function fetchTronHistory(
  chain: TronChainConfig,
  address: string,
  prev: readonly TronTx[] = [],
): Promise<TronTx[]> {
  const [nativeRes, trc20Res] = await Promise.allSettled([
    tronCall<{ data?: V1Tx[] }>(
      chain,
      `/v1/accounts/${encodeURIComponent(address)}/transactions?limit=12`,
    ),
    tronCall<{ data?: V1Trc20Tx[] }>(
      chain,
      `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?limit=10&contract_address=${chain.usdt.contract}`,
    ),
  ])
  if (nativeRes.status === 'rejected' && trc20Res.status === 'rejected') throw nativeRes.reason
  const out: TronTx[] = []
  if (nativeRes.status === 'fulfilled') {
    for (const t of nativeRes.value.data ?? []) {
      const contract = t.raw_data?.contract?.[0]
      if (!t.txID || !TRON_TXID.test(t.txID)) continue
      // A USDT send that failed on chain (out of energy, say) burned its fee
      // but moved nothing; TRC-20 history lists only transfers that
      // happened, so it never showed (bug audit 2026-10-27, BL29)
      const failedUsdt = failedUsdtSend(chain, address, t)
      if (failedUsdt !== null) {
        out.push(failedUsdt)
        continue
      }
      if (contract?.type !== 'TransferContract') continue
      const v = contract.parameter?.value
      const from = hexAddrToBase58(v?.owner_address) ?? v?.owner_address ?? null
      const to = hexAddrToBase58(v?.to_address) ?? v?.to_address ?? null
      if (!t.txID || typeof v?.amount !== 'number' || v.amount <= 0) continue
      const isOut = from === address
      const isIn = to === address
      out.push({
        id: t.txID,
        direction: isOut && isIn ? 'self' : isOut ? 'out' : 'in',
        amount: isOut ? -BigInt(v.amount) : BigInt(v.amount),
        asset: 'trx',
        time: t.block_timestamp != null ? Math.floor(t.block_timestamp / 1000) : null,
        counterparty: isOut ? to : from,
        failed: t.ret?.[0]?.contractRet !== undefined && t.ret[0].contractRet !== 'SUCCESS',
      })
    }
  }
  if (nativeRes.status === 'rejected') out.push(...prev.filter((t) => t.asset === 'trx'))
  const seen = new Set(out.map((t) => t.id))
  if (trc20Res.status === 'rejected') {
    for (const t of prev) if (t.asset === 'usdt' && !seen.has(t.id)) out.push(t)
  } else {
    for (const t of trc20Res.value.data ?? []) {
      if (!t.transaction_id || !TRON_TXID.test(t.transaction_id) || seen.has(t.transaction_id)) continue
      if (t.token_info?.address !== chain.usdt.contract) continue
      if (!/^\d+$/.test(t.value ?? '') || BigInt(t.value ?? '0') === 0n) continue
      const isOut = t.from === address
      out.push({
        id: t.transaction_id,
        direction: isOut && t.to === address ? 'self' : isOut ? 'out' : 'in',
        amount: isOut ? -BigInt(t.value ?? '0') : BigInt(t.value ?? '0'),
        asset: 'usdt',
        time: t.block_timestamp != null ? Math.floor(t.block_timestamp / 1000) : null,
        counterparty: isOut ? (t.to ?? null) : (t.from ?? null),
        failed: false,
      })
    }
  }
  out.sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER))
  return out.slice(0, 15)
}

// ---------------------------------------------------------------------------
// Display + QR parsing.

export function formatTron(v: bigint): string {
  return formatEvmAmount(v, 6)
}

export function formatTronUsdt(chain: TronChainConfig, v: bigint): string {
  return formatEvmAmount(v, chain.usdt.decimals)
}

/** Bare T… address or a tron: URI. Explains wrong-family scans. */
export function parseTronScanned(text: string): { address: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('The scanned code was empty.')
  // "tron:T…?amount=…": the address is what this form takes from it (a
  // query used to make the whole code read as no address; BL34)
  const candidate = trimmed.replace(/^tron:(\/\/)?/i, '').split('?')[0]!
  if (isValidTronAddress(candidate)) return { address: candidate }
  if (/^0x/i.test(candidate)) {
    throw new Error("That's an Ethereum-style address — TRON addresses start with T.")
  }
  if (/^(bc1|tb1|ltc1|bitcoin:|dogecoin:|litecoin:)/i.test(candidate)) {
    throw new Error('That looks like a Bitcoin-family address, not a TRON address.')
  }
  throw new Error("That code doesn't contain a valid TRON address.")
}

/** Per-chain UI state held by App (null balance = not yet loaded). */
export interface TronUiState {
  balance: bigint | null
  usdtBalance: bigint | null
  /** TRX staked or unstaking (TronAccountView.staked); undefined until read */
  staked?: bigint
  /** the account exists on chain, so it has history even if none is listed */
  activated?: boolean
  txs: TronTx[]
  /** the last refresh's history lookup failed, so the list may be out of date */
  lookupFailed?: boolean
  /** the balance above is fresh and its history is still being read: nothing can be concluded yet */
  historyPending?: boolean
  loading: boolean
  error: string | null
}
