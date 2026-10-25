// ledger-emulator.mjs — TEST ONLY (never shipped). An in-memory Ledger that
// implements the DEVICE side of the protocols the wallet speaks:
//   • HID framing (its own implementation, independent of src/lib/ledger/framing.ts)
//   • GET_APP_AND_VERSION (B0 01)
//   • Bitcoin app ≥ 2.1 (CLA E1): GET_MASTER_FINGERPRINT, GET_EXTENDED_PUBKEY,
//     GET_WALLET_ADDRESS, SIGN_PSBT — rebuilding the PSBT purely through client
//     commands, verifying every merkle proof and preimage, enforcing the
//     default-wallet-policy rules, detecting change from BIP32 paths,
//     recording what it would display, and yielding BIP143 signatures
//   • Litecoin legacy app (CLA E0): GET_WALLET_PUBLIC_KEY, GET_TRUSTED_INPUT
//     (HMAC-authenticated), HASH_INPUT_START, HASH_INPUT_FINALIZE_FULL,
//     HASH_SIGN (with the R-parity flag in the first byte, as the device does)
// Its merkle tree, varints and BIP143 digest are written here from the specs,
// not imported from the wallet, so a shared misunderstanding is less likely.
//
//   const dev = new LedgerEmulator({ mnemonic, app: 'Bitcoin', network, coinType: 0 })
//   const source = () => Promise.resolve(dev.transport())
//   dev.screens   // what the device showed, in order
//   dev.approve = false / dev.locked = true / dev.tamper = 'digest' | 'trusted-amount'

import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { Address, OutScript, p2pkh, p2wpkh } from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { hmac } from '@noble/hashes/hmac.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { makeFrames, FrameReader } from '../src/lib/ledger/framing.ts'

const H = 0x80000000
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const cat = (...p) => {
  const out = new Uint8Array(p.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of p) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16))
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const dsha = (b) => sha256(sha256(b))
const ascii = (s) => new TextEncoder().encode(s)
const sw = (code) => Uint8Array.of(code >> 8, code & 0xff)
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255)
const rd32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const rd32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const rd64le = (b, o) => {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i])
  return v
}
const le64 = (v) => {
  const o = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    o[i] = Number(v & 255n)
    v >>= 8n
  }
  return o
}
function cs(n) {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 255, n >> 8)
  return cat(Uint8Array.of(0xfe), le32(n))
}
function rdcs(b, o) {
  const f = b[o]
  if (f === undefined) throw new DeviceError(0x6a80)
  if (f < 0xfd) return [f, 1]
  if (f === 0xfd) return [b[o + 1] | (b[o + 2] << 8), 3]
  if (f === 0xfe) return [rd32le(b, o + 1), 5]
  throw new DeviceError(0x6a80)
}

class DeviceError extends Error {
  constructor(code) {
    super(`device sw ${code.toString(16)}`)
    this.code = code
  }
}
const need = (cond, code = 0x6a80) => {
  if (!cond) throw new DeviceError(code)
}

// --- merkle (doc/merkle.md), written independently --------------------------
const leaf = (d) => sha256(cat(Uint8Array.of(0), d))
const node = (l, r) => sha256(cat(Uint8Array.of(1), l, r))
const lpow2 = (n) => {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}
/** Fold a leaf-to-root proof back to the root, tree shape from (size, index). */
function proofRoot(leafHash, index, size, proof) {
  const sides = [] // top-down: true = we are on the left
  let lo = 0
  let hi = size
  while (hi - lo > 1) {
    const mid = lo + lpow2(hi - lo)
    if (index < mid) {
      sides.push(true)
      hi = mid
    } else {
      sides.push(false)
      lo = mid
    }
  }
  if (sides.length !== proof.length) throw new DeviceError(0xb007)
  let h = leafHash
  for (let d = 0; d < proof.length; d++) {
    const left = sides[sides.length - 1 - d]
    h = left ? node(h, proof[d]) : node(proof[d], h)
  }
  return h
}

// --- BIP143 (written from the BIP) -------------------------------------------
function bip143({ version, outpoints, sequences, outputsSer, outpoint, scriptCode, amount, sequence, lockTime }) {
  const hashPrevouts = dsha(cat(...outpoints))
  const hashSequence = dsha(cat(...sequences.map(le32)))
  const hashOutputs = dsha(outputsSer)
  return dsha(
    cat(le32(version), hashPrevouts, hashSequence, outpoint, cs(scriptCode.length), scriptCode, le64(amount), le32(sequence), hashOutputs, le32(lockTime), le32(1)),
  )
}

// --- legacy tx parsing (witness-free) ------------------------------------------
function parseTx(b) {
  let o = 0
  const take = (n) => {
    if (o + n > b.length) throw new RangeError('short')
    const s = b.subarray(o, o + n)
    o += n
    return s
  }
  const vi = () => {
    if (o >= b.length) throw new RangeError('short')
    const [v, n] = rdcs(b, o)
    o += n
    return v
  }
  const version = rd32le(take(4), 0)
  const nIn = vi()
  const inputs = []
  for (let i = 0; i < nIn; i++) {
    const outpoint = take(36)
    const script = take(vi())
    inputs.push({ outpoint, script, sequence: rd32le(take(4), 0) })
  }
  const nOut = vi()
  const outputs = []
  for (let i = 0; i < nOut; i++) {
    const amount = rd64le(take(8), 0)
    outputs.push({ amount, script: take(vi()) })
  }
  const lockTime = rd32le(take(4), 0)
  return { version, inputs, outputs, lockTime, consumed: o }
}
const serOutputs = (outputs) => cat(...outputs.map((x) => cat(le64(x.amount), cs(x.script.length), x.script)))

export class LedgerEmulator {
  constructor({ mnemonic, app = 'Bitcoin', version, network, coinType = 0, testnet = false, tamper = null }) {
    this.app = app
    this.version = version ?? (app === 'Litecoin' ? '2.4.13' : '2.3.0')
    this.network = network
    this.coinType = coinType
    this.testnet = testnet
    const seed = mnemonicToSeedSync(mnemonic)
    this.root = HDKey.fromMasterSeed(seed, testnet ? { private: 0x04358394, public: 0x043587cf } : undefined)
    this.fingerprint = this.root.identifier.slice(0, 4)
    this.secret = crypto.getRandomValues(new Uint8Array(32))
    this.screens = []
    this.approve = true
    this.locked = false
    this.tamper = tamper
    this.apdus = 0
    this.pending = null
    this.emit = null
    this.legacy = {}
  }

  key(path) {
    let n = this.root
    for (const i of path) n = n.deriveChild(i)
    return n
  }

  /** A LedgerTransport whose bytes go through both framings. */
  transport() {
    const dev = this
    return {
      kind: 'emulator',
      async exchange(apdu) {
        const channel = 0x0101 + (dev.apdus % 7)
        const req = dev.unframe(makeFrames(apdu, channel), channel)
        const reply = await dev.handle(req)
        const reader = new FrameReader(channel)
        let out = null
        for (const f of dev.frame(reply, channel)) out = reader.push(f)
        return out
      },
      async close() {},
    }
  }

  // Device-side framing, independent of the host's.
  unframe(frames, channel) {
    let data = new Uint8Array(0)
    let len = -1
    frames.forEach((f, seq) => {
      need(f.length === 64 && ((f[0] << 8) | f[1]) === channel && f[2] === 5 && ((f[3] << 8) | f[4]) === seq, 0x6a80)
      if (seq === 0) {
        len = (f[5] << 8) | f[6]
        data = cat(data, f.subarray(7))
      } else data = cat(data, f.subarray(5))
    })
    return data.subarray(0, len)
  }

  frame(reply, channel) {
    const payload = cat(Uint8Array.of(reply.length >> 8, reply.length & 255), reply)
    const frames = []
    for (let seq = 0, off = 0; off < payload.length || seq === 0; seq++, off += 59) {
      const f = new Uint8Array(64)
      f.set([channel >> 8, channel & 255, 5, seq >> 8, seq & 255])
      f.set(payload.subarray(off, off + 59), 5)
      frames.push(f)
    }
    return frames
  }

  async handle(apdu) {
    this.apdus++
    const [cla, ins, p1, p2, lc] = apdu
    const data = apdu.subarray(5, 5 + lc)
    if (apdu.length !== 5 + lc) return sw(0x6a87)
    if (this.locked) return sw(0x5515)
    if (this.pending) {
      // only CONTINUE is legal while a command is interrupted
      if (cla !== 0xf8 || ins !== 0x01 || p1 !== 0 || p2 !== 1) return sw(0x6e00)
      return new Promise((resolve) => {
        this.emit = resolve
        const p = this.pending
        this.pending = null
        p(data.slice())
      })
    }
    try {
      if (cla === 0xb0 && ins === 0x01) {
        const name = ascii(this.app)
        const ver = ascii(this.version)
        return cat(Uint8Array.of(1, name.length), name, Uint8Array.of(ver.length), ver, Uint8Array.of(1, 0), sw(0x9000))
      }
      if (this.app === 'BOLOS') return sw(0x6e00)
      if (cla === 0xe1 && (this.app === 'Bitcoin' || this.app === 'Bitcoin Test')) return await this.btc(ins, p1, p2, data)
      if (cla === 0xe0 && this.app === 'Litecoin') return this.legacyCmd(ins, p1, p2, data)
      return sw(0x6e00)
    } catch (e) {
      if (e instanceof DeviceError) return sw(e.code)
      throw e
    }
  }

  // ---- Bitcoin app -----------------------------------------------------------
  interruptible(fn) {
    return new Promise((resolve) => {
      this.emit = resolve
      const ask = (req) =>
        new Promise((answer) => {
          this.pending = answer
          const emit = this.emit
          this.emit = null
          emit(cat(req, sw(0xe000)))
        })
      fn(ask).then(
        (result) => {
          const emit = this.emit
          this.emit = null
          this.pending = null
          emit(cat(result, sw(0x9000)))
        },
        (e) => {
          const emit = this.emit
          this.emit = null
          this.pending = null
          emit(sw(e instanceof DeviceError ? e.code : 0xb007))
        },
      )
    })
  }

  async btc(ins, p1, p2, data) {
    need(p1 === 0 && p2 === 1, 0x6a86)
    const coin = this.app === 'Bitcoin Test' ? 1 : 0
    if (ins === 0x05) return cat(this.fingerprint, sw(0x9000))
    if (ins === 0x00) {
      const n = data[1]
      need(data.length === 2 + 4 * n && n <= 8)
      const path = Array.from({ length: n }, (_, i) => rd32be(data, 2 + 4 * i))
      need(path[0] === 84 + H && path[1] === coin + H, 0x6a86) // standard paths only in this emulator
      return cat(ascii(this.key(path).publicExtendedKey), sw(0x9000))
    }
    if (ins === 0x03) {
      need(data.length === 70)
      return this.interruptible(async (ask) => {
        const pol = await this.readPolicy(ask, data.subarray(1, 33), data.subarray(33, 65), coin)
        const change = data[65]
        const index = rd32be(data, 66)
        need(change <= 1 && index <= 50000)
        const pub = this.key([...pol.path, change, index]).publicKey
        const address = p2wpkh(pub, this.network).address
        if (data[0] === 1) {
          this.screens.push({ kind: 'address', address })
          if (!this.approve) throw new DeviceError(0x6985)
        }
        return ascii(address)
      })
    }
    if (ins === 0x04) return this.interruptible((ask) => this.signPsbt(ask, data, coin))
    return sw(0x6d00)
  }

  async preimage(ask, hash) {
    const r = await ask(cat(Uint8Array.of(0x40, 0x00), hash))
    const [len, n] = rdcs(r, 0)
    const b = r[n]
    let got = r.slice(n + 1, n + 1 + b)
    need(got.length === b && r.length === n + 1 + b, 0xb007)
    while (got.length < len) {
      const m = await ask(Uint8Array.of(0xa0))
      const count = m[0]
      const size = m[1]
      need(size === 1 && m.length === 2 + count, 0xb007)
      got = cat(got, m.subarray(2))
    }
    need(got.length === len && eq(sha256(got), hash), 0xb008)
    return got
  }

  async leafHashAt(ask, root, size, index) {
    const r = await ask(cat(Uint8Array.of(0x41), root, cs(size), cs(index)))
    const lh = r.slice(0, 32)
    const total = r[32]
    const first = r[33]
    need(r.length === 34 + 32 * first, 0xb007)
    const proof = []
    for (let i = 0; i < first; i++) proof.push(r.slice(34 + 32 * i, 66 + 32 * i))
    while (proof.length < total) {
      const m = await ask(Uint8Array.of(0xa0))
      need(m[1] === 32 && m.length === 2 + 32 * m[0], 0xb007)
      for (let i = 0; i < m[0]; i++) proof.push(m.slice(2 + 32 * i, 34 + 32 * i))
    }
    need(eq(proofRoot(lh, index, size, proof), root), 0xb008)
    return lh
  }

  async element(ask, root, size, index) {
    const lh = await this.leafHashAt(ask, root, size, index)
    const p = await this.preimage(ask, lh)
    need(p[0] === 0, 0xb008)
    return p.subarray(1)
  }

  /** Materialize a merkleized map (every entry proof-checked). */
  async readMap(ask, commitment) {
    const [n, used] = rdcs(commitment, 0)
    need(commitment.length === used + 64, 0xb007)
    const kr = commitment.subarray(used, used + 32)
    const vr = commitment.subarray(used + 32, used + 64)
    const map = new Map()
    let prev = null
    for (let i = 0; i < n; i++) {
      const k = await this.element(ask, kr, n, i)
      need(prev === null || hex(prev) < hex(k), 0xb007) // strictly sorted
      prev = k
      map.set(hex(k), await this.element(ask, vr, n, i))
    }
    if (n > 0) {
      // exercise GET_MERKLE_LEAF_INDEX the way the app does for lookups
      const firstKey = unhex([...map.keys()][0])
      const r = await ask(cat(Uint8Array.of(0x42), kr, leaf(firstKey)))
      const [idx] = rdcs(r, 1)
      need(r[0] === 1 && idx === 0, 0xb007)
      const miss = await ask(cat(Uint8Array.of(0x42), kr, leaf(Uint8Array.of(0xee, 0xee))))
      need(miss[0] === 0, 0xb007)
    }
    return map
  }

  async readPolicy(ask, walletId, walletHmac, coin) {
    need(walletHmac.every((x) => x === 0), 0x6a80) // only default policies here
    const ser = await this.preimage(ask, walletId)
    let o = 0
    need(ser[o++] === 0x02)
    const nameLen = ser[o++]
    need(nameLen === 0, 0x6a80) // default wallets have no name
    const [tlen, a] = rdcs(ser, o)
    o += a
    const thash = ser.subarray(o, o + 32)
    o += 32
    const [nkeys, b] = rdcs(ser, o)
    o += b
    const keysRoot = ser.subarray(o, o + 32)
    need(o + 32 === ser.length && nkeys === 1)
    const template = new TextDecoder().decode(await this.preimage(ask, thash))
    need(template.length === tlen && template === 'wpkh(@0/**)', 0x6a80)
    const keyInfo = new TextDecoder().decode(await this.element(ask, keysRoot, 1, 0))
    const m = /^\[([0-9a-f]{8})\/84'\/(\d+)'\/(\d+)'\]([1-9A-HJ-NP-Za-km-z]+)$/.exec(keyInfo)
    need(m !== null, 0x6a80)
    const [, fp, c, acct, xpub] = m
    need(fp === hex(this.fingerprint) && Number(c) === coin && Number(acct) <= 100, 0x6a80)
    const path = [84 + H, coin + H, Number(acct) + H]
    need(xpub === this.key(path).publicExtendedKey, 0x6a80)
    return { path }
  }

  async signPsbt(ask, data, coin) {
    let o = 0
    const [gn, g1] = rdcs(data, o)
    const globalCommit = data.subarray(o, o + g1 + 64)
    o += g1 + 64
    void gn
    const [nIn, a] = rdcs(data, o)
    o += a
    const inRoot = data.subarray(o, o + 32)
    o += 32
    const [nOut, b] = rdcs(data, o)
    o += b
    const outRoot = data.subarray(o, o + 32)
    o += 32
    const walletId = data.subarray(o, o + 32)
    const walletHmac = data.subarray(o + 32, o + 64)
    need(o + 64 === data.length)
    const pol = await this.readPolicy(ask, walletId, walletHmac, coin)

    const g = await this.readMap(ask, globalCommit)
    const gget = (t) => g.get(hex(Uint8Array.of(t)))
    need(rd32le(gget(0xfb), 0) === 2 && rdcs(gget(0x04), 0)[0] === nIn && rdcs(gget(0x05), 0)[0] === nOut)
    const version = rd32le(gget(0x02), 0)
    const lockTime = gget(0x03) ? rd32le(gget(0x03), 0) : 0

    const ins = []
    for (let i = 0; i < nIn; i++) {
      const m = await this.readMap(ask, await this.element(ask, inRoot, nIn, i))
      const get = (t) => m.get(hex(Uint8Array.of(t)))
      const prevTxid = get(0x0e)
      const vout = rd32le(get(0x0f), 0)
      const sequence = get(0x10) ? rd32le(get(0x10), 0) : 0xffffffff
      const wu = get(0x01)
      const amount = rd64le(wu, 0)
      const [sl, sn] = rdcs(wu, 8)
      const script = wu.subarray(8 + sn, 8 + sn + sl)
      // strict: the full previous tx must be there and agree (segwit fee attack)
      const nwu = get(0x00)
      need(nwu !== undefined, 0x6a80)
      need(eq(dsha(nwu), prevTxid), 0xb008)
      const prev = parseTx(nwu)
      need(prev.consumed === nwu.length && prev.outputs[vout] && prev.outputs[vout].amount === amount && eq(prev.outputs[vout].script, script), 0xb008)
      const derivs = [...m.entries()].filter(([k]) => k.startsWith('06'))
      need(derivs.length === 1, 0x6a80)
      const [dk, dv] = derivs[0]
      const pub = unhex(dk.slice(2))
      need(eq(dv.subarray(0, 4), this.fingerprint), 0x6a80)
      const path = Array.from({ length: (dv.length - 4) / 4 }, (_, j) => rd32le(dv, 4 + 4 * j))
      need(path.length === 5 && path.slice(0, 3).every((x, j) => x === pol.path[j]) && path[3] <= 1, 0x6a80)
      const k = this.key(path)
      need(eq(k.publicKey, pub) && eq(p2wpkh(pub, this.network).script, script), 0x6a80)
      ins.push({ outpoint: cat(prevTxid, le32(vout)), amount, sequence, key: k })
    }
    const outs = []
    const shown = []
    for (let j = 0; j < nOut; j++) {
      const m = await this.readMap(ask, await this.element(ask, outRoot, nOut, j))
      const amount = rd64le(m.get('03'), 0)
      const script = m.get('04')
      outs.push({ amount, script })
      const d = [...m.entries()].find(([k]) => k.startsWith('02'))
      let isChange = false
      if (d) {
        const [dk, dv] = d
        const path = Array.from({ length: (dv.length - 4) / 4 }, (_, i) => rd32le(dv, 4 + 4 * i))
        const derived = path.length === 5 ? this.key(path).publicKey : null
        isChange =
          eq(dv.subarray(0, 4), this.fingerprint) &&
          path.length === 5 &&
          path.slice(0, 3).every((x, i) => x === pol.path[i]) &&
          path[3] === 1 &&
          eq(derived, unhex(dk.slice(2))) &&
          eq(p2wpkh(derived, this.network).script, script)
      }
      if (!isChange) shown.push({ address: Address(this.network).encode(OutScript.decode(script)), amount })
    }
    const fee = ins.reduce((s, x) => s + x.amount, 0n) - outs.reduce((s, x) => s + x.amount, 0n)
    need(fee >= 0n, 0x6a80)
    this.screens.push({ kind: 'tx', outputs: shown, fee })
    if (!this.approve) throw new DeviceError(0x6985)

    const outputsSer = serOutputs(outs)
    for (let i = 0; i < ins.length; i++) {
      const x = ins[i]
      let digest = bip143({
        version,
        outpoints: ins.map((y) => y.outpoint),
        sequences: ins.map((y) => y.sequence),
        outputsSer,
        outpoint: x.outpoint,
        scriptCode: p2pkh(x.key.publicKey).script,
        amount: x.amount,
        sequence: x.sequence,
        lockTime,
      })
      if (this.tamper === 'digest') digest = sha256(digest)
      const sig = secp256k1.sign(digest, x.key.privateKey, { lowS: true })
      const ack = await ask(cat(Uint8Array.of(0x10), cs(i), Uint8Array.of(33), x.key.publicKey, sig.toDERRawBytes(), Uint8Array.of(1)))
      need(ack.length === 0, 0xb007)
    }
    return new Uint8Array(0)
  }

  // ---- Litecoin legacy app -----------------------------------------------------
  legacyPath(data, off = 0) {
    const n = data[off]
    need(n <= 10 && data.length >= off + 1 + 4 * n)
    const path = Array.from({ length: n }, (_, i) => rd32be(data, off + 1 + 4 * i))
    // the app's derivation lock: */2'
    need(path.length < 2 || path[1] === this.coinType + H, 0x6982)
    return { path, next: off + 1 + 4 * n }
  }

  legacyCmd(ins, p1, p2, data) {
    const L = this.legacy
    if (ins === 0x40) {
      const { path } = this.legacyPath(data)
      const k = this.key(path)
      const uncompressed = secp256k1.ProjectivePoint.fromHex(k.publicKey).toRawBytes(false)
      const address = p2 === 2 ? p2wpkh(k.publicKey, this.network).address : p2pkh(k.publicKey, this.network).address
      if (p1 === 1) {
        this.screens.push({ kind: 'address', address })
        if (!this.approve) return sw(0x6985)
      }
      const a = ascii(address)
      return cat(Uint8Array.of(65), uncompressed, Uint8Array.of(a.length), a, k.chainCode, sw(0x9000))
    }
    if (ins === 0x42) {
      if (p1 === 0x00) {
        L.ti = { index: rd32be(data, 0), buf: data.slice(4) }
      } else {
        need(L.ti, 0x6985)
        L.ti.buf = cat(L.ti.buf, data)
      }
      let tx = null
      try {
        tx = parseTx(L.ti.buf)
      } catch {
        tx = null
      }
      if (tx === null || tx.consumed !== L.ti.buf.length) return sw(0x9000)
      const out = tx.outputs[L.ti.index]
      need(out !== undefined)
      let amount = out.amount
      if (this.tamper === 'trusted-amount') amount += 1n
      const body = cat(Uint8Array.of(0x32, 0x00), crypto.getRandomValues(new Uint8Array(2)), dsha(L.ti.buf), le32(L.ti.index), le64(amount))
      L.ti = null
      return cat(body, hmac(sha256, this.secret, body).subarray(0, 8), sw(0x9000))
    }
    if (ins === 0x44) {
      if (p1 === 0x00) {
        need(p2 === 0x02 || p2 === 0x80, 0x6a86)
        const [n, used] = rdcs(data, 4)
        L.h = { version: rd32le(data, 0), n, buf: data.slice(4 + used), inputs: [], second: p2 === 0x80 }
        if (p2 === 0x02) L.first = null
      } else {
        need(L.h && (p2 === 0x02) === !L.h.second, 0x6a86)
        L.h.buf = cat(L.h.buf, data)
      }
      // consume as many complete inputs as are buffered
      for (;;) {
        const b = L.h.buf
        if (b.length < 2) break
        need(b[0] === 0x01, 0x6a80) // trusted inputs only (segwit, app ≥ 1.4)
        const tl = b[1]
        if (b.length < 2 + tl + 1) break
        const ti = b.subarray(2, 2 + tl)
        const [sl, sn] = rdcs(b, 2 + tl)
        const end = 2 + tl + sn + sl + 4
        if (b.length < end) break
        need(tl === 56 && ti[0] === 0x32 && eq(hmac(sha256, this.secret, ti.subarray(0, 48)).subarray(0, 8), ti.subarray(48)), 0x6a80)
        L.h.inputs.push({
          outpoint: ti.slice(4, 40),
          amount: rd64le(ti, 40),
          script: b.slice(2 + tl + sn, 2 + tl + sn + sl),
          sequence: rd32le(b, 2 + tl + sn + sl),
        })
        L.h.buf = b.slice(end)
      }
      need(L.h.inputs.length <= L.h.n)
      return sw(0x9000)
    }
    if (ins === 0x4a) {
      need(L.h && !L.h.second && L.h.inputs.length === L.h.n, 0x6985)
      if (p1 === 0xff) {
        L.changePath = this.legacyPath(data).path
        return cat(Uint8Array.of(0x00), sw(0x9000))
      }
      L.obuf = cat(L.obuf ?? new Uint8Array(0), data)
      if (p1 === 0x00) return cat(Uint8Array.of(0x00), sw(0x9000))
      need(p1 === 0x80, 0x6a86)
      const ob = L.obuf
      L.obuf = null
      const [n, used] = rdcs(ob, 0)
      let o = used
      const outs = []
      for (let i = 0; i < n; i++) {
        const amount = rd64le(ob, o)
        const [sl, sn] = rdcs(ob, o + 8)
        outs.push({ amount, script: ob.slice(o + 8 + sn, o + 8 + sn + sl) })
        o += 8 + sn + sl
      }
      need(o === ob.length)
      const changeScript = L.changePath ? p2wpkh(this.key(L.changePath).publicKey, this.network).script : null
      const shown = outs
        .filter((x) => !(changeScript && eq(x.script, changeScript)))
        .map((x) => ({ address: Address(this.network).encode(OutScript.decode(x.script)), amount: x.amount }))
      const fee = L.h.inputs.reduce((s, x) => s + x.amount, 0n) - outs.reduce((s, x) => s + x.amount, 0n)
      this.screens.push({ kind: 'tx', outputs: shown, fee })
      L.changePath = null
      if (!this.approve) {
        L.h = null
        return sw(0x6985)
      }
      L.first = { version: L.h.version, inputs: L.h.inputs, outputsSer: serOutputs(outs) }
      return cat(Uint8Array.of(0x00, 0x00), sw(0x9000))
    }
    if (ins === 0x48) {
      need(L.first && L.h && L.h.second && L.h.inputs.length === 1, 0x6985)
      const { path, next } = this.legacyPath(data)
      need(data[next] === 0x00 && data.length === next + 6)
      const lockTime = rd32be(data, next + 1)
      need(data[next + 5] === 0x01, 0x6a80)
      const x = L.h.inputs[0]
      need(L.first.inputs.some((y) => eq(y.outpoint, x.outpoint)) && L.h.version === L.first.version, 0x6a80)
      let digest = bip143({
        version: L.first.version,
        outpoints: L.first.inputs.map((y) => y.outpoint),
        sequences: L.first.inputs.map((y) => y.sequence),
        outputsSer: L.first.outputsSer,
        outpoint: x.outpoint,
        scriptCode: x.script,
        amount: x.amount,
        sequence: x.sequence,
        lockTime,
      })
      if (this.tamper === 'digest') digest = sha256(digest)
      const sig = secp256k1.sign(digest, this.key(path).privateKey, { lowS: true })
      const der = sig.toDERRawBytes()
      der[0] = 0x30 | (sig.recovery & 1) // the device's parity flag
      L.h = null
      return cat(der, Uint8Array.of(1), sw(0x9000))
    }
    return sw(0x6d00)
  }
}

/** An independent BIP84 address helper for tests. */
export function hash160(b) {
  return ripemd160(sha256(b))
}
