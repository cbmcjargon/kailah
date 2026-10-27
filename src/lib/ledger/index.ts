// Ledger, high level: sessions, app checks, identity binding, account import,
// on-device address verification, and the UtxoSigner. docs/hardware-signing.md.
//
// Every operation takes a TransportSource so the offline suite can drive the
// exact same code against the device emulator; the app passes
// browserTransport(), which reuses one open WebHID/WebUSB session.

import { bytesToHex } from '@noble/hashes/utils'
import { CHAINS } from '../networks'
import {
  HARDWARE_CHAINS,
  hardwareRecordId,
  parseAccountXpub,
  parsePath,
  xpubAddress,
} from '../hwaccount'
import type {
  HardwareAccountKeys,
  HardwareAccountRecord,
  HardwareChainId,
  SignRequest,
  UtxoSigner,
} from '../types'
import { LedgerBtcApp, WalletPolicy } from './btcapp'
import { LedgerLegacyApp } from './legacyapp'
import {
  LedgerDisconnectedError,
  LedgerStatusError,
  forgetLedgerDevices,
  ledgerSupport,
  openLedgerTransport,
  sendApdu,
  type LedgerTransport,
} from './transport'

export { ledgerSupport, forgetLedgerDevices }
export type { LedgerTransport }

export type LedgerErrorKind =
  | 'unsupported'
  | 'no-device'
  | 'cancelled'
  | 'busy'
  | 'locked'
  | 'wrong-app'
  | 'app-too-old'
  | 'rejected'
  | 'wrong-device'
  | 'disconnected'
  | 'protocol'
  /** not the device's doing: a data service or the wallet itself (BL48) */
  | 'other'

/** Every failure a Ledger operation can end in, with user-facing copy. */
export class LedgerError extends Error {
  constructor(
    readonly kind: LedgerErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** Progress for the UI: opening the device, talking to the app, waiting on the user. */
export type LedgerStatus = 'connecting' | 'checking' | 'confirm'
export type TransportSource = () => Promise<LedgerTransport>

const APP_TIMEOUT_MS = 10_000

export function toLedgerError(e: unknown, appName = 'Bitcoin'): LedgerError {
  if (e instanceof LedgerError) return e
  if (e instanceof LedgerStatusError) {
    switch (e.sw) {
      case 0x6985:
        // declined on the device: true of a signature and of an address check alike (BL48)
        return new LedgerError('rejected', 'You declined it on your Ledger, so nothing was signed.')
      case 0x5515:
      case 0x6982:
        return new LedgerError('locked', 'Unlock your Ledger with its PIN, then try again.')
      case 0x6e00:
      case 0x6d00:
      case 0x6511:
      case 0x6e01:
        return new LedgerError('wrong-app', `Open the ${appName} app on your Ledger, then try again.`)
      default:
        return new LedgerError(
          'protocol',
          `Your Ledger refused the request (code 0x${e.sw.toString(16).padStart(4, '0')}). Update the ${appName} app in Ledger Live and try again.`,
        )
    }
  }
  if (e instanceof LedgerDisconnectedError) {
    return new LedgerError('disconnected', 'Your Ledger disconnected. Reconnect it, unlock it, and try again.')
  }
  const name = (e as { name?: string } | null)?.name
  if (name === 'NotFoundError') return new LedgerError('cancelled', 'No Ledger was selected.')
  if (name === 'SecurityError') {
    return new LedgerError('unsupported', 'This page is not allowed to use USB devices.')
  }
  if (name === 'NotAllowedError' || name === 'InvalidStateError' || name === 'NetworkError') {
    return new LedgerError(
      'busy',
      'The browser could not open your Ledger. Close Ledger Live or other wallet tabs, replug the device, and try again.',
    )
  }
  // Anything else came from outside the device (a data service fetching
  // the funding transactions, say): not a "Ledger problem" (BL48)
  return new LedgerError('other', e instanceof Error && e.message ? e.message : 'Something went wrong.')
}

// ---------------------------------------------------------------------------
// Browser session (one open device per page)

let session: LedgerTransport | null = null

/**
 * The real device. prompt=true may open the browser's chooser and so must be
 * called from a tap; prompt=false only reopens an already-granted device.
 */
export function browserTransport(prompt: boolean): TransportSource {
  return async () => {
    if (session) {
      // Opening or closing an app on the Ledger (or a replug) re-enumerates
      // it and leaves the old handle dead: reopen rather than fail the tap
      // with "Your Ledger disconnected" (bug audit 2026-10-27, BM27).
      if (session.alive?.() !== false) return session
      const stale = session
      session = null
      await stale.close().catch(() => undefined)
    }
    if (ledgerSupport() === null) {
      throw new LedgerError(
        'unsupported',
        'Hardware wallets need Chrome or Edge on a computer, or Chrome on Android with a USB cable.',
      )
    }
    const t = await openLedgerTransport(prompt)
    if (t === null) throw new LedgerError('no-device', 'Connect your Ledger, unlock it, then try again.')
    session = t
    return t
  }
}

/** Lock/erase: close the open device handle (nothing secret lives here). */
export async function closeLedgerSession(): Promise<void> {
  const s = session
  session = null
  await s?.close()
}

async function withLedger<T>(
  source: TransportSource,
  appName: string,
  onStatus: ((s: LedgerStatus) => void) | undefined,
  fn: (t: LedgerTransport) => Promise<T>,
): Promise<T> {
  onStatus?.('connecting')
  let t: LedgerTransport
  try {
    t = await source()
  } catch (e) {
    throw toLedgerError(e, appName)
  }
  try {
    return await fn(t)
  } catch (e) {
    const err = toLedgerError(e, appName)
    // A stale or wedged handle is useless; the next tap reconnects. So is
    // one to the wrong app: opening the right one re-enumerates the device.
    if (err.kind === 'disconnected' || err.kind === 'busy' || err.kind === 'wrong-app') {
      if (session === t) session = null
      await t.close().catch(() => undefined)
    }
    throw err
  }
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new LedgerError('disconnected', "Your Ledger isn't responding. Unplug it, plug it back in, unlock it and try again."))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(id)
        resolve(v)
      },
      (e) => {
        clearTimeout(id)
        reject(e)
      },
    )
  })
}

export async function getAppAndVersion(t: LedgerTransport): Promise<{ name: string; version: string }> {
  const { data } = await sendApdu(t, 0xb0, 0x01, 0x00, 0x00)
  const dec = new TextDecoder()
  if (data[0] !== 0x01) throw new Error('Unexpected app info from Ledger')
  const nameLen = data[1] ?? 0
  const name = dec.decode(data.subarray(2, 2 + nameLen))
  const verLen = data[2 + nameLen] ?? 0
  const version = dec.decode(data.subarray(3 + nameLen, 3 + nameLen + verLen))
  return { name, version }
}

function versionAtLeast(v: string, min: [number, number, number]): boolean {
  const parts = v.split(/[.-]/).map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const a = Number.isFinite(parts[i]) ? parts[i]! : 0
    if (a !== min[i]) return a > min[i]!
  }
  return true
}

type OpenedApp = { kind: 'bitcoin'; app: LedgerBtcApp } | { kind: 'litecoin-legacy'; app: LedgerLegacyApp }

async function openAppFor(t: LedgerTransport, chain: HardwareChainId): Promise<OpenedApp> {
  const want = HARDWARE_CHAINS[chain]
  const { name, version } = await timeout(getAppAndVersion(t), APP_TIMEOUT_MS)
  if (name !== want.appName) {
    const dashboard = name === 'BOLOS' || name === 'OLOS\u0000' || name === ''
    throw new LedgerError(
      'wrong-app',
      dashboard
        ? `Open the ${want.appName} app on your Ledger, then try again.`
        : `Your Ledger has the ${name} app open. Open the ${want.appName} app instead.`,
    )
  }
  if (want.app === 'bitcoin') {
    if (!versionAtLeast(version, [2, 1, 0])) {
      throw new LedgerError(
        'app-too-old',
        `Your ${want.appName} app is version ${version}. Update it to 2.1 or newer in Ledger Live.`,
      )
    }
    return { kind: 'bitcoin', app: new LedgerBtcApp(t) }
  }
  return { kind: 'litecoin-legacy', app: new LedgerLegacyApp(t) }
}

const WRONG_DEVICE = "This Ledger doesn't hold this account (different device, or a different passphrase)."

/** The connected device must hold exactly this account's key. */
async function assertSameAccount(opened: OpenedApp, account: HardwareAccountKeys): Promise<void> {
  const rec = account.record
  if (opened.kind === 'bitcoin') {
    const fp = bytesToHex(await opened.app.getMasterFingerprint())
    const xpub = await opened.app.getExtendedPubkey(account.accountPathIndices)
    if (fp !== rec.masterFingerprint || xpub !== rec.xpub) throw new LedgerError('wrong-device', WRONG_DEVICE)
  } else {
    const xpub = await opened.app.getAccountXpub(account.accountPathIndices)
    if (xpub !== rec.xpub) throw new LedgerError('wrong-device', WRONG_DEVICE)
  }
}

function policyFor(account: HardwareAccountKeys): WalletPolicy {
  const fp = account.record.masterFingerprint
  if (fp === null) throw new Error('Internal error: no master fingerprint for a Bitcoin-app account.')
  return WalletPolicy.defaultWpkh(Uint8Array.from(fp.match(/../g)!.map((h) => Number.parseInt(h, 16))), account.accountPathIndices, account.record.xpub)
}

async function showAddress(opened: OpenedApp, policy: WalletPolicy | null, path: number[], branch: 0 | 1, index: number): Promise<string> {
  if (opened.kind === 'bitcoin') return opened.app.getWalletAddress(policy!, branch, index, true)
  return (await opened.app.getWalletPublicKey([...path, branch, index], { display: true, format: 2 })).address
}

// ---------------------------------------------------------------------------
// Operations

/**
 * Read the account key from the device and have the user confirm receive
 * address 0/0 on the device screen. Returns the record to store.
 */
export async function importLedgerAccount(
  chainId: HardwareChainId,
  source: TransportSource,
  onStatus?: (s: LedgerStatus) => void,
  /** the address the device is about to display, for the user to compare */
  onExpectAddress?: (address: string) => void,
): Promise<HardwareAccountRecord> {
  const chain = CHAINS[chainId]
  const info = HARDWARE_CHAINS[chainId]
  return withLedger(source, info.appName, onStatus, async (t) => {
    onStatus?.('checking')
    const opened = await openAppFor(t, chainId)
    const path = parsePath(chain.accountPath)
    let xpub: string
    let masterFingerprint: string | null
    if (opened.kind === 'bitcoin') {
      masterFingerprint = bytesToHex(await opened.app.getMasterFingerprint())
      xpub = await opened.app.getExtendedPubkey(path)
    } else {
      masterFingerprint = null
      xpub = await opened.app.getAccountXpub(path)
    }
    parseAccountXpub(chain, xpub)
    const first = xpubAddress(chain, xpub, 0, 0)
    const policy =
      masterFingerprint === null
        ? null
        : WalletPolicy.defaultWpkh(Uint8Array.from(masterFingerprint.match(/../g)!.map((h) => Number.parseInt(h, 16))), path, xpub)
    onExpectAddress?.(first)
    onStatus?.('confirm')
    const shown = await showAddress(opened, policy, path, 0, 0)
    if (shown !== first) {
      throw new LedgerError('wrong-device', "The address on your Ledger doesn't match the wallet's — the account was not added.")
    }
    return {
      v: 1,
      id: hardwareRecordId(chainId, xpub),
      chain: chainId,
      device: 'ledger',
      app: info.app,
      accountPath: chain.accountPath,
      xpub,
      masterFingerprint,
      verifiedAddress: first,
      label: 'Ledger',
      addedAt: Date.now(),
    }
  })
}

/** Show branch/index on the device; resolves once the user confirms and it matches. */
export async function verifyAddressOnLedger(
  account: HardwareAccountKeys,
  branch: 0 | 1,
  index: number,
  source: TransportSource,
  onStatus?: (s: LedgerStatus) => void,
  /** the exact string the screen shows: it must equal the derivation AND the device */
  displayed?: string,
): Promise<void> {
  const info = HARDWARE_CHAINS[account.record.chain]
  await withLedger(source, info.appName, onStatus, async (t) => {
    onStatus?.('checking')
    const opened = await openAppFor(t, account.record.chain)
    await assertSameAccount(opened, account)
    const expected = account.address(branch, index).address
    if (displayed !== undefined && displayed !== expected) {
      throw new LedgerError('wrong-device', "The address on this screen isn't the one this account derives. Don't use it.")
    }
    onStatus?.('confirm')
    const shown = await showAddress(
      opened,
      opened.kind === 'bitcoin' ? policyFor(account) : null,
      account.accountPathIndices,
      branch,
      index,
    )
    if (shown !== expected) {
      throw new LedgerError('wrong-device', "The address on your Ledger doesn't match this screen. Don't use it.")
    }
  })
}

/** The device as a UtxoSigner for one hardware account. */
export function ledgerSigner(
  account: HardwareAccountKeys,
  source: TransportSource,
  onStatus?: (s: LedgerStatus) => void,
): UtxoSigner {
  const info = HARDWARE_CHAINS[account.record.chain]
  return {
    sign: (req: SignRequest) =>
      withLedger(source, info.appName, onStatus, async (t) => {
        if (req.chain.id !== account.chain) throw new Error('Internal error: account/chain mismatch.')
        onStatus?.('checking')
        const opened = await openAppFor(t, account.record.chain)
        await assertSameAccount(opened, account)
        if (opened.kind === 'bitcoin') {
          onStatus?.('confirm')
          return opened.app.signPsbt(req, policyFor(account))
        }
        return opened.app.signSegwit(req, () => onStatus?.('confirm'))
      }),
  }
}
