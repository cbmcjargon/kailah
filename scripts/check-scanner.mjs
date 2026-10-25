// check-scanner.mjs — OFFLINE (mock provider + mock localStorage).
// Proves the scan-frontier hardening and snapshot validation:
//  • a cold scan is uncapped (deep restores find their true frontier);
//  • the frontier is computed over scan ∪ cache (a provider hiding usage
//    can't cause address reuse);
//  • a provider inventing a run of fake-used addresses can push the frontier
//    at most GAP_LIMIT−1 past the pre-scan cache frontier, never past MAX_INDEX;
//  • a persisted snapshot must re-derive from the account's keys.
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

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
