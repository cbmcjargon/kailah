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

export function deriveTronKey(mnemonic: string): TronKey {
  // step-wise derivation: seed, root and intermediates wiped as it goes
  const node = deriveNodeWiped(mnemonic, TRON_DERIVATION_PATH)
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

async function tronCall<T>(chain: TronChainConfig, path: string, body?: unknown): Promise<T> {
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
  const json = (await res.json()) as T & { Error?: string; error?: string }
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
}

export async function getTronBalance(chain: TronChainConfig, address: string): Promise<bigint> {
  const r = await tronCall<GetAccountResult>(chain, '/wallet/getaccount', {
    address,
    visible: true,
  })
  // A never-used account comes back as {} — that is a genuine zero.
  return BigInt(r.balance ?? 0)
}

interface V1Account {
  data?: { trc20?: Record<string, string>[] }[]
}

export async function getTronUsdtBalance(
  chain: TronChainConfig,
  address: string,
): Promise<bigint> {
  const r = await tronCall<V1Account>(chain, `/v1/accounts/${encodeURIComponent(address)}`)
  const acc = r.data?.[0]
  if (!acc) return 0n
  for (const entry of acc.trc20 ?? []) {
    const v = entry[chain.usdt.contract]
    if (v !== undefined) return BigInt(v)
  }
  return 0n
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
        ? (inner.get(3)?.varint ?? 0n) === 1n
          ? 'ENERGY'
          : 'BANDWIDTH'
        : null,
  }
}

/** Decode protocol.Transaction.raw (the exact bytes that get signed). */
export function decodeTronRawTx(rawHex: string): DecodedTronTx {
  const fields = readFields(hexToBytes(rawHex))
  const out: DecodedTronTx = { expiration: 0n, feeLimit: 0n, contracts: [] }
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
    if (f.num === 18) out.feeLimit = f.varint ?? 0n
  }
  return out
}

/**
 * Envelope checks shared by every signing path: fee_limit must be exactly
 * what the flow pins (0 for bandwidth-only contracts — an inflated limit is
 * budget a hostile node could burn as energy), and expiration must sit within
 * a day of now, so signed bytes can't be kept valid-for-broadcast far beyond
 * the ~minute the node intends.
 */
export function assertTronEnvelope(decoded: DecodedTronTx, feeLimit: bigint): void {
  if (decoded.feeLimit !== feeLimit) throw new Error(UNEXPECTED)
  const dayAhead = BigInt(Date.now() + 24 * 3600 * 1000)
  if (decoded.expiration <= 0n || decoded.expiration > dayAhead) throw new Error(UNEXPECTED)
}

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
  /** the exact bytes to sign (verified by our own decoder) */
  rawDataHex: string
  /** verbatim node response pieces needed to broadcast */
  rawData: unknown
  txID: string
}

const MISMATCH =
  'The transaction the network node returned does not match your request — refusing to sign it. Nothing was sent and your coins are untouched.'

/** ~0.27 TRX: 268 bandwidth bytes when free bandwidth is spent. */
const TRX_BANDWIDTH_FEE_SUN = 270_000n
/** ~1.1 TRX burned when a transfer must create the recipient account. */
const NEW_ACCOUNT_FEE_SUN = 1_100_000n
/** fee_limit cap for USDT sends: 30 TRX, sane ceiling for energy spikes. */
const USDT_FEE_LIMIT_SUN = 30_000_000n

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
  amount: bigint,
): Promise<PreparedTronSend> {
  if (!isValidTronAddress(to)) {
    throw new Error(`"${to}" is not a valid TRON address (they start with T).`)
  }
  if (to === key.address) {
    throw new Error('That is your own address — sending to yourself only burns fees.')
  }
  if (amount <= 0n) throw new Error('Enter an amount to send.')

  const [balance, usdtBalance, toAccount] = await Promise.all([
    getTronBalance(chain, key.address),
    asset === 'usdt' ? getTronUsdtBalance(chain, key.address) : Promise.resolve(0n),
    tronCall<GetAccountResult>(chain, '/wallet/getaccount', { address: to, visible: true }),
  ])
  const createsAccount = toAccount.address === undefined

  if (asset === 'trx') {
    const feeEstimate = TRX_BANDWIDTH_FEE_SUN + (createsAccount ? NEW_ACCOUNT_FEE_SUN : 0n)
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
      rawDataHex: r.raw_data_hex,
      rawData: r.raw_data,
      txID: verifyTxId(r.raw_data_hex, r.txID),
    }
  }

  // USDT: build the calldata ourselves — transfer(address,uint256).
  if (amount > usdtBalance) {
    throw new Error(
      `Insufficient ${chain.usdt.symbol}: you have ${formatTronUsdt(chain, amount > usdtBalance ? usdtBalance : amount)} ${chain.usdt.symbol}.`,
    )
  }
  const toHex20 = tronAddressToHex(to).slice(2) // drop the 41 prefix
  const param = toHex20.padStart(64, '0') + amount.toString(16).padStart(64, '0')
  const calldata = 'a9059cbb' + param

  // Estimate energy with a constant (free, read-only) call first.
  let estimatedFeeSun = 15_000_000n // honest default: ~15 TRX
  try {
    const est = await tronCall<{ energy_used?: number }>(chain, '/wallet/triggerconstantcontract', {
      owner_address: key.address,
      contract_address: chain.usdt.contract,
      function_selector: 'transfer(address,uint256)',
      parameter: param,
      visible: true,
    })
    if (typeof est.energy_used === 'number' && est.energy_used > 0) {
      // energy price 420 sun/unit (chain parameter; stable for years)
      estimatedFeeSun = BigInt(est.energy_used) * 420n
    }
  } catch {
    // estimation is best-effort; the fee_limit still caps the worst case
  }
  if (balance < estimatedFeeSun) {
    throw new Error(
      `Sending ${chain.usdt.symbol} burns TRX for energy (~${formatTron(estimatedFeeSun)} TRX now). ` +
        `You have ${formatTron(balance)} TRX — top up a little TRX first.`,
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
      fee_limit: Number(USDT_FEE_LIMIT_SUN),
      call_value: 0,
      visible: true,
    },
  )
  const tx = r.transaction
  if (!tx?.raw_data_hex) throw new Error(MISMATCH)
  const decoded = decodeTronRawTx(tx.raw_data_hex)
  assertTronEnvelope(decoded, USDT_FEE_LIMIT_SUN)
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
    feeLimitSun: USDT_FEE_LIMIT_SUN,
    createsAccount,
    rawDataHex: tx.raw_data_hex,
    rawData: tx.raw_data,
    txID: verifyTxId(tx.raw_data_hex, tx.txID),
  }
}

export async function broadcastTronSend(
  key: TronKey,
  prepared: PreparedTronSend,
): Promise<string> {
  // txID = sha256(raw bytes) — recomputed at prepare; sign exactly that.
  const digest = hexToBytes(prepared.txID)
  const sig = secp256k1.sign(digest, key.privateKey)
  const signature = bytesToHex(sig.toCompactRawBytes()) + (sig.recovery === 1 ? '01' : '00')
  const r = await tronCall<{ result?: boolean; code?: string; message?: string }>(
    prepared.chain,
    '/wallet/broadcasttransaction',
    {
      raw_data: prepared.rawData,
      raw_data_hex: prepared.rawDataHex,
      txID: prepared.txID,
      signature: [signature],
      visible: true,
    },
  )
  if (r.result !== true) {
    let detail = r.message ?? r.code ?? 'the node rejected the transaction'
    try {
      // node messages arrive hex-encoded
      detail = new TextDecoder().decode(hexToBytes(detail))
    } catch {
      // keep as-is
    }
    throw new Error(`Broadcast failed: ${detail}`)
  }
  return prepared.txID
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
}

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

export async function fetchTronHistory(
  chain: TronChainConfig,
  address: string,
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
  const out: TronTx[] = []
  if (nativeRes.status === 'fulfilled') {
    for (const t of nativeRes.value.data ?? []) {
      const contract = t.raw_data?.contract?.[0]
      if (contract?.type !== 'TransferContract') continue
      const v = contract.parameter?.value
      const from = hexAddrToBase58(v?.owner_address) ?? v?.owner_address ?? null
      const to = hexAddrToBase58(v?.to_address) ?? v?.to_address ?? null
      if (!t.txID || typeof v?.amount !== 'number') continue
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
  if (trc20Res.status === 'fulfilled') {
    const seen = new Set(out.map((t) => t.id))
    for (const t of trc20Res.value.data ?? []) {
      if (!t.transaction_id || seen.has(t.transaction_id)) continue
      if (t.token_info?.address !== chain.usdt.contract) continue
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
  const candidate = trimmed.replace(/^tron:/i, '')
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
  txs: TronTx[]
  loading: boolean
  error: string | null
}
