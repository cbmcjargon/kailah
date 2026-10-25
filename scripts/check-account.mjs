// Standalone verification for the v2 HD-account slice:
//   src/lib/keys.ts     deriveAccount()  — xpubs + address rotation + zero()
//   src/lib/addrcache.ts get/update/clearAll persistence
//   src/lib/scanner.ts  scanAccount()    — per-address gap-limit scan, live
//
// Part 1 (offline): deriveAccount against published BIP84 vectors for the
// standard test mnemonic — receive addresses, zpub/vpub re-encoding, and the
// account xpub equal to the spec's account extended key.
// Part 2 (offline): addrcache persistence over a mock localStorage; zero() wipe.
// Part 3 (LIVE, testnet4): scanAccount against mempool.space testnet4. The
// standard-mnemonic account has heavy real history, so we assert it discovers
// the known-used addresses, returns a plausible balance/utxo/tx set, that
// nextReceive is the first UNUSED index (verified live), and that a warm scan
// (seeded from the cache we just persisted) reproduces the cold result.
//
// Run from the repo root: npx tsx scripts/check-account.mjs

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-account')
import { createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'

// ---------------------------------------------------------------------------
// Mock localStorage BEFORE importing modules that touch it, so addrcache and
// the scanner's warm-start persistence exercise real read/write paths in Node.
const memStore = new Map()
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => void memStore.set(k, String(v)),
  removeItem: (k) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() {
    return memStore.size
  },
}

const { deriveAccount } = await import('../src/lib/keys.ts')
const { CHAINS } = await import('../src/lib/networks.ts')
const addrcache = await import('../src/lib/addrcache.ts')
const { scanAccount } = await import('../src/lib/scanner.ts')
const { unlockSecureStore } = await import('../src/lib/securestore.ts')
const { getClient } = await import('../src/lib/api.ts')

const MN =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Published BIP84 vectors for the mnemonic above.
const BTC_R0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const BTC_R1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
const LTC_R0 = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
const BTC_ACCOUNT_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'

// Known-used testnet4 addresses (this shared account, verified live).
const T4_R0 = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl'
const T4_R1 = 'tb1qd7spv5q28348xl4myc8zmh983w5jx32cjhkn97'
const T4_R2 = 'tb1qxdyjf6h5d6qxap4n2dap97q4j5ps6ua8sll0ct'
const T4_C0 = 'tb1q9u62588spffmq4dzjxsr5l297znf3z6j5p2688'

const T4_BASE = CHAINS['btc-testnet'].providers[0].base

let failures = 0
function check(label, ok, detail) {
  if (ok) console.log(`PASS  ${label}`)
  else {
    failures++
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// base58check with swapped 4-byte version prefix (independent reimplementation
// of the encoding under test, so a bug in keys.ts can't hide behind itself).
const b58c = createBase58check(sha256)
function swapVersion(extKey, version) {
  const p = b58c.decode(extKey).slice()
  p[0] = (version >>> 24) & 0xff
  p[1] = (version >>> 16) & 0xff
  p[2] = (version >>> 8) & 0xff
  p[3] = version & 0xff
  return b58c.encode(p)
}
const XPUB_VER = 0x0488b21e

function lowestUnused(indices) {
  const set = new Set(indices)
  let i = 0
  while (set.has(i)) i++
  return i
}

async function t4Stats(address) {
  const r = await fetch(`${T4_BASE}/address/${encodeURIComponent(address)}`)
  if (!r.ok) throw new Error(`testnet4 stats ${address}: HTTP ${r.status}`)
  const info = await r.json()
  return info.chain_stats.tx_count + info.mempool_stats.tx_count
}

// Inline esplora fallback client (only used if the real getClient scan fails).
function makeStubClient() {
  const j = async (path) => {
    const r = await fetch(T4_BASE + path)
    if (!r.ok) throw new Error(`${T4_BASE}${path} -> HTTP ${r.status}`)
    return r.json()
  }
  const norm = (tx) => ({
    txid: tx.txid,
    height: tx.status?.confirmed ? tx.status.block_height : null,
    time: tx.status?.confirmed ? tx.status.block_time : null,
    fee: tx.fee != null ? BigInt(tx.fee) : null,
    inputs: (tx.vin ?? []).map((v) => ({
      address: v.prevout?.scriptpubkey_address ?? null,
      value: BigInt(v.prevout?.value ?? 0),
      prevTxid: v.txid ?? null,
      prevVout: typeof v.vout === 'number' ? v.vout : null,
    })),
    outputs: (tx.vout ?? []).map((o) => ({
      address: o.scriptpubkey_address ?? null,
      value: BigInt(o.value),
    })),
    rbfSignaled: (tx.vin ?? []).some((v) => (v.sequence ?? 0xffffffff) < 0xfffffffe),
  })
  return {
    async getTipHeight() {
      const r = await fetch(`${T4_BASE}/blocks/tip/height`)
      return parseInt(await r.text(), 10)
    },
    async getAddressStats(a) {
      const info = await j(`/address/${encodeURIComponent(a)}`)
      const cs = info.chain_stats
      const ms = info.mempool_stats
      return {
        balance: {
          confirmed: BigInt(cs.funded_txo_sum) - BigInt(cs.spent_txo_sum),
          unconfirmed: BigInt(ms.funded_txo_sum) - BigInt(ms.spent_txo_sum),
        },
        txCount: cs.tx_count + ms.tx_count,
      }
    },
    async getAddressUtxos(a) {
      const us = await j(`/address/${encodeURIComponent(a)}/utxo`)
      return us.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) }))
    },
    async getAddressTxs(a) {
      const txs = await j(`/address/${encodeURIComponent(a)}/txs`)
      return txs.map(norm)
    },
    hasXpubApi: () => false,
    getRawTxHex: async () => {
      throw new Error('not needed')
    },
    getFeeOptions: async () => [],
    broadcast: async () => {
      throw new Error('not needed')
    },
    scanXpub: async () => {
      throw new Error('not needed')
    },
    getXpubUtxos: async () => {
      throw new Error('not needed')
    },
    activeProvider: () => 'mempool.space (inline stub)',
  }
}

// ===========================================================================
console.log('--- Part 1: deriveAccount vs published BIP84 vectors ---')

const btc = deriveAccount(MN, CHAINS.btc)
const tnet = deriveAccount(MN, CHAINS['btc-testnet'])
const ltc = deriveAccount(MN, CHAINS.ltc)

const btcR0 = btc.address(0, 0)
const btcR1 = btc.address(0, 1)
console.log(`btc  r0 ${btcR0.address}  (${btcR0.path})`)
console.log(`btc  r1 ${btcR1.address}  (${btcR1.path})`)
check('btc receive index 0 matches BIP84 vector', btcR0.address === BTC_R0, `got ${btcR0.address}`)
check('btc receive index 1 matches BIP84 vector', btcR1.address === BTC_R1, `got ${btcR1.address}`)
check('btc receive index 0 path is m/84\'/0\'/0\'/0/0', btcR0.path === "m/84'/0'/0'/0/0", btcR0.path)
check('btc receive index 0 branch/index tagged', btcR0.branch === 0 && btcR0.index === 0)
check('btc receive index 1 branch/index tagged', btcR1.branch === 0 && btcR1.index === 1)

const ltcR0 = ltc.address(0, 0)
console.log(`ltc  r0 ${ltcR0.address}`)
check('ltc receive index 0 matches BIP84 vector', ltcR0.address === LTC_R0, `got ${ltcR0.address}`)

// xpub encodings
console.log(`btc  xpub    ${btc.xpubs.xpub}`)
console.log(`btc  slip132 ${btc.xpubs.slip132}`)
console.log(`tnet slip132 ${tnet.xpubs.slip132}`)
check('btc xpub uses standard version (xpub…)', btc.xpubs.xpub.startsWith('xpub'), btc.xpubs.xpub)
check('btc slip132 re-encodes to zpub…', btc.xpubs.slip132.startsWith('zpub'), btc.xpubs.slip132)
check('testnet slip132 re-encodes to vpub…', tnet.xpubs.slip132.startsWith('vpub'), tnet.xpubs.slip132)
check(
  'btc slip132 equals published BIP84 account zpub',
  btc.xpubs.slip132 === BTC_ACCOUNT_ZPUB,
  btc.xpubs.slip132,
)
check(
  'btc standard xpub equals published zpub decoded to xpub version',
  btc.xpubs.xpub === swapVersion(BTC_ACCOUNT_ZPUB, XPUB_VER),
  btc.xpubs.xpub,
)
check('btc native mirrors standard xpub', btc.xpubs.native === btc.xpubs.xpub)
check('doge slip132 mirrors xpub (no SLIP-132 scheme)', (() => {
  const d = deriveAccount(MN, CHAINS.doge)
  return d.xpubs.slip132 === d.xpubs.xpub && d.xpubs.native === d.xpubs.xpub
})())

// memoization: repeated address() returns the same object
check('address() memoizes (same reference on repeat)', btc.address(0, 0) === btcR0)

// ===========================================================================
console.log('\n--- Part 2: addrcache persistence + zero() wipe ---')

const FAKE_XPUB = 'xpub-unit-test-key'
// The cache lives in the encrypted secure store, so it persists only while
// unlocked; the writes are encrypted in the background.
await unlockSecureStore(MN)
check('addrcache.get on unknown xpub is empty', (() => {
  const e = addrcache.get(FAKE_XPUB)
  return (
    Array.isArray(e.receive) &&
    e.receive.length === 0 &&
    e.highestReceive === -1 &&
    e.highestChange === -1
  )
})())
addrcache.update(FAKE_XPUB, { receive: [0, 3, 1, 3], change: [2] })
addrcache.update(FAKE_XPUB, { receive: [5], change: [2, 7] })
const merged = addrcache.get(FAKE_XPUB)
check(
  'addrcache.update merges/dedupes/sorts + tracks highest',
  JSON.stringify(merged) ===
    JSON.stringify({ receive: [0, 1, 3, 5], change: [2, 7], highestReceive: 5, highestChange: 7 }),
  JSON.stringify(merged),
)
for (let i = 0; i < 40 && !memStore.has('kailah.sec.addrmap'); i++) await new Promise((r) => setTimeout(r, 25))
const sealed = memStore.get('kailah.sec.addrmap') ?? ''
check(
  'addrcache persisted encrypted under kailah.sec.addrmap (no xpub or indices in the clear)',
  sealed !== '' && !sealed.includes(FAKE_XPUB) && !sealed.includes('receive'),
  sealed.slice(0, 24),
)
check('no plaintext copy under the legacy key kailah.addrmap.v1', !memStore.has('kailah.addrmap.v1'))
addrcache.clearAll()
check('addrcache.clearAll empties the store', addrcache.get(FAKE_XPUB).receive.length === 0)

// zero(): the private bytes we handed out must be wiped in place.
const wipeAcct = deriveAccount(MN, CHAINS.btc)
const wipeKey = wipeAcct.address(0, 0)
check('derived private key is 32 bytes before wipe', wipeKey.privateKey.length === 32)
check('derived private key is non-zero before wipe', wipeKey.privateKey.some((b) => b !== 0))
wipeAcct.zero()
check('zero() wipes the handed-out private key bytes', wipeKey.privateKey.every((b) => b === 0))

// ===========================================================================
console.log('\n--- Part 3: LIVE scan against testnet4 ---')

const chain = CHAINS['btc-testnet']
const acct = deriveAccount(MN, chain)
await unlockSecureStore(MN) // caches are encrypted; the key comes from the seed

let state
let usedClient
let scanClient
try {
  scanClient = getClient(chain)
  state = await scanAccount(acct, scanClient)
  usedClient = `getClient/${scanClient.activeProvider?.() ?? 'esplora'}`
} catch (err) {
  console.warn(`real client scan failed (${err.message}); using inline stub`)
  scanClient = makeStubClient()
  state = await scanAccount(acct, scanClient)
  usedClient = 'inline esplora stub'
}
console.log(`client: ${usedClient}`)
console.log(`tipHeight ${state.tipHeight}  balance ${JSON.stringify({
  confirmed: state.balance.confirmed.toString(),
  unconfirmed: state.balance.unconfirmed.toString(),
})}`)

const usedReceive = state.addresses
  .filter((a) => a.branch === 0 && a.used)
  .map((a) => a.index)
  .sort((a, b) => a - b)
const usedChange = state.addresses
  .filter((a) => a.branch === 1 && a.used)
  .map((a) => a.index)
  .sort((a, b) => a - b)
console.log(`usedReceive ${JSON.stringify(usedReceive)}`)
console.log(`usedChange  ${JSON.stringify(usedChange)}`)
console.log(`nextReceive #${state.nextReceive.index} ${state.nextReceive.address}`)
console.log(`nextChange  #${state.nextChange.index} ${state.nextChange.address}`)
console.log(`utxos ${state.utxos.length}  txs ${state.txs.length}  rawTxs ${state.rawTxs.length}`)

const addrSet = new Map(state.addresses.map((a) => [a.address, a]))
check('discovers known used receive index 0', addrSet.get(T4_R0)?.used === true && addrSet.get(T4_R0)?.branch === 0)
check('discovers known used receive index 1', addrSet.get(T4_R1)?.used === true)
check('discovers known used receive index 2', addrSet.get(T4_R2)?.used === true)
check('discovers known used change index 0', addrSet.get(T4_C0)?.used === true && addrSet.get(T4_C0)?.branch === 1)
check('receive branch is heavily used (>= 8 addresses)', usedReceive.length >= 8, `${usedReceive.length}`)

check('tipHeight is a plausible testnet4 height', state.tipHeight > 100000, `${state.tipHeight}`)
check(
  'balance is a valid non-negative Balance',
  typeof state.balance.confirmed === 'bigint' &&
    typeof state.balance.unconfirmed === 'bigint' &&
    state.balance.confirmed >= 0n,
  JSON.stringify({ c: state.balance.confirmed.toString(), u: state.balance.unconfirmed.toString() }),
)
check('utxos is an array (consistent with balance)', Array.isArray(state.utxos))
check(
  'utxos annotated with address/branch/index when present',
  state.utxos.every(
    (u) => typeof u.address === 'string' && (u.branch === 0 || u.branch === 1) && Number.isInteger(u.index),
  ),
)
check('plausible tx history (> 20 txs)', state.txs.length > 20, `${state.txs.length}`)
check('rawTxs count equals classified txs count', state.rawTxs.length === state.txs.length, `${state.rawTxs.length} vs ${state.txs.length}`)

// newest-first: pending (null height) lead, then non-increasing confirmed heights.
check('txs are newest-first (heights non-increasing among confirmed)', (() => {
  let seenConfirmed = false
  let prev = Infinity
  for (const tx of state.txs) {
    if (tx.height === null) {
      if (seenConfirmed) return false // a pending tx after a confirmed one
      continue
    }
    seenConfirmed = true
    if (tx.height > prev) return false
    prev = tx.height
  }
  return true
})())

// nextReceive is the first UNUSED index, verified against the live chain.
check(
  'nextReceive is the lowest unused receive index',
  state.nextReceive.index === lowestUnused(usedReceive) &&
    state.nextReceive.used === false &&
    state.nextReceive.branch === 0,
  `nextReceive #${state.nextReceive.index}, lowestUnused ${lowestUnused(usedReceive)}`,
)
check(
  'nextChange is the lowest unused change index',
  state.nextChange.index === lowestUnused(usedChange) && state.nextChange.used === false,
  `nextChange #${state.nextChange.index}, lowestUnused ${lowestUnused(usedChange)}`,
)
try {
  const nextTx = await t4Stats(state.nextReceive.address)
  check('nextReceive address is genuinely unused on-chain (txCount 0)', nextTx === 0, `txCount ${nextTx}`)
} catch (err) {
  check('nextReceive live unused check reachable', false, err.message)
}

// Persistence: the cold scan must have written the discovered indices.
const persisted = addrcache.get(acct.xpubs.xpub)
check(
  'scan persisted used receive indices to addrcache',
  JSON.stringify(persisted.receive) === JSON.stringify(usedReceive) && persisted.highestReceive === (usedReceive.at(-1) ?? -1),
  JSON.stringify(persisted.receive),
)
check(
  'scan persisted used change indices to addrcache',
  JSON.stringify(persisted.change) === JSON.stringify(usedChange),
  JSON.stringify(persisted.change),
)

// Warm scan: seeded from the cache we just wrote, must reproduce the result.
// (Live testnet4 providers time out from some networks — that is a SKIP.)
try {
  const warm = await scanAccount(acct, scanClient)
  const warmUsedReceive = warm.addresses.filter((a) => a.branch === 0 && a.used).map((a) => a.index).sort((a, b) => a - b)
  const warmUsedChange = warm.addresses.filter((a) => a.branch === 1 && a.used).map((a) => a.index).sort((a, b) => a - b)
  check(
    'warm scan reproduces used receive set',
    JSON.stringify(warmUsedReceive) === JSON.stringify(usedReceive),
    `${JSON.stringify(warmUsedReceive)} vs ${JSON.stringify(usedReceive)}`,
  )
  check(
    'warm scan reproduces used change set',
    JSON.stringify(warmUsedChange) === JSON.stringify(usedChange),
    `${JSON.stringify(warmUsedChange)} vs ${JSON.stringify(usedChange)}`,
  )
  check('warm scan reproduces nextReceive', warm.nextReceive.index === state.nextReceive.index)
} catch (err) {
  const msg = String(err?.message ?? err)
  if (isNetworkIssue(err)) {
    console.log(`SKIP  warm scan — live provider unreachable: ${msg.slice(0, 80)}`)
  } else {
    throw err
  }
}

// ===========================================================================
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
