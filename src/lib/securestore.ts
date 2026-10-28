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
//
// Several unlocked windows of the wallet share the same storage. Each keeps
// its mirror current from the others' writes (the `storage` event), and the
// double-pay ledger re-reads its blob before every decision (refreshSecure),
// so one window can't overwrite or miss another's record (bug audit
// 2026-10-27, BM11).

import { mnemonicToSeedSync } from '@scure/bip39'
import { base64 } from '@scure/base'

const PREFIX = 'kailah.sec.'
const KNOWN_NAMES = ['addrmap', 'statecache', 'pending', 'hwaccounts', 'netprefs', 'sentto'] as const
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

/**
 * Which unlock this is: every unlock, lock and erase starts a new one.
 * Background work (a scan, a provider failover) takes it when it starts and
 * writes nothing once it has changed, so an erased wallet's scan can't put
 * its caches back, or its address map into the next wallet's store (bug
 * audit 2026-10-27, BL9).
 */
let session = 0

export function storeSession(): number {
  return session
}

/** Derive the cache key from the mnemonic and load every known blob. */
export async function unlockSecureStore(mnemonic: string): Promise<void> {
  session += 1
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
  listen(true)
}

/** Forget the key and the decrypted mirror; ciphertext stays on disk. */
export function lockSecureStore(): void {
  session += 1
  listen(false)
  aesKey = null
  mem.clear()
  unsaved.clear()
}

/**
 * Names whose newest write never reached storage (quota full, storage
 * refusing writes): the mirror is newer than the disk, so a refresh keeps
 * it. Re-read from the disk, it was wiped, and the double-pay ledger forgot
 * every attempt for the rest of the session (review 2026-10-28).
 */
const unsaved = new Set<SecureName>()

function isKnownName(name: string): name is SecureName {
  return (KNOWN_NAMES as readonly string[]).includes(name)
}

/**
 * Re-read one blob from storage into the mirror: another window of the
 * wallet may have written it. This window's own write still in flight lands
 * first (otherwise the older blob on disk would overwrite it). A blob this
 * key can't open (another wallet's, or tampered) leaves the mirror as is.
 */
export async function refreshSecure(name: SecureName): Promise<void> {
  const key = aesKey
  const store = storage()
  if (key === null || store === null) return
  await (writes.get(name) ?? Promise.resolve()).catch(() => undefined)
  if (aesKey !== key || unsaved.has(name)) return
  let blob: string | null
  try {
    blob = store.getItem(PREFIX + name)
  } catch {
    return
  }
  if (blob === null) {
    mem.delete(name)
    return
  }
  try {
    const value = await decryptBlob(key, blob)
    if (aesKey === key) mem.set(name, value)
  } catch {
    // not ours to read: keep the mirror
  }
}

function onStorage(e: StorageEvent): void {
  if (e.key === null) {
    // storage was cleared in another window
    for (const name of KNOWN_NAMES) void refreshSecure(name)
    return
  }
  if (!e.key.startsWith(PREFIX)) return
  const name = e.key.slice(PREFIX.length)
  if (isKnownName(name)) void refreshSecure(name)
}

let listening = false
function listen(on: boolean): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  if (on && !listening) window.addEventListener('storage', onStorage)
  if (!on && listening) window.removeEventListener('storage', onStorage)
  listening = on
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
      if (aesKey !== key) return
      store.setItem(PREFIX + name, blob)
      unsaved.delete(name)
    })
    .catch(() => {
      // quota / storage disabled — the cache is best-effort, the mirror stays
      if (aesKey === key) unsaved.add(name)
    })
  writes.set(name, next)
}

export function secureRemove(name: SecureName): void {
  mem.delete(name)
  unsaved.delete(name)
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
