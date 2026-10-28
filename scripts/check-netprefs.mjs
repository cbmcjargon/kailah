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
//   G. netprefs' static ids and labels match the engines' real configs;
//   H. (bug audit 2026-10-27, BM8/BM9) a lookup that failed is "unknown",
//      never "unused": EVM history that couldn't be read is an error, not an
//      empty list; a used UTXO address is history; staked or unstaking TRX
//      is funds and an activated TRON account is history; the portfolio
//      counts staked SOL/TRX and a gas coin without its token's price.
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
    addresses: [],
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

console.log('--- H. lookups that failed, staked TRX, the portfolio (bug audit 2026-10-27, BM8/BM9) ---')
{
  const u = (o) => ({ account: { balance: { confirmed: 0n, unconfirmed: 0n }, addresses: [], txs: [], ...o }, loading: false, error: null })
  check('H1 UTXO: a used address whose transactions didn\'t load is used, not unused', np.utxoActivity(u({ addresses: [{ used: true }, { used: false }] })) === 'used')
  const e = (o) => ({ token: 0n, gas: 0n, others: [], txs: [], loading: false, error: null, ...o })
  check('H2 EVM: a history or token lookup that failed can\'t say "unused"', np.evmActivity(e({ lookupFailed: true })) === 'unknown' && np.evmActivity(e({ lookupFailed: true, gas: 1n })) === 'funded')
  const s = (o) => ({ balance: 0n, usdcBalance: 0n, stakeAccounts: [], txs: [], loading: false, error: null, ...o })
  check('H3 Solana: nor can a history or stake lookup that failed', np.solActivity(s({ lookupFailed: true })) === 'unknown' && np.solActivity(s({ lookupFailed: false })) === 'unused')
  const t = (o) => ({ balance: 0n, usdtBalance: 0n, txs: [], loading: false, error: null, ...o })
  check('H4 TRON: staked or unstaking TRX alone is funds', np.tronActivity(t({ staked: 5_000_000n })) === 'funded')
  check('H4b ...and an account that exists on chain is used, even with nothing listed (staking, votes)', np.tronActivity(t({ activated: true })) === 'used' && np.tronActivity(t({ activated: false })) === 'unused')

  // the engines' side: a lookup that fails says so
  const evm = await import('../src/lib/evm.ts')
  const tron = await import('../src/lib/tron.ts')
  tron.tronTuning.gapMs = 0
  tron.tronTuning.v1GapMs = 0
  const realFetch = globalThis.fetch
  const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const answer = (transfers, txs) => (globalThis.fetch = async (url) => {
    const which = String(url).includes('token-transfers') ? transfers : txs
    return which === 'fail' ? new Response('{"message":"Too Many Requests"}', { status: 429 }) : new Response(JSON.stringify({ items: which }), { status: 200 })
  })
  const outcome = async () => { try { return await evm.fetchEvmHistory(evm.EVM_CHAINS.ethereum, ADDR) } catch (err) { return err } }
  answer('fail', 'fail')
  check('H5 EVM history: both explorer calls failing is an error, not an empty history', (await outcome()) instanceof Error)
  answer([], 'fail')
  check('H5b one failing with nothing found is an error too', (await outcome()) instanceof Error)
  answer('fail', [{ hash: '0x' + 'ab'.repeat(32), value: '5', from: { hash: '0x' + '11'.repeat(20) }, to: { hash: ADDR }, timestamp: '2026-10-01T00:00:00Z' }])
  const partial = await outcome()
  check('H5c one failing with rows found keeps the rows (that is history)', Array.isArray(partial) && partial.length === 1)
  answer([], [])
  const none = await outcome()
  check('H5d both answering empty is a real empty history', Array.isArray(none) && none.length === 0)

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    if (String(url).endsWith('/wallet/getaccount')) {
      return new Response(JSON.stringify(body.address === 'TNew' ? {} : {
        address: body.address, balance: 1_000_000,
        frozenV2: [{ amount: 50_000_000 }, { type: 'ENERGY', amount: 20_000_000 }, { type: 'TRON_POWER' }],
        unfrozenV2: [{ unfreeze_amount: 3_000_000, unfreeze_expire_time: 1 }],
        frozen: [{ frozen_balance: 7_000_000 }],
        account_resource: { frozen_balance_for_energy: { frozen_balance: 2_000_000 } },
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const acc = await tron.getTronAccount(tron.TRON_CHAINS.tron, 'TStaker')
  check('H6 TRON: staked (Stake 2.0 for bandwidth and energy, legacy Stake 1.0) plus unstaking TRX is read, beside the liquid balance', acc.balance === 1_000_000n && acc.staked === 82_000_000n && acc.activated === true, `${acc.staked}`)
  const fresh = await tron.getTronAccount(tron.TRON_CHAINS.tron, 'TNew')
  check('H6b a never-activated address: nothing staked, not activated', fresh.balance === 0n && fresh.staked === 0n && fresh.activated === false)
  globalThis.fetch = realFetch

  // BM9: the portfolio counts staked SOL and TRX, and a network's gas coin without its USDC price
  const dash = await readFile(new URL('../src/components/Dashboard.tsx', import.meta.url), 'utf8')
  check('H7 the portfolio counts staked SOL and staked/unstaking TRX (BM9)', /evmToUsd\(st\.balance \+ staked, c\.decimals, price\)/.test(dash) && /evmToUsd\(st\.balance \+ \(st\.staked \?\? 0n\), c\.decimals, price\)/.test(dash))
  check('H7b ...and a network\'s ETH/BNB even when the USDC price is missing', /if \(tokenUsd === null && gasUsd === null\) continue/.test(dash))
  const tronCard = await readFile(new URL('../src/components/TronCard.tsx', import.meta.url), 'utf8')
  check('H7c the TRON card shows staked TRX and never says "Nothing here yet" over it', /TRX staked/.test(tronCard) && /staked === 0n && \(/.test(tronCard))
  check('H8 a modal whose network was hidden (the automatic pick) closes for good instead of coming back when it shows again (BL42)',
    /if \(activeGone\) setActive\(null\)/.test(dash) && /'evmId' in active && activeEvmChain === undefined/.test(dash))
  const buy = await readFile(new URL('../src/components/BuyModal.tsx', import.meta.url), 'utf8')
  const receive = await readFile(new URL('../src/components/ReceiveModal.tsx', import.meta.url), 'utf8')
  check('H9 the Buy modal\'s delivery address is fixed when it opens, and a Ledger account is sent to verify THAT address on the device (BL43; review 2026-10-28)',
    /onBuy=\{\(\) => setActive\(\{ kind: 'buy', slot: s\.key, receive: receiveFor\(s\) \}\)\}/.test(dash) && /address=\{active\.receive\.address\}/.test(dash) &&
      /onVerifyOnDevice: \(\) => setActive\(\{ kind: 'receive', slot: activeSlot\.key, pinned: active\.receive \}\)/.test(dash) &&
      /pinned: active\.pinned/.test(dash) && /useState\(pinned \?\? accountState\?\.nextReceive \?\? null\)/.test(receive) && /Verify on Ledger/.test(buy))
}

console.log('--- I. what a store reviewer meets (review 2026-10-28) ---')
{
  const src = (f) => readFile(new URL(`../${f}`, import.meta.url), 'utf8')
  const shell = await src('src/Shell.tsx')
  check('I1 a brand-new wallet shows every network (it showed only Bitcoin and Base, hiding most of what the listing describes)',
    same(np.NEW_WALLET_SHOWN, np.REAL_NETWORKS) && np.NEW_WALLET_SHOWN.length === 9 &&
      /const \{ saveNetworkPrefs, NEW_WALLET_SHOWN \} = await import\('\.\/lib\/netprefs'\)\n\s*saveNetworkPrefs\(NEW_WALLET_SHOWN\)/.test(shell))
  const unused = Object.fromEntries(np.REAL_NETWORKS.map((id) => [id, 'unused']))
  check('I1b ...while a restored wallet that uses nothing still keeps just Bitcoin and Base', same(np.decideShown(unused), ['btc', 'base']))

  // Every Buy option the app can list, from every place that builds one.
  const onramp = await import('../src/lib/onramp.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  const options = [
    ...Object.values(CHAINS).flatMap((c) => onramp.getBuyOptions(c, 'addr')),
    onramp.strikeOption('addr'), onramp.krakenOption('SOL', 'Solana', 'addr'), onramp.geminiOption('SOL', 'Solana', 'addr'),
  ]
  const referral = (o) => /invite|referral|[?&]ref=|proinvite/i.test(o.url)
  const refs = options.filter(referral)
  check('I2 every referral link is tagged "Invite link", says what a new account gets, and that the creator is rewarded (store affiliate policy)',
    refs.length >= 3 && refs.every((o) => o.tag === 'Invite link' && /bonus|fee-free/.test(o.blurb) && /creator gets/.test(o.blurb)),
    refs.filter((o) => !(o.tag === 'Invite link' && /bonus|fee-free/.test(o.blurb) && /creator gets/.test(o.blurb))).map((o) => o.name).join(', '))
  check('I2b ...and nothing else carries a tag or a referral-looking URL', options.filter((o) => !referral(o)).every((o) => o.tag === undefined))
  const inline = [await src('src/components/ChainCard.tsx'), await src('src/components/BuyModal.tsx')]
  check('I2c the two inline Strike mentions (empty Bitcoin card, practice Buy) carry the tag, the benefit and the reward too',
    inline.every((t) => /buy-option-tag">Invite link</.test(t) && /fee-free trades to start through this invite/.test(t) && /creator gets a\s+referral reward/.test(t)))
  const listing = await src('extension/store/description.txt')
  check('I3 the store description discloses the referral links: which, what a new account gets, that the developer is rewarded',
    /REFERRAL LINKS/.test(listing) && ['Strike', 'Kraken', 'Gemini'].every((n) => listing.includes(n)) && /developer receives a referral reward/.test(listing) && /sign-up offer/.test(listing))
  check('I4 the listing promises biometric unlock only where the device supports it', /Face ID or fingerprint unlock with a passkey, where your device supports it/.test(listing))
  // Yellow Argon (keyword spam), the store's 2026-10-28 rejection: the
  // summary listed eight tickers, and the description said "wallet" 15 times
  const manifestSrc = await src('extension/manifest.ts')
  const summary = /description:\s*'([^']*)'/.exec(manifestSrc)?.[1] ?? ''
  const tickerList = /\b[A-Z]{2,5}\b(?:,\s*(?:and\s+)?[A-Z]{2,5}\b|\s+and\s+[A-Z]{2,5}\b){2,}/
  check('I6 the store summary lists no tickers (it was rejected as keyword spam for "BTC, DOGE, LTC, USDC, ETH, BNB, SOL and TRX")',
    summary.length > 0 && summary.length <= 132 && !tickerList.test(summary) && tickerList.test('BTC, DOGE, LTC and SOL') && /lists tickers/.test(manifestSrc), summary)
  const prose = listing.replace(/https?:\/\/\S+/g, '').replace(/[a-z0-9.-]+\.(?:app|org)\b/g, '')
  const counts = Object.fromEntries(['wallet', 'kailah', 'crypto', 'bitcoin', 'ethereum', 'solana', 'tron', 'usdc', 'usdt', 'swap', 'swaps', 'extension', 'networks', 'coins', 'app']
    .map((w) => [w, (prose.match(new RegExp(`\\b${w}\\b`, 'gi')) ?? []).length]))
  check('I7 ...and the description repeats no keyword more than five times, nor lists tickers (the store\'s keyword-spam rule)',
    Object.values(counts).every((n) => n <= 5) && !tickerList.test(prose), JSON.stringify(Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 3))))
  const welcome = await src('src/components/Welcome.tsx')
  check('I5 the welcome screen names more than Bitcoin, Dogecoin and Litecoin', /Ethereum, Solana, TRON/.test(welcome) && !/Dogecoin &amp; Litecoin/.test(welcome))
}

console.log(failures === 0 ? '\nAll networks-shown checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
