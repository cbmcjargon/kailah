// TRON engine verification for Kailah Wallet.
//
// Run from the repo root: npx tsx scripts/check-tron.mjs
//
// Offline: address derivation re-implemented INDEPENDENTLY (raw noble
// secp256k1 + keccak + hand-built base58check with double-sha256 — no
// @scure/base, no tron.ts helpers) and compared against the engine; address
// validation; protobuf decoder against hand-built vectors; sign + local
// public-key recovery round-trip.
// Live (read-only, keyless): decoder verified against REAL createtransaction
// bytes on mainnet and Nile (the node's raw_data JSON must match what OUR
// decoder reads from raw_data_hex); USDT trigger build + calldata
// verification; balance/history endpoint shapes; and a negative broadcast on
// Nile — a transaction signed with the WRONG key must be rejected for its
// signature (proving the node parses our 65-byte signature format), never
// accepted. Nothing here can move funds: the vector key holds nothing on
// TRON, and the negative test is rejected by design.

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-tron')
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { prepareFreeze, prepareVote } from '../src/lib/tronstake.ts'
import {
  TRON_CHAINS,
  assertTronEnvelope,
  decodeTronRawTx,
  deriveTronKey,
  fetchTronHistory,
  getTronBalance,
  getTronUsdtBalance,
  isValidTronAddress,
  parseTronScanned,
  tronAddressToHex,
} from '../src/lib/tron.ts'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let failures = 0
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`)
const check = (name, cond, detail = '') => {
  // A live dependency being unreachable or rate-limited is not a wallet
  // defect — the app fails over; the suite reports it as a skip, not a fail.
  if (!cond && NET_ISSUE.test(String(detail))) return skip(name, `live dependency unavailable: ${String(detail).slice(0, 90)}`)
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : ` — ${detail}`))
  if (!cond) failures++
}

const MAINNET = TRON_CHAINS.tron
const NILE = TRON_CHAINS['tron-nile']

// --- 1. Independent derivation ----------------------------------------------
// Base58 alphabet encode + double-sha256 checksum, written from scratch.
{
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const b58encode = (bytes) => {
    let n = 0n
    for (const b of bytes) n = (n << 8n) | BigInt(b)
    let s = ''
    while (n > 0n) {
      s = A[Number(n % 58n)] + s
      n /= 58n
    }
    for (const b of bytes) {
      if (b !== 0) break
      s = '1' + s
    }
    return s
  }
  const seed = mnemonicToSeedSync(VECTOR_MNEMONIC)
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'/0/0")
  const pub = secp256k1.getPublicKey(node.privateKey, false)
  const h = keccak_256(pub.slice(1))
  const payload = concatBytes(new Uint8Array([0x41]), h.slice(12))
  const checksum = sha256(sha256(payload)).slice(0, 4)
  const independent = b58encode(concatBytes(payload, checksum))

  const key = deriveTronKey(VECTOR_MNEMONIC)
  check('independent derivation matches engine', key.address === independent, `${key.address} vs ${independent}`)
  check('address starts with T, validates', key.address.startsWith('T') && isValidTronAddress(key.address))
  check('hex form is 41-prefixed 21 bytes', tronAddressToHex(key.address).startsWith('41') && tronAddressToHex(key.address).length === 42)
  check('validator rejects tampered checksum', !isValidTronAddress(key.address.slice(0, -1) + (key.address.endsWith('a') ? 'b' : 'a')))
  key.zero()
}

// --- 2. Sign + recover round-trip -------------------------------------------
{
  const key = deriveTronKey(VECTOR_MNEMONIC)
  const digest = sha256(new TextEncoder().encode('kailah tron check'))
  const sig = secp256k1.sign(digest, key.privateKey)
  const recovered = sig.recoverPublicKey(digest).toRawBytes(false)
  const h = keccak_256(recovered.slice(1))
  const payload = concatBytes(new Uint8Array([0x41]), h.slice(12))
  check(
    'signature recovers to our own address bytes',
    bytesToHex(payload) === tronAddressToHex(key.address),
  )
  key.zero()
}

// --- 3. Live: decoder vs real node bytes (mainnet + Nile) -------------------
const FUNDED = 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX'
for (const chain of [MAINNET, NILE]) {
  try {
    const res = await fetch(`${chain.api}/wallet/createtransaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner_address: FUNDED,
        to_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        amount: 1234567,
        visible: true,
      }),
    })
    const tx = await res.json()
    if (!tx.raw_data_hex) {
      check(`decoder vs live bytes (${chain.id})`, false, JSON.stringify(tx).slice(0, 120))
      continue
    }
    const decoded = decodeTronRawTx(tx.raw_data_hex)
    const c = decoded.contracts[0]
    check(
      `decoder reads live ${chain.id} TransferContract exactly`,
      decoded.contracts.length === 1 &&
        c.type === 'TransferContract' &&
        c.owner === FUNDED &&
        c.to === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' &&
        c.amount === 1234567n,
      JSON.stringify({ owner: c?.owner, to: c?.to, amount: String(c?.amount) }),
    )
    check(
      `txID equals sha256(raw bytes) (${chain.id})`,
      tx.txID === bytesToHex(sha256(hexToBytes(tx.raw_data_hex))),
    )
  } catch (e) {
    check(`decoder vs live bytes (${chain.id})`, false, e.message)
  }
}

// --- 4. Live: USDT trigger build + our calldata, decoder verifies -----------
try {
  const to20 = tronAddressToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').slice(2)
  const param = to20.padStart(64, '0') + (5_000_000n).toString(16).padStart(64, '0')
  const res = await fetch(`${MAINNET.api}/wallet/triggersmartcontract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_address: FUNDED,
      contract_address: MAINNET.usdt.contract,
      function_selector: 'transfer(address,uint256)',
      parameter: param,
      fee_limit: 30000000,
      call_value: 0,
      visible: true,
    }),
  })
  const r = await res.json()
  const decoded = decodeTronRawTx(r.transaction.raw_data_hex)
  const c = decoded.contracts[0]
  check(
    'USDT trigger: decoder confirms contract, calldata, fee_limit',
    c.type === 'TriggerSmartContract' &&
      c.owner === FUNDED &&
      c.contractAddress === MAINNET.usdt.contract &&
      c.dataHex === 'a9059cbb' + param &&
      decoded.feeLimit === 30_000_000n,
    JSON.stringify({ contract: c?.contractAddress, feeLimit: String(decoded.feeLimit) }),
  )
} catch (e) {
  check('USDT trigger build', false, e.message)
}

// --- 5. Live: balances + history shapes -------------------------------------
try {
  const bal = await getTronBalance(MAINNET, FUNDED)
  check(`live TRX balance reads (${bal} sun)`, typeof bal === 'bigint' && bal > 0n)
  const usdt = await getTronUsdtBalance(MAINNET, FUNDED)
  check(`live USDT balance reads (${usdt})`, typeof usdt === 'bigint')
  const key = deriveTronKey(VECTOR_MNEMONIC)
  const own = await getTronBalance(MAINNET, key.address)
  check(`vector account balance reads (${own} sun — fresh account is 0)`, typeof own === 'bigint')
  const hist = await fetchTronHistory(MAINNET, FUNDED)
  check(
    'live history returns classified rows',
    hist.length > 0 && ['in', 'out', 'self'].includes(hist[0].direction) && typeof hist[0].amount === 'bigint',
  )
  key.zero()
} catch (e) {
  check('live balances/history', false, e.message)
}

// --- 6. Live negative broadcast (Nile): wrong-key signature must be rejected
// for its SIGNATURE — proving the node parses our 65-byte r||s||recovery form.
try {
  const build = await fetch(`${NILE.api}/wallet/createtransaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_address: FUNDED, // funded on Nile too (exchange test addr)
      to_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amount: 1000000,
      visible: true,
    }),
  })
  const tx = await build.json()
  if (!tx.raw_data_hex) {
    skip('negative broadcast', 'Nile build unavailable: ' + JSON.stringify(tx).slice(0, 80))
  } else {
    const key = deriveTronKey(VECTOR_MNEMONIC) // NOT the owner — must fail SIGERROR
    const digest = sha256(hexToBytes(tx.raw_data_hex))
    const sig = secp256k1.sign(digest, key.privateKey)
    const signature = bytesToHex(sig.toCompactRawBytes()) + (sig.recovery === 1 ? '01' : '00')
    const res = await fetch(`${NILE.api}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tx, signature: [signature], visible: true }),
    })
    const out = await res.json()
    let msg = out.message ?? ''
    try {
      msg = new TextDecoder().decode(hexToBytes(msg))
    } catch {
      /* keep */
    }
    check(
      'node rejects wrong-key signature as SIGERROR (format parses)',
      out.result !== true && (out.code === 'SIGERROR' || /valid.*sig|sig.*valid/i.test(msg)),
      JSON.stringify({ code: out.code, msg: msg.slice(0, 60) }),
    )
    key.zero()
  }
} catch (e) {
  check('negative broadcast', false, e.message)
}

// --- 6b. Stake 2.0: decoder + prepare flows ---------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1500)
// Live: freeze builds keylessly for any funded account; our decoder must read
// the node's bytes exactly (type, owner, amount, resource) for BOTH resources.
for (const resource of ['ENERGY', 'BANDWIDTH']) {
  try {
    const res = await fetch(`${MAINNET.api}/wallet/freezebalancev2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_address: FUNDED, frozen_balance: 2500000, resource, visible: true }),
    })
    const tx = await res.json()
    const d = decodeTronRawTx(tx.raw_data_hex)
    const c = d.contracts[0]
    check(
      `freeze(${resource}) decodes from live bytes`,
      d.contracts.length === 1 &&
        c.type === 'FreezeBalanceV2Contract' &&
        c.owner === FUNDED &&
        c.amount === 2500000n &&
        c.resource === resource,
      JSON.stringify({ type: c?.type, amount: String(c?.amount), resource: c?.resource }),
    )
    await sleep(1200)
  } catch (e) {
    check(`freeze(${resource}) decode`, false, e.message)
  }
}

// Live: the real prepareFreeze pipeline end to end (build → decode-verify →
// txID recompute) using a read-only stand-in key for the funded account.
try {
  const fakeKey = { address: FUNDED, privateKey: new Uint8Array(32), zero() {} }
  const p = await prepareFreeze(MAINNET, fakeKey, 3000000n, 'ENERGY')
  check(
    'prepareFreeze passes its own decode-verify gate',
    p.action === 'freeze' && p.resource === 'ENERGY' && p.amount === 3000000n && p.txID.length === 64,
  )
} catch (e) {
  check('prepareFreeze pipeline', false, e.message)
}
await sleep(1200)

// Live: vote for an account with zero TRON Power must be refused AT BUILD
// TIME with the node's readable reason — nothing ever gets near signing.
try {
  const fakeKey = { address: FUNDED, privateKey: new Uint8Array(32), zero() {} }
  await prepareVote(MAINNET, fakeKey, [{ address: 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', count: 5n }])
  check('vote without power refused at build time', false, 'unexpectedly built')
} catch (e) {
  check('vote without power refused at build time', /tronPower|vote/i.test(e.message), e.message)
}

// Hand-built vectors for the types the network won't build for unfunded
// accounts. Layout anchored by the live decodes above (same reader, same
// Any-wrapped pattern); runtime decode-verify fails closed regardless.
{
  const enc = (bytes) => bytesToHex(bytes)
  const varint = (n) => {
    const out = []
    let v = BigInt(n)
    for (;;) {
      const b = Number(v & 0x7fn)
      v >>= 7n
      if (v > 0n) out.push(b | 0x80)
      else {
        out.push(b)
        break
      }
    }
    return Uint8Array.from(out)
  }
  const len = (num, bytes) => Uint8Array.from([...varint((num << 3) | 2), ...varint(bytes.length), ...bytes])
  const vint = (num, n) => Uint8Array.from([...varint(num << 3), ...varint(n)])
  const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]))
  const { hexToBytes: h2b } = await import('@noble/hashes/utils')

  const ownerBytes = h2b(tronAddressToHex(FUNDED))
  const srBytes = h2b(tronAddressToHex('TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M'))

  const wrap = (typeNum, typeUrl, innerBytes) => {
    const any = cat(len(1, new TextEncoder().encode(typeUrl)), len(2, innerBytes))
    const contract = cat(vint(1, typeNum), len(2, any))
    return cat(len(1, h2b('aabb')), vint(8, 1785700000000), len(11, contract))
  }

  const voteInner = cat(len(1, ownerBytes), len(2, cat(len(1, srBytes), vint(2, 7))))
  const dVote = decodeTronRawTx(enc(wrap(4, 'type.googleapis.com/protocol.VoteWitnessContract', voteInner)))
  check(
    'vector: VoteWitnessContract decodes (owner, SR, count)',
    dVote.contracts[0].type === 'VoteWitnessContract' &&
      dVote.contracts[0].owner === FUNDED &&
      dVote.contracts[0].votes?.[0]?.address === 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M' &&
      dVote.contracts[0].votes?.[0]?.count === 7n,
  )

  const unfreezeInner = cat(len(1, ownerBytes), vint(2, 4000000), vint(3, 1))
  const dUn = decodeTronRawTx(enc(wrap(55, 'type.googleapis.com/protocol.UnfreezeBalanceV2Contract', unfreezeInner)))
  check(
    'vector: UnfreezeBalanceV2 decodes (amount, ENERGY)',
    dUn.contracts[0].type === 'UnfreezeBalanceV2Contract' &&
      dUn.contracts[0].amount === 4000000n &&
      dUn.contracts[0].resource === 'ENERGY',
  )

  const claimInner = cat(len(1, ownerBytes))
  const dClaim = decodeTronRawTx(enc(wrap(13, 'type.googleapis.com/protocol.WithdrawBalanceContract', claimInner)))
  check('vector: WithdrawBalanceContract decodes', dClaim.contracts[0].type === 'WithdrawBalanceContract' && dClaim.contracts[0].owner === FUNDED)

  const wdInner = cat(len(1, ownerBytes))
  const dWd = decodeTronRawTx(enc(wrap(56, 'type.googleapis.com/protocol.WithdrawExpireUnfreezeContract', wdInner)))
  check('vector: WithdrawExpireUnfreeze decodes', dWd.contracts[0].type === 'WithdrawExpireUnfreezeContract' && dWd.contracts[0].owner === FUNDED)
}

// --- 6b. Adversarial vectors: the decoder must be deny-by-default ------------
// A hostile node controls every byte it asks the wallet to sign. Unknown
// fields, duplicate scalars (TRON's Java stack resolves them last-wins),
// riders like call_value, and type/url mismatches must all throw.
{
  const enc = (bytes) => bytesToHex(bytes)
  const varint = (n) => {
    const out = []
    let v = BigInt(n)
    for (;;) {
      const b = Number(v & 0x7fn)
      v >>= 7n
      if (v > 0n) out.push(b | 0x80)
      else {
        out.push(b)
        break
      }
    }
    return Uint8Array.from(out)
  }
  const len = (num, bytes) => Uint8Array.from([...varint((num << 3) | 2), ...varint(bytes.length), ...bytes])
  const vint = (num, n) => Uint8Array.from([...varint(num << 3), ...varint(n)])
  const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]))
  const { hexToBytes: h2b } = await import('@noble/hashes/utils')
  const throwsUnexpected = (name, fn) => {
    let msg = ''
    try {
      fn()
    } catch (e) {
      msg = e.message
    }
    check(name, /unexpected or duplicate fields/.test(msg), msg || '(did not throw)')
  }

  const ownerBytes = h2b(tronAddressToHex(FUNDED))
  const toBytes = h2b(tronAddressToHex('TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M'))
  const wrapRaw = (contract, extraTop = new Uint8Array()) =>
    cat(len(1, h2b('aabb')), vint(8, 1785700000000), len(11, contract), extraTop)
  const transferContract = (inner) =>
    cat(vint(1, 1), len(2, cat(len(1, new TextEncoder().encode('type.googleapis.com/protocol.TransferContract')), len(2, inner))))

  // Honest shape decodes (baseline for the cases below)
  const honest = wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1_000_000))))
  const dHonest = decodeTronRawTx(enc(honest))
  check('adversarial baseline: honest TransferContract decodes', dHonest.contracts[0].amount === 1000000n)

  // Duplicate amount: wallet would read the first, the chain executes the last
  throwsUnexpected('duplicate amount field refused', () =>
    decodeTronRawTx(enc(wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1_000_000), vint(3, 999_000_000)))))))

  // Duplicate recipient
  throwsUnexpected('duplicate to field refused', () =>
    decodeTronRawTx(enc(wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), len(2, ownerBytes), vint(3, 1_000_000)))))))

  // Unknown inner field smuggled into a TransferContract
  throwsUnexpected('unknown inner field refused', () =>
    decodeTronRawTx(enc(wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1_000_000), vint(7, 1)))))))

  // Unknown top-level field (10 = data/memo the wallet never requests)
  throwsUnexpected('unknown top-level field refused', () =>
    decodeTronRawTx(enc(wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1))), len(10, new TextEncoder().encode('memo'))))))

  // Duplicate top-level expiration
  throwsUnexpected('duplicate expiration refused', () =>
    decodeTronRawTx(enc(cat(wrapRaw(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1)))), vint(8, 1785700000001)))))

  // Permission_id on the contract would switch the signing authority
  throwsUnexpected('Permission_id on contract refused', () => {
    const c = cat(transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1))).slice(0), vint(5, 2))
    decodeTronRawTx(enc(wrapRaw(c)))
  })

  // type enum says Transfer, type_url says Trigger
  throwsUnexpected('type enum / type_url mismatch refused', () => {
    const inner = cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1))
    const c = cat(vint(1, 1), len(2, cat(len(1, new TextEncoder().encode('type.googleapis.com/protocol.TriggerSmartContract')), len(2, inner))))
    decodeTronRawTx(enc(wrapRaw(c)))
  })

  // call_value rider on a Trigger decodes visibly (the USDT verify requires 0)
  const trigInner = cat(len(1, ownerBytes), len(2, toBytes), vint(3, 5_000_000), len(4, h2b('a9059cbb')))
  const trig = cat(vint(1, 31), len(2, cat(len(1, new TextEncoder().encode('type.googleapis.com/protocol.TriggerSmartContract')), len(2, trigInner))))
  const dTrig = decodeTronRawTx(enc(wrapRaw(trig)))
  check('call_value rider is decoded, not skipped', dTrig.contracts[0].callValue === 5_000_000n)

  // Envelope pins: inflated fee_limit and far-future expiration
  throwsUnexpected('fee_limit mismatch refused by envelope check', () =>
    assertTronEnvelope(decodeTronRawTx(enc(cat(honest, vint(18, 30_000_000)))), 0n))
  throwsUnexpected('far-future expiration refused by envelope check', () => {
    const far = cat(len(1, h2b('aabb')), vint(8, Date.now() + 90 * 24 * 3600 * 1000), len(11, transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1)))))
    assertTronEnvelope(decodeTronRawTx(enc(far)), 0n)
  })
  // and an honest envelope passes
  {
    const ok = cat(len(1, h2b('aabb')), vint(8, Date.now() + 60_000), len(11, transferContract(cat(len(1, ownerBytes), len(2, toBytes), vint(3, 1)))))
    assertTronEnvelope(decodeTronRawTx(enc(ok)), 0n)
    check('sane envelope accepted', true)
  }
}

// --- 7. QR / address parsing -------------------------------------------------
{
  check('parse bare T address', parseTronScanned(' TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t ').address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  check('parse tron: URI', parseTronScanned('tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').address.startsWith('TR7'))
  let ethMsg = ''
  try {
    parseTronScanned('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  } catch (e) {
    ethMsg = e.message
  }
  check('wrong-family scan explained', /ethereum/i.test(ethMsg))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
