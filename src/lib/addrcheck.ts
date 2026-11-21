// "Is this an address on that network?" for every network the wallet knows,
// without loading a network engine.
//
// Contract:
//   isAddressOn(kind, chainId, address): boolean
//   canonicalAddress(kind, address): string   — the one spelling to store
//   addressKey(kind, address): string         — equal keys ⇔ the same address
//
// Why this exists: the contact book (contacts.ts) lives in the App chunk and
// must judge addresses of all four engines, but a static import of
// lib/evm|sol|tron would pull that engine in with it, hidden networks
// included (CLAUDE.md, "First load is code-split"). The UTXO chains share
// their one validator (utxoaddr.ts). The other three rules are small enough
// to state again here, and check-contacts B holds each to its engine's own
// validator on a few thousand addresses, good and bad, so they can't drift:
//   EVM     0x + 40 hex; a mixed-case address must carry a correct EIP-55
//           checksum (evm.ts isValidEvmAddress)
//   Solana  base58 of exactly 32 bytes (micro-sol-signer validateAddress),
//           and not a segwit address of the UTXO chains in capitals, which
//           can be both (sol.ts isValidSolAddress)
//   TRON    base58check of 21 bytes starting 0x41 (tron.ts isValidTronAddress)
//
// This is never the last word on a send: every send form still validates the
// destination with its own engine before anything is built or signed.

import { base58, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { utf8ToBytes } from '@noble/hashes/utils'
import { CHAINS } from './networks'
import { isValidAddress } from './utxoaddr'
import type { ChainId } from './types'

/** The four address families, one per engine. */
export type AddressKind = 'utxo' | 'evm' | 'sol' | 'tron'

const EVM_SHAPE = /^0x[a-fA-F0-9]{40}$/
const b58check = createBase58check(sha256)

/** EIP-55: the address with the checksum in its letters' case. Expects a valid shape. */
function evmChecksum(address: string): string {
  const hex = address.slice(2).toLowerCase()
  const hash = keccak_256(utf8ToBytes(hex))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f
    out += nibble >= 8 ? hex[i]!.toUpperCase() : hex[i]!
  }
  return out
}

function isEvmAddress(address: string): boolean {
  if (!EVM_SHAPE.test(address)) return false
  // all-lowercase and all-uppercase carry no checksum; mixed case must be right
  const hex = address.slice(2)
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex)
  return mixed ? evmChecksum(address) === address : true
}

function isSolAddress(address: string): boolean {
  // a Litecoin address in capitals is often valid base58 of 32 bytes too
  if (BECH32.test(address)) return false
  try {
    return base58.decode(address).length === 32
  } catch {
    return false
  }
}

function isTronAddress(address: string): boolean {
  try {
    const decoded = b58check.decode(address)
    return decoded.length === 21 && decoded[0] === 0x41
  } catch {
    return false
  }
}

function isUtxoChain(id: string): id is ChainId {
  return Object.prototype.hasOwnProperty.call(CHAINS, id)
}

/** bech32 in one case throughout (the format forbids mixed case), on this wallet's networks */
const BECH32 = /^(?:(?:bc|tb|ltc)1[02-9ac-hj-np-z]+|(?:BC|TB|LTC)1[02-9AC-HJ-NP-Z]+)$/

/**
 * Whether `address` (already trimmed) is a destination on the network.
 * `chainId` matters for the UTXO chains only: a Bitcoin address is no
 * Litecoin address. The other kinds have one format across their networks.
 */
export function isAddressOn(kind: AddressKind, chainId: string, address: string): boolean {
  if (typeof address !== 'string' || address === '' || address.length > 120) return false
  switch (kind) {
    case 'utxo':
      return isUtxoChain(chainId) && isValidAddress(address, CHAINS[chainId])
    case 'evm':
      return isEvmAddress(address)
    case 'sol':
      return isSolAddress(address)
    case 'tron':
      return isTronAddress(address)
  }
}

/**
 * The spelling a valid address is stored in: EVM with its EIP-55 checksum
 * (what the send path signs for, evm.ts getAddress), bech32 in lowercase,
 * everything else exactly as it is (base58 is case-sensitive).
 */
export function canonicalAddress(kind: AddressKind, address: string): string {
  if (kind === 'evm') return evmChecksum(address)
  if (kind === 'utxo' && BECH32.test(address)) return address.toLowerCase()
  return address
}

/**
 * Equal keys mean the same address. History rows and the send log don't all
 * spell an address alike (an explorer lists 0x addresses in lowercase), so
 * matching a contact goes through this, never through string equality.
 */
export function addressKey(kind: AddressKind, address: string): string {
  const a = address.trim()
  if (kind === 'evm') return a.toLowerCase()
  if (kind === 'utxo' && BECH32.test(a)) return a.toLowerCase()
  return a
}
