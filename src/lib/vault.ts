// Encrypted mnemonic vault for Kailah Wallet. Implements the vault.ts
// contract from types.ts.
//
// v2 (current): Argon2id (memory-hard, @noble/hashes — already a dependency)
//   -> AES-256-GCM. An attacker who copies the ciphertext from a locked device
//   must spend ~32 MiB of RAM per password guess, which turns a GPU's billions
//   of guesses per second into hundreds.
// v1 (legacy): PBKDF2-SHA256 (600k) -> AES-256-GCM. Still decrypted, and
//   re-encrypted as v2 on the next successful unlock — transparent to the user.
// Both live under the same storage key; the record carries its own version.

import { argon2idAsync } from '@noble/hashes/argon2'
import { base64 } from '@scure/base'
import type { ArgonJob, ArgonReply } from './argon.worker'

/** 0..1 while the key derives — drives the lock screen's progress bar. */
export type ProgressFn = (fraction: number) => void

const STORAGE_KEY = 'kailah.vault.v1'
/** The vault's storage key, for windows watching each other's erase (Shell.tsx). */
export const VAULT_STORAGE_KEY = STORAGE_KEY
const SALT_BYTES = 16
const IV_BYTES = 12

// Argon2id parameters: 32 MiB, 3 passes, 1 lane — ~2.7× OWASP's floor at
// three passes (m=12288,t=3); measured ~0.9 s in pure JS on a laptop, so
// ~2-3 s on a phone, run with asyncTick so the UI keeps painting. (64 MiB
// measured 1.9 s here — 4-6 s on a phone — too slow for every unlock.) Bounds below reject a tampered
// record before it can hang unlock for minutes or exhaust memory.
const ARGON = { m: 32768, t: 3, p: 1 } as const
// m up to 256 MiB: a tampered record can't make unlock exhaust a phone's memory
const ARGON_BOUNDS = { m: [8192, 262144], t: [1, 10], p: [1, 4] } as const

const KDF_V1 = 'pbkdf2-sha256'
const KDF_V2 = 'argon2id'

interface VaultRecordV1 {
  v: 1
  kdf: typeof KDF_V1
  iter: number
  salt: string
  iv: string
  ct: string
}

interface VaultRecordV2 {
  v: 2
  kdf: typeof KDF_V2
  m: number
  t: number
  p: number
  salt: string
  iv: string
  ct: string
}

type VaultRecord = VaultRecordV1 | VaultRecordV2

const DAMAGED =
  'The saved wallet data on this device is damaged. Erase it and restore from your recovery phrase.'

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
  } finally {
    raw.fill(0) // the CryptoKey is non-extractable; our copy must not linger
  }
}

/** Run the hash in a worker when the platform has one (see argon.worker.ts). */
function argonInWorker(
  password: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number },
  onProgress?: ProgressFn,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./argon.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<ArgonReply>) => {
      if (e.data.type === 'progress') {
        onProgress?.(e.data.value)
        return
      }
      worker.terminate()
      resolve(e.data.key)
    }
    worker.onerror = (err) => {
      worker.terminate()
      reject(err instanceof ErrorEvent ? (err.error ?? new Error(err.message)) : new Error('worker'))
    }
    const job: ArgonJob = { password, salt, ...params }
    worker.postMessage(job)
  })
}

async function deriveKeyArgon(
  password: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number },
  onProgress?: ProgressFn,
): Promise<CryptoKey> {
  let raw: Uint8Array | null = null
  if (typeof Worker !== 'undefined') {
    try {
      raw = await argonInWorker(password, salt, params, onProgress)
    } catch {
      raw = null // e.g. module workers unsupported — fall through
    }
  }
  // Main-thread fallback (also the path under Node for the check scripts):
  // yields every ~10 ms so the UI keeps painting, at the cost of being
  // subject to background-tab timer throttling.
  if (raw === null) {
    raw = await argon2idAsync(password, salt, {
      ...params,
      dkLen: 32,
      asyncTick: 10,
      ...(onProgress !== undefined && { onProgress }),
    })
  }
  onProgress?.(1)
  return importAesKey(raw)
}

async function deriveKeyPbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function hasVault(): boolean {
  // localStorage access itself throws in some environments (storage blocked,
  // certain private modes); treat that as "no vault" instead of crashing boot.
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export async function saveVault(
  mnemonic: string,
  password: string,
  onProgress?: ProgressFn,
): Promise<void> {
  const sealed = await sealVault(mnemonic, password, onProgress)
  try {
    localStorage.setItem(STORAGE_KEY, sealed)
  } catch {
    throw new Error(
      'This browser is blocking local storage, so the wallet cannot be saved on this device.',
    )
  }
}

/**
 * Save a NEW wallet: refused when a vault exists by the time it would be
 * written. Another window of the wallet may have created one while this
 * window's welcome screen stood open, and saveVault would have replaced it
 * without a word (review 2026-10-28).
 */
export async function createVault(mnemonic: string, password: string, onProgress?: ProgressFn): Promise<void> {
  if (hasVault()) throw new Error(VAULT_EXISTS)
  const sealed = await sealVault(mnemonic, password, onProgress)
  if (hasVault()) throw new Error(VAULT_EXISTS)
  try {
    localStorage.setItem(STORAGE_KEY, sealed)
  } catch {
    throw new Error(
      'This browser is blocking local storage, so the wallet cannot be saved on this device.',
    )
  }
}

const VAULT_EXISTS =
  'A wallet was set up in another window of Kailah Wallet meanwhile, so this one was not saved over it. Reload this page to unlock that wallet.'

/** The stored form of a new v2 (Argon2id) vault record. */
async function sealVault(mnemonic: string, password: string, onProgress?: ProgressFn): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKeyArgon(password, salt, ARGON, onProgress)
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(mnemonic),
  )
  const record: VaultRecordV2 = {
    v: 2,
    kdf: KDF_V2,
    ...ARGON,
    salt: base64.encode(salt),
    iv: base64.encode(iv),
    ct: base64.encode(new Uint8Array(ctBuf)),
  }
  return JSON.stringify(record)
}

/** Which KDF protects the stored vault right now (for the settings screen). */
export function vaultKdf(): 'argon2id' | 'pbkdf2' | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const record = JSON.parse(raw) as Partial<VaultRecord>
    return record.v === 2 ? 'argon2id' : 'pbkdf2'
  } catch {
    return null
  }
}

function inRange(n: unknown, [lo, hi]: readonly [number, number]): n is number {
  return Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi
}

/**
 * Decrypts and resolves the mnemonic; throws Error('Wrong password') on any
 * failure except a structurally damaged record, which says so instead. A
 * legacy v1 (PBKDF2) vault that unlocks is re-saved as v2 (Argon2id) with the
 * same password before returning.
 */
export async function unlockVault(password: string, onProgress?: ProgressFn): Promise<string> {
  let mnemonic: string
  let legacy = false
  // A record that can't be read (not JSON, bad base64, an unknown version,
  // impossible lengths) is damaged, whatever the password: only a failed
  // decryption means the password is wrong (bug audit 2026-10-27, BL38).
  let raw: string | null = null
  let record: VaultRecord
  let salt: Uint8Array
  let iv: Uint8Array
  let ct: Uint8Array
  try {
    raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) throw new Error('no vault')
    record = JSON.parse(raw) as VaultRecord
    salt = base64.decode(record.salt)
    iv = base64.decode(record.iv)
    ct = base64.decode(record.ct)
  } catch {
    throw new Error(DAMAGED)
  }
  const known = (record.v === 2 && record.kdf === KDF_V2) || (record.v === 1 && record.kdf === KDF_V1)
  // AES-GCM: a 12-byte IV, and a ciphertext that holds at least the 16-byte tag and one byte
  if (!known || iv.length !== 12 || ct.length < 17 || salt.length < 16) throw new Error(DAMAGED)
  try {
    let key: CryptoKey
    if (record.v === 2 && record.kdf === KDF_V2) {
      if (
        !inRange(record.m, ARGON_BOUNDS.m) ||
        !inRange(record.t, ARGON_BOUNDS.t) ||
        !inRange(record.p, ARGON_BOUNDS.p)
      ) {
        throw new Error(DAMAGED)
      }
      key = await deriveKeyArgon(password, salt, { m: record.m, t: record.t, p: record.p }, onProgress)
    } else if (record.v === 1 && record.kdf === KDF_V1) {
      // A tampered iteration count can't weaken the ciphertext (the key just
      // won't match) but a huge one would hang unlock for minutes. Bound it.
      if (!Number.isInteger(record.iter) || record.iter < 100_000 || record.iter > 10_000_000) {
        throw new Error(DAMAGED)
      }
      key = await deriveKeyPbkdf2(password, salt, record.iter)
      legacy = true
    } else {
      throw new Error('bad record')
    }
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ct as BufferSource,
    )
    mnemonic = new TextDecoder().decode(pt)
  } catch (e) {
    if (e instanceof Error && e.message === DAMAGED) throw e
    throw new Error('Wrong password')
  }
  if (legacy) {
    // Transparent upgrade; if storage refuses, the v1 vault simply stays.
    // Written only over the very record just unlocked: an erase during the
    // slow Argon2id derivation (or a wallet another window created) must
    // not be overwritten, and an erased vault came back (BL40; review
    // 2026-10-28).
    try {
      const sealed = await sealVault(mnemonic, password, onProgress)
      if (localStorage.getItem(STORAGE_KEY) === raw) localStorage.setItem(STORAGE_KEY, sealed)
    } catch {
      // keep the legacy record
    }
  }
  return mnemonic
}

export function clearVault(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked — nothing was persisted there anyway.
  }
}
