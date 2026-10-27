// Standalone verification for the v2 transaction layer:
//   src/lib/txbuild.ts   (buildTxV2, buildBump)
//   src/lib/history.ts   (classifyTxs)
//   src/lib/csvexport.ts (txsToCsv)
//
// Run from the repo root: npx tsx scripts/check-txv2.mjs
// Exits nonzero on any failed assertion. Keys are derived inline via @scure so
// this doesn't depend on keys.ts / scanner.ts (which may be mid-build).

import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { RawTx, p2pkh, p2wpkh } from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { CHAINS } from '../src/lib/networks.ts'
import {
  buildTxV2,
  buildBump,
  decodeVerifiedTx,
  verifiedPrevout,
  verifiedRawTxInfo,
} from '../src/lib/txbuild.ts'
import { classifyTxs } from '../src/lib/history.ts'
import { csvExportHint, txsToCsv } from '../src/lib/csvexport.ts'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function checkThrows(name, fn, msgRe) {
  try {
    fn()
    check(name, false, 'did not throw')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msgRe.test(msg), `message: "${msg}"`)
  }
}
const absBig = (v) => (v < 0n ? -v : v)

// --- inline HD key derivation (do NOT import keys.ts) ----------------------
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))

function deriveAt(chain, branch, index) {
  const path = `${chain.accountPath}/${branch}/${index}`
  const node = root.derive(path)
  if (!node.privateKey || !node.publicKey) throw new Error('derivation failed')
  const payment =
    chain.addressType === 'p2wpkh'
      ? p2wpkh(node.publicKey, chain.network)
      : p2pkh(node.publicKey, chain.network)
  return {
    chain: chain.id,
    address: payment.address,
    path,
    publicKey: node.publicKey,
    privateKey: node.privateKey,
    branch,
    index,
  }
}
const scriptOf = (chain, key) =>
  (chain.addressType === 'p2wpkh' ? p2wpkh(key.publicKey, chain.network) : p2pkh(key.publicKey, chain.network))
    .script

// Encode a synthetic funding tx paying `value` to `key`'s address (for legacy
// nonWitnessUtxo signing), returning {txid, hex}.
function fund(chain, key, value, seed) {
  const raw = RawTx.encode({
    version: 1,
    segwitFlag: undefined,
    inputs: [
      { txid: new Uint8Array(32).fill(seed), index: 0, finalScriptSig: Uint8Array.from([0x51]), sequence: 0xffffffff },
    ],
    outputs: [{ amount: value, script: scriptOf(chain, key) }],
    witnesses: undefined,
    lockTime: 0,
  })
  return { txid: hex.encode(sha256(sha256(raw)).reverse()), hex: hex.encode(raw) }
}

// ===========================================================================
// Case A: buildTxV2 BTC segwit, two utxos from DIFFERENT indices/keys
// ===========================================================================
console.log('--- Case A: buildTxV2 BTC p2wpkh, per-input keys ---')
const btc = CHAINS.btc
const kA0 = deriveAt(btc, 0, 0) // funds input #0
const kA1 = deriveAt(btc, 0, 1) // funds input #1
const changeA = deriveAt(btc, 1, 0) // fresh change address
const recipA = deriveAt(btc, 0, 9) // stand-in external recipient

// Distinct values so input ordering (largest-first) is deterministic.
const uA0 = { txid: 'a1'.repeat(32), vout: 0, value: 80000n, address: kA0.address, branch: 0, index: 0 }
const uA1 = { txid: 'b2'.repeat(32), vout: 1, value: 50000n, address: kA1.address, branch: 0, index: 1 }
const keyByAddr = { [kA0.address]: kA0, [kA1.address]: kA1 }

const a = buildTxV2({
  chain: btc,
  utxos: [uA1, uA0], // pass out of order; selection sorts largest-first
  keyFor: (u) => keyByAddr[u.address],
  toAddress: recipA.address,
  amount: 100000n, // > either single utxo ⇒ forces BOTH inputs (distinct keys)
  feeRate: 2n,
  changeAddress: changeA.address,
})
const rawA = RawTx.decode(hex.decode(a.hex))
check('A1 two inputs', rawA.inputs.length === 2, `n=${rawA.inputs.length}`)
// largest-first ⇒ input0 = uA0 (80000), input1 = uA1 (50000)
check('A2 input0 = uA0 outpoint', hex.encode(rawA.inputs[0].txid) === uA0.txid && rawA.inputs[0].index === 0)
check('A3 input1 = uA1 outpoint', hex.encode(rawA.inputs[1].txid) === uA1.txid && rawA.inputs[1].index === 1)
check('A4 RBF sequence on both', rawA.inputs.every((i) => i.sequence === 0xfffffffd))
// per-index signing: witness = [sig, pubkey]; pubkey must be that input's key
check(
  'A5 input0 signed with kA0 pubkey',
  rawA.witnesses && hex.encode(rawA.witnesses[0][1]) === hex.encode(kA0.publicKey),
  rawA.witnesses ? hex.encode(rawA.witnesses[0][1]) : 'no witness',
)
check(
  'A6 input1 signed with kA1 pubkey (DIFFERENT key)',
  rawA.witnesses && hex.encode(rawA.witnesses[1][1]) === hex.encode(kA1.publicKey),
  rawA.witnesses ? hex.encode(rawA.witnesses[1][1]) : 'no witness',
)
check('A7 keys really differ', hex.encode(kA0.publicKey) !== hex.encode(kA1.publicKey))
// outputs: recipient + change to FRESH change address
const recipScript = scriptOf(btc, recipA)
const changeScript = scriptOf(btc, changeA)
const outRecip = rawA.outputs.find((o) => hex.encode(o.script) === hex.encode(recipScript))
const outChange = rawA.outputs.find((o) => hex.encode(o.script) === hex.encode(changeScript))
check('A8 recipient output = 100000 to toAddress', outRecip !== undefined && outRecip.amount === 100000n)
check('A9 change pays FRESH change addr', outChange !== undefined && outChange.amount === a.change, `change=${a.change}`)
check(
  'A10 change addr is NOT any input address',
  hex.encode(changeScript) !== hex.encode(scriptOf(btc, kA0)) &&
    hex.encode(changeScript) !== hex.encode(scriptOf(btc, kA1)),
)
const sumA = rawA.outputs.reduce((s, o) => s + o.amount, 0n)
check('A11 inputs = outputs + fee', sumA + a.fee === 130000n, `sum=${sumA} fee=${a.fee}`)
check(
  'A12 fee >= vbytes*rate and within 2 vB',
  a.fee >= BigInt(a.vbytes) * 2n && a.fee - BigInt(a.vbytes) * 2n <= 4n,
  `fee=${a.fee} vbytes=${a.vbytes}`,
)
check('A13 delivered amount', a.amount === 100000n)

// ===========================================================================
// Case B: buildTxV2 DOGE legacy, two synthetic-funded inputs
// ===========================================================================
console.log('--- Case B: buildTxV2 DOGE p2pkh, per-input keys ---')
const doge = CHAINS.doge
const kB0 = deriveAt(doge, 0, 0)
const kB1 = deriveAt(doge, 0, 1)
const changeB = deriveAt(doge, 1, 0)
const recipB = deriveAt(doge, 0, 9)
const fB0 = fund(doge, kB0, 300000000n, 0xc0)
const fB1 = fund(doge, kB1, 200000000n, 0xc1)
const uB0 = { txid: fB0.txid, vout: 0, value: 300000000n, rawTxHex: fB0.hex, address: kB0.address, branch: 0, index: 0 }
const uB1 = { txid: fB1.txid, vout: 0, value: 200000000n, rawTxHex: fB1.hex, address: kB1.address, branch: 0, index: 1 }
const keyByAddrB = { [kB0.address]: kB0, [kB1.address]: kB1 }

const b = buildTxV2({
  chain: doge,
  utxos: [uB0, uB1],
  keyFor: (u) => keyByAddrB[u.address],
  toAddress: recipB.address,
  amount: 400000000n, // > either single utxo ⇒ forces BOTH legacy inputs
  feeRate: doge.fixedFeeRate,
  changeAddress: changeB.address,
})
const rawB = RawTx.decode(hex.decode(b.hex))
check('B1 version 1', rawB.version === 1)
check('B2 no segwit flag', !rawB.segwitFlag)
check('B3 two inputs', rawB.inputs.length === 2)
check('B4 sequence 0xffffffff (no RBF on doge)', rawB.inputs.every((i) => i.sequence === 0xffffffff))
// input0 = uB0 (300M, larger) signed by kB0; input1 = uB1 signed by kB1
check(
  'B5 input0 scriptSig ends with kB0 pubkey',
  hex.encode(rawB.inputs[0].txid) === uB0.txid &&
    hex.encode(rawB.inputs[0].finalScriptSig).endsWith(hex.encode(kB0.publicKey)),
)
check(
  'B6 input1 scriptSig ends with kB1 pubkey (DIFFERENT key)',
  hex.encode(rawB.inputs[1].txid) === uB1.txid &&
    hex.encode(rawB.inputs[1].finalScriptSig).endsWith(hex.encode(kB1.publicKey)),
)
check('B7 both scriptSigs look like sig+pubkey', rawB.inputs.every((i) => i.finalScriptSig.length >= 100))
const changeScriptB = scriptOf(doge, changeB)
const outChangeB = rawB.outputs.find((o) => hex.encode(o.script) === hex.encode(changeScriptB))
check('B8 change pays fresh change addr, above dust', outChangeB !== undefined && b.change >= doge.dustLimit)
check('B9 inputs = outputs + fee', rawB.outputs.reduce((s, o) => s + o.amount, 0n) + b.fee === 500000000n)

// ===========================================================================
// Case C: sendMax — single output, no change
// ===========================================================================
console.log('--- Case C: buildTxV2 sendMax ---')
const c = buildTxV2({
  chain: btc,
  utxos: [uA0, uA1],
  keyFor: (u) => keyByAddr[u.address],
  toAddress: recipA.address,
  amount: 0n,
  feeRate: 2n,
  sendMax: true,
  changeAddress: changeA.address,
})
const rawC = RawTx.decode(hex.decode(c.hex))
check('C1 single output', rawC.outputs.length === 1)
check('C2 output pays recipient', hex.encode(rawC.outputs[0].script) === hex.encode(recipScript))
check('C3 amount + fee = total (130000)', c.amount + c.fee === 130000n && rawC.outputs[0].amount === c.amount)
check('C4 change 0', c.change === 0n)
check('C5 both inputs swept', rawC.inputs.length === 2)

// ===========================================================================
// Case D: buildBump — RBF replacement at a higher rate
// ===========================================================================
console.log('--- Case D: buildBump ---')
// Original: 2 inputs (kA0, kA1), recipient 40000, change to changeA, rate 2.
const orig = a // reuse Case A's tx
const origChangeAddr = changeA.address
// Reconstruct the provider-normalized RawTxInfo for `orig`.
const rawOrig = RawTx.decode(hex.decode(orig.hex))
const allUtxos = [uA0, uA1]
const origInputs = rawOrig.inputs.map((inp) => {
  const txid = hex.encode(inp.txid)
  const u = allUtxos.find((x) => x.txid === txid && x.vout === inp.index)
  return { address: u.address, value: u.value, prevTxid: txid, prevVout: inp.index }
})
const original = {
  txid: orig.txid,
  height: null,
  time: null,
  fee: orig.fee,
  inputs: origInputs,
  outputs: [
    { address: recipA.address, value: orig.amount }, // recipient
    { address: origChangeAddr, value: orig.change }, // our change (to be dropped)
  ],
  rbfSignaled: true,
}
const ourAddresses = new Set([kA0.address, kA1.address, origChangeAddr, changeA.address])
const bumpChange = deriveAt(btc, 1, 1)
const bump = buildBump({
  chain: btc,
  original,
  ourAddresses,
  keyFor: (addr) => keyByAddr[addr] ?? null,
  originalUtxos: allUtxos,
  extraUtxos: [],
  extraKeyFor: () => {
    throw new Error('no extra expected')
  },
  newFeeRate: 6n,
  changeAddress: bumpChange.address,
})
const rawBump = RawTx.decode(hex.decode(bump.hex))
// same inputs (same outpoints)
const bumpOutpoints = rawBump.inputs.map((i) => `${hex.encode(i.txid)}:${i.index}`).sort()
const origOutpoints = origInputs.map((i) => `${i.prevTxid}:${i.prevVout}`).sort()
check('D1 spends the same inputs', JSON.stringify(bumpOutpoints) === JSON.stringify(origOutpoints))
// keeps recipient output + value
const bumpRecip = rawBump.outputs.find((o) => hex.encode(o.script) === hex.encode(recipScript))
check('D2 keeps recipient output at original value', bumpRecip !== undefined && bumpRecip.amount === 100000n)
// old change addr dropped; new change to bumpChange
const oldChangeScript = scriptOf(btc, changeA)
const bumpChangeScript = scriptOf(btc, bumpChange)
check('D3 old change output dropped', !rawBump.outputs.some((o) => hex.encode(o.script) === hex.encode(oldChangeScript)))
check(
  'D4 new change to fresh bump change addr',
  rawBump.outputs.some((o) => hex.encode(o.script) === hex.encode(bumpChangeScript) && o.amount === bump.change),
)
// pays strictly higher absolute fee AND higher feerate
check('D5 higher absolute fee', bump.fee > orig.fee, `bump=${bump.fee} orig=${orig.fee}`)

// D5b/D5c — regression for the live -26 rejection ("less fees than
// conflicting txs"): when an unconfirmed OUTSIDE spender re-spent an output,
// the replacement must outbid the original PLUS that spender's fee; and a
// node-reported absolute floor must be honored even above the rate math.
{
  const extra = 5_000n // pretend an outside spender paid 5000 sats
  const bumpC = buildBump({
    chain: btc,
    original,
    ourAddresses,
    keyFor: (addr) => keyByAddr[addr] ?? null,
    originalUtxos: allUtxos,
    extraUtxos: [],
    extraKeyFor: () => {
      throw new Error('no extra expected')
    },
    newFeeRate: 6n,
    changeAddress: bumpChange.address,
    conflictExtraFees: extra,
  })
  check(
    'D5b conflict fees raise the floor (fee ≥ orig + extra + vsize)',
    bumpC.fee >= orig.fee + extra + BigInt(bumpC.vbytes),
    `fee=${bumpC.fee} needed>=${orig.fee + extra + BigInt(bumpC.vbytes)}`,
  )
  const floor = 30_000n
  const bumpF = buildBump({
    chain: btc,
    original,
    ourAddresses,
    keyFor: (addr) => keyByAddr[addr] ?? null,
    originalUtxos: allUtxos,
    extraUtxos: [],
    extraKeyFor: () => {
      throw new Error('no extra expected')
    },
    newFeeRate: 6n,
    changeAddress: bumpChange.address,
    absoluteFeeFloor: floor,
  })
  check('D5c node-reported absolute floor honored', bumpF.fee >= floor, `fee=${bumpF.fee} floor=${floor}`)
  check('D5c floor still balances (fee+outputs=inputs)', bumpF.fee + bumpF.amount + bumpF.change === uA0.value + uA1.value)
}
const origRateNum = Number(orig.fee) / orig.vbytes
const bumpRateNum = Number(bump.fee) / bump.vbytes
check('D6 higher fee rate', bumpRateNum > origRateNum, `bump=${bumpRateNum.toFixed(3)} orig=${origRateNum.toFixed(3)}`)
// signatures valid: both witness pubkeys match their input's key
check(
  'D7 signatures valid (per-input keys)',
  rawBump.witnesses &&
    hex.encode(rawBump.witnesses[0][1]) === hex.encode(kA0.publicKey) &&
    hex.encode(rawBump.witnesses[1][1]) === hex.encode(kA1.publicKey),
)

// D2 sub-case: bump needs EXTRA utxos when the rate is high enough
console.log('--- Case D2: buildBump pulling extra utxos ---')
const kD = deriveAt(btc, 0, 0)
const changeD = deriveAt(btc, 1, 0)
const recipD = deriveAt(btc, 0, 9)
const uD = { txid: 'd1'.repeat(32), vout: 0, value: 45000n, address: kD.address, branch: 0, index: 0 }
const origD = buildTxV2({
  chain: btc,
  utxos: [uD],
  keyFor: () => kD,
  toAddress: recipD.address,
  amount: 40000n,
  feeRate: 2n,
  changeAddress: changeD.address,
})
check('D2a original has small change', origD.change > 0n && origD.change < 6000n, `change=${origD.change}`)
const rawOrigD = RawTx.decode(hex.decode(origD.hex))
const origDInputs = rawOrigD.inputs.map((inp) => ({
  address: kD.address,
  value: uD.value,
  prevTxid: hex.encode(inp.txid),
  prevVout: inp.index,
}))
const originalD = {
  txid: origD.txid,
  height: null,
  time: null,
  fee: origD.fee,
  inputs: origDInputs,
  outputs: [
    { address: recipD.address, value: origD.amount },
    { address: changeD.address, value: origD.change },
  ],
  rbfSignaled: true,
}
const kExtra = deriveAt(btc, 0, 2)
const uExtra = { txid: 'e2'.repeat(32), vout: 0, value: 30000n, address: kExtra.address, branch: 0, index: 2 }
const bumpChangeD = deriveAt(btc, 1, 3)
const bumpD = buildBump({
  chain: btc,
  original: originalD,
  ourAddresses: new Set([kD.address, changeD.address, kExtra.address, bumpChangeD.address]),
  keyFor: (addr) => (addr === kD.address ? kD : null),
  originalUtxos: [uD],
  extraUtxos: [uExtra],
  extraKeyFor: () => kExtra,
  newFeeRate: 40n, // high enough that the recovered value can't cover it alone
  changeAddress: bumpChangeD.address,
})
const rawBumpD = RawTx.decode(hex.decode(bumpD.hex))
check('D2b pulled the extra input', rawBumpD.inputs.length === 2)
check(
  'D2c extra outpoint present',
  rawBumpD.inputs.some((i) => hex.encode(i.txid) === uExtra.txid && i.index === 0),
)
check('D2d higher absolute fee', bumpD.fee > origD.fee, `bump=${bumpD.fee} orig=${origD.fee}`)
check(
  'D2e extra input signed with extra key',
  rawBumpD.witnesses &&
    rawBumpD.inputs.some(
      (i, idx) =>
        hex.encode(i.txid) === uExtra.txid && hex.encode(rawBumpD.witnesses[idx][1]) === hex.encode(kExtra.publicKey),
    ),
)

// D3 sub-case: precondition failures
console.log('--- Case D3: buildBump preconditions ---')
checkThrows(
  'D3a non-rbf throws',
  () => buildBump({ ...bumpArgsFor(original, keyByAddr), original: { ...original, rbfSignaled: false } }),
  /can't be sped up/i,
)
checkThrows(
  'D3b unresolvable input key throws',
  () =>
    buildBump({
      ...bumpArgsFor(original, keyByAddr),
      keyFor: () => null,
    }),
  /can't be sped up/i,
)
function bumpArgsFor(orig, keymap) {
  return {
    chain: btc,
    original: orig,
    ourAddresses,
    keyFor: (addr) => keymap[addr] ?? null,
    originalUtxos: allUtxos,
    extraUtxos: [],
    extraKeyFor: () => {
      throw new Error('no extra')
    },
    newFeeRate: 6n,
    changeAddress: bumpChange.address,
  }
}

// ===========================================================================
// Case E: classifyTxs
// ===========================================================================
console.log('--- Case E: classifyTxs ---')
const A1 = 'ourReceive1'
const A2 = 'ourChange1'
const EXT = 'externalAddr'
const OUR = new Set([A1, A2])
const tip = 105

const txIn = {
  txid: 'ff01'.padEnd(64, '0'),
  height: 100,
  time: 1000,
  fee: 500n,
  inputs: [{ address: EXT, value: 100000n, prevTxid: 'p'.repeat(64), prevVout: 0 }],
  outputs: [{ address: A1, value: 100000n }],
  rbfSignaled: false,
}
const txOut = {
  txid: 'ff02'.padEnd(64, '0'),
  height: null,
  time: 2000,
  fee: 5000n,
  inputs: [{ address: A1, value: 100000n, prevTxid: 'q'.repeat(64), prevVout: 0 }],
  outputs: [
    { address: EXT, value: 70000n },
    { address: A2, value: 25000n }, // change back to us
  ],
  rbfSignaled: true,
}
const txSelf = {
  txid: 'ff03'.padEnd(64, '0'),
  height: 90,
  time: 900,
  fee: 2000n,
  inputs: [{ address: A1, value: 50000n, prevTxid: 'r'.repeat(64), prevVout: 0 }],
  outputs: [{ address: A2, value: 48000n }],
  rbfSignaled: false,
}
const txOutNoRbf = {
  txid: 'ff04'.padEnd(64, '0'),
  height: null,
  time: 2500,
  fee: 3000n,
  inputs: [{ address: A1, value: 60000n, prevTxid: 's'.repeat(64), prevVout: 0 }],
  outputs: [{ address: EXT, value: 57000n }],
  rbfSignaled: false, // pending + all ours, but NO rbf ⇒ not bumpable
}
const txOutForeignInput = {
  txid: 'ff05'.padEnd(64, '0'),
  height: null,
  time: 2600,
  fee: 1000n,
  inputs: [
    { address: A1, value: 30000n, prevTxid: 't'.repeat(64), prevVout: 0 },
    { address: EXT, value: 10000n, prevTxid: 'u'.repeat(64), prevVout: 0 }, // not ours
  ],
  outputs: [{ address: EXT, value: 39000n }],
  rbfSignaled: true, // pending + rbf, but an input isn't ours ⇒ not bumpable
}

const sums = classifyTxs([txIn, txOut, txSelf, txOutNoRbf, txOutForeignInput], OUR, tip)
const byId = Object.fromEntries(sums.map((s) => [s.txid, s]))

check('E1 in: direction', byId[txIn.txid].direction === 'in')
check('E2 in: amount = +100000', byId[txIn.txid].amount === 100000n)
check('E3 in: counterparty = external sender', byId[txIn.txid].counterparty === EXT)
check('E4 in: confirmations = tip-h+1 = 6', byId[txIn.txid].confirmations === 6)
check('E5 in: not pending', byId[txIn.txid].pending === false)

check('E6 out: direction', byId[txOut.txid].direction === 'out')
check('E7 out: amount = -(100000-25000) = -75000', byId[txOut.txid].amount === -75000n)
check('E8 out: counterparty = recipient EXT', byId[txOut.txid].counterparty === EXT)
check('E9 out: pending', byId[txOut.txid].pending === true && byId[txOut.txid].confirmations === 0)
check('E10 out: bumpable (pending+rbf+all ours)', byId[txOut.txid].bumpable === true)

check('E11 self: direction', byId[txSelf.txid].direction === 'self')
check('E12 self: amount = -fee = -2000', byId[txSelf.txid].amount === -2000n)
check('E13 self: counterparty null (no external output)', byId[txSelf.txid].counterparty === null)

check('E14 noRbf: not bumpable', byId[txOutNoRbf.txid].bumpable === false)
check('E15 foreignInput: not bumpable (input not ours)', byId[txOutForeignInput.txid].bumpable === false)

// sort: pending first (by time desc), then confirmed by height desc
const order = sums.map((s) => s.txid)
const pendingIds = new Set([txOut.txid, txOutNoRbf.txid, txOutForeignInput.txid])
const firstThreePending = order.slice(0, 3).every((id) => pendingIds.has(id))
check('E16 pending sorted before confirmed', firstThreePending, order.join(','))
// pending order by time desc: 2600 (foreign) > 2500 (noRbf) > 2000 (out)
check(
  'E17 pending ordered by time desc',
  order[0] === txOutForeignInput.txid && order[1] === txOutNoRbf.txid && order[2] === txOut.txid,
)
// confirmed order by height desc: txIn (100) before txSelf (90)
check('E18 confirmed ordered by height desc', order[3] === txIn.txid && order[4] === txSelf.txid)

// ===========================================================================
// Case F: txsToCsv
// ===========================================================================
console.log('--- Case F: txsToCsv ---')
const csvRows = [
  {
    txid: 'aaa',
    direction: 'in',
    amount: 100000000n, // 1 BTC
    fee: null,
    time: 1700000000,
    height: 800000,
    confirmations: 3,
    pending: false,
    counterparty: 'bc1qexample',
    bumpable: false,
  },
  {
    txid: 'bbb',
    direction: 'out',
    amount: -75000n,
    fee: 5000n,
    time: null,
    height: null,
    confirmations: 0,
    pending: true,
    counterparty: 'weird,addr"x', // forces RFC-4180 quoting
    bumpable: true,
  },
]
const csv = txsToCsv(btc, csvRows)
const lines = csv.split('\n')
check('F1 header: the amount is the net change, and the fee column says it is already in it (bug audit 2026-10-27, BL2)', lines[0] === 'Date,Type,Net amount BTC,Fee paid BTC (included in net amount),Counterparty,Txid,Confirmations', lines[0])
check('F2 in row: date ISO + positive amount + empty fee', lines[1] === `${new Date(1700000000 * 1000).toISOString()},in,1,,bc1qexample,aaa,3`)
check('F3 out row: pending date + negative amount', lines[2].startsWith('pending,out,-0.00075,0.00005,'))
check('F4 RFC-4180 quoting of comma+quote field', lines[2].includes('"weird,addr""x"'))
check('F5 exactly 3 lines (header + 2)', lines.length === 3)
const inWithFee = txsToCsv(btc, [{ ...csvRows[0], fee: 1234n }]).split('\n')[1]
check('F6 an incoming row has no fee: the sender paid it (BL2)', inWithFee === `${new Date(1700000000 * 1000).toISOString()},in,1,,bc1qexample,aaa,3`, inWithFee)
{
  const { readFileSync } = await import('node:fs')
  const detail = readFileSync(new URL('../src/components/TxDetailModal.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  check('F7 the detail view says an incoming fee was the sender\'s (BL2)', /paid by the sender/.test(detail))
  check('F8 the export hint names the networks the file holds, each once (BL2)',
    csvExportHint([]) === 'No history yet' &&
    csvExportHint(['Bitcoin testnet']) === 'One file: Bitcoin testnet history' &&
    csvExportHint(['Bitcoin', 'Dogecoin']) === 'One file: Bitcoin and Dogecoin history' &&
    csvExportHint(['Bitcoin', 'Litecoin', 'Dogecoin', 'Bitcoin']) === 'One file: Bitcoin, Litecoin and Dogecoin history')
  check('F9 ...the row shows that hint, from the shown networks with history (not a fixed list)',
    /\{csvExportHint\(csvNetworks\)\}/.test(settings) && !/One file/.test(settings) &&
    /const csvNetworks = \[\s*\.\.\.shownIn\(chainsForMode\(mode\), netPrefs\)\.filter\(/.test(app))
}

// ===========================================================================
// Case G: raw-byte verification for RBF bumps (decodeVerifiedTx & friends) —
// a bump must rebuild recipients from bytes bound to the txid, never from
// provider JSON.
// ===========================================================================
console.log('--- Case G: bump raw-byte verification ---')
const decG = decodeVerifiedTx(btc, origD.txid, origD.hex)
check(
  'G1 outputs decoded from bytes match the built tx',
  decG.outputs.length === 2 &&
    decG.outputs[0].address === recipD.address &&
    decG.outputs[0].value === origD.amount &&
    decG.outputs[1].address === changeD.address &&
    decG.outputs[1].value === origD.change,
)
check('G2 rbf signaling read from bytes', decG.rbfSignaled === true)
check(
  'G3 outpoints read from bytes',
  decG.inputs.length === 1 && decG.inputs[0].prevTxid === uD.txid && decG.inputs[0].prevVout === 0,
)
checkThrows('G4 txid mismatch refused', () => decodeVerifiedTx(btc, 'ff'.repeat(32), origD.hex), /does not match/)
const fundG = fund(btc, kD, 45000n, 9)
const prevG = verifiedPrevout(btc, fundG.txid, fundG.hex, 0)
check('G5 funding output verified (addr+value)', prevG.address === kD.address && prevG.value === 45000n)
checkThrows('G6 funding txid mismatch refused', () => verifiedPrevout(btc, 'aa'.repeat(32), fundG.hex, 0), /does not match/)
checkThrows('G7 out-of-range vout refused', () => verifiedPrevout(btc, fundG.txid, fundG.hex, 5), /does not match/)
const infoG = verifiedRawTxInfo({ txid: origD.txid, height: null, time: null }, decG, () => ({
  address: kD.address,
  value: uD.value,
}))
check('G8 fee recomputed from verified in/out', infoG.fee === origD.fee, `fee=${infoG.fee} want=${origD.fee}`)

// G9: the bump fee ceiling — a provider/node-fed absolute floor cannot push
// the replacement past MAX_BUMP_FEE_RATE.
const kH = deriveAt(btc, 0, 3)
const changeH = deriveAt(btc, 1, 5)
const recipH = deriveAt(btc, 0, 9)
const uH = { txid: 'f3'.repeat(32), vout: 0, value: 10_000_000n, address: kH.address, branch: 0, index: 3 }
const origH = buildTxV2({
  chain: btc,
  utxos: [uH],
  keyFor: () => kH,
  toAddress: recipH.address,
  amount: 100_000n,
  feeRate: 2n,
  changeAddress: changeH.address,
})
const originalH = {
  txid: origH.txid,
  height: null,
  time: null,
  fee: origH.fee,
  inputs: [{ address: kH.address, value: uH.value, prevTxid: uH.txid, prevVout: 0 }],
  outputs: [
    { address: recipH.address, value: origH.amount },
    { address: changeH.address, value: origH.change },
  ],
  rbfSignaled: true,
}
checkThrows(
  'G9 absurd node-fed fee floor refused by the rate ceiling',
  () =>
    buildBump({
      chain: btc,
      original: originalH,
      ourAddresses: new Set([kH.address, changeH.address]),
      keyFor: (a) => (a === kH.address ? kH : null),
      originalUtxos: [uH],
      extraUtxos: [],
      extraKeyFor: () => kH,
      newFeeRate: 3n,
      changeAddress: changeH.address,
      absoluteFeeFloor: 9_000_000n,
    }),
  /unreasonably high/,
)

// ===========================================================================
// Case H: dust is a property of the destination SCRIPT, not the chain.
// ===========================================================================
console.log('--- Case H: per-script dust limits ---')
{
  const kH2 = deriveAt(btc, 0, 4)
  const uH2 = { txid: 'c4'.repeat(32), vout: 0, value: 100_000n, address: kH2.address, branch: 0, index: 4 }
  const argsH = (toAddress, amount) => ({
    chain: btc, utxos: [uH2], keyFor: () => kH2, toAddress, amount, feeRate: 2n, changeAddress: deriveAt(btc, 1, 0).address,
  })
  checkThrows('H1 300 sat to a legacy p2pkh address refused (546 floor)', () => buildTxV2(argsH('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 300n)), /546/)
  checkThrows('H2 300 sat to a p2sh address refused (540 floor)', () => buildTxV2(argsH('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 300n)), /540/)
  check('H3 300 sat to p2wpkh still builds (294 floor)', buildTxV2(argsH(deriveAt(btc, 0, 5).address, 300n)).amount === 300n)
  check('H4 600 sat to legacy builds', buildTxV2(argsH('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 600n)).amount === 600n)
}

// ===========================================================================
// Case I: the bump verification path with REAL transaction ids. Case G's
// synthetic txids ('d1'.repeat(32)) read the same in both byte orders, which
// hid a reversal bug that broke every Speed up in production: decoded
// outpoints must be the display-order ids that providers serve.
// ===========================================================================
// Case J: a pending transaction must carry OUR signatures before Speed up
// rebuilds it (audit 2026-10-26, C1): the provider chooses which tx it shows
// as pending and serves its bytes, so decodeVerifiedTx alone proves nothing
// about who made it. hwsign.assertSignedByUs verifies every input's witness
// signature against the wallet's own BIP143 digest under our public key.
console.log('--- Case J: a pending tx must be signed by us ---')
{
  const { assertSignedByUs, NOT_OURS } = await import('../src/lib/hwsign.ts')
  const ours = [{ publicKey: kA0.publicKey, value: uA0.value }, { publicKey: kA1.publicKey, value: uA1.value }]
  const refuses = (label, hexStr, inputs) => {
    let msg = ''
    try { assertSignedByUs(btc, hexStr, inputs) } catch (e) { msg = e.message }
    check(label, msg === NOT_OURS, msg || 'accepted!')
  }
  let ok = true
  try { assertSignedByUs(btc, a.hex, ours) } catch { ok = false }
  check('J1 the transaction buildTxV2 signed passes', ok)
  refuses('J2 inputs in the wrong order (keys swapped) → refused', a.hex, [ours[1], ours[0]])
  refuses('J3 a lied-about input value → refused (the digest commits to it)', a.hex, [{ ...ours[0], value: uA0.value + 1n }, ours[1]])
  refuses('J4 one input too few → refused', a.hex, [ours[0]])
  const forged = RawTx.decode(hex.decode(a.hex))
  forged.witnesses = forged.witnesses.map((w, i) => (i === 0 ? [new Uint8Array(72).fill(0x42), kA0.publicKey] : w))
  refuses('J5 a garbage signature with our public key → refused', hex.encode(RawTx.encode(forged)), ours)
  const swapped = RawTx.decode(hex.decode(a.hex))
  swapped.witnesses = [[swapped.witnesses[0][0], kA1.publicKey], swapped.witnesses[1]]
  refuses('J6 a real signature under a different key → refused', hex.encode(RawTx.encode(swapped)), ours)
  const extra = RawTx.decode(hex.decode(a.hex))
  extra.witnesses = [[...extra.witnesses[0], new Uint8Array(1)], extra.witnesses[1]]
  refuses('J7 a witness that is not exactly [signature, key] → refused', hex.encode(RawTx.encode(extra)), ours)
  const stripped = RawTx.decode(hex.decode(a.hex))
  stripped.segwitFlag = false
  stripped.witnesses = undefined
  refuses('J8 witness-stripped bytes → refused', hex.encode(RawTx.encode(stripped)), ours)
  let dogeMsg = ''
  try { assertSignedByUs(CHAINS.doge, a.hex, ours) } catch (e) { dogeMsg = e.message }
  check('J9 a legacy (p2pkh) chain is never sped up from here', dogeMsg === NOT_OURS)
}

console.log('--- Case I: bump verification with non-palindromic txids ---')
{
  const kI = deriveAt(btc, 0, 6)
  const fI = fund(btc, kI, 80_000n, 7) // txid = sha256d(bytes): a real hash
  const reversed = fI.txid.match(/../g).reverse().join('')
  check('I0 funding txid is not a byte palindrome (the test can see order bugs)', reversed !== fI.txid)
  const uI = { txid: fI.txid, vout: 0, value: 80_000n, address: kI.address, branch: 0, index: 6 }
  const origI = buildTxV2({
    chain: btc,
    utxos: [uI],
    keyFor: () => kI,
    toAddress: deriveAt(btc, 0, 9).address,
    amount: 30_000n,
    feeRate: 2n,
    changeAddress: deriveAt(btc, 1, 6).address,
  })
  const decI = decodeVerifiedTx(btc, origI.txid, origI.hex)
  check(
    'I1 decoded outpoint is the funding txid providers know (display order)',
    decI.inputs[0].prevTxid === fI.txid,
    `decoded ${decI.inputs[0].prevTxid.slice(0, 16)}… want ${fI.txid.slice(0, 16)}…`,
  )
  try {
    const prevI = verifiedPrevout(btc, decI.inputs[0].prevTxid, fI.hex, decI.inputs[0].prevVout)
    check('I2 funding tx verifies against the decoded outpoint', prevI.address === kI.address && prevI.value === 80_000n)
    const infoI = verifiedRawTxInfo({ txid: origI.txid, height: null, time: null }, decI, (t, v) =>
      verifiedPrevout(btc, t, fI.hex, v),
    )
    check('I3 fee recomputed end to end from verified bytes', infoI.fee === origI.fee, `fee=${infoI.fee} want=${origI.fee}`)
  } catch (e) {
    check('I2/I3 verified bump chain', false, e.message)
  }
}

// ===========================================================================
// Case D7: Speed up after the 2026-10-27 bug audit (BH5, BM25, BM26, BL1)
// ===========================================================================
console.log('--- Case D7: Speed up — fresh coins, the floor, the rate rule, the node floor ---')
{
  const { assertBumpRules, bumpExtraUtxos } = await import('../src/lib/txbuild.ts')
  const dArgs = {
    chain: btc,
    original: originalD,
    ourAddresses: new Set([kD.address, changeD.address, kExtra.address, bumpChangeD.address]),
    keyFor: (addr) => (addr === kD.address ? kD : null),
    originalUtxos: [uD],
    extraUtxos: [uExtra],
    extraKeyFor: () => kExtra,
    changeAddress: bumpChangeD.address,
  }
  // BM25: an outside spender paid 10 000 sats, so the floor (~10 491) is far
  // above the rate's fee (~1 254) and above the 5 000 recovered from the
  // original. Covering the rate alone stopped before the spare coin and
  // reported "not enough funds"; BM26 then refused the rate anyway.
  let d7a = null
  try {
    d7a = buildBump({ ...dArgs, newFeeRate: 6n, conflictExtraFees: 10_000n })
  } catch (e) {
    d7a = e
  }
  check('D7a a floor above the rate pulls in the spare coin (BM25) and passes the rate rule (BM26)',
    d7a?.hex !== undefined && RawTx.decode(hex.decode(d7a.hex)).inputs.length === 2 && d7a.fee >= origD.fee + 10_000n + BigInt(d7a.vbytes),
    d7a?.message ?? `fee=${d7a?.fee} vbytes=${d7a?.vbytes}`)
  check('D7a ...and balances to the sat', d7a?.hex === undefined || d7a.fee + d7a.amount + d7a.change === uD.value + uExtra.value)
  let d7b = null
  try {
    d7b = buildBump({ ...dArgs, newFeeRate: 3n, absoluteFeeFloor: 12_000n })
  } catch (e) {
    d7b = e
  }
  check('D7b a node-reported floor above the recovered value pulls in the spare coin too', d7b?.hex !== undefined && d7b.fee >= 12_000n, d7b?.message ?? `fee=${d7b?.fee}`)
  checkThrows('D7b ...and with no spare coin it is still "not enough funds", not a bad transaction',
    () => buildBump({ ...dArgs, extraUtxos: [], newFeeRate: 3n, absoluteFeeFloor: 12_000n }), /aren't enough funds/)

  // BM26: the rate rule compares with the original's OWN rate
  const newVsize = 209 // one input more than the original's 141 vB
  let passed = true
  try {
    assertBumpRules(btc, originalD, 10_000n, origD.fee + 10_000n + BigInt(newVsize), newVsize)
  } catch {
    passed = false
  }
  check('D7c a replacement paying the whole floor at a larger size passes (outside spenders count toward the fee, not the rate)', passed)
  checkThrows('D7d a rate at or below the original\'s own is still refused',
    () => assertBumpRules(btc, { ...originalD, fee: 14_100n }, 0n, 14_100n + BigInt(newVsize), newVsize), /isn't higher/)

  // BH5: coins a Speed up may add, from the fresh scan
  const T = (c) => c.repeat(64)
  const state = {
    utxos: [
      { txid: T('1'), vout: 0, value: 1n, confirmed: true },   // spare: kept
      { txid: T('2'), vout: 1, value: 1n, confirmed: false },  // unconfirmed: BIP125 rule 2
      { txid: T('3'), vout: 0, value: 1n, confirmed: true },   // spent by a pending payment C
      { txid: T('a'), vout: 1, value: 1n, confirmed: true },   // an output of the tx being replaced
      { txid: T('4'), vout: 2, value: 1n },                    // confirmation unknown: kept as before
    ],
    rawTxs: [
      { txid: T('c'), height: null, inputs: [{ prevTxid: T('3'), prevVout: 0 }] },
      { txid: T('d'), height: 800_000, inputs: [{ prevTxid: T('4'), prevVout: 2 }] }, // confirmed long ago, so its coin isn't listed anyway
    ],
  }
  const extras = bumpExtraUtxos(state, T('a')).map((u) => u.txid[0])
  check('D7e Speed up adds only confirmed coins no pending payment spends (BH5)', extras.join() === '1,4', extras.join())

  // BL1: the node's floor sits past 200 characters; the provider keeps it
  const { EsploraProvider } = await import('../src/lib/esplora.ts')
  const { replacementFloorFrom } = await import('../src/lib/utxosend.ts')
  const ep = new EsploraProvider({ name: 'mock', kind: 'esplora', base: 'https://esplora.invalid/api', pageSize: 50 }, btc)
  const realFetch = globalThis.fetch
  const answer = (body) => (globalThis.fetch = async () => new Response(body, { status: 400 }))
  const refusal = async () => { try { await ep.broadcast('00'); return '' } catch (e) { return e.message } }
  answer(`sendrawtransaction RPC error: {"code":-26,"message":"insufficient fee, rejecting replacement ${T('b')}; less fees than conflicting txs; 0.00000564 < 0.00001046"}`)
  const m1 = await refusal()
  check('D7f the node\'s floor survives the provider\'s bound (the full body is 216 characters)', replacementFloorFrom(m1, 8) === 1046n, m1)
  check('D7f ...in a short, attributed message', m1.length < 140 && m1.startsWith('mock: '), `${m1.length} chars`)
  answer('x'.repeat(5000))
  const m2 = await refusal()
  check('D7g any other refusal is still cut at 200 characters', m2.length === 'mock: '.length + 200)
  answer(`less fees than conflicting txs; 1 < ${'9'.repeat(400)}`)
  const m3 = await refusal()
  check('D7h a hostile "floor" with hundreds of digits is not taken as one', replacementFloorFrom(m3, 8) === null && m3.length === 'mock: '.length + 200, m3.slice(0, 80))
  globalThis.fetch = realFetch
  check('D7i the floor parser reads exact decimals (no floats)', replacementFloorFrom('…less fees than conflicting txs; 0.1 < 1.23456789', 8) === 123_456_789n && replacementFloorFrom('insufficient fee', 8) === null)

  // BH5 wiring: the modal scans fresh and checks unseen attempts first
  const { readFileSync } = await import('node:fs')
  const bm = readFileSync(new URL('../src/components/BumpModal.tsx', import.meta.url), 'utf8')
  check('D7j Speed up builds from a fresh scan, after the unseen-attempt check, with the fresh coins (no mount-time snapshot)',
    /utxoUnseenBlock\(chain\.id/.test(bm) && /snap = await scanAccount\(account, client\)/.test(bm) && /bumpExtraUtxos\(snap, original\.txid\)/.test(bm) && !/snapRef|accountState/.test(bm))
}

// ===========================================================================
// Case D8: a transaction the data service served in part (bug audit 2026-10-27, BM7)
// ===========================================================================
console.log('--- Case D8: partly served transactions ---')
{
  const me = deriveAt(btc, 0, 0).address
  const big = {
    txid: 'f8'.repeat(32), height: null, time: 1, fee: 500n, rbfSignaled: true, partial: true,
    inputs: [{ address: me, value: 50_000n, prevTxid: 'f9'.repeat(32), prevVout: 0 }],
    outputs: [{ address: 'bc1qsomeoneelse0000000000000000000000000', value: 1_000n }],
  }
  const [row] = classifyTxs([big], new Set([me]), 100)
  check('D8a a partly served transaction is marked partial, so its amount shows as unknown, not a wrong number', row?.partial === true)
  check('D8b ...and is never offered for Speed up (it can\'t be rebuilt)', row?.bumpable === false)
  const [whole] = classifyTxs([{ ...big, partial: undefined }], new Set([me]), 100)
  check('D8c the same transaction served whole is an ordinary row', whole?.partial === undefined && whole?.bumpable === true)
  const csv = txsToCsv(btc, [row]).split('\n')[1]?.split(',') ?? []
  check('D8d the CSV says "unknown", with no amount or counterparty to mislead', csv[1] === 'unknown' && csv[2] === '' && csv[4] === '', csv.join(','))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
