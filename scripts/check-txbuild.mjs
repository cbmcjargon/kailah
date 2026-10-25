// Standalone verification for src/lib/txbuild.ts.
// Run from the repo root: npx tsx scripts/check-txbuild.mjs
// Exits nonzero on any failed assertion.

import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { Address, RawTx, p2pkh, p2wpkh } from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { CHAINS } from '../src/lib/networks.ts'
import { buildTx, isValidAddress } from '../src/lib/txbuild.ts'

let failures = 0
const results = []
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  results.push(line)
  console.log(line)
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

// --- inline key derivation (do NOT import keys.ts) -------------------------
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))

function deriveKey(chain) {
  const node = root.derive(chain.derivationPath)
  if (!node.privateKey || !node.publicKey) throw new Error('derivation failed')
  const payment =
    chain.addressType === 'p2wpkh'
      ? p2wpkh(node.publicKey, chain.network)
      : p2pkh(node.publicKey, chain.network)
  return {
    chain: chain.id,
    address: payment.address,
    path: chain.derivationPath,
    publicKey: node.publicKey,
    privateKey: node.privateKey,
  }
}

// ===========================================================================
// Case A: BTC segwit (mainnet config)
// ===========================================================================
console.log('--- Case A: BTC p2wpkh ---')
const btc = CHAINS.btc
const btcKey = deriveKey(btc)
// Well-known BIP84 test vector for this mnemonic at m/84'/0'/0'/0/0:
check(
  'A0 BIP84 vector address',
  btcKey.address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  btcKey.address,
)
const btcScript = p2wpkh(btcKey.publicKey, btc.network).script

const utxoA = { txid: 'ab'.repeat(32), vout: 0, value: 100000n }
const a = buildTx({
  chain: btc,
  key: btcKey,
  utxos: [utxoA],
  toAddress: btcKey.address,
  amount: 40000n,
  feeRate: 2n,
})
const rawA = RawTx.decode(hex.decode(a.hex))
check('A1 version 2', rawA.version === 2, `version=${rawA.version}`)
check('A2 input count 1', rawA.inputs.length === 1)
check(
  'A3 input txid round-trips',
  hex.encode(rawA.inputs[0].txid) === utxoA.txid,
  hex.encode(rawA.inputs[0].txid),
)
check('A4 RBF sequence 0xfffffffd', rawA.inputs[0].sequence === 0xfffffffd)
check('A5 output count 2', rawA.outputs.length === 2, `outputs=${rawA.outputs.length}`)
const sumA = rawA.outputs.reduce((s, o) => s + o.amount, 0n)
check('A6 outputs + fee = 100000', sumA + a.fee === 100000n, `sum=${sumA} fee=${a.fee}`)
check(
  'A7 fee = vbytes*2 (±4)',
  absBig(a.fee - BigInt(a.vbytes) * 2n) <= 4n,
  `fee=${a.fee} vbytes=${a.vbytes}`,
)
check('A8 delivered amount 40000', a.amount === 40000n)
const changeOutA = rawA.outputs.find((o) => o.amount === a.change)
check(
  'A9 change output pays source address',
  changeOutA !== undefined &&
    hex.encode(changeOutA.script) === hex.encode(btcScript) &&
    rawA.outputs.some((o) => o.amount === 40000n && hex.encode(o.script) === hex.encode(btcScript)),
  `change=${a.change}`,
)
check('A10 txid is 64 hex chars', /^[0-9a-f]{64}$/.test(a.txid), a.txid)
// segwit txid hashes the serialization WITHOUT witness data
const strippedA = RawTx.encode({ ...rawA, segwitFlag: undefined, witnesses: undefined })
check(
  'A11 txid = sha256d(stripped raw).reverse',
  a.txid === hex.encode(sha256(sha256(strippedA)).reverse()),
)

// sendMax: all utxos, single output
const aMax = buildTx({
  chain: btc,
  key: btcKey,
  utxos: [utxoA],
  toAddress: btcKey.address,
  amount: 0n,
  feeRate: 2n,
  sendMax: true,
})
const rawAMax = RawTx.decode(hex.decode(aMax.hex))
check('A12 sendMax output count 1', rawAMax.outputs.length === 1)
check(
  'A13 sendMax amount + fee = 100000',
  aMax.amount + aMax.fee === 100000n && rawAMax.outputs[0].amount === aMax.amount,
  `amount=${aMax.amount} fee=${aMax.fee}`,
)
check('A14 sendMax change 0', aMax.change === 0n)

// dust-change folding: change would be 100000 - 99500 - feeWithChange(282) = 218 < 294
const aDust = buildTx({
  chain: btc,
  key: btcKey,
  utxos: [utxoA],
  toAddress: btcKey.address,
  amount: 99500n,
  feeRate: 2n,
})
const rawADust = RawTx.decode(hex.decode(aDust.hex))
check('A15 dust-change fold: 1 output', rawADust.outputs.length === 1)
check(
  'A16 dust-change fold: fee absorbs remainder',
  aDust.fee === 500n && aDust.change === 0n && aDust.amount === 99500n,
  `fee=${aDust.fee} change=${aDust.change}`,
)

// ===========================================================================
// Case B: DOGE legacy p2pkh
// ===========================================================================
console.log('--- Case B: DOGE p2pkh ---')
const doge = CHAINS.doge
const dogeKey = deriveKey(doge)
check('B0 doge address prefix D', dogeKey.address.startsWith('D'), dogeKey.address)
const dogeScript = p2pkh(dogeKey.publicKey, doge.network).script
const dogeRate = doge.fixedFeeRate // 2000n

// Hand-encode a funding tx paying 5 DOGE to the wallet's p2pkh address.
const fundingRaw = RawTx.encode({
  version: 1,
  segwitFlag: undefined,
  inputs: [
    {
      txid: new Uint8Array(32).fill(0xcd),
      index: 0,
      finalScriptSig: Uint8Array.from([0x51]), // OP_TRUE — parses, tx is final
      sequence: 0xffffffff,
    },
  ],
  outputs: [{ amount: 500000000n, script: dogeScript }],
  witnesses: undefined,
  lockTime: 0,
})
const fundingTxid = hex.encode(sha256(sha256(fundingRaw)).reverse())
check('B1 funding tx parses + txid stable', /^[0-9a-f]{64}$/.test(fundingTxid), fundingTxid)

const utxoB = { txid: fundingTxid, vout: 0, value: 500000000n, rawTxHex: hex.encode(fundingRaw) }
const b = buildTx({
  chain: doge,
  key: dogeKey,
  utxos: [utxoB],
  toAddress: dogeKey.address,
  amount: 100000000n,
  feeRate: dogeRate,
})
const rawB = RawTx.decode(hex.decode(b.hex))
check('B2 version 1', rawB.version === 1, `version=${rawB.version}`)
check('B3 no segwit flag', !rawB.segwitFlag)
check(
  'B4 legacy scriptSig present (sig+pubkey)',
  rawB.inputs[0].finalScriptSig.length >= 100,
  `scriptSig len=${rawB.inputs[0].finalScriptSig.length}`,
)
check(
  'B5 scriptSig ends with our pubkey',
  hex.encode(rawB.inputs[0].finalScriptSig).endsWith(hex.encode(dogeKey.publicKey)),
)
check('B6 sequence 0xffffffff (no RBF)', rawB.inputs[0].sequence === 0xffffffff)
check('B7 output count 2', rawB.outputs.length === 2)
const sumB = rawB.outputs.reduce((s, o) => s + o.amount, 0n)
check('B8 outputs + fee = 500000000', sumB + b.fee === 500000000n, `sum=${sumB} fee=${b.fee}`)
check(
  'B9 fee = vbytes*2000 (±2 vbytes)',
  absBig(b.fee - BigInt(b.vbytes) * dogeRate) <= 2n * dogeRate,
  `fee=${b.fee} vbytes=${b.vbytes}`,
)
const changeOutB = rawB.outputs.find((o) => o.amount === b.change)
check(
  'B10 change pays source, above dust',
  changeOutB !== undefined &&
    hex.encode(changeOutB.script) === hex.encode(dogeScript) &&
    b.change >= doge.dustLimit,
  `change=${b.change}`,
)
check(
  'B11 txid = sha256d(raw).reverse',
  b.txid === hex.encode(sha256(sha256(hex.decode(b.hex))).reverse()),
)

// dust-change fold on DOGE: change would be 500000000-499000000-452000 = 548000 < 1000000
const bDust = buildTx({
  chain: doge,
  key: dogeKey,
  utxos: [utxoB],
  toAddress: dogeKey.address,
  amount: 499000000n,
  feeRate: dogeRate,
})
const rawBDust = RawTx.decode(hex.decode(bDust.hex))
check(
  'B12 doge dust-change fold: 1 output, fee absorbs',
  rawBDust.outputs.length === 1 && bDust.change === 0n && bDust.fee === 1000000n,
  `outputs=${rawBDust.outputs.length} fee=${bDust.fee}`,
)

// sendMax on DOGE
const bMax = buildTx({
  chain: doge,
  key: dogeKey,
  utxos: [utxoB],
  toAddress: dogeKey.address,
  amount: 0n,
  feeRate: dogeRate,
  sendMax: true,
})
const rawBMax = RawTx.decode(hex.decode(bMax.hex))
check(
  'B13 doge sendMax: 1 output, amount+fee=total',
  rawBMax.outputs.length === 1 && bMax.amount + bMax.fee === 500000000n,
  `amount=${bMax.amount} fee=${bMax.fee}`,
)

// missing rawTxHex on legacy chain
checkThrows(
  'B14 missing rawTxHex throws',
  () =>
    buildTx({
      chain: doge,
      key: dogeKey,
      utxos: [{ txid: fundingTxid, vout: 0, value: 500000000n }],
      toAddress: dogeKey.address,
      amount: 100000000n,
      feeRate: dogeRate,
    }),
  /raw funding transaction is missing/i,
)

// ===========================================================================
// Error paths + address validation
// ===========================================================================
console.log('--- Errors & validation ---')
checkThrows(
  'E1 insufficient funds readable (states shortfall in BTC)',
  () =>
    buildTx({
      chain: btc,
      key: btcKey,
      utxos: [utxoA],
      toAddress: btcKey.address,
      amount: 200000n,
      feeRate: 2n,
    }),
  /Insufficient funds.*0\.001\d* BTC more/,
)
checkThrows(
  'E2 insufficient with zero utxos',
  () =>
    buildTx({ chain: btc, key: btcKey, utxos: [], toAddress: btcKey.address, amount: 50000n, feeRate: 2n }),
  /Insufficient funds/i,
)
checkThrows(
  'E3 invalid address rejected',
  () =>
    buildTx({ chain: btc, key: btcKey, utxos: [utxoA], toAddress: 'not-an-address', amount: 40000n, feeRate: 2n }),
  /not a valid Bitcoin address/i,
)
checkThrows(
  'E4 below-dust amount rejected',
  () =>
    buildTx({ chain: btc, key: btcKey, utxos: [utxoA], toAddress: btcKey.address, amount: 100n, feeRate: 2n }),
  /dust/i,
)
checkThrows(
  'E5 DOGE bech32 destination rejected',
  () =>
    buildTx({
      chain: doge,
      key: dogeKey,
      utxos: [utxoB],
      toAddress: btcKey.address,
      amount: 100000000n,
      feeRate: dogeRate,
    }),
  /not a valid Dogecoin address/i,
)
checkThrows(
  'E6 sendMax below dust throws',
  () =>
    buildTx({
      chain: btc,
      key: btcKey,
      utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 400n }],
      toAddress: btcKey.address,
      amount: 0n,
      feeRate: 2n,
      sendMax: true,
    }),
  /too small|dust/i,
)

check('V1 btc bech32 valid on btc', isValidAddress(btcKey.address, btc) === true)
check('V2 doge p2pkh valid on doge', isValidAddress(dogeKey.address, doge) === true)
check('V3 bech32 invalid on doge', isValidAddress(btcKey.address, doge) === false)
check('V4 doge addr invalid on btc', isValidAddress(dogeKey.address, btc) === false)
check('V5 garbage invalid', isValidAddress('hello', btc) === false)
check('V6 empty invalid', isValidAddress('', btc) === false)
check(
  'V7 testnet addr invalid on mainnet',
  isValidAddress(deriveKey(CHAINS['btc-testnet']).address, btc) === false,
)
check(
  'V8 testnet addr valid on testnet',
  isValidAddress(deriveKey(CHAINS['btc-testnet']).address, CHAINS['btc-testnet']) === true,
)
// p2tr destination accepted on BTC (encode a dummy taproot output address)
const trAddr = Address(btc.network).encode({ type: 'tr', pubkey: btcKey.publicKey.slice(1) })
check('V9 p2tr destination valid on btc', isValidAddress(trAddr, btc) === true, trAddr)
const aTr = buildTx({
  chain: btc,
  key: btcKey,
  utxos: [utxoA],
  toAddress: trAddr,
  amount: 40000n,
  feeRate: 2n,
})
check(
  'V10 send-to-p2tr builds, fee consistent',
  absBig(aTr.fee - BigInt(aTr.vbytes) * 2n) <= 4n,
  `fee=${aTr.fee} vbytes=${aTr.vbytes}`,
)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
