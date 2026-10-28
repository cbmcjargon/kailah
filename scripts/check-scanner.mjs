// check-scanner.mjs — OFFLINE (mock provider + mock localStorage).
// Proves the scan-frontier hardening and snapshot validation:
//  • a cold scan is uncapped (deep restores find their true frontier);
//  • the frontier is computed over scan ∪ cache (a provider hiding usage
//    can't cause address reuse);
//  • a provider inventing a run of fake-used addresses can push the frontier
//    at most GAP_LIMIT−1 past the pre-scan cache frontier, never past MAX_INDEX;
//  • a persisted snapshot must re-derive from the account's keys;
//  • after the 2026-10-27 audit: a failed worker pool stops taking items;
//    a scan from before a lock or erase writes nothing afterwards; a
//    snapshot carries its own flag; and the dashboard keeps the last
//    complete balance, queues rescans as asked, polls a chain on a backup
//    slowly, and a send says when coins couldn't load; confirmations count
//    from a tip no lower than the payment's block, and quick polls advance
//    them.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { deriveAccount } = await import('../src/lib/keys.ts')
const { CHAINS } = await import('../src/lib/networks.ts')
const { scanAccount } = await import('../src/lib/scanner.ts')
const { unlockSecureStore } = await import('../src/lib/securestore.ts')
const { snapshotMatchesAccount } = await import('../src/lib/statecache.ts')
const { lockSecureStore } = await import('../src/lib/securestore.ts')
const addrcache = await import('../src/lib/addrcache.ts')

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const acct = deriveAccount(MNEMONIC, CHAINS.btc)
await unlockSecureStore(MNEMONIC) // caches are encrypted; the key comes from the seed
let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- frontier ---------------------------------------------------------------
const addrIndex = new Map()
for (let b = 0; b <= 1; b++) for (let i = 0; i <= 120; i++) addrIndex.set(acct.address(b, i).address, [b, i])
const mkClient = (usedFn) => ({
  getTipHeight: async () => 100,
  getAddressStats: async (address) => {
    const [b, i] = addrIndex.get(address) ?? [0, 9999]
    const used = usedFn(b, i)
    return { balance: { confirmed: used ? 1000n : 0n, unconfirmed: 0n }, txCount: used ? 1 : 0 }
  },
  getAddressUtxos: async () => [],
  getAddressTxs: async () => [],
})
const honest = (b, i) => (b === 0 ? i <= 23 : i <= 3)
const cold = await scanAccount(acct, mkClient(honest))
check('cold scan uncapped: deep wallet gets its true frontier', cold.nextReceive.index === 24 && cold.nextChange.index === 4, `receive=${cold.nextReceive.index} change=${cold.nextChange.index}`)
const warm = await scanAccount(acct, mkClient(honest))
check('warm scan reproduces the frontier', warm.nextReceive.index === 24 && warm.nextChange.index === 4)
const liar = await scanAccount(acct, mkClient(() => true))
check('fake-used run capped at GAP_LIMIT-1 past the cache frontier', liar.nextReceive.index === 24 + 19 && liar.nextChange.index === 4 + 19, `receive=${liar.nextReceive.index} change=${liar.nextChange.index}`)
const hider = await scanAccount(acct, mkClient(() => false))
check('hidden usage cannot drag the frontier back (no reuse), never past MAX_INDEX', hider.nextReceive.index >= 24 && hider.nextReceive.index <= 1000 && hider.nextChange.index >= 4, `receive=${hider.nextReceive.index} change=${hider.nextChange.index}`)

// --- snapshot validation ------------------------------------------------------
const a = (branch, index, used) => ({ address: acct.address(branch, index).address, branch, index, used })
const base = {
  balance: { confirmed: 0n, unconfirmed: 0n },
  addresses: [a(0, 0, true), a(1, 0, true)],
  nextReceive: a(0, 1, false),
  nextChange: a(1, 1, false),
  utxos: [], txs: [], rawTxs: [], tipHeight: 0,
  incomplete: { balance: false, utxos: true },
}
check('honest snapshot validates', snapshotMatchesAccount(base, acct))
check('forged nextReceive address rejected', !snapshotMatchesAccount({ ...base, nextReceive: { ...base.nextReceive, address: 'bc1qattacker0000000000000000000000000000xx' } }, acct))
check('forged entry in addresses rejected', !snapshotMatchesAccount({ ...base, addresses: [base.addresses[0], { ...base.addresses[1], address: base.addresses[0].address }] }, acct))
check('receive address on change branch rejected', !snapshotMatchesAccount({ ...base, nextReceive: a(1, 1, false) }, acct))
check('out-of-range index rejected', !snapshotMatchesAccount({ ...base, nextChange: { ...base.nextChange, index: 5000 } }, acct))
check("another wallet's snapshot rejected", !snapshotMatchesAccount(base, deriveAccount('legal winner thank year wave sausage worth useful legal winner thank yellow', CHAINS.btc)))

// --- encrypted cache round trip -----------------------------------------------
// The caches persist as AES-GCM ciphertext under a seed-derived key: lock
// drops the key and the mirror; unlock with the same seed restores the data;
// unlock with another seed (or tampering) yields nothing.
await new Promise((r) => setTimeout(r, 50)) // let the background persist land
const blob = store.get('kailah.sec.addrmap')
check('cache persisted as an opaque blob (no JSON, no xpub in the clear)',
  typeof blob === 'string' && blob.includes('.') && !/[{}"]/.test(blob) && !blob.includes(acct.xpubs.xpub.slice(0, 12)), String(blob).slice(0, 40))
const before = addrcache.get(acct.xpubs.xpub)
lockSecureStore()
check('locked: cache reads empty', addrcache.get(acct.xpubs.xpub).receive.length === 0)
await unlockSecureStore(MNEMONIC)
const after = addrcache.get(acct.xpubs.xpub)
check('unlock with the same seed restores the cache', JSON.stringify(after) === JSON.stringify(before) && before.receive.length > 0, `${before.receive.length} receive indices`)
lockSecureStore()
await unlockSecureStore('legal winner thank year wave sausage worth useful legal winner thank yellow')
check("another seed cannot read this wallet's cache", addrcache.get(acct.xpubs.xpub).receive.length === 0)
lockSecureStore()
store.set('kailah.sec.addrmap', blob.slice(0, -4) + 'AAAA') // tamper the ciphertext tail
await unlockSecureStore(MNEMONIC)
check('tampered blob is rejected (reads empty, no throw)', addrcache.get(acct.xpubs.xpub).receive.length === 0)

// --- after the 2026-10-27 bug audit -------------------------------------------
{
  const { runPool } = await import('../src/lib/scanner.ts')
  const { secureGet, secureRemove, clearSecureStore } = await import('../src/lib/securestore.ts')
  const { saveStateSnapshot, loadStateSnapshot } = await import('../src/lib/statecache.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // BL12: a failed pool stops taking items
  let calls = 0
  const err = await runPool([...Array(20).keys()], 4, async (i) => {
    calls++
    await sleep(5)
    if (i === 0) throw new Error('down')
  }).then(() => null, (e) => e)
  await sleep(50)
  check('S1 once one item fails, the pool stops taking items: no requests spent on a pass that has failed (BL12)', err?.message === 'down' && calls === 4, `${calls} calls`)

  // BL9: an erased wallet's scan writes nothing afterwards
  lockSecureStore()
  await unlockSecureStore(MNEMONIC)
  const used = acct.address(0, 0).address
  let release = () => {}
  let gate = Promise.resolve()
  const client = {
    getTipHeight: async () => {
      await gate
      return 800_000
    },
    getAddressStats: async (addr) => ({ balance: { confirmed: addr === used ? 1n : 0n, unconfirmed: 0n }, txCount: addr === used ? 1 : 0 }),
    getAddressUtxos: async () => [],
    getAddressTxs: async () => [],
  }
  store.delete('kailah.tipcache.v1')
  secureRemove('addrmap')
  const control = await scanAccount(acct, client)
  await sleep(50)
  check('S2 control: a scan writes the tip cache and the address map', store.has('kailah.tipcache.v1') && Object.keys(secureGet('addrmap') ?? {}).includes(acct.xpubs.xpub))
  store.delete('kailah.tipcache.v1')
  secureRemove('addrmap')
  gate = new Promise((r) => (release = r))
  const orphan = scanAccount(acct, client)
  clearSecureStore() // the user erases the wallet mid-scan…
  const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
  await unlockSecureStore(OTHER) // …and restores another
  release()
  await orphan
  await sleep(100)
  check('S2b the erased wallet\'s scan, finishing afterwards, writes no tip cache back (BL9)', !store.has('kailah.tipcache.v1'))
  check('S2c ...and none of its address map into the next wallet\'s store', !Object.keys(secureGet('addrmap') ?? {}).includes(acct.xpubs.xpub))
  lockSecureStore()
  await unlockSecureStore(MNEMONIC)

  // BL10: a snapshot says it's one; a real partial scan doesn't
  saveStateSnapshot('btc', control)
  const snap = loadStateSnapshot('btc')
  check('S3 a restored snapshot carries its own flag, a scan doesn\'t (BL10)', snap?.snapshot === true && snap.incomplete?.utxos === true && control.snapshot === undefined)

  // the dashboard's side, read from the source
  const { readFileSync } = await import('node:fs')
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const app = read('App.tsx')
  check('S4 polls tell a snapshot by its flag, not by a real scan\'s missing coins (BL10)', /const snapshotOnly = baseline\?\.snapshot === true/.test(app) && !/snapshotOnly = baseline\?\.incomplete/.test(app))
  check('S4b ...and a real scan that missed coins is scanned in full again every 10 minutes, not left until the balance moves (review 2026-10-28)',
    /const PARTIAL_RESCAN_MS = 10 \* 60 \* 1000/.test(app) && /baseline\?\.incomplete\?\.utxos === true &&\s*baseline\.snapshot !== true &&\s*Date\.now\(\) - \(fullScanAtRef\.current\[key\] \?\? 0\) >= PARTIAL_RESCAN_MS/.test(app) &&
      /\(budgetChain \|\| \(!snapshotOnly && !partialDue\)\)/.test(app) && /if \(prevAccount === undefined\) fullScanAtRef\.current\[key\] = Date\.now\(\)/.test(app))
  check('S5 a partial scan keeps the last complete balance on screen, with a note (BM4)', /const keepLast = kept != null && kept\.incomplete\?\.balance !== true/.test(app) && /showing the last complete balance/.test(app))
  check('S6 a rescan queued mid-scan runs as asked (quick stays quick) and not for a network hidden since (BL11)',
    /pendingManualScanRef\.current\[key\] = \{ quick: opts\?\.quick === true/.test(app) && /if \(shown\) refreshSlotRef\.current\?\.\(key, queued\.quick \? \{ quick: true \} : undefined\)/.test(app))
  check('S7 a chain whose backup is answering polls on the slow, 10-minute cadence (BL7)', /getClient\(chain\)\.onBackup\(\)/.test(app) && /poll\('slow'\), 600_000/.test(app))
  const card = read('components/ChainCard.tsx')
  check('S8 a possibly-low balance is marked and never reads "Nothing here yet" (BM4)', /const isEmpty = balance !== null && !partialBalance/.test(card) && /balance may be higher/.test(card))
  const send = read('components/SendModal.tsx')
  check('S9 with coins that couldn\'t load, a send says so instead of "Insufficient funds" (BM5)', /state\.incomplete\?\.utxos === true && \/\^Insufficient funds\//.test(send))

  // BM10: confirmations from a tip that can't trail the chain, advanced on quick polls
  const a0 = acct.address(0, 0).address
  let tip = 900_005
  let tipCalls = 0
  const TX = {
    txid: 'ab'.repeat(32), height: 900_000, time: 1_760_000_000, fee: 500n, rbfSignaled: false,
    inputs: [{ address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', value: 100_500n, prevTxid: 'cd'.repeat(32), prevVout: 0 }],
    outputs: [{ address: a0, value: 100_000n }],
  }
  const chainClient = {
    getTipHeight: async () => (tipCalls++, tip),
    getAddressStats: async (x) => (x === a0 ? { balance: { confirmed: 100_000n, unconfirmed: 0n }, txCount: 1 } : { balance: { confirmed: 0n, unconfirmed: 0n }, txCount: 0 }),
    getAddressUtxos: async (x) => (x === a0 ? [{ txid: TX.txid, vout: 0, value: 100_000n, confirmed: true }] : []),
    getAddressTxs: async (x) => (x === a0 ? [TX] : []),
  }
  // a cached tip (fresh, so no network call) that trails the block the payment is in
  store.set('kailah.tipcache.v1', JSON.stringify({ btc: { h: 899_990, at: Date.now() } }))
  const full = await scanAccount(acct, chainClient)
  check('S10 a confirmed payment never reads 0 confirmations: the tip is at least its block (BM10)', full.txs[0]?.confirmations === 1 && full.tipHeight === 900_000, `${full.txs[0]?.confirmations} conf at tip ${full.tipHeight}`)
  store.set('kailah.tipcache.v1', JSON.stringify({ btc: { h: 900_000, at: 0 } })) // stale: the next tip read goes out
  const quick = await scanAccount(acct, chainClient, { quickCheckAgainst: full })
  check('S11 a quick poll that finds nothing changed still advances the confirmations', quick.txs[0]?.confirmations === 6 && quick.tipHeight === 900_005 && quick.balance === full.balance, `${quick.txs[0]?.confirmations} conf`)
  tipCalls = 0
  const again = await scanAccount(acct, chainClient, { quickCheckAgainst: quick })
  check('S11b ...from the tip cache while it is fresh (no extra request), handing back the same state when the tip hasn\'t moved', again === quick && tipCalls === 0)
  // the cache ages out at the 600 s poll cadence: once no payment still shows
  // its count, a quick poll reads the cached tip however old (review 2026-10-28)
  store.set('kailah.tipcache.v1', JSON.stringify({ btc: { h: 900_007, at: 0 } }))
  tip = 900_009; tipCalls = 0
  const deep = await scanAccount(acct, chainClient, { quickCheckAgainst: quick })
  check('S11c past the confirmations the list shows, a quick poll asks for no live tip, the cache being stale or not (Dogecoin\'s budget)',
    tipCalls === 0 && deep.txs[0]?.confirmations === 8, `${tipCalls} tip call(s), ${deep.txs[0]?.confirmations} conf`)
  store.set('kailah.tipcache.v1', JSON.stringify({ btc: { h: 900_001, at: 0 } }))
  tipCalls = 0
  const shallow = await scanAccount(acct, chainClient, { quickCheckAgainst: { ...full, txs: full.txs.map((t) => ({ ...t, confirmations: 2 })), tipHeight: 900_001 } })
  check('S11d ...while one still shows its count gets one live tip when the cache is stale', tipCalls === 1 && shallow.txs[0]?.confirmations === 10, `${tipCalls} tip call(s)`)

  // BM29: a scan for an account removed meanwhile keeps no address map
  secureRemove('addrmap')
  await scanAccount(acct, chainClient, { persist: () => false })
  await sleep(50)
  check('S12 a scan whose account was removed meanwhile (persist says no) writes no address map (BM29)', !Object.keys(secureGet('addrmap') ?? {}).includes(acct.xpubs.xpub))
  await scanAccount(acct, chainClient, { persist: () => true })
  await sleep(50)
  check('S12b ...and one whose account is still there does', Object.keys(secureGet('addrmap') ?? {}).includes(acct.xpubs.xpub))
}

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
