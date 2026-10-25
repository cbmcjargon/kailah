// check-netprefs.mjs — OFFLINE (mock localStorage, no network).
//
// "Networks shown" (src/lib/netprefs.ts) decides which networks the dashboard
// shows — and so which ones are scanned and polled at all. This suite proves:
//   A. storage: encrypted in the secure store, bound to the seed that saved
//      it, gone after lock (memory) and erase (disk); bad records never hide
//      anything; an empty choice is refused;
//   B. visibility: undecided shows everything, practice mirrors real, and
//      practice never comes up empty;
//   C. the per-engine activity classifiers: a balance of any asset is
//      "funded", a failed or partial scan is "unknown", never "unused";
//   D. decideShown: waits for every network, keeps defaults + anything that
//      isn't provably unused (an engine that failed to load counts as unknown);
//   E. wiring: every scan/poll loop in App.tsx goes through the filter, each
//      engine chunk is requested only when engineShown says so, and the
//      chooser's code never value-imports an engine (that would undo the
//      code split);
//   F. engineShown: which engine chunks load for a choice, in both modes;
//   G. netprefs' static ids and labels match the engines' real configs.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { webcrypto } = await import('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto
const { readFile } = await import('node:fs/promises')

const { unlockSecureStore, lockSecureStore, clearSecureStore, secureSet } = await import('../src/lib/securestore.ts')
const np = await import('../src/lib/netprefs.ts')

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const KEY = 'kailah.sec.netprefs'
let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
// secureSet encrypts in the background; wait for the ciphertext to land
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ===========================================================================
console.log('--- A. storage ---')
{
  await unlockSecureStore(MN)
  check('A1 a wallet with nothing stored is undecided', np.loadNetworkPrefs() === null)

  np.saveNetworkPrefs(np.DEFAULT_SHOWN)
  await settle()
  check('A2 the default is Bitcoin plus Base', same(np.loadNetworkPrefs()?.shown, ['btc', 'base']))
  const blob = store.get(KEY) ?? ''
  check('A3 stored under kailah.sec.netprefs as ciphertext, not plain ids', blob !== '' && !/btc|base/.test(blob), blob.slice(0, 24))

  np.saveNetworkPrefs(['tron', 'btc', 'tron', 'doge'])
  check('A4 a choice is de-duplicated and kept in dashboard order', same(np.loadNetworkPrefs()?.shown, ['btc', 'doge', 'tron']))
  let threw = false
  try {
    np.saveNetworkPrefs([])
  } catch {
    threw = true
  }
  check('A5 an empty choice is refused (one network always stays shown)', threw && np.loadNetworkPrefs()?.shown.length === 3)
  await settle()

  lockSecureStore()
  check('A6 locked: the choice is not readable', np.loadNetworkPrefs() === null)
  await unlockSecureStore(MN)
  check('A7 unlocked again with the same seed: the choice is back', same(np.loadNetworkPrefs()?.shown, ['btc', 'doge', 'tron']))
  lockSecureStore()
  await unlockSecureStore(OTHER)
  check("A8 another seed can't read it (each wallet keeps its own)", np.loadNetworkPrefs() === null)
  lockSecureStore()

  await unlockSecureStore(MN)
  secureSet('netprefs', { v: 1, shown: ['btc', 'nonsense', 'sol'] })
  check('A9 unknown ids in a record are dropped', same(np.loadNetworkPrefs()?.shown, ['btc', 'sol']))
  secureSet('netprefs', { v: 1, shown: ['nonsense'] })
  check('A10 a record that would hide everything reads as undecided', np.loadNetworkPrefs() === null)
  secureSet('netprefs', { v: 2, shown: ['btc'] })
  check('A11 an unknown version reads as undecided', np.loadNetworkPrefs() === null)
  secureSet('netprefs', 'btc')
  check('A12 garbage reads as undecided', np.loadNetworkPrefs() === null)
  np.saveNetworkPrefs(['btc'])
  await settle()

  clearSecureStore()
  check('A13 erase (clearSecureStore) removes kailah.sec.netprefs', !store.has(KEY))
  await unlockSecureStore(MN)
  check('A14 …and the wallet is undecided again', np.loadNetworkPrefs() === null)
}

// ===========================================================================
console.log('--- B. visibility ---')
{
  const prefs = (shown) => ({ v: 1, shown })
  const all = [...np.REAL_NETWORKS, ...Object.keys(np.PRACTICE_TWINS)]
  check('B1 undecided shows every network, real and practice', all.every((id) => np.isNetworkShown(null, id)))
  const p = prefs(['btc', 'base'])
  check('B2 real: exactly the chosen ones', np.REAL_NETWORKS.filter((id) => np.isNetworkShown(p, id)).join() === 'btc,base')
  check('B3 practice mirrors: tBTC and Base Sepolia shown', np.isNetworkShown(p, 'btc-testnet') && np.isNetworkShown(p, 'base-sepolia'))
  check('B4 practice mirrors: Solana devnet and Nile hidden', !np.isNetworkShown(p, 'sol-devnet') && !np.isNetworkShown(p, 'tron-nile'))
  const noTwin = prefs(['doge', 'ltc'])
  check(
    'B5 no shown network has a practice twin → practice shows all four, not nothing',
    Object.keys(np.PRACTICE_TWINS).every((id) => np.isNetworkShown(noTwin, id)),
  )
  check('B6 an unknown chain id is never shown under a choice', !np.isNetworkShown(p, 'btc-signet'))
  check(
    'B7 every practice twin points at a real network',
    Object.values(np.PRACTICE_TWINS).every((id) => np.REAL_NETWORKS.includes(id)),
  )
}

// ===========================================================================
console.log('--- C. activity ---')
{
  const acct = (confirmed, unconfirmed, txs, incomplete) => ({
    balance: { confirmed, unconfirmed },
    txs: Array.from({ length: txs }, (_, i) => ({ txid: String(i) })),
    ...(incomplete && { incomplete: { balance: true, utxos: true } }),
  })
  const u = (account, extra = {}) => ({ account, loading: false, error: null, ...extra })
  check('C1 UTXO: not scanned yet → pending', np.utxoActivity(u(null)) === 'pending' && np.utxoActivity(undefined) === 'pending')
  check('C2 UTXO: scanning → pending', np.utxoActivity(u(acct(0n, 0n, 0), { loading: true })) === 'pending')
  check('C3 UTXO: unconfirmed incoming alone → funded', np.utxoActivity(u(acct(0n, 5n, 0))) === 'funded')
  check('C4 UTXO: history, zero balance → used', np.utxoActivity(u(acct(0n, 0n, 2))) === 'used')
  check('C5 UTXO: empty and complete → unused', np.utxoActivity(u(acct(0n, 0n, 0))) === 'unused')
  check('C6 UTXO: empty but partial scan → unknown', np.utxoActivity(u(acct(0n, 0n, 0, true))) === 'unknown')
  check('C7 UTXO: scan failed, nothing known → unknown', np.utxoActivity(u(null, { error: '429' })) === 'unknown')
  check('C8 UTXO: empty snapshot + failed rescan → unknown', np.utxoActivity(u(acct(0n, 0n, 0), { error: 'x' })) === 'unknown')

  const e = (o) => ({ token: 0n, gas: 0n, others: [], txs: [], loading: false, error: null, ...o })
  check('C9 EVM: no balances yet → pending', np.evmActivity(e({ token: null, gas: null })) === 'pending')
  check('C10 EVM: balance call failed → unknown', np.evmActivity(e({ token: null, gas: null, error: 'rpc' })) === 'unknown')
  check('C11 EVM: gas coin alone → funded', np.evmActivity(e({ gas: 1n })) === 'funded')
  check('C12 EVM: a custom token with a balance → funded', np.evmActivity(e({ others: [{ balance: 3n }] })) === 'funded')
  check('C13 EVM: history only → used', np.evmActivity(e({ txs: [{}] })) === 'used')
  check('C14 EVM: empty → unused', np.evmActivity(e({})) === 'unused')

  const s = (o) => ({ balance: 0n, usdcBalance: 0n, stakeAccounts: [], txs: [], loading: false, error: null, ...o })
  check('C15 Solana: USDC alone → funded', np.solActivity(s({ usdcBalance: 1n })) === 'funded')
  check('C16 Solana: a stake account (SOL locked in staking) → funded', np.solActivity(s({ stakeAccounts: [{}] })) === 'funded')
  check("C17 Solana: USDC lookup failed, SOL zero → unknown", np.solActivity(s({ usdcBalance: null })) === 'unknown')
  check('C18 Solana: empty → unused', np.solActivity(s({})) === 'unused')

  const t = (o) => ({ balance: 0n, usdtBalance: 0n, txs: [], loading: false, error: null, ...o })
  check('C19 TRON: USDT alone → funded', np.tronActivity(t({ usdtBalance: 9n })) === 'funded')
  check('C20 TRON: USDT lookup failed → unknown', np.tronActivity(t({ usdtBalance: null })) === 'unknown')
  check('C21 TRON: history only → used', np.tronActivity(t({ txs: [{}] })) === 'used')
  check('C22 TRON: empty → unused', np.tronActivity(t({})) === 'unused')

  const act = np.realNetworkActivity({
    utxo: { btc: u(acct(0n, 0n, 0)), doge: u(null, { error: 'x' }), ltc: u(acct(1n, 0n, 1)) },
    evm: { base: e({}), ethereum: e({ txs: [{}] }), arbitrum: e({}), bnb: e({ token: 2n }) },
    sol: { sol: s({}) },
    tron: { tron: t({}) },
  })
  check(
    'C23 realNetworkActivity reads the right slot for each network',
    same(act, { btc: 'unused', doge: 'unknown', ltc: 'funded', base: 'unused', ethereum: 'used', arbitrum: 'unused', bnb: 'funded', sol: 'unused', tron: 'unused' }),
    JSON.stringify(act),
  )
}

// ===========================================================================
console.log('--- D. decideShown ---')
{
  const every = (a) => Object.fromEntries(np.REAL_NETWORKS.map((id) => [id, a]))
  check('D1 waits while any network is pending', np.decideShown({ ...every('unused'), tron: 'pending' }) === null)
  check('D2 an existing wallet that uses nothing gets the new-wallet default', same(np.decideShown(every('unused')), ['btc', 'base']))
  check(
    'D3 funded, used and unknown networks all stay shown',
    same(np.decideShown({ ...every('unused'), doge: 'funded', arbitrum: 'used', tron: 'unknown' }), ['btc', 'doge', 'base', 'arbitrum', 'tron']),
  )
  check('D4 a wallet active everywhere keeps all nine', np.decideShown(every('used'))?.length === 9)
  check('D5 every network failing to answer hides nothing', np.decideShown(every('unknown'))?.length === 9)
  const none = { utxo: {}, evm: {}, sol: {}, tron: {} }
  const failedAct = np.realNetworkActivity(none, { evm: true, sol: true, tron: true })
  check(
    "D6 an engine chunk that failed to load reads as unknown (kept), not pending forever",
    ['base', 'ethereum', 'arbitrum', 'bnb', 'sol', 'tron'].every((id) => failedAct[id] === 'unknown') && failedAct.btc === 'pending',
  )
}

// ===========================================================================
console.log('--- E. wiring ---')
{
  // A loop straight over a mode's chain list would scan hidden networks.
  // Every scan, poll, refresh-all and export loop must filter through
  // shownIn(…); the unhide handler's loops filter by `appeared` instead.
  const read = (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const src = await read('App.tsx')
  // every `for (const chain of <expr>)` whose expr lists a mode's chains
  const loops = [...src.matchAll(/for \(const chain of ([^\n]*?)\) (?=\{|\w)/g)]
    .map((m) => m[1])
    .filter((expr) => /ChainsForMode\(|chainsForMode\(/.test(expr))
  const bare = loops.filter((expr) => !expr.startsWith('shownIn(') && !expr.endsWith('.filter(appeared)'))
  check('E1 no scan loop in App.tsx iterates a mode\'s chains unfiltered', loops.length >= 14 && bare.length === 0, bare.join(' | ') || `${loops.length} loops`)
  const filtered = (src.match(/shownIn\([^\n]*?[cC]hainsForMode\(/g) ?? []).length
  check('E2 the filter is in place (unlock, engine scans, polls, refresh all, export, render)', filtered >= 16, `${filtered} uses`)
  const wired = ['Evm', 'Sol', 'Tron'].every((E) =>
    new RegExp(`useEngine\\(\\s*load${E},[\\s\\S]{0,200}?engineShown\\(netPrefs, '${E.toLowerCase()}', mode\\)`).test(src),
  )
  check('E3 each engine chunk is requested only when engineShown says one of its networks shows', wired)
  const dash = await read('components/Dashboard.tsx')
  check(
    'E4 an engine not wanted shows no loading placeholder',
    ['evm', 'sol', 'tron'].every((e) => dash.includes(`${e}Ui === null && ${e}.wanted && <EnginePending`)),
  )
  const valueImport = /^import (?!type )[^\n]*from '(?:\.\.\/lib\/|\.\/)(?:evm|sol|tron)'/m
  const chooserFiles = { 'lib/netprefs.ts': await read('lib/netprefs.ts'), 'components/SettingsModal.tsx': await read('components/SettingsModal.tsx') }
  const leaks = Object.entries(chooserFiles).filter(([, text]) => valueImport.test(text)).map(([f]) => f)
  check('E5 the chooser never value-imports an engine (type imports only)', leaks.length === 0, leaks.join(', '))
}

// ===========================================================================
console.log('--- F. engineShown ---')
{
  const p = (shown) => ({ v: 1, shown })
  const loads = (prefs, mode) => ['evm', 'sol', 'tron'].filter((e) => np.engineShown(prefs, e, mode)).join(',') || 'none'
  check('F1 undecided: every engine loads, both modes', loads(null, 'real') === 'evm,sol,tron' && loads(null, 'practice') === 'evm,sol,tron')
  const def = p(['btc', 'base'])
  check('F2 the default (Bitcoin + Base): only EVM loads, in real mode…', loads(def, 'real') === 'evm', loads(def, 'real'))
  check('F3 …and in practice (Base Sepolia mirrors Base)', loads(def, 'practice') === 'evm', loads(def, 'practice'))
  check('F4 UTXO only, real mode: no engine chunk at all', loads(p(['btc', 'doge', 'ltc']), 'real') === 'none')
  check('F5 BNB alone loads EVM in real mode', loads(p(['bnb']), 'real') === 'evm')
  check('F6 Solana + Bitcoin: only Solana in both modes', loads(p(['btc', 'sol']), 'real') === 'sol' && loads(p(['btc', 'sol']), 'practice') === 'sol')
  check(
    "F7 practice follows isNetworkShown: no shown network has a twin → all four practice networks, so every engine",
    loads(p(['doge', 'bnb']), 'practice') === 'evm,sol,tron',
  )
  check('F8 TRON only: TRON engine, no EVM or Solana', loads(p(['tron']), 'real') === 'tron' && loads(p(['tron']), 'practice') === 'tron')
}

// ===========================================================================
console.log('--- G. static ids and labels match the engines ---')
{
  const { CHAINS, chainsForMode } = await import('../src/lib/networks.ts')
  const evm = await import('../src/lib/evm.ts')
  const sol = await import('../src/lib/sol.ts')
  const tron = await import('../src/lib/tron.ts')
  const ids = (list) => list.map((c) => c.id).join()
  for (const mode of ['real', 'practice']) {
    check(`G1 ${mode}: ENGINE_NETWORKS.evm = evmChainsForMode`, np.ENGINE_NETWORKS.evm[mode].join() === ids(evm.evmChainsForMode(mode)))
    check(`G2 ${mode}: ENGINE_NETWORKS.sol = solChainsForMode`, np.ENGINE_NETWORKS.sol[mode].join() === ids(sol.solChainsForMode(mode)))
    check(`G3 ${mode}: ENGINE_NETWORKS.tron = tronChainsForMode`, np.ENGINE_NETWORKS.tron[mode].join() === ids(tron.tronChainsForMode(mode)))
    const all = [chainsForMode(mode), evm.evmChainsForMode(mode), sol.solChainsForMode(mode), tron.tronChainsForMode(mode)].map(ids).join()
    check(`G4 ${mode}: networksForMode is every engine's chains, in dashboard order`, np.networksForMode(mode).join() === all, all)
  }
  const config = (id) => CHAINS[id] ?? evm.EVM_CHAINS[id] ?? sol.SOL_CHAINS[id] ?? tron.TRON_CHAINS[id]
  const assets = (id) => {
    if (CHAINS[id]) return CHAINS[id].ticker
    const e = evm.EVM_CHAINS[id]
    if (e) return (e.gasPrimary ? [e.gas, e.token] : [e.token, e.gas]).map((a) => a.symbol).join(' · ')
    if (sol.SOL_CHAINS[id]) return `SOL · ${sol.SOL_CHAINS[id].usdc.symbol}`
    return `TRX · ${tron.TRON_CHAINS[id].usdt.symbol}`
  }
  const wrong = np.REAL_NETWORKS.filter((id) => {
    const l = np.NETWORK_LABELS[id]
    return l.name !== config(id).name || l.color !== config(id).color || l.assets !== assets(id)
  })
  check('G5 every Settings label (name, color, assets) matches its engine config', wrong.length === 0, wrong.join(', '))
}

console.log(failures === 0 ? '\nAll networks-shown checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
