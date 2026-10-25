// WebAuthn PRF-based biometric unlock (Face ID / Touch ID / Android biometrics).
//
// Security model: enrollment creates a platform passkey with the PRF
// extension. The authenticator's PRF output — a 32-byte secret that is only
// released after a successful biometric user-verification and never exists
// outside the device's secure hardware until then — is stretched through
// HKDF-SHA256 into an AES-256-GCM key that encrypts a copy of the mnemonic.
// The ciphertext stored in localStorage is useless without a fresh biometric
// assertion on this device. The password vault (vault.ts) remains the
// primary and fallback unlock; this is an additional convenience door with
// equivalent cryptographic protection, not a bypass.

import { base64, base64urlnopad } from '@scure/base'
import { IS_EXTENSION } from '../platform'

const BIO_KEY = 'kailah.biovault.v1'
const HKDF_INFO = new TextEncoder().encode('kailah-biometric-v1')

interface BioRecord {
  v: 1
  credId: string
  prfSalt: string
  hkdfSalt: string
  iv: string
  ct: string
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function hasBiometricVault(): boolean {
  try {
    return localStorage.getItem(BIO_KEY) !== null
  } catch {
    return false
  }
}

/** true when this device has a biometric (or PIN) platform authenticator */
export async function biometricAvailable(): Promise<boolean> {
  try {
    if (typeof PublicKeyCredential === 'undefined') return false
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/** Runs a biometric assertion and returns the PRF secret for prfSalt. */
async function evalPrf(credId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credId as BufferSource }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
    },
  })) as PublicKeyCredential | null
  const out = (assertion?.getClientExtensionResults() as PrfExtensionResults | undefined)?.prf
    ?.results?.first
  if (out === undefined) {
    throw new Error('This device could not provide the biometric key.')
  }
  return new Uint8Array(out)
}

async function deriveAesKey(secret: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt as BufferSource, info: HKDF_INFO as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Creates the platform passkey and stores a biometric-protected copy of the
 * mnemonic. Triggers two biometric prompts (passkey creation + first key
 * evaluation). Must be called while the wallet is unlocked.
 */
export async function enrollBiometric(mnemonic: string): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Kailah Wallet', id: location.hostname },
      user: {
        id: randomBytes(16) as BufferSource,
        name: 'kailah-wallet',
        displayName: 'Kailah Wallet',
      },
      challenge: randomBytes(32) as BufferSource,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      extensions: { prf: {} },
    },
  })) as PublicKeyCredential | null
  if (cred === null) throw new Error('Biometric setup was cancelled.')
  const ext = cred.getClientExtensionResults() as PrfExtensionResults
  if (ext.prf?.enabled !== true) {
    throw new Error('This device does not support biometric key protection (PRF).')
  }

  const credId = new Uint8Array(cred.rawId)
  const prfSalt = randomBytes(32)
  const hkdfSalt = randomBytes(32)
  const secret = await evalPrf(credId, prfSalt)
  const key = await deriveAesKey(secret, hkdfSalt)
  secret.fill(0)

  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(mnemonic),
  )
  const record: BioRecord = {
    v: 1,
    credId: base64.encode(credId),
    prfSalt: base64.encode(prfSalt),
    hkdfSalt: base64.encode(hkdfSalt),
    iv: base64.encode(iv),
    ct: base64.encode(new Uint8Array(ct)),
  }
  try {
    localStorage.setItem(BIO_KEY, JSON.stringify(record))
  } catch {
    throw new Error('This browser is blocking local storage, so biometric unlock cannot be saved.')
  }
}

/** Biometric prompt -> mnemonic. Throws with a readable message on failure. */
export async function biometricUnlock(): Promise<string> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(BIO_KEY)
  } catch {
    raw = null
  }
  if (raw === null) throw new Error('Biometric unlock is not set up on this device.')
  const record = JSON.parse(raw) as BioRecord
  const secret = await evalPrf(base64.decode(record.credId), base64.decode(record.prfSalt))
  const key = await deriveAesKey(secret, base64.decode(record.hkdfSalt))
  secret.fill(0)
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64.decode(record.iv) as BufferSource },
      key,
      base64.decode(record.ct) as BufferSource,
    )
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error('Biometric unlock failed — use your password instead.')
  }
}

/**
 * Best-effort hint to the platform credential manager that the passkey is no
 * longer used, so it can offer to delete the orphan (Signal API, Chrome 128+).
 * Browsers cannot delete passkeys outright; absent the API this is a no-op and
 * the passkey simply lingers harmlessly (it protects nothing once the record
 * is gone).
 */
function signalCredentialRemoved(credIdB64: string): void {
  try {
    const pkc = PublicKeyCredential as unknown as {
      signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>
    }
    if (typeof pkc.signalUnknownCredential !== 'function') return
    const bytes = base64.decode(credIdB64)
    const b64url = base64urlnopad.encode(bytes)
    void pkc.signalUnknownCredential({ rpId: location.hostname, credentialId: b64url }).catch(() => {})
  } catch {
    // purely cosmetic cleanup — never let it break disable/erase
  }
}

export function disableBiometric(): void {
  try {
    const raw = localStorage.getItem(BIO_KEY)
    localStorage.removeItem(BIO_KEY)
    if (raw !== null) {
      const record = JSON.parse(raw) as BioRecord
      signalCredentialRemoved(record.credId)
    }
  } catch {
    // storage blocked — nothing was persisted anyway
  }
}

/** Maps WebAuthn errors to friendly text. */
export function biometricErrorMessage(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
    return 'Biometric prompt was cancelled.'
  }
  // In the extension the passkey's RP ID is the extension ID (location.hostname
  // on a chrome-extension:// page). Chrome accepts that, but a platform passkey
  // provider that refuses it surfaces as one of these errors: say so plainly
  // instead of showing the raw DOMException text. See docs/extension.md.
  if (IS_EXTENSION && e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'NotSupportedError')) {
    return 'Face ID / fingerprint unlock isn’t available to the browser extension on this device — your password still unlocks the wallet.'
  }
  if (e instanceof Error && e.message) return e.message
  return 'Biometric unlock failed — use your password instead.'
}
