// check-hw.mjs — OFFLINE. Hardware signing (docs/hardware-signing.md §10).
//
// Drives the wallet's real Ledger code (src/lib/ledger/*, hwaccount, hwsign,
// prepareTxV2/prepareBump) against scripts/ledger-emulator.mjs — a device-side
// implementation of both Ledger protocols holding the public BIP39 test seed —
// and against a mock signer that only sees standard PSBTv2 bytes parsed by
// @scure/btc-signer. The core claim: a send or RBF bump signed through the
// device path is BYTE-IDENTICAL to the software path's buildTxV2/buildBump.
//
// Run: npx tsx scripts/check-hw.mjs   (part of npm run check:offline)

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { webcrypto } = await import('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const { HDKey } = await import('@scure/bip32')
const { mnemonicToSeedSync } = await import('@scure/bip39')
const { RawTx, Transaction, p2wpkh } = await import('@scure/btc-signer')
const { sha256 } = await import('@noble/hashes/sha2.js')
const { hex } = await import('@scure/base')
const { CHAINS } = await import('../src/lib/networks.ts')
const { deriveAccount } = await import('../src/lib/keys.ts')
const { buildTxV2, buildBump, prepareTxV2, prepareBump, decodeVerifiedTx } = await import('../src/lib/txbuild.ts')
const { fetchPrevTxs, buildSignRequest, assembleSigned, parseDerSignature, encodeDerSignature, SIGNATURE_MISMATCH } =
  await import('../src/lib/hwsign.ts')
const hwacc = await import('../src/lib/hwaccount.ts')
const { hardwareAccount, loadHardwareRecords, saveHardwareRecords } = hwacc
const { importLedgerAccount, verifyAddressOnLedger, ledgerSigner, LedgerError } = await import('../src/lib/ledger/index.ts')
const { makeFrames, FrameReader } = await import('../src/lib/ledger/framing.ts')
const { MerkleTree, ClientCommandInterpreter, WalletPolicy, leafHash, psbtV2Maps, serializePsbt } =
  await import('../src/lib/ledger/btcapp.ts')
const { unlockSecureStore, lockSecureStore, clearSecureStore } = await import('../src/lib/securestore.ts')
const { LedgerEmulator } = await import('./ledger-emulator.mjs')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function rejects(name, fn, test) {
  try {
    await fn()
    check(name, false, 'did not throw')
  } catch (e) {
    const ok = typeof test === 'function' ? test(e) : test.test(e instanceof Error ? e.message : String(e))
    check(name, ok, `${e?.kind ? `[${e.kind}] ` : ''}${e instanceof Error ? e.message : String(e)}`)
  }
}
const kind = (k) => (e) => e instanceof LedgerError && e.kind === k
const cat = (...p) => {
  const out = new Uint8Array(p.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of p) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const DEVICES = {
  btc: { app: 'Bitcoin', coinType: 0 },
  'btc-testnet': { app: 'Bitcoin Test', coinType: 1, testnet: true },
  ltc: { app: 'Litecoin', coinType: 2 },
}
const emu = (id, mnemonic = MN, extra = {}) =>
  new LedgerEmulator({ mnemonic, network: CHAINS[id].network, ...DEVICES[id], ...extra })
const src = (dev) => async () => dev.transport()

// ===========================================================================
console.log('--- A: HID framing ---')
{
  let ok = true
  for (const n of [0, 1, 2, 55, 56, 57, 58, 59, 60, 114, 115, 116, 117, 118, 200, 255, 260, 1000, 4000]) {
    const apdu = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
    const frames = makeFrames(apdu, 0xabcd)
    const r = new FrameReader(0xabcd)
    let out = null
    for (const f of frames) out = r.push(f)
    if (!out || hex.encode(out) !== hex.encode(apdu) || frames.some((f) => f.length !== 64)) ok = false
  }
  check('A1 frames round-trip at every boundary size (0…4000 bytes, 64-byte packets)', ok)
  const f = makeFrames(new Uint8Array(100), 0x1234)
  const bad = (mut) => {
    const r = new FrameReader(0x1234)
    try {
      for (const [i, fr] of f.entries()) r.push(i === 1 ? mut(fr.slice()) : fr)
      return false
    } catch {
      return true
    }
  }
  check('A2 wrong channel refused', bad((x) => ((x[0] = 0x99), x)))
  check('A3 wrong tag refused', bad((x) => ((x[2] = 0x06), x)))
  check('A4 out-of-sequence frame refused', bad((x) => ((x[4] = 0x05), x)))
}

// ===========================================================================
console.log('--- B: merkle tree + client commands ---')
{
  const node = (l, r) => sha256(cat(Uint8Array.of(1), l, r))
  const naive = (ls) => {
    if (ls.length === 0) return new Uint8Array(32)
    if (ls.length === 1) return ls[0]
    let k = 1
    while (k * 2 < ls.length) k *= 2
    return node(naive(ls.slice(0, k)), naive(ls.slice(k)))
  }
  const verify = (lh, i, n, proof, root) => {
    // independent fold: recompute the split path top-down, then hash bottom-up
    const sides = []
    let lo = 0
    let hi = n
    while (hi - lo > 1) {
      let k = 1
      while (k * 2 < hi - lo) k *= 2
      if (i < lo + k) {
        sides.push('L')
        hi = lo + k
      } else {
        sides.push('R')
        lo = lo + k
      }
    }
    if (sides.length !== proof.length) return false
    let h = lh
    proof.forEach((p, d) => {
      h = sides[sides.length - 1 - d] === 'L' ? node(h, p) : node(p, h)
    })
    return hex.encode(h) === hex.encode(root)
  }
  let rootsOk = true
  let proofsOk = true
  for (let n = 0; n <= 70; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash(Uint8Array.of(i, n)))
    const t = new MerkleTree(leaves)
    if (hex.encode(t.root) !== hex.encode(naive(leaves))) rootsOk = false
    for (let i = 0; i < n; i++) if (!verify(leaves[i], i, n, t.proof(i), t.root)) proofsOk = false
  }
  check('B1 roots match an independent recursive reference for 0…70 leaves (empty = 32 zero bytes)', rootsOk)
  check('B2 every leaf proof (leaf-to-root) folds back to the root', proofsOk)

  const cci = new ClientCommandInterpreter()
  const elems = Array.from({ length: 70 }, (_, i) => Uint8Array.of(i))
  const tree = cci.addList(elems)
  const r = cci.execute(cat(Uint8Array.of(0x41), tree.root, Uint8Array.of(70, 0)))
  const total = r[32]
  const first = r[33]
  const more = cci.execute(Uint8Array.of(0xa0))
  check('B3 deep proof: 6 hashes inline, the rest via GET_MORE_ELEMENTS', total === 7 && first === 6 && more[0] === 1 && more[1] === 32)
  const big = Uint8Array.from({ length: 600 }, (_, i) => i & 255)
  cci.addPreimage(big)
  const p = cci.execute(cat(Uint8Array.of(0x40, 0x00), sha256(big)))
  let got = p.slice(4)
  while (got.length < 600) {
    const m = cci.execute(Uint8Array.of(0xa0))
    got = cat(got, m.subarray(2))
  }
  check('B4 600-byte preimage: varint length, 251 inline, rest streamed 1-byte elements', p[0] === 0xfd && p[3] === 251 && hex.encode(got) === hex.encode(big))
  const li = cci.execute(cat(Uint8Array.of(0x42), tree.root, leafHash(Uint8Array.of(42))))
  const miss = cci.execute(cat(Uint8Array.of(0x42), tree.root, leafHash(Uint8Array.of(0xff, 0xff))))
  check('B5 GET_MERKLE_LEAF_INDEX found / not found', li[0] === 1 && li[1] === 42 && miss.length === 2 && miss[0] === 0)
  const leafPre = cci.execute(cat(Uint8Array.of(0x40, 0x00), leafHash(Uint8Array.of(7))))
  check('B6 list elements are served as 0x00 || element', leafPre[0] === 2 && leafPre[1] === 2 && leafPre[2] === 0 && leafPre[3] === 7)
  const y = cci.execute(cat(Uint8Array.of(0x10), Uint8Array.of(1, 2, 3)))
  check('B7 YIELD stores the data and answers empty', y.length === 0 && hex.encode(cci.yielded[0]) === '010203')
}

// ===========================================================================
console.log('--- C: wallet policy ---')
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MN))
const MFP = root.identifier.slice(0, 4)
{
  const xpub = root.derive("m/84'/0'/0'").publicExtendedKey
  const pol = WalletPolicy.defaultWpkh(MFP, [0x80000054, 0x80000000, 0x80000000], xpub)
  check('C1 key info string', pol.keys[0] === `[73c5da0a/84'/0'/0']${xpub}`, pol.keys[0].slice(0, 30))
  const ser = pol.serialize()
  const want = cat(
    Uint8Array.of(0x02, 0x00, 11),
    sha256(new TextEncoder().encode('wpkh(@0/**)')),
    Uint8Array.of(1),
    sha256(cat(Uint8Array.of(0), new TextEncoder().encode(pol.keys[0]))),
  )
  check('C2 serialization: v2 | empty name | len+sha256(template) | 1 key | keys root', hex.encode(ser) === hex.encode(want))
  check('C3 wallet id = sha256(serialization)', hex.encode(pol.id()) === hex.encode(sha256(ser)))
}

// ===========================================================================
console.log('--- D: import + hardware accounts ---')
const hw = {}
const sw = {}
for (const id of ['btc', 'btc-testnet', 'ltc']) {
  const chain = CHAINS[id]
  const dev = emu(id)
  const rec = await importLedgerAccount(id, src(dev))
  hw[id] = hardwareAccount(rec)
  sw[id] = deriveAccount(MN, chain)
  const shown = dev.screens.at(-1)
  check(`D1 ${id}: import made the device show receive 0/0, and stored it`, shown?.kind === 'address' && shown.address === rec.verifiedAddress && rec.verifiedAddress === sw[id].address(0, 0).address, rec.verifiedAddress)
  check(`D2 ${id}: canonical xpub equals the software account's${id === 'ltc' ? ' (assembled from legacy replies, parent fingerprint included)' : ''}`, hw[id].xpubs.xpub === sw[id].xpubs.xpub && hw[id].xpubs.slip132 === sw[id].xpubs.slip132)
  let same = true
  for (const b of [0, 1]) for (let i = 0; i < 8; i++) if (hw[id].address(b, i).address !== sw[id].address(b, i).address) same = false
  check(`D3 ${id}: public derivation matches the seed derivation on both branches`, same)
  check(`D4 ${id}: no private key anywhere in the hardware account`, !('privateKey' in hw[id].address(0, 1)) && rec.masterFingerprint === (DEVICES[id].app === 'Litecoin' ? null : '73c5da0a'))
}
check('D5 BTC vector: m/84\'/0\'/0\'/0/0 = bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', hw.btc.address(0, 0).address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
check('D6 testnet record keeps the device tpub verbatim', hw['btc-testnet'].record.xpub.startsWith('tpub'))
{
  const r = hw.btc.record
  const bad = (name, mut) => {
    let threw = false
    try {
      hardwareAccount(mut({ ...r }))
    } catch {
      threw = true
    }
    check(`D7 record refused: ${name}`, threw)
  }
  bad('wrong network (tpub on mainnet)', (x) => ({ ...x, xpub: hw['btc-testnet'].record.xpub, id: hwacc.hardwareRecordId('btc', hw['btc-testnet'].record.xpub) }))
  bad('private extended key', (x) => {
    const xprv = root.derive("m/84'/0'/0'").privateExtendedKey
    return { ...x, xpub: xprv, id: hwacc.hardwareRecordId('btc', xprv) }
  })
  bad('wrong depth', (x) => {
    const k = root.derive("m/84'/0'").publicExtendedKey
    return { ...x, xpub: k, id: hwacc.hardwareRecordId('btc', k) }
  })
  bad('other account path', (x) => ({ ...x, accountPath: "m/84'/0'/1'" }))
  bad('id not bound to the xpub', (x) => ({ ...x, id: 'ledger:btc:0000000000000000' }))
  bad('verified address not derived by the xpub', (x) => ({ ...x, verifiedAddress: hw.btc.address(0, 1).address }))
  bad('unknown chain', (x) => ({ ...x, chain: 'doge' }))
}

// ===========================================================================
// Funding transactions (some segwit-serialized, to prove witness stripping)
const hexOf = new Map()
const client = { getRawTxHex: async (txid) => hexOf.get(txid) ?? (await Promise.reject(new Error('unknown tx'))) }
let seedByte = 1
function fund(chain, address, value, segwit) {
  const script = p2wpkh(sw[chain.id].address(0, 0).publicKey, chain.network).script
  const outScript = (() => {
    for (const b of [0, 1]) for (let i = 0; i < 20; i++) {
      const k = sw[chain.id].address(b, i)
      if (k.address === address) return p2wpkh(k.publicKey, chain.network).script
    }
    throw new Error('unknown test address')
  })()
  const raw = RawTx.encode({
    version: 2,
    segwitFlag: segwit,
    inputs: [{ txid: new Uint8Array(32).fill(seedByte++), index: 0, finalScriptSig: segwit ? new Uint8Array(0) : Uint8Array.of(0x51), sequence: 0xfffffffd }],
    outputs: [
      { amount: 777n, script },
      { amount: value, script: outScript },
    ],
    witnesses: segwit ? [[new Uint8Array(71).fill(7), new Uint8Array(33).fill(2)]] : undefined,
    lockTime: 0,
  })
  const txid = Transaction.fromRaw(raw, { allowUnknownOutputs: true, disableScriptCheck: true }).id
  hexOf.set(txid, hex.encode(raw))
  return txid
}
function coin(chain, branch, index, value, segwit) {
  const k = sw[chain.id].address(branch, index)
  return { txid: fund(chain, k.address, value, segwit), vout: 1, value, address: k.address, branch, index, confirmed: true }
}

/** Device path end to end: prepare → prevouts → request → device → assemble. */
async function viaDevice(chain, account, unsigned, dev, known) {
  const prev = await fetchPrevTxs(chain, client, unsigned, known)
  const req = buildSignRequest(unsigned, account, prev)
  const sigs = await ledgerSigner(account, src(dev)).sign(req)
  return { built: assembleSigned(unsigned, sigs), req, sigs }
}

/**
 * Mock signer: sees only standard PSBTv2 bytes, parsed by @scure/btc-signer.
 * One adaptation: btc-signer 1.8.1 reads PSBT_IN_PREVIOUS_TXID in display
 * (reversed) order, while BIP-370 — its own test vector, checked in G23 — and
 * Ledger use the raw hash. The wallet follows BIP-370; for btc-signer's parser
 * only that field is flipped. It still binds NON_WITNESS_UTXO to it.
 */
const forBtcSigner = (maps) => ({
  ...maps,
  inputs: maps.inputs.map((m) => new Map([...m].map(([k, v]) => [k, k === '0e' ? v.slice().reverse() : v]))),
})
const mockSigner = {
  async sign(req) {
    const tx = Transaction.fromPSBT(serializePsbt(forBtcSigner(psbtV2Maps(req))))
    const out = []
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      const [[pub, { fingerprint, path }]] = inp.bip32Derivation
      if (fingerprint !== root.fingerprint) throw new Error('mock: foreign fingerprint')
      let k = root
      for (const p of path) k = k.deriveChild(p)
      if (hex.encode(k.publicKey) !== hex.encode(pub)) throw new Error('mock: derivation does not match pubkey')
      if (!inp.nonWitnessUtxo || !inp.witnessUtxo) throw new Error('mock: missing utxo data')
      tx.signIdx(k.privateKey, i)
      out.push({ index: i, publicKey: pub, signature: tx.getInput(i).partialSig[0][1] })
    }
    return out
  },
}

// ===========================================================================
console.log('--- E: sends — device-signed bytes == software bytes ---')
const originals = {}
for (const id of ['btc', 'btc-testnet', 'ltc']) {
  const chain = CHAINS[id]
  const utxos = [coin(chain, 0, 0, 80_000n, true), coin(chain, 0, 3, 50_000n, false), coin(chain, 1, 2, 30_000n, true)]
  const to = sw[id].address(0, 40).address
  for (const [label, amount, feeRate, sendMax] of [
    ['3 inputs + change', 120_000n, 3n, false],
    ['1 input + change', 20_000n, 5n, false],
    ['MAX sweep', 0n, 2n, true],
  ]) {
    const dev = emu(id)
    const soft = buildTxV2({ chain, utxos, keyFor: (u) => sw[id].address(u.branch, u.index), toAddress: to, amount, feeRate, sendMax, changeAddress: sw[id].address(1, 7).address })
    const unsigned = prepareTxV2({ chain, utxos, keyFor: (u) => hw[id].address(u.branch, u.index), toAddress: to, amount, feeRate, sendMax, change: hw[id].address(1, 7) })
    check(`E1 ${id} ${label}: review summary equals the software build`, unsigned.amount === soft.amount && unsigned.fee === soft.fee && unsigned.change === soft.change && unsigned.toAddress === soft.toAddress)
    const { built, req } = await viaDevice(chain, hw[id], unsigned, dev)
    check(`E2 ${id} ${label}: device-signed tx is byte-identical to buildTxV2`, built.hex === soft.hex && built.txid === soft.txid, `${built.txid.slice(0, 16)}…`)
    const screen = dev.screens.at(-1)
    check(`E3 ${id} ${label}: the device displayed exactly the review screen (recipient, amount, fee; change hidden)`, screen?.kind === 'tx' && json(screen.outputs) === json([{ address: to, amount: unsigned.amount }]) && screen.fee === unsigned.fee)
    check(`E4 ${id} ${label}: size estimate is an upper bound`, unsigned.vbytesEstimate >= built.vbytes, `${unsigned.vbytesEstimate} ≥ ${built.vbytes}`)
    if (id !== 'ltc') {
      const viaMock = assembleSigned(unsigned, await mockSigner.sign(req))
      check(`E5 ${id} ${label}: PSBTv2 parsed by @scure/btc-signer and signed from it — same bytes`, viaMock.hex === soft.hex)
    }
    if (label === '3 inputs + change') originals[id] = { soft, utxos }
  }
}

// Several coins from ONE segwit funding tx (change + receive in the same tx is
// the common case): the funding tx is fetched once and re-verified per coin.
{
  const chain = CHAINS.btc
  const k0 = sw.btc.address(0, 11)
  const k1 = sw.btc.address(1, 11)
  const raw = RawTx.encode({
    version: 2,
    segwitFlag: true,
    inputs: [{ txid: new Uint8Array(32).fill(0xab), index: 1, finalScriptSig: new Uint8Array(0), sequence: 0xfffffffd }],
    outputs: [
      { amount: 45_000n, script: p2wpkh(k1.publicKey, chain.network).script },
      { amount: 70_000n, script: p2wpkh(k0.publicKey, chain.network).script },
    ],
    witnesses: [[new Uint8Array(72).fill(5), new Uint8Array(33).fill(3)]],
    lockTime: 0,
  })
  const txid = Transaction.fromRaw(raw, { allowUnknownOutputs: true, disableScriptCheck: true }).id
  hexOf.set(txid, hex.encode(raw))
  const utxos = [
    { txid, vout: 1, value: 70_000n, address: k0.address, branch: 0, index: 11, confirmed: true },
    { txid, vout: 0, value: 45_000n, address: k1.address, branch: 1, index: 11, confirmed: true },
  ]
  const to = sw.btc.address(0, 42).address
  const soft = buildTxV2({ chain, utxos, keyFor: (u) => sw.btc.address(u.branch, u.index), toAddress: to, amount: 100_000n, feeRate: 2n, changeAddress: sw.btc.address(1, 12).address })
  const unsigned = prepareTxV2({ chain, utxos, keyFor: (u) => hw.btc.address(u.branch, u.index), toAddress: to, amount: 100_000n, feeRate: 2n, change: hw.btc.address(1, 12) })
  let fetches = 0
  const counting = { getRawTxHex: async (id) => (fetches++, hexOf.get(id)) }
  const prev = await fetchPrevTxs(chain, counting, unsigned)
  const sigs = await ledgerSigner(hw.btc, src(emu('btc'))).sign(buildSignRequest(unsigned, hw.btc, prev))
  check('E6 btc: two coins of one segwit funding tx — fetched once, both verified, bytes identical', fetches === 1 && assembleSigned(unsigned, sigs).hex === soft.hex, `fetches=${fetches}`)
}

// ===========================================================================
console.log('--- F: RBF bumps — device-signed bytes == buildBump ---')
for (const id of ['btc', 'ltc']) {
  const chain = CHAINS[id]
  const { soft, utxos } = originals[id]
  const dec = decodeVerifiedTx(chain, soft.txid, soft.hex)
  const byOut = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]))
  check(
    `F0 ${id}: decodeVerifiedTx reports outpoints as display txids (regression: they came back byte-reversed)`,
    dec.inputs.every((i) => byOut.has(`${i.prevTxid}:${i.prevVout}`)) && utxos.some((u) => u.txid !== u.txid.match(/../g).reverse().join('')),
  )
  const original = {
    txid: soft.txid,
    height: null,
    time: null,
    fee: soft.fee,
    rbfSignaled: dec.rbfSignaled,
    inputs: dec.inputs.map((i) => ({ ...i, address: byOut.get(`${i.prevTxid}:${i.prevVout}`).address, value: byOut.get(`${i.prevTxid}:${i.prevVout}`).value })),
    outputs: dec.outputs,
  }
  const ours = new Set()
  for (const b of [0, 1]) for (let i = 0; i < 12; i++) ours.add(sw[id].address(b, i).address)
  const find = (acct) => (addr) => {
    for (const b of [0, 1]) for (let i = 0; i < 12; i++) if (acct.address(b, i).address === addr) return acct.address(b, i)
    return null
  }
  const extra = [coin(chain, 0, 5, 60_000n, true)]
  for (const [label, rate, extras, conflict] of [
    ['higher rate', 10n, [], 0n],
    ['needs an extra input', 60n, extra, 0n],
    ['outbids an outside spender', 12n, [], 3_000n],
  ]) {
    const common = { chain, original, ourAddresses: ours, originalUtxos: [], extraUtxos: extras, newFeeRate: rate, conflictExtraFees: conflict }
    const softBump = buildBump({ ...common, keyFor: find(sw[id]), extraKeyFor: (u) => sw[id].address(u.branch, u.index), changeAddress: sw[id].address(1, 8).address })
    const unsigned = prepareBump({ ...common, keyFor: find(hw[id]), extraKeyFor: (u) => hw[id].address(u.branch, u.index), change: hw[id].address(1, 8) })
    const dev = emu(id)
    const { built } = await viaDevice(chain, hw[id], unsigned, dev)
    check(`F1 ${id} bump (${label}): device-signed replacement is byte-identical to buildBump`, built.hex === softBump.hex && built.fee === softBump.fee, `fee ${built.fee}`)
    check(`F2 ${id} bump (${label}): device showed the recipient and the new fee`, json(dev.screens.at(-1).outputs) === json([{ address: soft.toAddress, amount: soft.amount }]) && dev.screens.at(-1).fee === softBump.fee)
  }
}

// ===========================================================================
console.log('--- G: refusals ---')
{
  const id = 'btc'
  const chain = CHAINS[id]
  const utxos = [coin(chain, 0, 1, 90_000n, true), coin(chain, 1, 4, 40_000n, true)]
  const to = sw[id].address(0, 41).address
  const plan = () => prepareTxV2({ chain, utxos, keyFor: (u) => hw[id].address(u.branch, u.index), toAddress: to, amount: 100_000n, feeRate: 4n, change: hw[id].address(1, 9) })
  const signed = async (dev, unsigned = plan()) => {
    const prev = await fetchPrevTxs(chain, client, unsigned)
    return { unsigned, sigs: await ledgerSigner(hw[id], src(dev)).sign(buildSignRequest(unsigned, hw[id], prev)) }
  }
  for (const proto of ['btc', 'ltc']) {
    const dev = emu(proto, MN, { tamper: 'digest' })
    if (proto === 'btc') {
      const { unsigned, sigs } = await signed(dev)
      await rejects('G1 Bitcoin app signing a different digest is refused', () => assembleSigned(unsigned, sigs), (e) => e.message === SIGNATURE_MISMATCH)
    } else {
      const ltc = CHAINS.ltc
      const lu = [coin(ltc, 0, 2, 70_000n, true)]
      const unsigned = prepareTxV2({ chain: ltc, utxos: lu, keyFor: (u) => hw.ltc.address(u.branch, u.index), toAddress: sw.ltc.address(0, 41).address, amount: 30_000n, feeRate: 3n, change: hw.ltc.address(1, 9) })
      const prev = await fetchPrevTxs(ltc, client, unsigned)
      const sigs = await ledgerSigner(hw.ltc, src(dev)).sign(buildSignRequest(unsigned, hw.ltc, prev))
      await rejects('G2 Litecoin app signing a different digest is refused', () => assembleSigned(unsigned, sigs), (e) => e.message === SIGNATURE_MISMATCH)
      const dev2 = emu('ltc', MN, { tamper: 'trusted-amount' })
      await rejects('G3 Litecoin trusted input with another amount is refused before signing', () => ledgerSigner(hw.ltc, src(dev2)).sign(buildSignRequest(unsigned, hw.ltc, prev)), /different coin/)
    }
  }
  const good = await signed(emu(id))
  await rejects('G4 signatures swapped between inputs are refused', () => assembleSigned(good.unsigned, good.sigs.map((s, i, a) => ({ ...a[(i + 1) % a.length], index: s.index }))), (e) => e.message === SIGNATURE_MISMATCH)
  await rejects('G5 a missing signature is refused', () => assembleSigned(good.unsigned, good.sigs.slice(1)), (e) => e.message === SIGNATURE_MISMATCH)
  await rejects('G6 a duplicate / out-of-range index is refused', () => assembleSigned(good.unsigned, [...good.sigs, { ...good.sigs[0], index: 5 }]), (e) => e.message === SIGNATURE_MISMATCH)
  await rejects('G7 a signature under the wrong public key is refused', () => assembleSigned(good.unsigned, good.sigs.map((s) => ({ ...s, publicKey: hw.btc.address(0, 9).publicKey }))), (e) => e.message === SIGNATURE_MISMATCH)
  {
    // high-S: same signature, s → n − s. Valid ECDSA, non-standard; normalized.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const flip = (sig) => {
      const { r, s } = parseDerSignature(sig.subarray(0, -1))
      return cat(encodeDerSignature(r, N - s), Uint8Array.of(1))
    }
    const normal = assembleSigned(good.unsigned, good.sigs)
    const fromHigh = assembleSigned(good.unsigned, good.sigs.map((s) => ({ ...s, signature: flip(s.signature) })))
    check('G8 a high-S signature is normalized to low-S (same final bytes)', fromHigh.hex === normal.hex)
    const padded = good.sigs.map((s) => {
      const d = s.signature
      return { ...s, signature: cat(Uint8Array.of(0x30, d[1] + 1, 0x02, d[3] + 1, 0x00), d.subarray(4)) }
    })
    await rejects('G9 non-canonical DER is refused', () => assembleSigned(good.unsigned, padded), (e) => e.message === SIGNATURE_MISMATCH)
    const sighashNone = good.sigs.map((s) => ({ ...s, signature: cat(s.signature.subarray(0, -1), Uint8Array.of(2)) }))
    await rejects('G10 a non-SIGHASH_ALL signature is refused', () => assembleSigned(good.unsigned, sighashNone), (e) => e.message === SIGNATURE_MISMATCH)
  }
  {
    const u = plan()
    const liar = { getRawTxHex: async (txid) => (txid === u.inputs[0].txid ? hexOf.get(u.inputs[1].txid) : hexOf.get(txid)) }
    await rejects('G11 a provider returning the wrong funding tx is refused', () => fetchPrevTxs(chain, liar, u), /wrong transaction/)
    const inflated = { ...u, inputs: u.inputs.map((x, i) => (i === 0 ? { ...x, value: x.value + 1000n } : x)) }
    await rejects('G12 a scan that disagrees with the funding tx is refused', () => fetchPrevTxs(chain, client, inflated), /isn't what the scan reported/)
  }
  const prev = await fetchPrevTxs(chain, client, plan())
  const req = buildSignRequest(plan(), hw.btc, prev)
  await rejects('G13 a different Ledger (other seed) is refused before signing', () => ledgerSigner(hw.btc, src(emu('btc', OTHER))).sign(req), kind('wrong-device'))
  await rejects('G14 the same seed on a Litecoin account check: other seed refused', () => verifyAddressOnLedger(hw.ltc, 0, 0, src(emu('ltc', OTHER))), kind('wrong-device'))
  const rejecting = emu('btc')
  rejecting.approve = false
  await rejects('G15 user rejects on the Bitcoin app → "rejected"', () => ledgerSigner(hw.btc, src(rejecting)).sign(req), kind('rejected'))
  const rejectingLtc = emu('ltc')
  rejectingLtc.approve = false
  await rejects('G16 user rejects on the Litecoin app → "rejected"', () => verifyAddressOnLedger(hw.ltc, 0, 3, src(rejectingLtc)), kind('rejected'))
  const locked = emu('btc')
  locked.locked = true
  await rejects('G17 locked device → "locked"', () => ledgerSigner(hw.btc, src(locked)).sign(req), kind('locked'))
  await rejects('G18 dashboard instead of the app → "wrong-app"', () => ledgerSigner(hw.btc, src(emu('btc', MN, { app: 'BOLOS', version: '2.2.3' }))).sign(req), kind('wrong-app'))
  await rejects('G19 another app open → "wrong-app"', () => importLedgerAccount('btc', src(emu('btc', MN, { app: 'Ethereum', version: '1.10.4' }))), (e) => kind('wrong-app')(e) && /Ethereum/.test(e.message))
  await rejects('G20 Bitcoin app older than 2.1 → "app-too-old"', () => importLedgerAccount('btc', src(emu('btc', MN, { version: '2.0.6' }))), kind('app-too-old'))
  await rejects('G21 testnet account on the mainnet Bitcoin app → "wrong-app"', () => importLedgerAccount('btc-testnet', src(emu('btc'))), kind('wrong-app'))
  let threw = false
  try {
    prepareTxV2({ chain: CHAINS.doge, utxos: [], keyFor: () => null, toAddress: 'D', amount: 1n, feeRate: 1n, change: hw.btc.address(1, 0) })
  } catch (e) {
    threw = /native segwit only/.test(e.message)
  }
  check('G22 non-segwit chains are refused by the hardware path', threw)

  // BIP-370's own valid-PSBTv2 vector: its PSBT_IN_PREVIOUS_TXID equals the raw
  // sha256d of its NON_WITNESS_UTXO (internal byte order). Ours must too.
  const v = Buffer.from(
    'cHNidP8BAgQCAAAAAQQBAQEFAQIB+wQCAAAAAAEAUgIAAAABwaolbiFLlqGCL5PeQr/ztfP/jQUZMG41FddRWl6AWxIAAAAAAP////8BGMaaOwAAAAAWABSwo68UQghBJpPKfRZoUrUtsK7wbgAAAAABAR8Yxpo7AAAAABYAFLCjrxRCCEEmk8p9FmhStS2wrvBuAQ4gCwrZIUGcHIcZc11y3HOfnqngY40f5MHu8PmUQISBX8gBDwQAAAAAAQMIAAivLwAAAAABBBYAFMQw9kj8hWPZRMEtc6j1h7PMVTwWAAEDCIEhAQAAAAAAAQQWABSZNZWi1UrWcAvbqL0Vyn5HeKkXzQA=',
    'base64',
  ).toString('hex')
  const at = v.indexOf('0100520200')
  const vTx = hex.decode(v.slice(at + 6, at + 6 + 0x52 * 2))
  const vField = v.slice(v.indexOf('010e20') + 6, v.indexOf('010e20') + 70)
  const ours = psbtV2Maps(req).inputs[0]
  check(
    'G23 PSBT_IN_PREVIOUS_TXID uses BIP-370 byte order (raw sha256d, as in the BIP\'s own vector)',
    vField === hex.encode(sha256(sha256(vTx))) && hex.encode(ours.get('0e')) === hex.encode(sha256(sha256(ours.get('00')))),
  )
}

// ===========================================================================
console.log('--- H: on-device address verification ---')
for (const id of ['btc', 'btc-testnet', 'ltc']) {
  const dev = emu(id)
  await verifyAddressOnLedger(hw[id], 0, 6, src(dev))
  check(`H1 ${id}: the device displayed receive 0/6 and it matched`, dev.screens.at(-1)?.address === sw[id].address(0, 6).address)
}

// ===========================================================================
console.log('--- I: storage, lock, erase ---')
{
  await unlockSecureStore(MN)
  const recs = [hw.btc.record, hw.ltc.record]
  saveHardwareRecords(recs)
  await new Promise((r) => setTimeout(r, 50))
  const blob = localStorage.getItem('kailah.sec.hwaccounts')
  check('I1 records persist only as ciphertext (no xpub in the clear)', blob !== null && !blob.includes(hw.btc.record.xpub.slice(4, 20)) && !blob.includes('ledger:'))
  lockSecureStore()
  check('I2 locked: nothing readable', loadHardwareRecords().length === 0)
  await unlockSecureStore(MN)
  check('I3 unlocked again: both records come back intact', json(loadHardwareRecords()) === json(recs))
  saveHardwareRecords([...recs, { ...hw.btc.record, verifiedAddress: 'bc1qforged' }])
  check('I4 an inconsistent record is dropped on load, the rest survive', loadHardwareRecords().length === 2)
  await new Promise((r) => setTimeout(r, 50))
  clearSecureStore()
  check('I5 erase removes kailah.sec.hwaccounts', localStorage.getItem('kailah.sec.hwaccounts') === null && [...store.keys()].every((k) => !k.startsWith('kailah.sec.')))
}

console.log(`\n${failures === 0 ? 'ALL HARDWARE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
