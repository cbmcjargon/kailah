// fakehid.mjs — a fake WebHID bound to scripts/ledger-emulator.mjs, for
// check-hw: frames go device-side through the emulator's own (un)framing and
// replies come back as inputreport events, as in the browser. `reenumerate`
// is the USB re-enumeration a Ledger goes through when an app opens or
// closes, or on a replug: the old device object dies, a new one appears.
import { LedgerEmulator } from './ledger-emulator.mjs'

export { LedgerEmulator }

/** One USB enumeration of the device: a new HIDDevice object each time. */
export function makeHidDevice(emu, hid, opts = {}) {
  const dev = new EventTarget()
  dev.opened = false
  dev.vendorId = 0x2c97
  dev.productId = 0x5011
  dev.productName = 'Nano S Plus'
  dev.collections = [{ usagePage: 0xffa0 }]
  dev.gone = false
  dev.log = []
  let frames = []
  let channel = -1
  dev.open = async () => {
    if (dev.gone) throw Object.assign(new Error('gone'), { name: 'NotFoundError' })
    dev.opened = true
  }
  dev.close = async () => {
    dev.opened = false
  }
  dev.forget = async () => {}
  dev.sendReport = async (_id, f) => {
    if (dev.gone || !dev.opened) throw Object.assign(new Error('Failed to write the report.'), { name: 'NotAllowedError' })
    const fr = new Uint8Array(f)
    const ch = (fr[0] << 8) | fr[1]
    const seq = (fr[3] << 8) | fr[4]
    if (seq === 0) {
      frames = []
      channel = ch
    }
    frames.push(fr)
    const len = (frames[0][5] << 8) | frames[0][6]
    const have = 57 + (frames.length - 1) * 59
    if (have < len) return
    const apdu = emu.unframe(frames, channel)
    const myChannel = channel
    dev.log.push(Array.from(apdu.subarray(0, 4), (x) => x.toString(16).padStart(2, '0')).join(''))
    // the device answers asynchronously, as USB does, one command at a time
    dev.queue = (dev.queue ?? Promise.resolve()).then(async () => {
      const reply = await emu.handle(apdu)
      if (opts.holdReply) await opts.holdReply(apdu, reply)
      for (const out of emu.frame(reply, myChannel)) {
        if (dev.gone) return
        const ev = new Event('inputreport')
        ev.device = dev
        ev.data = new DataView(out.buffer.slice(0))
        dev.dispatchEvent(ev)
        await new Promise((r) => setTimeout(r, 0))
      }
    })
  }
  return dev
}

export function makeHid() {
  const hid = new EventTarget()
  hid.devices = []
  hid.getDevices = async () => hid.devices.filter((d) => !d.gone)
  hid.requestDevice = async () => {
    throw Object.assign(new Error('No device selected.'), { name: 'NotFoundError' })
  }
  /** USB re-enumeration (the user opened/closed an app): old object dies, new one appears. */
  hid.reenumerate = (emu, opts) => {
    for (const d of hid.devices) {
      if (d.gone) continue
      d.gone = true
      d.opened = false
      const ev = new Event('disconnect')
      ev.device = d
      hid.dispatchEvent(ev)
    }
    const fresh = makeHidDevice(emu, hid, opts)
    hid.devices.push(fresh)
    return fresh
  }
  return hid
}

export function installNavigator(hid) {
  Object.defineProperty(globalThis, 'navigator', { value: { hid }, configurable: true, writable: true })
}
