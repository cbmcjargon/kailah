// Ledger HID framing (used over both WebHID and WebUSB).
//
// An APDU is prefixed with its 2-byte big-endian length, then cut into
// fixed-size packets: channel (2 BE) | tag 0x05 | sequence (2 BE) | data,
// zero-padded. Replies come back the same way; every packet's channel, tag
// and sequence must match before its bytes are accepted. Pure functions — the
// offline suite drives them directly and through the device emulator.

export const PACKET_SIZE = 64
const TAG = 0x05
const HEADER = 5

export function makeFrames(apdu: Uint8Array, channel: number, packetSize = PACKET_SIZE): Uint8Array[] {
  if (apdu.length > 0xffff) throw new Error('APDU too long')
  const data = new Uint8Array(2 + apdu.length)
  data[0] = apdu.length >> 8
  data[1] = apdu.length & 0xff
  data.set(apdu, 2)
  const block = packetSize - HEADER
  const count = Math.max(1, Math.ceil(data.length / block))
  const frames: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const f = new Uint8Array(packetSize)
    f[0] = (channel >> 8) & 0xff
    f[1] = channel & 0xff
    f[2] = TAG
    f[3] = (i >> 8) & 0xff
    f[4] = i & 0xff
    f.set(data.subarray(i * block, (i + 1) * block), HEADER)
    frames.push(f)
  }
  return frames
}

/** Reassembles one reply; push() returns the full payload once complete. */
export class FrameReader {
  private seq = 0
  private expected = -1
  private chunks: Uint8Array[] = []
  private got = 0

  constructor(private readonly channel: number) {}

  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length < HEADER + (this.seq === 0 ? 2 : 0)) throw new Error('Short frame from device')
    if (((frame[0]! << 8) | frame[1]!) !== this.channel) throw new Error('Frame on the wrong channel')
    if (frame[2] !== TAG) throw new Error('Unexpected frame tag')
    if (((frame[3]! << 8) | frame[4]!) !== this.seq) throw new Error('Frame out of sequence')
    let body: Uint8Array
    if (this.seq === 0) {
      this.expected = (frame[5]! << 8) | frame[6]!
      body = frame.subarray(7)
    } else {
      body = frame.subarray(HEADER)
    }
    this.seq++
    const take = Math.min(body.length, this.expected - this.got)
    this.chunks.push(body.slice(0, take))
    this.got += take
    if (this.got < this.expected) return null
    const out = new Uint8Array(this.expected)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}
