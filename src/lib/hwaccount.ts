// Hardware accounts: watch-only HD accounts whose keys live in a device.
// Design: docs/hardware-signing.md §4–5.
//
// The browser holds the account xpub only. address() derives public children
// (non-hardened, so no secret is needed); zero() just drops the memo — there
// is no private material to wipe. Records persist in the encrypted secure
// store under 'hwaccounts' (kailah.sec.hwaccounts): ciphertext while locked,
// removed by erase with every other kailah.sec.* blob.

import { HDKey } from '@scure/bip32'
import { p2wpkh } from '@scure/btc-signer'
import { createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { CHAINS } from './networks'
import { secureGet, secureSet } from './securestore'
import type {
  ChainConfig,
  HardwareAccountKeys,
  HardwareAccountRecord,
  HardwareChainId,
  PublicAddressKey,
  WatchAccountKeys,
} from './types'

const base58check = createBase58check(sha256)
const HARDENED = 0x80000000

/** BIP32 public/private version bytes by network. */
const XPUB = { public: 0x0488b21e, private: 0x0488ade4 }
const TPUB = { public: 0x043587cf, private: 0x04358394 }

/** Which device app signs for each hardware-capable chain. */
export const HARDWARE_CHAINS: Record<
  HardwareChainId,
  { app: HardwareAccountRecord['app']; appName: string }
> = {
  btc: { app: 'bitcoin', appName: 'Bitcoin' },
  'btc-testnet': { app: 'bitcoin', appName: 'Bitcoin Test' },
  ltc: { app: 'litecoin-legacy', appName: 'Litecoin' },
}

export function isHardwareChain(id: string): id is HardwareChainId {
  return id in HARDWARE_CHAINS
}

export function isHardwareAccount(a: WatchAccountKeys): a is HardwareAccountKeys {
  return (a as Partial<HardwareAccountKeys>).kind === 'hardware'
}

/** "m/84'/0'/0'" → [0x80000054, 0x80000000, 0x80000000] */
export function parsePath(path: string): number[] {
  const parts = path.split('/')
  if (parts[0] !== 'm') throw new Error(`Bad derivation path ${path}`)
  return parts.slice(1).map((seg) => {
    const hardened = seg.endsWith("'") || seg.endsWith('h')
    const n = Number(hardened ? seg.slice(0, -1) : seg)
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error(`Bad derivation path ${path}`)
    return hardened ? n + HARDENED : n
  })
}

/** [0x80000054, 0x80000000, 0x80000000] → "84'/0'/0'" (no leading m) */
export function formatPath(indices: number[]): string {
  return indices.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`)).join('/')
}

function versionOf(xpub: string): number {
  const payload = base58check.decode(xpub)
  if (payload.length !== 78) throw new Error('That extended public key is malformed.')
  return ((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) >>> 0
}

function reEncode(xpub: string, version: number): string {
  const payload = base58check.decode(xpub).slice()
  payload[0] = (version >>> 24) & 0xff
  payload[1] = (version >>> 16) & 0xff
  payload[2] = (version >>> 8) & 0xff
  payload[3] = version & 0xff
  return base58check.encode(payload)
}

/**
 * Parse an account-level extended public key and bind it to `chain`'s account
 * path: right network version, depth 3, the expected hardened child index, and
 * public only. Throws a readable error otherwise.
 */
export function parseAccountXpub(chain: ChainConfig, xpub: string): HDKey {
  let version: number
  try {
    version = versionOf(xpub)
  } catch {
    throw new Error('That extended public key is malformed.')
  }
  const versions = chain.mainnet ? XPUB : TPUB
  // Litecoin's legacy app has no xpub command: the wallet assembles the key
  // itself, always with standard xpub bytes. Testnet devices answer tpub.
  if (version !== versions.public) {
    throw new Error(`That key is for a different network than ${chain.name}.`)
  }
  let node: HDKey
  try {
    node = HDKey.fromExtendedKey(xpub, versions)
  } catch {
    throw new Error('That extended public key is malformed.')
  }
  const path = parsePath(chain.accountPath)
  if (node.privateKey !== null) throw new Error('Refusing a private extended key.')
  if (node.depth !== path.length || node.index !== path[path.length - 1]) {
    throw new Error(`That key is not the ${chain.accountPath} account key.`)
  }
  return node
}

/** Canonical (0488b21e) encoding — the addrcache key, as for software accounts. */
export function canonicalXpub(chain: ChainConfig, xpub: string): string {
  return chain.mainnet ? xpub : reEncode(xpub, XPUB.public)
}

/** Address at branch/index of an account xpub (public derivation only). */
export function xpubAddress(chain: ChainConfig, xpub: string, branch: 0 | 1, index: number): string {
  const pub = parseAccountXpub(chain, xpub).deriveChild(branch).deriveChild(index).publicKey
  const addr = pub ? p2wpkh(pub, chain.network).address : undefined
  if (!addr) throw new Error(`Could not derive a ${chain.name} address`)
  return addr
}

export function hardwareRecordId(chain: HardwareChainId, xpub: string): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(xpub))).slice(0, 16)
  return `ledger:${chain}:${digest}`
}

/** Key for this account's UI slot and state snapshot (never collides with a ChainId). */
export function hardwareSlotKey(record: HardwareAccountRecord): string {
  return `hw:${record.id}`
}

/** Build the in-memory account for a record. Throws if the record is inconsistent. */
export function hardwareAccount(record: HardwareAccountRecord): HardwareAccountKeys {
  if (record.v !== 1 || record.device !== 'ledger' || !isHardwareChain(record.chain)) {
    throw new Error('Unknown hardware account record.')
  }
  const chain = CHAINS[record.chain]
  if (record.accountPath !== chain.accountPath) throw new Error('Hardware account path mismatch.')
  if (record.app !== HARDWARE_CHAINS[record.chain].app) throw new Error('Hardware account app mismatch.')
  if (record.masterFingerprint !== null && !/^[0-9a-f]{8}$/.test(record.masterFingerprint)) {
    throw new Error('Hardware account fingerprint is malformed.')
  }
  if (record.id !== hardwareRecordId(record.chain, record.xpub)) {
    throw new Error('Hardware account id mismatch.')
  }
  const node = parseAccountXpub(chain, record.xpub)
  const canonical = canonicalXpub(chain, record.xpub)
  const slip132 = chain.slip132 ? reEncode(canonical, chain.slip132.public) : canonical

  const branches = new Map<0 | 1, HDKey>()
  const memo = new Map<string, PublicAddressKey>()
  const address = (branch: 0 | 1, index: number): PublicAddressKey => {
    const k = `${branch}/${index}`
    const hit = memo.get(k)
    if (hit) return hit
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
      throw new Error(`Bad address index ${index}`)
    }
    let b = branches.get(branch)
    if (!b) {
      b = node.deriveChild(branch)
      branches.set(branch, b)
    }
    const publicKey = b.deriveChild(index).publicKey
    if (!publicKey) throw new Error('Public derivation failed')
    const addr = p2wpkh(publicKey, chain.network).address
    if (!addr) throw new Error(`Could not derive a ${chain.name} address`)
    const out: PublicAddressKey = {
      chain: chain.id,
      address: addr,
      path: `${chain.accountPath}/${branch}/${index}`,
      publicKey,
      branch,
      index,
    }
    memo.set(k, out)
    return out
  }

  // The import flow stored the address the user confirmed on the device; a
  // record whose xpub no longer derives it is not this account.
  if (address(0, 0).address !== record.verifiedAddress) {
    throw new Error('Hardware account does not derive its verified address.')
  }

  return {
    kind: 'hardware',
    record,
    chain: chain.id,
    accountPath: chain.accountPath,
    accountPathIndices: parsePath(chain.accountPath),
    xpubs: { xpub: canonical, slip132, native: canonical },
    address,
    zero: () => {
      memo.clear()
      branches.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Persistence (encrypted secure store; available only while unlocked)

const NAME = 'hwaccounts'

/** Records that validate; anything malformed is dropped rather than trusted. */
export function loadHardwareRecords(): HardwareAccountRecord[] {
  const raw = secureGet(NAME)
  if (!Array.isArray(raw)) return []
  const out: HardwareAccountRecord[] = []
  for (const r of raw) {
    try {
      hardwareAccount(r as HardwareAccountRecord)
      out.push(r as HardwareAccountRecord)
    } catch {
      // skip an invalid record; the user can re-add it from the device
    }
  }
  return out
}

export function saveHardwareRecords(records: HardwareAccountRecord[]): void {
  secureSet(NAME, records)
}
