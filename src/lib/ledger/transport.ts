// Ledger transports: WebHID (preferred: Chrome/Edge/Opera desktop) and WebUSB
// (fallback where WebHID is missing — Chrome on Android with USB-OTG). Both
// speak the same 64-byte framing (framing.ts). No network, no new hosts.
//
// WebHID and WebUSB are Chromium-only APIs that TypeScript's DOM lib doesn't
// declare, so the few members used here are typed locally.

import { FrameReader, PACKET_SIZE, makeFrames } from './framing'

export const LEDGER_VENDOR_ID = 0x2c97
/** Ledger's generic HID collection (the other one on newer models is FIDO). */
const LEDGER_USAGE_PAGE = 0xffa0

/** A connection to a device: one APDU in, the reply (data || SW1 SW2) out. */
export interface LedgerTransport {
  readonly kind: 'webhid' | 'webusb' | 'emulator'
  exchange(apdu: Uint8Array): Promise<Uint8Array>
  close(): Promise<void>
  /** false once the handle is known dead: the device re-enumerated (an app opened or closed) or was unplugged */
  alive?(): boolean
}

/** A status word other than the ones the caller accepts. */
export class LedgerStatusError extends Error {
  constructor(readonly sw: number) {
    super(`Ledger replied 0x${sw.toString(16).padStart(4, '0')}`)
    this.name = 'LedgerStatusError'
  }
}

/** The transport went away (unplugged, re-enumerated after an app switch). */
export class LedgerDisconnectedError extends Error {
  constructor() {
    super('Ledger disconnected')
    this.name = 'LedgerDisconnectedError'
  }
}

export function encodeApdu(cla: number, ins: number, p1: number, p2: number, data: Uint8Array): Uint8Array {
  if (data.length > 255) throw new Error('APDU data too long')
  const out = new Uint8Array(5 + data.length)
  out.set([cla, ins, p1, p2, data.length], 0)
  out.set(data, 5)
  return out
}

/** Send one APDU; returns the data and status word, throwing on a non-accepted SW. */
export async function sendApdu(
  t: LedgerTransport,
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  data: Uint8Array = new Uint8Array(0),
  accept: number[] = [0x9000],
): Promise<{ data: Uint8Array; sw: number }> {
  const reply = await t.exchange(encodeApdu(cla, ins, p1, p2, data))
  if (reply.length < 2) throw new Error('Short reply from Ledger')
  const sw = (reply[reply.length - 2]! << 8) | reply[reply.length - 1]!
  if (!accept.includes(sw)) throw new LedgerStatusError(sw)
  return { data: reply.slice(0, -2), sw }
}

/** Serialize exchanges: a second request never interleaves frames with the first. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}

const randomChannel = (): number => {
  const b = new Uint16Array(1)
  crypto.getRandomValues(b)
  return b[0]!
}

// ---------------------------------------------------------------------------
// WebHID

interface HidInputReportEvent extends Event {
  device: HidDeviceLike
  data: DataView
}

export interface HidDeviceLike extends EventTarget {
  opened: boolean
  vendorId: number
  productId: number
  productName: string
  collections?: { usagePage?: number }[]
  open(): Promise<void>
  close(): Promise<void>
  sendReport(reportId: number, data: BufferSource): Promise<void>
  forget?(): Promise<void>
}

interface HidLike extends EventTarget {
  getDevices(): Promise<HidDeviceLike[]>
  requestDevice(opts: { filters: { vendorId?: number; usagePage?: number }[] }): Promise<HidDeviceLike[]>
}

class WebHidTransport implements LedgerTransport {
  readonly kind = 'webhid' as const
  private reports: Uint8Array[] = []
  private waiter: { resolve: (r: Uint8Array) => void; reject: (e: unknown) => void } | null = null
  private dead: unknown = null
  private readonly mutex = new Mutex()

  private readonly onReport = (e: Event) => {
    const ev = e as HidInputReportEvent
    const r = new Uint8Array(ev.data.buffer.slice(ev.data.byteOffset, ev.data.byteOffset + ev.data.byteLength))
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve(r)
    } else {
      this.reports.push(r)
    }
  }

  private readonly onDisconnect = (e: Event) => {
    if ((e as unknown as { device?: HidDeviceLike }).device === this.device) this.fail(new LedgerDisconnectedError())
  }

  constructor(
    private readonly device: HidDeviceLike,
    private readonly hid: HidLike,
  ) {
    device.addEventListener('inputreport', this.onReport)
    hid.addEventListener('disconnect', this.onDisconnect)
  }

  alive(): boolean {
    return this.dead === null && this.device.opened
  }

  private fail(err: unknown): void {
    this.dead = err
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.reject(err)
    }
  }

  private next(): Promise<Uint8Array> {
    if (this.dead !== null) return Promise.reject(this.dead)
    const queued = this.reports.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  exchange(apdu: Uint8Array): Promise<Uint8Array> {
    return this.mutex.run(async () => {
      if (this.dead !== null) throw this.dead
      this.reports = [] // drop leftovers of an aborted exchange
      const channel = randomChannel()
      try {
        for (const f of makeFrames(apdu, channel, PACKET_SIZE)) await this.device.sendReport(0, f as BufferSource)
      } catch {
        this.fail(new LedgerDisconnectedError())
        throw this.dead
      }
      const reader = new FrameReader(channel)
      for (;;) {
        const out = reader.push(await this.next())
        if (out) return out
      }
    })
  }

  async close(): Promise<void> {
    this.fail(new LedgerDisconnectedError())
    this.device.removeEventListener('inputreport', this.onReport)
    this.hid.removeEventListener('disconnect', this.onDisconnect)
    try {
      if (this.device.opened) await this.device.close()
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// WebUSB

export interface UsbDeviceLike {
  opened: boolean
  vendorId: number
  productName?: string
  configuration: unknown | null
  configurations: {
    interfaces: { interfaceNumber: number; alternates: { interfaceClass: number }[] }[]
  }[]
  open(): Promise<void>
  close(): Promise<void>
  reset(): Promise<void>
  selectConfiguration(v: number): Promise<void>
  claimInterface(n: number): Promise<void>
  releaseInterface(n: number): Promise<void>
  transferOut(ep: number, data: BufferSource): Promise<unknown>
  transferIn(ep: number, len: number): Promise<{ data?: DataView }>
  forget?(): Promise<void>
}

interface UsbLike extends EventTarget {
  getDevices(): Promise<UsbDeviceLike[]>
  requestDevice(opts: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike>
}

const USB_ENDPOINT = 3

class WebUsbTransport implements LedgerTransport {
  readonly kind = 'webusb' as const
  private readonly mutex = new Mutex()
  private dead = false

  private readonly onDisconnect = (e: Event) => {
    if ((e as unknown as { device?: UsbDeviceLike }).device === this.device) this.dead = true
  }

  private constructor(
    private readonly device: UsbDeviceLike,
    private readonly iface: number,
    private readonly usb: UsbLike,
  ) {
    usb.addEventListener('disconnect', this.onDisconnect)
  }

  alive(): boolean {
    return !this.dead && this.device.opened
  }

  static async open(device: UsbDeviceLike, usb: UsbLike): Promise<WebUsbTransport> {
    if (!device.opened) await device.open()
    if (device.configuration === null) await device.selectConfiguration(1)
    try {
      await device.reset()
    } catch {
      // some platforms refuse a reset; the device still works
    }
    const iface = device.configurations[0]?.interfaces.find((i) =>
      i.alternates.some((a) => a.interfaceClass === 0xff),
    )
    if (!iface) throw new Error('This USB device has no Ledger interface.')
    await device.claimInterface(iface.interfaceNumber)
    return new WebUsbTransport(device, iface.interfaceNumber, usb)
  }

  exchange(apdu: Uint8Array): Promise<Uint8Array> {
    return this.mutex.run(async () => {
      if (this.dead) throw new LedgerDisconnectedError()
      const channel = randomChannel()
      try {
        for (const f of makeFrames(apdu, channel, PACKET_SIZE)) {
          await this.device.transferOut(USB_ENDPOINT, f as BufferSource)
        }
        const reader = new FrameReader(channel)
        for (;;) {
          const r = await this.device.transferIn(USB_ENDPOINT, PACKET_SIZE)
          if (!r.data) throw new LedgerDisconnectedError()
          const out = reader.push(new Uint8Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength)))
          if (out) return out
        }
      } catch (e) {
        if (e instanceof Error && /frame|sequence|channel|tag/i.test(e.message)) throw e
        this.dead = true
        throw new LedgerDisconnectedError()
      }
    })
  }

  async close(): Promise<void> {
    this.dead = true
    this.usb.removeEventListener('disconnect', this.onDisconnect)
    try {
      await this.device.releaseInterface(this.iface)
    } catch {
      // ignore
    }
    try {
      await this.device.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery

function nav(): { hid?: HidLike; usb?: UsbLike } | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as { hid?: HidLike; usb?: UsbLike })
}

/** Which browser API this session will use, or null when none exists. */
export function ledgerSupport(): 'webhid' | 'webusb' | null {
  const n = nav()
  if (n?.hid) return 'webhid'
  if (n?.usb) return 'webusb'
  return null
}

const isLedgerHid = (d: HidDeviceLike) =>
  d.vendorId === LEDGER_VENDOR_ID &&
  (d.collections === undefined || d.collections.length === 0 || d.collections.some((c) => c.usagePage === LEDGER_USAGE_PAGE))

/**
 * Open a Ledger: an already-granted one first; otherwise (prompt=true, which
 * must run inside a user gesture) the browser's device chooser. Resolves null
 * when no device is available without prompting.
 */
export async function openLedgerTransport(prompt: boolean): Promise<LedgerTransport | null> {
  const n = nav()
  if (n?.hid) {
    const hid = n.hid
    let device = (await hid.getDevices()).find(isLedgerHid)
    if (!device && prompt) {
      const picked = await hid.requestDevice({
        filters: [{ vendorId: LEDGER_VENDOR_ID, usagePage: LEDGER_USAGE_PAGE }],
      })
      device = picked.find(isLedgerHid)
    }
    if (!device) return null
    if (!device.opened) await device.open()
    return new WebHidTransport(device, hid)
  }
  if (n?.usb) {
    const usb = n.usb
    let device = (await usb.getDevices()).find((d) => d.vendorId === LEDGER_VENDOR_ID)
    if (!device && prompt) device = await usb.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR_ID }] })
    if (!device) return null
    return WebUsbTransport.open(device, usb)
  }
  return null
}

/** Erase: revoke this origin's permission to every Ledger it was granted. */
export async function forgetLedgerDevices(): Promise<void> {
  const n = nav()
  try {
    for (const d of (await n?.hid?.getDevices()) ?? []) {
      if (d.vendorId === LEDGER_VENDOR_ID) await d.forget?.()
    }
  } catch {
    // best effort
  }
  try {
    for (const d of (await n?.usb?.getDevices()) ?? []) {
      if (d.vendorId === LEDGER_VENDOR_ID) await d.forget?.()
    }
  } catch {
    // best effort
  }
}
