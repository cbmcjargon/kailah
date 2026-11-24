// Kailah Wallet marketing site: the wallet's own checks, for the demo (rob/).
// The lookalike check and the TRON decoder follow src/lib/lookalike.ts and
// src/lib/tron.ts line for line, and a Dogecoin coin's ID is rawtxcache.ts's
// double SHA-256; every refusal carries the wallet's own message. The `why`
// notes are the page's own and change no verdict. scripts/check-sitedemo.mjs
// runs all of it beside the real modules on every change and fails on any
// difference. The rest (encoders, made-up addresses, the staged attacks)
// only sets the scene. No network, no storage, no HTML sinks.
;(function (root) {
  'use strict'

  // ---------------------------------------------------------------- bytes
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
  function unhex(h) {
    if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error('bad hex')
    const o = new Uint8Array(h.length / 2)
    for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    return o
  }
  function concat(...parts) {
    const n = parts.reduce((s, p) => s + p.length, 0)
    const o = new Uint8Array(n)
    let at = 0
    for (const p of parts) {
      o.set(p, at)
      at += p.length
    }
    return o
  }
  const utf8 = (s) => new TextEncoder().encode(s)
  function randomBytes(n) {
    const o = new Uint8Array(n)
    root.crypto.getRandomValues(o)
    return o
  }

  // --------------------------------------------------------------- SHA-256
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  function sha256(msg) {
    const H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ])
    const len = msg.length
    const total = Math.ceil((len + 9) / 64) * 64
    const buf = new Uint8Array(total)
    buf.set(msg)
    buf[len] = 0x80
    const dv = new DataView(buf.buffer)
    dv.setUint32(total - 4, (len * 8) >>> 0)
    dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000))
    const W = new Uint32Array(64)
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4)
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
        h = g
        g = f
        f = e
        e = (d + t1) >>> 0
        d = c
        c = b
        b = a
        a = (t1 + t2) >>> 0
      }
      H[0] = (H[0] + a) >>> 0
      H[1] = (H[1] + b) >>> 0
      H[2] = (H[2] + c) >>> 0
      H[3] = (H[3] + d) >>> 0
      H[4] = (H[4] + e) >>> 0
      H[5] = (H[5] + f) >>> 0
      H[6] = (H[6] + g) >>> 0
      H[7] = (H[7] + h) >>> 0
    }
    const out = new Uint8Array(32)
    const odv = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i])
    return out
  }

  // ---------------------------------------------------------------- base58
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  function b58encode(bytes) {
    let zeros = 0
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++
    let n = 0n
    for (const b of bytes) n = (n << 8n) | BigInt(b)
    let s = ''
    while (n > 0n) {
      s = B58[Number(n % 58n)] + s
      n /= 58n
    }
    return '1'.repeat(zeros) + s
  }
  function b58decode(str) {
    let n = 0n
    for (const ch of str) {
      const i = B58.indexOf(ch)
      if (i < 0) return null
      n = n * 58n + BigInt(i)
    }
    const bytes = []
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn))
      n >>= 8n
    }
    let zeros = 0
    while (zeros < str.length && str[zeros] === '1') zeros++
    return new Uint8Array([...new Array(zeros).fill(0), ...bytes])
  }
  const b58checkEncode = (payload) => b58encode(concat(payload, sha256(sha256(payload)).slice(0, 4)))

  // Made-up addresses for the demo: random bytes, never anyone's real account.
  const madeUp = {
    sol: () => b58encode(randomBytes(32)),
    tron: () => b58checkEncode(concat(new Uint8Array([0x41]), randomBytes(20))),
    evm: () => '0x' + hex(randomBytes(20)),
  }

  // ------------------------------------------- lookalike.ts, line for line
  const ONE_END_BASE58 = { start: 4, end: 4 }
  const ONE_END_HEX = { start: 6, end: 6 }
  const EVM_FORMAT = {
    caseInsensitive: true,
    fixedPrefix: (a) => (/^0x/i.test(a) ? 2 : 0),
    oneEnd: () => ONE_END_HEX,
  }
  const TRON_FORMAT = {
    caseInsensitive: false,
    fixedPrefix: (a) => (a.startsWith('T') ? 1 : 0),
    oneEnd: () => ONE_END_BASE58,
  }
  const SOL_FORMAT = {
    caseInsensitive: false,
    fixedPrefix: () => 0,
    oneEnd: () => ONE_END_BASE58,
  }
  const LOOKALIKE_MIN = 3

  function normalize(address, format) {
    const a = address.trim()
    return format.caseInsensitive || (format.foldCase !== undefined && format.foldCase(a) === true)
      ? a.toLowerCase()
      : a
  }
  function body(address, format) {
    const n = normalize(address, format)
    const skip = format.fixedPrefix(n)
    return { text: n.slice(skip), skip, one: format.oneEnd(n) }
  }
  function overlap(a, b) {
    const max = Math.min(a.length, b.length)
    let start = 0
    while (start < max && a[start] === b[start]) start++
    let end = 0
    while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    return { start, end }
  }
  const PRIORITY = { contact: 0, sent: 1, own: 2, other: 3 }

  function findLookalike(candidate, known, format) {
    const cand = body(candidate, format)
    if (cand.text.length < LOOKALIKE_MIN * 2) return null
    const same = (k) => body(k.address, format).text === cand.text
    if (known.some((k) => k.relation !== 'other' && same(k))) return null
    const seenIncoming = known.some((k) => k.relation === 'other' && same(k))
    let best = null
    for (const k of known) {
      const kb = body(k.address, format)
      if (kb.text === cand.text) continue
      const { start, end } = overlap(cand.text, kb.text)
      const both = start >= LOOKALIKE_MIN && end >= LOOKALIKE_MIN
      if (!both && start < cand.one.start && end < cand.one.end) continue
      const match = {
        known: k.address,
        relation: k.relation,
        ...(k.name !== undefined && { name: k.name }),
        seenIncoming,
        sameStart: cand.skip + start,
        sameEnd: end,
        ends: both ? 'both' : start >= cand.one.start ? 'start' : 'end',
      }
      if (
        best === null ||
        PRIORITY[match.relation] < PRIORITY[best.relation] ||
        (PRIORITY[match.relation] === PRIORITY[best.relation] &&
          match.sameStart + match.sameEnd > best.sameStart + best.sameEnd)
      ) {
        best = match
      }
    }
    return best
  }

  const SAYS_FIRST = { contact: 0, own: 1, sent: 2, other: 3 }
  function findKnown(candidate, known, format) {
    const cand = body(candidate, format)
    if (cand.text === '') return null
    let best = null
    for (const k of known) {
      if (k.relation === 'other' || body(k.address, format).text !== cand.text) continue
      if (best === null || SAYS_FIRST[k.relation] < SAYS_FIRST[best.relation]) best = k
    }
    return best
  }

  function knownAddresses(own, counterparties, sentTo, contacts = []) {
    const out = []
    const taken = new Set()
    for (const c of contacts) {
      if (taken.has(c.address)) continue
      taken.add(c.address)
      out.push({ address: c.address, relation: 'contact', name: c.name })
    }
    for (const address of own) {
      if (taken.has(address)) continue
      taken.add(address)
      out.push({ address, relation: 'own' })
    }
    for (const address of sentTo) {
      if (taken.has(address)) continue
      taken.add(address)
      out.push({ address, relation: 'sent' })
    }
    for (const address of counterparties) {
      if (!address || taken.has(address)) continue
      taken.add(address)
      out.push({ address, relation: 'other' })
    }
    return out
  }

  // ------------------------------------------------ tron.ts, line for line
  const UNEXPECTED =
    'The transaction bytes the node returned contain unexpected or duplicate fields — refusing to sign them. Nothing was sent.'
  const CLOCK_OR_NODE =
    "The transaction's expiry is more than 10 minutes away from this device's clock. If the clock is wrong, set it to update automatically and try again; otherwise the network node is misbehaving. Nothing was signed."
  const MISMATCH =
    'The transaction the network node returned does not match your request — refusing to sign it. Nothing was sent and your coins are untouched.'
  const TRON_MAX_EXPIRATION_MS = 10 * 60_000

  function refuse(message, check, why) {
    const e = new Error(message)
    e.check = check
    e.why = why
    return e
  }

  function readVarint(buf, pos) {
    let value = 0n
    let shift = 0n
    let p = pos
    for (;;) {
      if (p >= buf.length) throw refuse('truncated varint', 'fields', 'the bytes end inside a number')
      const b = buf[p]
      value |= BigInt(b & 0x7f) << shift
      p += 1
      if ((b & 0x80) === 0) break
      shift += 7n
      if (shift > 70n) throw refuse('varint too long', 'fields', 'a number longer than any field allows')
    }
    return { value, next: p }
  }

  function readFields(buf) {
    const out = []
    let p = 0
    while (p < buf.length) {
      const tag = readVarint(buf, p)
      const num = Number(tag.value >> 3n)
      const wire = Number(tag.value & 7n)
      p = tag.next
      if (wire === 0) {
        const v = readVarint(buf, p)
        out.push({ num, wire, varint: v.value })
        p = v.next
      } else if (wire === 2) {
        const len = readVarint(buf, p)
        const start = len.next
        const end = start + Number(len.value)
        if (end > buf.length) throw refuse('truncated length-delimited field', 'fields', 'a field runs past the end')
        out.push({ num, wire, bytes: buf.slice(start, end) })
        p = end
      } else if (wire === 5) {
        out.push({ num, wire })
        p += 4
      } else if (wire === 1) {
        out.push({ num, wire })
        p += 8
      } else {
        throw refuse(`unsupported protobuf wire type ${wire}`, 'fields', `wire type ${wire}`)
      }
    }
    return out
  }

  const TYPE_BY_ENUM = new Map([
    [1n, 'TransferContract'],
    [31n, 'TriggerSmartContract'],
    [4n, 'VoteWitnessContract'],
    [13n, 'WithdrawBalanceContract'],
    [54n, 'FreezeBalanceV2Contract'],
    [55n, 'UnfreezeBalanceV2Contract'],
    [56n, 'WithdrawExpireUnfreezeContract'],
  ])

  function addrFromBytes(b) {
    if (!b || b.length !== 21 || b[0] !== 0x41) return null
    return b58checkEncode(b)
  }

  function fieldsOnce(fields, spec, where) {
    const out = new Map()
    for (const f of fields) {
      if (spec[f.num] !== f.wire || out.has(f.num)) {
        throw refuse(
          UNEXPECTED,
          'fields',
          spec[f.num] !== f.wire
            ? `${where} carries field ${f.num}, which a payment never has`
            : `${where} carries field ${f.num} twice (the chain would use the last copy)`,
        )
      }
      out.set(f.num, f)
    }
    return out
  }

  const INNER_SPEC = {
    TransferContract: { 1: 2, 2: 2, 3: 0 },
    TriggerSmartContract: { 1: 2, 2: 2, 3: 0, 4: 2, 5: 0, 6: 0 },
    WithdrawBalanceContract: { 1: 2 },
    FreezeBalanceV2Contract: { 1: 2, 2: 0, 3: 0 },
    UnfreezeBalanceV2Contract: { 1: 2, 2: 0, 3: 0 },
    WithdrawExpireUnfreezeContract: { 1: 2 },
  }

  function decodeResource(v) {
    if (v === 0n) return 'BANDWIDTH'
    if (v === 1n) return 'ENERGY'
    throw refuse(UNEXPECTED, 'fields', 'an unknown resource code')
  }

  function decodeContract(bytes) {
    const c = fieldsOnce(readFields(bytes), { 1: 0, 2: 2 }, 'The contract')
    const typeField = c.get(1)
    const paramField = c.get(2)
    if (typeField?.varint === undefined || !paramField?.bytes) {
      throw refuse(UNEXPECTED, 'fields', 'the contract has no type or no parameter')
    }
    const type = TYPE_BY_ENUM.get(typeField.varint) ?? 'other'
    const empty = {
      owner: null,
      to: null,
      amount: 0n,
      contractAddress: null,
      dataHex: null,
      callValue: 0n,
      callTokenValue: 0n,
      tokenId: 0n,
      resource: null,
      votes: null,
    }
    if (type === 'other') return { type, ...empty }
    const any = fieldsOnce(readFields(paramField.bytes), { 1: 2, 2: 2 }, 'The contract parameter')
    const typeUrl = new TextDecoder().decode(any.get(1)?.bytes ?? new Uint8Array())
    const valueBytes = any.get(2)?.bytes
    if (!valueBytes || !typeUrl.endsWith(`/protocol.${type}`)) {
      throw refuse(UNEXPECTED, 'fields', `the contract says ${type} but its contents are ${typeUrl.split('.').pop() || 'missing'}`)
    }
    if (type === 'VoteWitnessContract') {
      let owner = null
      let ownerSeen = false
      const votes = []
      for (const f of readFields(valueBytes)) {
        if (f.num === 1 && f.wire === 2 && !ownerSeen) {
          ownerSeen = true
          owner = addrFromBytes(f.bytes)
        } else if (f.num === 2 && f.wire === 2 && f.bytes) {
          const vf = fieldsOnce(readFields(f.bytes), { 1: 2, 2: 0 }, 'A vote')
          const addr = addrFromBytes(vf.get(1)?.bytes)
          if (addr === null) throw refuse(UNEXPECTED, 'fields', 'a vote for no address')
          votes.push({ address: addr, count: vf.get(2)?.varint ?? 0n })
        } else {
          throw refuse(UNEXPECTED, 'fields', `the vote carries field ${f.num}`)
        }
      }
      return { type, ...empty, owner, votes }
    }
    const inner = fieldsOnce(readFields(valueBytes), INNER_SPEC[type], `The ${type}`)
    const isStakeAmount =
      type === 'TransferContract' || type === 'FreezeBalanceV2Contract' || type === 'UnfreezeBalanceV2Contract'
    return {
      type,
      ...empty,
      owner: addrFromBytes(inner.get(1)?.bytes),
      to: type === 'TransferContract' ? addrFromBytes(inner.get(2)?.bytes) : null,
      amount: isStakeAmount ? (inner.get(type === 'TransferContract' ? 3 : 2)?.varint ?? 0n) : 0n,
      contractAddress: type === 'TriggerSmartContract' ? addrFromBytes(inner.get(2)?.bytes) : null,
      dataHex: type === 'TriggerSmartContract' ? hex(inner.get(4)?.bytes ?? new Uint8Array()) : null,
      callValue: type === 'TriggerSmartContract' ? (inner.get(3)?.varint ?? 0n) : 0n,
      callTokenValue: type === 'TriggerSmartContract' ? (inner.get(5)?.varint ?? 0n) : 0n,
      tokenId: type === 'TriggerSmartContract' ? (inner.get(6)?.varint ?? 0n) : 0n,
      resource:
        type === 'FreezeBalanceV2Contract' || type === 'UnfreezeBalanceV2Contract'
          ? decodeResource(inner.get(3)?.varint ?? 0n)
          : null,
    }
  }

  function decodeTronRawTx(rawHex) {
    const fields = readFields(unhex(rawHex))
    const out = { expiration: 0n, timestamp: 0n, feeLimit: 0n, contracts: [] }
    const TOP_SPEC = { 1: 2, 3: 0, 4: 2, 8: 0, 14: 0, 18: 0 }
    const seen = new Set()
    for (const f of fields) {
      if (f.num === 11) {
        if (f.wire !== 2 || !f.bytes) throw refuse(UNEXPECTED, 'fields', 'a contract that is not a message')
        out.contracts.push(decodeContract(f.bytes))
        continue
      }
      if (TOP_SPEC[f.num] !== f.wire || seen.has(f.num)) {
        throw refuse(
          UNEXPECTED,
          'fields',
          TOP_SPEC[f.num] !== f.wire
            ? `the transaction carries field ${f.num}${f.num === 10 ? ' (a memo)' : ''}, which a payment never has`
            : `the transaction carries field ${f.num} twice`,
        )
      }
      seen.add(f.num)
      if (f.num === 8) out.expiration = f.varint ?? 0n
      if (f.num === 14) out.timestamp = f.varint ?? 0n
      if (f.num === 18) out.feeLimit = f.varint ?? 0n
    }
    return out
  }

  function assertTronEnvelope(decoded, feeLimit, now) {
    if (decoded.feeLimit !== feeLimit) {
      throw refuse(UNEXPECTED, 'envelope', `a ${Number(decoded.feeLimit) / 1e6} TRX fee limit, where a TRX payment has none`)
    }
    if (
      decoded.expiration <= BigInt(now - TRON_MAX_EXPIRATION_MS) ||
      decoded.expiration > BigInt(now + TRON_MAX_EXPIRATION_MS)
    ) {
      throw refuse(CLOCK_OR_NODE, 'envelope', 'the signature would stay valid far longer than ten minutes')
    }
  }

  function verifyTxId(rawHex, claimed) {
    const computed = hex(sha256(unhex(rawHex)))
    if (claimed !== undefined && claimed !== computed) {
      throw refuse(MISMATCH, 'id', "the transaction ID the node sent isn't the hash of the bytes")
    }
    return computed
  }

  /** prepareTronSend's TRX path, from the node's reply to the bytes it signs. */
  function checkTrxSend(reply, ownerAddress, to, amount, now) {
    if (!reply.raw_data_hex) throw refuse(MISMATCH, 'match', 'the node sent no bytes')
    const decoded = decodeTronRawTx(reply.raw_data_hex)
    assertTronEnvelope(decoded, 0n, now)
    const c = decoded.contracts[0]
    if (
      decoded.contracts.length !== 1 ||
      c === undefined ||
      c.type !== 'TransferContract' ||
      c.owner !== ownerAddress ||
      c.to !== to ||
      c.amount !== amount
    ) {
      const why =
        decoded.contracts.length !== 1
          ? `${decoded.contracts.length} contracts where you asked for one payment`
          : c.type !== 'TransferContract'
            ? `a ${c.type} where you asked for a TRX payment`
            : c.owner !== ownerAddress
              ? 'it spends from another account'
              : c.to !== to
                ? 'it pays someone else'
                : 'it moves a different amount'
      throw refuse(MISMATCH, 'match', why)
    }
    return { decoded, txID: verifyTxId(reply.raw_data_hex, reply.txID) }
  }

  // ---------------------------------------------------- protobuf, to stage
  function varint(n) {
    let v = BigInt(n)
    const out = []
    do {
      let b = Number(v & 0x7fn)
      v >>= 7n
      if (v > 0n) b |= 0x80
      out.push(b)
    } while (v > 0n)
    return out
  }
  const tag = (num, wire) => varint((BigInt(num) << 3n) | BigInt(wire))
  const pbVarint = (num, v) => [...tag(num, 0), ...varint(v)]
  const pbBytes = (num, bytes) => [...tag(num, 2), ...varint(bytes.length), ...bytes]
  const tronAddrBytes = (addr) => {
    const d = b58decode(addr)
    return Array.from(d.slice(0, 21))
  }

  function contractBytes({ type = 1, typeUrl = 'type.googleapis.com/protocol.TransferContract', value, permissionId }) {
    const any = [...pbBytes(1, Array.from(utf8(typeUrl))), ...pbBytes(2, value)]
    return [...pbVarint(1, type), ...pbBytes(2, any), ...(permissionId !== undefined ? pbVarint(5, permissionId) : [])]
  }
  const transferValue = (owner, to, amount, extraTo) => [
    ...pbBytes(1, tronAddrBytes(owner)),
    ...pbBytes(2, tronAddrBytes(to)),
    ...pbVarint(3, amount),
    ...(extraTo ? pbBytes(2, tronAddrBytes(extraTo)) : []),
  ]
  function rawTx({ refBytes, refHash, expiration, contracts, timestamp, memo, feeLimit }) {
    const out = [...pbBytes(1, refBytes), ...pbBytes(4, refHash), ...pbVarint(8, expiration)]
    if (memo !== undefined) out.push(...pbBytes(10, Array.from(utf8(memo))))
    for (const c of contracts) out.push(...pbBytes(11, c))
    out.push(...pbVarint(14, timestamp))
    if (feeLimit !== undefined) out.push(...pbVarint(18, feeLimit))
    return new Uint8Array(out)
  }

  /** Byte ranges of a raw transaction, for drawing it. Lenient: never throws. */
  function annotate(bytes) {
    const spans = []
    const NAMES = {
      top: { 1: 'ref_block_bytes', 3: 'ref_block_num', 4: 'ref_block_hash', 8: 'expiration', 9: 'auths', 10: 'data (memo)', 11: 'contract', 12: 'scripts', 14: 'timestamp', 18: 'fee_limit' },
      contract: { 1: 'type', 2: 'parameter', 3: 'provider', 4: 'ContractName', 5: 'Permission_id' },
      any: { 1: 'type_url', 2: 'value' },
      TransferContract: { 1: 'owner_address', 2: 'to_address', 3: 'amount' },
      TriggerSmartContract: { 1: 'owner_address', 2: 'contract_address', 3: 'call_value', 4: 'data', 5: 'call_token_value', 6: 'token_id' },
    }
    function walk(buf, base, level, depth) {
      let p = 0
      try {
        while (p < buf.length) {
          const start = p
          const t = readVarint(buf, p)
          const num = Number(t.value >> 3n)
          const wire = Number(t.value & 7n)
          p = t.next
          const name = (NAMES[level] && NAMES[level][num]) || `field ${num}`
          if (wire === 0) {
            const v = readVarint(buf, p)
            spans.push({ from: base + start, to: base + v.next, name, level, depth, value: v.value })
            p = v.next
          } else if (wire === 2) {
            const len = readVarint(buf, p)
            const s = len.next
            const e = Math.min(buf.length, s + Number(len.value))
            const inner = buf.slice(s, e)
            if (level === 'top' && num === 11) {
              spans.push({ from: base + start, to: base + s, name: 'contract', level, depth, head: true })
              walk(inner, base + s, 'contract', depth + 1)
            } else if (level === 'contract' && num === 2) {
              spans.push({ from: base + start, to: base + s, name: 'parameter', level, depth, head: true })
              walk(inner, base + s, 'any', depth + 1)
            } else if (level === 'any' && num === 2) {
              spans.push({ from: base + start, to: base + s, name: 'value', level, depth, head: true })
              const url = annotate.lastUrl || ''
              const inner_level = url.endsWith('TriggerSmartContract') ? 'TriggerSmartContract' : 'TransferContract'
              walk(inner, base + s, inner_level, depth + 1)
            } else {
              if (level === 'any' && num === 1) annotate.lastUrl = new TextDecoder().decode(inner)
              spans.push({ from: base + start, to: base + e, name, level, depth, bytes: inner })
            }
            p = e
          } else {
            spans.push({ from: base + start, to: base + buf.length, name: 'unreadable', level, depth })
            return
          }
        }
      } catch {
        spans.push({ from: base + p, to: base + buf.length, name: 'unreadable', level, depth })
      }
    }
    annotate.lastUrl = ''
    walk(bytes, 0, 'top', 0)
    return spans
  }

  // ------------------------------------------------------ Dogecoin, legacy
  const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
  function le64(v) {
    const out = []
    let x = BigInt(v)
    for (let i = 0; i < 8; i++) {
      out.push(Number(x & 0xffn))
      x >>= 8n
    }
    return out
  }
  const p2pkh = (h160) => [0x76, 0xa9, 0x14, ...h160, 0x88, 0xac]
  /** A legacy (non-segwit) transaction, serialized as a Dogecoin node stores it. */
  function legacyTx({ prevTxid, prevVout, scriptSig, outputs }) {
    const out = [...le32(1), 1, ...unhex(prevTxid).reverse(), ...le32(prevVout), scriptSig.length, ...scriptSig, ...le32(0xffffffff)]
    out.push(outputs.length)
    for (const o of outputs) out.push(...le64(o.value), o.script.length, ...o.script)
    out.push(...le32(0))
    return new Uint8Array(out)
  }
  /** txbuild.ts txidOfRawTx: double SHA-256, byte-reversed. */
  const txidOfRawTx = (rawHex) => hex(sha256(sha256(unhex(rawHex))).reverse())


  // ------------------------------------------- the page's staged attacks
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const TRIGGER_URL = 'type.googleapis.com/protocol.TriggerSmartContract'
  const ATTACKS = ['honest', 'recipient', 'amount', 'duplicate', 'approve', 'relabel', 'second', 'permission', 'expiry', 'feelimit', 'memo', 'txid']
  /** What a node could send back for "250 TRX to Alex": the bytes and the ID it claims. */
  function stage(attack, { owner, to, thief, amount, refBytes, refHash, now, fakeId }) {
    // approve(thief, unlimited) on the USDT contract
    const approveData = [0x09, 0x5e, 0xa7, 0xb3, ...new Array(12).fill(0), ...tronAddrBytes(thief).slice(1), ...new Array(32).fill(0xff)]
    const trigger = [...pbBytes(1, tronAddrBytes(owner)), ...pbBytes(2, tronAddrBytes(USDT)), ...pbBytes(4, approveData)]
    const pay = (dest, amt, extraTo, permissionId) => contractBytes({ value: transferValue(owner, dest, amt, extraTo), permissionId })
    const shapes = {
      honest: { contracts: [pay(to, amount)] },
      recipient: { contracts: [pay(thief, amount)] },
      amount: { contracts: [pay(to, amount * 10n)] },
      duplicate: { contracts: [pay(to, amount, thief)] },
      approve: { contracts: [contractBytes({ type: 31, typeUrl: TRIGGER_URL, value: trigger })] },
      relabel: { contracts: [contractBytes({ type: 1, typeUrl: TRIGGER_URL, value: trigger })] },
      second: { contracts: [pay(to, amount), pay(thief, amount)] },
      permission: { contracts: [pay(to, amount, undefined, 2)] },
      expiry: { contracts: [pay(to, amount)], expiration: now + 24 * 3600_000 },
      feelimit: { contracts: [pay(to, amount)], feeLimit: 100_000_000 },
      memo: { contracts: [pay(to, amount)], memo: 'thanks!' },
      txid: { contracts: [pay(to, amount)] },
    }
    if (!Object.prototype.hasOwnProperty.call(shapes, attack)) throw new Error('unknown attack ' + attack)
    const raw = rawTx({ refBytes, refHash, expiration: now + 60_000, timestamp: now, ...shapes[attack] })
    return { raw, reply: { raw_data_hex: hex(raw), txID: attack === 'txid' ? fakeId : hex(sha256(raw)) } }
  }

  const HEX = '0123456789abcdef'
  function randIndex(n) {
    const b = randomBytes(4)
    return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) % n
  }
  /** A made-up lookalike of `base`: its first k and last m characters around a
      random middle, with the characters next to the copied ends different, so
      exactly k and m match. A Solana fake still decodes to 32 bytes. */
  function fakeOf(net, base, k, m) {
    const pre = net === 'evm' ? 2 : 0
    const alphabet = net === 'evm' ? HEX : B58
    const body = base.slice(pre)
    for (let tries = 0; tries < 1000; tries++) {
      let mid = ''
      for (let i = 0; i < body.length - k - m; i++) mid += alphabet[randIndex(alphabet.length)]
      const b = body.slice(0, k) + mid + (m > 0 ? body.slice(-m) : '')
      if (b[k] === body[k] || b[b.length - 1 - m] === body[body.length - 1 - m]) continue
      const s = base.slice(0, pre) + b
      if (net === 'sol') {
        const d = b58decode(s)
        if (!d || d.length !== 32 || b58encode(d) !== s) continue
      }
      return s
    }
    throw new Error('no lookalike found')
  }

  root.KAILAH = {
    hex,
    unhex,
    concat,
    utf8,
    randomBytes,
    sha256,
    b58encode,
    b58decode,
    b58checkEncode,
    madeUp,
    lookalike: { SOL_FORMAT, TRON_FORMAT, EVM_FORMAT, findLookalike, findKnown, knownAddresses, fakeOf },
    tron: {
      UNEXPECTED,
      CLOCK_OR_NODE,
      MISMATCH,
      decodeTronRawTx,
      assertTronEnvelope,
      verifyTxId,
      checkTrxSend,
      contractBytes,
      transferValue,
      rawTx,
      pbBytes,
      pbVarint,
      tronAddrBytes,
      annotate,
      USDT,
      ATTACKS,
      stage,
    },
    doge: { legacyTx, p2pkh, le64, txidOfRawTx },
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
