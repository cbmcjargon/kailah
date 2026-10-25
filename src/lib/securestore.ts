// Encrypted-at-rest store for the wallet's scan caches (address map, state
// snapshots). Everything in them is public on-chain data, but together they
// reveal the wallet's full address set, balances and history to anyone who can
// read the device while it is LOCKED — and a forged snapshot could put an
// attacker's receive address on screen. So: AES-256-GCM under a key derived
// (HKDF-SHA256) from the BIP39 seed, which exists only while the wallet is
// unlocked. Locked device → ciphertext only. Tampering → authentication
// failure → the cache is simply treated as empty and a cold scan runs.
//
// Shape: a tiny key/value store with an in-memory mirror. unlock() decrypts
// the known blobs once (async); get/set are then synchronous for the scanner
// and the hydration path, and every set writes through as a fresh ciphertext.
// Before unlock (or under Node without a key) reads are empty and writes are
// dropped — nothing is ever persisted in the clear.

import { mnemonicToSeedSync } from '@scure/bip39'
import { base64 } from '@scure/base'

const PREFIX = 'kailah.sec.'
const KNOWN_NAMES = ['addrmap', 'statecache', 'pending', 'hwaccounts', 'netprefs'] as const
export type SecureName = (typeof KNOWN_NAMES)[number]

let aesKey: CryptoKey | null = null
const mem = new Map<SecureName, unknown>()
const writes = new Map<SecureName, Promise<void>>()

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

async function deriveKey(mnemonic: string): Promise<CryptoKey> {
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase().split(/\s+/).join(' '))
  try {
    const ikm = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('kailah-wallet cache salt'),
        info: new TextEncoder().encode('kailah cache key v1'),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    seed.fill(0)
  }
}

async function decryptBlob(key: CryptoKey, blob: string): Promise<unknown> {
  const [ivB64, ctB64] = blob.split('.')
  if (!ivB64 || !ctB64) throw new Error('bad blob')
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64.decode(ivB64) as BufferSource },
    key,
    base64.decode(ctB64) as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(pt)) as unknown
}

async function encryptBlob(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return `${base64.encode(iv)}.${base64.encode(new Uint8Array(ct))}`
}

/** Derive the cache key from the mnemonic and load every known blob. */
export async function unlockSecureStore(mnemonic: string): Promise<void> {
  const key = await deriveKey(mnemonic)
  mem.clear()
  const store = storage()
  for (const name of KNOWN_NAMES) {
    const blob = store?.getItem(PREFIX + name)
    if (!blob) continue
    try {
      mem.set(name, await decryptBlob(key, blob))
    } catch {
      // wrong key (another wallet's cache) or tampering: ignore, rebuild cold
    }
  }
  aesKey = key
}

/** Forget the key and the decrypted mirror; ciphertext stays on disk. */
export function lockSecureStore(): void {
  aesKey = null
  mem.clear()
}

export function secureGet(name: SecureName): unknown {
  return mem.get(name)
}

/** Update the mirror now; persist the new ciphertext in the background. */
export function secureSet(name: SecureName, value: unknown): void {
  mem.set(name, value)
  const key = aesKey
  const store = storage()
  if (key === null || store === null) return
  const prev = writes.get(name) ?? Promise.resolve()
  const next = prev
    .then(() => encryptBlob(key, value))
    .then((blob) => {
      // the key may have been dropped (lock) while encrypting — never write then
      if (aesKey === key) store.setItem(PREFIX + name, blob)
    })
    .catch(() => {
      // quota / storage disabled — the cache is best-effort
    })
  writes.set(name, next)
}

export function secureRemove(name: SecureName): void {
  mem.delete(name)
  try {
    storage()?.removeItem(PREFIX + name)
  } catch {
    // ignore
  }
}

/** Erase: drop the key, the mirror, and every kailah.sec.* blob. */
export function clearSecureStore(): void {
  lockSecureStore()
  const store = storage()
  if (!store) return
  try {
    for (const name of KNOWN_NAMES) store.removeItem(PREFIX + name)
  } catch {
    // ignore
  }
}
