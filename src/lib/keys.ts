// Key derivation for Kailah Wallet. Implements the keys.ts contract from
// types.ts: BIP39 mnemonic generation/validation and per-chain address
// derivation (BIP84 p2wpkh / BIP44 p2pkh) via @scure libraries.
//
// Works in both browser and plain Node 20 — no window/DOM references.

import {
  generateMnemonic as bip39GenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { HDKey } from '@scure/bip32'
import { p2pkh, p2wpkh } from '@scure/btc-signer'
import { createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import type { AccountKeys, AddressKey, ChainConfig, DerivedKey } from './types'

/** Collapse whitespace and lowercase so pasted phrases validate reliably. */
function normalizeMnemonic(m: string): string {
  return m.trim().toLowerCase().split(/\s+/).join(' ')
}

/** New 12-word english BIP39 phrase (128 bits of entropy). */
export function generateMnemonic(): string {
  return bip39GenerateMnemonic(wordlist, 128)
}

export function isValidMnemonic(m: string): boolean {
  return validateMnemonic(normalizeMnemonic(m), wordlist)
}

const HARDENED_OFFSET = 0x80000000

/**
 * Derive `path` from a fresh seed one step at a time, wiping the seed, the
 * root and every intermediate node immediately. HDKey.derive() would drop
 * them to the garbage collector with live private-key bytes that no later
 * zero() could reach — only the returned node still holds private material.
 * The EVM and TRON engines use this too; Solana has its own SLIP-0010 loop.
 */
export function deriveNodeWiped(mnemonic: string, path: string): HDKey {
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic))
  let node = HDKey.fromMasterSeed(seed)
  seed.fill(0)
  for (const seg of path.split('/').slice(1)) {
    const hardened = seg.endsWith("'")
    const idx = Number.parseInt(hardened ? seg.slice(0, -1) : seg, 10)
    const next = node.deriveChild(hardened ? idx + HARDENED_OFFSET : idx)
    node.wipePrivateData()
    node = next
  }
  return node
}

/**
 * Derive the wallet's single receive key/address for a chain.
 * mnemonic -> BIP39 seed -> BIP32 node at chain.derivationPath -> address.
 */
export function deriveKey(mnemonic: string, chain: ChainConfig): DerivedKey {
  const node = deriveNodeWiped(mnemonic, chain.derivationPath)
  const { privateKey, publicKey } = node
  if (!privateKey || !publicKey) {
    throw new Error(`Derived node for ${chain.derivationPath} lacks a private key`)
  }
  const payment =
    chain.addressType === 'p2wpkh'
      ? p2wpkh(publicKey, chain.network)
      : p2pkh(publicKey, chain.network)
  if (!payment.address) {
    throw new Error(`Could not derive a ${chain.addressType} address for ${chain.id}`)
  }
  return {
    chain: chain.id,
    address: payment.address,
    path: chain.derivationPath,
    publicKey,
    privateKey,
  }
}

// ===========================================================================
// v2 — HD account derivation (address rotation)
// ===========================================================================

// `HDKey.fromMasterSeed` uses the standard BIP32 version bytes (0488b21e) by
// default, so an account node's `publicExtendedKey` is always a canonical xpub.
// base58check codec (double-SHA256 checksum) — the exact encoding xpubs use.
const base58check = createBase58check(sha256)

/**
 * Re-serialize a standard xpub under different SLIP-0132 version bytes.
 * An extended key is `version(4) || depth(1) || fingerprint(4) || index(4) ||
 * chain(32) || key(33)`; only the 4 version bytes differ between xpub/zpub/vpub
 * for the same account node, so we decode, swap the prefix, and re-encode.
 * Verified against the published BIP84 vector (xpub <-> zpub, xpub <-> vpub).
 */
function reEncodeXpub(xpub: string, version: number): string {
  const payload = base58check.decode(xpub).slice()
  payload[0] = (version >>> 24) & 0xff
  payload[1] = (version >>> 16) & 0xff
  payload[2] = (version >>> 8) & 0xff
  payload[3] = version & 0xff
  return base58check.encode(payload)
}

/**
 * Derive a chain's HD account (m/purpose'/coin'/0') for address rotation.
 *
 * Returns account-level xpubs (for provider queries / export display) and a
 * memoized `address(branch, index)` deriver. Private material lives only in the
 * cached child nodes; `zero()` wipes it on lock/erase. No window/DOM refs, so
 * it runs identically in the browser and in Node.
 */
export function deriveAccount(mnemonic: string, chain: ChainConfig): AccountKeys {
  const accountNode = deriveNodeWiped(mnemonic, chain.accountPath)

  // 'xpub'    — canonical BIP32 (0488b21e), the key used to index addrcache.
  // 'slip132' — zpub/vpub for BIP84 chains; equals xpub when the chain has none.
  // 'native'  — chain's own scheme (e.g. DOGE dgub); unused by the per-address
  //             scanner, so it mirrors xpub.
  const xpub = accountNode.publicExtendedKey
  const slip132 = chain.slip132 ? reEncodeXpub(xpub, chain.slip132.public) : xpub
  const native = xpub

  // Memoize derived nodes so repeated address() calls are cheap. Every node
  // that ever held private material is tracked for zero().
  const branchNodes = new Map<0 | 1, HDKey>()
  const childCache = new Map<string, AddressKey>()
  const privateNodes: HDKey[] = [accountNode]

  const branchNode = (branch: 0 | 1): HDKey => {
    let node = branchNodes.get(branch)
    if (!node) {
      node = accountNode.deriveChild(branch)
      branchNodes.set(branch, node)
      privateNodes.push(node)
    }
    return node
  }

  const address = (branch: 0 | 1, index: number): AddressKey => {
    const cacheKey = `${branch}/${index}`
    const cached = childCache.get(cacheKey)
    if (cached) return cached

    const node = branchNode(branch).deriveChild(index)
    privateNodes.push(node)
    const { privateKey, publicKey } = node
    if (!privateKey || !publicKey) {
      throw new Error(
        `Derived node ${chain.accountPath}/${branch}/${index} lacks a private key`,
      )
    }
    const payment =
      chain.addressType === 'p2wpkh'
        ? p2wpkh(publicKey, chain.network)
        : p2pkh(publicKey, chain.network)
    if (!payment.address) {
      throw new Error(`Could not derive a ${chain.addressType} address for ${chain.id}`)
    }
    const key: AddressKey = {
      chain: chain.id,
      address: payment.address,
      path: `${chain.accountPath}/${branch}/${index}`,
      publicKey,
      privateKey,
      branch,
      index,
    }
    childCache.set(cacheKey, key)
    return key
  }

  const zero = (): void => {
    // Zero the exact byte buffers we handed out, then wipe every node's
    // private data (idempotent) and drop the caches.
    for (const key of childCache.values()) key.privateKey.fill(0)
    for (const node of privateNodes) node.wipePrivateData()
    childCache.clear()
    branchNodes.clear()
  }

  return {
    chain: chain.id,
    accountPath: chain.accountPath,
    xpubs: { xpub, slip132, native },
    address,
    zero,
  }
}
