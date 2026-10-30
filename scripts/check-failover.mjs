// check-failover.mjs — OFFLINE (mock providers, a controllable clock, no network).
//
// The FailoverClient (src/lib/api.ts) must tell a rate limit from an outage.
// Under scan load mempool.space answers some lookups with 429 (CORS-less, so a
// browser sees only "Load failed") and lets others hang, and its backup
// rate-limits harder still; a testnet4 scan used to die with "Couldn't reach
// the network data service". This suite proves:
//   A. push-back from a burst-limited provider pauses it and the request is
//      retried on it after the backoff, for a visible 429 and for the
//      browser's bare network error alike;
//   B. with two providers that both refuse, the request still finishes, and a
//      healthy backup takes over during a pause without waiting;
//   C. a provider that never answered is down, as before: immediate failover,
//      no waiting, a 60 s cooldown, the plain-words message;
//   D. timeouts get one retry (a second means the host is down); BlockCypher
//      (no burstLimited) and HTTP errors keep their old handling;
//   E. a concurrent scan burst rides out the limit, and no request is sent to
//      a provider while it is paused;
//   F. a provider that never stops refusing still fails the request, within
//      the attempt and wait limits, and never yields a made-up result;
//   H. a backup-only provider (Litecoin's BlockCypher) serves only while every
//      regular provider has failed or is cooling down: never raced at
//      startup, never remembered, never used for a mere rate limit;
//   I. the BlockCypher adapter serves Litecoin: fee estimates from the chain
//      root, BIP125 from input sequences (never on Dogecoin), no raw-hex
//      fetches for segwit, and one request gate shared by every chain;
//   J. after the 2026-10-27 audit: a visible 429 from any provider but
//      BlockCypher is push-back, and BlockCypher's budget isn't spent to
//      dodge the active provider's pause; the start-up probe keeps the
//      configured order; the client says when a backup answers (polls slow
//      down); nothing is remembered once the wallet locked or was erased;
//      BlockCypher serves up to 500 inputs/outputs and marks a bigger
//      transaction partial; its broadcast has a deadline.
//   K. practice Bitcoin has a second service that serves address lookups,
//      and background polls back off after a failed scan, while a test
//      network's failed check reads as a calm note (review 2026-10-28).
import { readFileSync } from 'node:fs'
const { createFailoverClient } = await import('../src/lib/api.ts')

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const rejects = async (fn) => {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

// A clock the cooldowns can be fast-forwarded on; real setTimeout for pauses.
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew
const advance = (ms) => (skew += ms)

const TUNING = { backoffMs: [20, 40, 80], maxWaitMs: 2_000 } // real: 1.5 s, 4 s, 8 s; 30 s
const STATS = { balance: { confirmed: 0n, unconfirmed: 0n }, txCount: 0 }

/**
 * A mock provider. `stats` is the outcome of each getAddressStats call in
 * order (the last repeats) or a function of the call number. Outcomes: 'ok';
 * 'rl' (a visible 429); 'net' (TypeError, which is how a browser reports a
 * CORS-less 429 or a dead host); 'timeout' (AbortSignal.timeout's
 * DOMException); 'http' (the server answered with another error).
 */
function provider(name, log, { tip = 'ok', stats = ['ok'], burstLimited = true, backupOnly = false, budgetLimited = false, logTip = false, push = 'ok', tipDelay = 0 } = {}) {
  let n = 0
  const act = async (outcome) => {
    log.push(`${name}:${outcome}`)
    log.times?.push({ name, outcome, at: realNow() })
    if (outcome === 'ok') return { ...STATS, from: name }
    if (outcome === 'rl') throw Object.assign(new Error(`${name}: rate limited (HTTP 429)`), { rateLimited: true })
    if (outcome === 'net') throw new TypeError('Load failed')
    if (outcome === 'timeout') throw new DOMException('signal timed out', 'TimeoutError')
    throw new Error(`${name}: HTTP 503`)
  }
  return {
    providerName: name,
    ...(burstLimited ? { burstLimited: true } : {}),
    ...(backupOnly ? { backupOnly: true } : {}),
    ...(budgetLimited ? { budgetLimited: true } : {}),
    getTipHeight: () => {
      if (logTip) log.push(`${name}:tip`)
      if (tip !== 'ok') return Promise.reject(new TypeError('Load failed'))
      return tipDelay > 0 ? new Promise((r) => setTimeout(() => r(100), tipDelay)) : Promise.resolve(100)
    },
    getAddressStats: () => act(typeof stats === 'function' ? stats(n++) : stats[Math.min(n++, stats.length - 1)]),
    broadcast: async () => {
      log.push(`${name}:push-${push}`)
      if (push === 'ok') return `txid-${name}`
      if (push === 'net') throw new TypeError('Load failed')
      throw new Error(`${name}: rejected (HTTP 400)`)
    },
  }
}
const client = (providers) => createFailoverClient(providers, undefined, TUNING)
const first = (log, from) => log.slice(from)[0]?.split(':')[0]
const timed = async (fn) => {
  const t0 = realNow()
  const out = await rejects(async () => (timed.value = await fn()))
  return { ms: realNow() - t0, err: out, value: timed.value }
}
// Each timing check gets its own client: trying a cooling provider as the
// last resort (and seeing it fail again) rightly restarts its cooldown.
async function firstTriedAfter(build, setup, waitMs) {
  const log = []
  const c = build(log)
  await setup(c)
  advance(waitMs)
  const m = log.length
  await rejects(() => c.getAddressStats('a'))
  return first(log, m)
}

console.log('--- A. push-back pauses the provider; the request is retried on it ---')
for (const [label, refusal] of [['a visible 429', 'rl'], ["the browser's bare network error", 'net']]) {
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', refusal, refusal, 'ok'] })])
  await c.getAddressStats('a')
  const { ms, err, value } = await timed(() => c.getAddressStats('a'))
  check(`A ${label}: the request succeeds on the same provider`, err === null && value?.from === 'P1', err?.message)
  check(`A ${label}: two paused retries, then success`, log.join(' ') === `P1:ok P1:${refusal} P1:${refusal} P1:ok`, log.join(' '))
  check(`A ${label}: it waited out both pauses (20 + 40 ms)`, ms >= 55, `${ms} ms`)
}
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'rl', 'rl', 'ok', 'rl', 'ok'] })])
  await c.getAddressStats('a')
  await c.getAddressStats('a')
  const { ms } = await timed(() => c.getAddressStats('a'))
  check('A a success resets the backoff: the next push-back pauses for the first step again', ms < 55, `${ms} ms`)
}

console.log('--- B. two providers, both under pressure ---')
{
  const log = []
  // The live case: the backup refuses every time.
  const c = client([provider('P1', log, { stats: ['ok', 'rl', 'rl', 'ok'] }), provider('P2', log, { stats: ['rl'] })])
  await c.getAddressStats('a')
  const { err, value } = await timed(() => c.getAddressStats('a'))
  check('B1 the request still finishes, on the primary once its pause ends', err === null && value?.from === 'P1', err?.message ?? log.join(' '))
}
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'rl'] }), provider('P2', log)])
  await c.getAddressStats('a')
  const { ms, value } = await timed(() => c.getAddressStats('a'))
  check('B2 a healthy backup takes over during the pause, without waiting', value?.from === 'P2' && ms < 20, `${value?.from}, ${ms} ms`)
}

console.log('--- C. a provider that never answered: down, as before ---')
{
  const log = []
  const c = client([provider('P1', log, { tip: 'net', stats: ['net'] }), provider('P2', log, { tip: 'net', stats: ['http'] })])
  const { ms, err } = await timed(() => c.getAddressStats('a'))
  check('C1 P1 tried once, no retry', log.join(' ') === 'P1:net P2:http', log.join(' '))
  check('C2 no waiting before failing over', ms < 20, `${ms} ms`)
  check('C3 the request fails, it does not return a guess', err !== null)
  const build = (l) => client([provider('P1', l, { tip: 'net', stats: ['net'] }), provider('P2', l, { tip: 'net', stats: ['http'] })])
  const setup = (cl) => rejects(() => cl.getAddressStats('a'))
  check('C4 30 s later P1 is still down (60 s cooldown): P2 first', (await firstTriedAfter(build, setup, 30_000)) === 'P2')
  check('C5 61 s later P1 is tried first again', (await firstTriedAfter(build, setup, 61_000)) === 'P1')
  const dead = client([provider('P1', [], { tip: 'net', stats: ['net'] })])
  const de = await rejects(() => dead.getAddressStats('a'))
  check('C6 all-network failure keeps the plain-words message', /Couldn't reach the network data service/.test(de?.message ?? ''), de?.message?.slice(0, 60))
}

console.log('--- D. timeouts, BlockCypher, HTTP errors ---')
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'timeout', 'ok'] })])
  await c.getAddressStats('a')
  const { err, value } = await timed(() => c.getAddressStats('a'))
  check('D1 a timeout right after a success gets one retry', err === null && value?.from === 'P1' && log.join(' ') === 'P1:ok P1:timeout P1:ok', log.join(' '))
}
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'timeout', 'timeout', 'ok'] }), provider('P2', log, { tip: 'net', stats: ['http'] })])
  await c.getAddressStats('a')
  const m = log.length
  await rejects(() => c.getAddressStats('a'))
  const tries = log.slice(m)
  check(
    'D2 a second timeout in the same request means down: no third try',
    tries.filter((t) => t === 'P1:timeout').length === 2 && !tries.includes('P1:ok'),
    tries.join(' '),
  )
  const build = (l) => client([provider('P1', l, { stats: ['ok', 'timeout'] }), provider('P2', l, { tip: 'net', stats: ['http'] })])
  const setup = async (cl) => { await cl.getAddressStats('a'); await rejects(() => cl.getAddressStats('a')) }
  check('D3 and it cools down for the full 60 s: still skipped 11 s later', (await firstTriedAfter(build, setup, 11_000)) === 'P2')
}
for (const refusal of ['net', 'rl']) {
  const log = []
  const c = client([provider('BC', log, { stats: ['ok', refusal], burstLimited: false, budgetLimited: true }), provider('P2', log, { tip: 'net', stats: ['http'] })])
  await c.getAddressStats('a')
  const m = log.length
  await rejects(() => c.getAddressStats('a'))
  check(`D4 BlockCypher (an hourly budget, not burst-limited) is not retried after '${refusal}'`, log.slice(m).join(' ') === `BC:${refusal} P2:http`, log.slice(m).join(' '))
}
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'http'] }), provider('P2', log, { tip: 'net', stats: ['http'] })])
  await c.getAddressStats('a')
  let m = log.length
  await rejects(() => c.getAddressStats('a'))
  check('D5 an HTTP-level error fails over at once, no retry', log.slice(m).join(' ') === 'P1:http P2:http', log.slice(m).join(' '))
  m = log.length
  await rejects(() => c.getAddressStats('a'))
  check('D6 and earns no cooldown: P1 is tried first next time', first(log, m) === 'P1')
}

console.log('--- E. a concurrent scan burst ---')
{
  const log = []
  log.times = []
  // Calls 2–7 are refused, as mempool.space does ~30 lookups into a burst.
  const c = client([provider('P1', log, { stats: (n) => (n >= 1 && n <= 6 ? 'rl' : 'ok') })])
  await c.getAddressStats('a')
  const results = await Promise.all(Array.from({ length: 4 }, () => c.getAddressStats('a')))
  check('E1 all four concurrent lookups succeed', results.every((r) => r.from === 'P1'), results.map((r) => r.from).join(','))
  // No request may start inside a pause: each refusal opens one of >= 20 ms.
  const refusals = log.times.filter((t) => t.outcome === 'rl')
  const intrusions = log.times.filter((t) => refusals.some((r) => t.at > r.at + 2 && t.at < r.at + 18))
  check('E2 no request was sent while the provider was paused', intrusions.length === 0, `${intrusions.length} sent during a pause`)
}
{
  const log = []
  // Four lookups in flight hit the same burst together, then it clears.
  const c = client([provider('P1', log, { stats: (n) => (n >= 1 && n <= 4 ? 'rl' : 'ok') })])
  await c.getAddressStats('a')
  const { ms, err } = await timed(() => Promise.all(Array.from({ length: 4 }, () => c.getAddressStats('a'))))
  check('E3 one burst seen by four requests counts as one strike: a single 20 ms pause, not 80', err === null && ms < 55, `${ms} ms`)
}

console.log('--- F. a provider that never stops refusing ---')
{
  const log = []
  const c = client([provider('P1', log, { stats: ['ok', 'rl'] })])
  await c.getAddressStats('a')
  const m = log.length
  const { err } = await timed(() => c.getAddressStats('a'))
  check('F1 the request fails (never a made-up result)', err !== null)
  check('F2 within the attempt limit (8)', log.length - m <= 8, `${log.length - m} attempts`)
  check('F3 with the plain-words message', /busy or rate-limited/.test(err?.message ?? ''), err?.message?.slice(0, 60))
  const slow = createFailoverClient([provider('P1', [], { stats: ['ok', 'rl'] })], undefined, { backoffMs: [1_000], maxWaitMs: 200 })
  await slow.getAddressStats('a')
  const { ms } = await timed(() => slow.getAddressStats('a'))
  check('F4 it never waits past the request\'s wait limit', ms < 500, `${ms} ms`)
}

console.log('--- G. the esplora client reports what it saw ---')
{
  const { EsploraProvider } = await import('../src/lib/esplora.ts')
  const spec = { name: 'mock-esplora', kind: 'esplora', base: 'https://esplora.invalid/api', pageSize: 50 }
  const ep = new EsploraProvider(spec, {})
  const realFetch = globalThis.fetch
  const respond = (status, body) => async () => new Response(body, { status })
  let calls = 0
  globalThis.fetch = async () => (calls++, new Response('Too Many Requests', { status: 429 }))
  const e429 = await rejects(() => ep.getTipHeight())
  check('G1 an HTTP 429 is reported as rate limited, for the client to pause on', e429?.rateLimited === true, e429?.message)
  check('G2 ...and is thrown at once, with no retry of its own (the client owns the backoff)', calls === 1, `${calls} fetch call(s)`)
  globalThis.fetch = async () => { throw new TypeError('Load failed') }
  const eNet = await rejects(() => ep.getTipHeight())
  check('G3 a fetch with no response (a CORS-less 429 in a browser) propagates as a TypeError', eNet instanceof TypeError)
  globalThis.fetch = respond(503, 'busy')
  const e503 = await rejects(() => ep.getTipHeight())
  check('G4 other HTTP errors are not marked rate limited', e503 !== null && e503.rateLimited !== true, e503?.message)
  globalThis.fetch = respond(200, '157564')
  check('G5 a normal answer still parses', (await ep.getTipHeight()) === 157564)
  check('G6 esplora providers are burst-limited; the client relies on it', ep.burstLimited === true)
  globalThis.fetch = realFetch
}

console.log('--- H. a backup-only provider ---')
{
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  }
  const pref = () => JSON.parse(store.get('kailah.provider.v1') ?? '{}')
  const ltc = (log, primary = {}, backup = {}, key) =>
    createFailoverClient([provider('LS', log, primary), provider('BC', log, { burstLimited: false, backupOnly: true, ...backup })], key, TUNING)

  {
    const log = []
    const c = ltc(log, { logTip: true }, { logTip: true })
    for (let k = 0; k < 5; k++) await c.getAddressStats('a')
    check('H1 a healthy primary: the backup is never called, not even by a startup probe', log.every((e) => e.startsWith('LS:')) && !log.includes('BC:tip'), log.join(' '))
  }
  {
    const log = []
    const c = createFailoverClient([provider('P1', log, { logTip: true }), provider('P2', log, { logTip: true }), provider('BC', log, { burstLimited: false, backupOnly: true, logTip: true })], undefined, TUNING)
    await c.getAddressStats('a')
    check('H2 with two regular providers, the startup race leaves the backup out', log.includes('P1:tip') && log.includes('P2:tip') && !log.includes('BC:tip'), log.join(' '))
  }
  {
    const log = []
    const c = ltc(log, { tip: 'net', stats: ['timeout'] })
    const { err, value, ms } = await timed(() => c.getAddressStats('a'))
    check('H3 a primary that times out: the backup serves the request', err === null && value?.from === 'BC', err?.message ?? log.join(' '))
    check('H4 ...without waiting (a host that never answered is down)', ms < 20, `${ms} ms`)
    const m = log.length
    await c.getAddressStats('a')
    check('H5 while the primary cools down, requests go straight to the backup', first(log, m) === 'BC', log.slice(m).join(' '))
  }
  {
    const build = (l) => ltc(l, { tip: 'net', stats: (n) => (n === 0 ? 'timeout' : 'ok') })
    const setup = (cl) => cl.getAddressStats('a')
    check('H6 once the cooldown is over, the primary is tried first again', (await firstTriedAfter(build, setup, 61_000)) === 'LS')
  }
  {
    const log = []
    const c = ltc(log, { stats: ['ok', 'rl', 'ok'] })
    await c.getAddressStats('a')
    const { value } = await timed(() => c.getAddressStats('a'))
    check('H7 a primary that is only rate-limited is waited for; the backup is not used', value?.from === 'LS' && !log.some((e) => e.startsWith('BC:')), log.join(' '))
  }
  {
    store.clear()
    const log = []
    const c = ltc(log, { tip: 'net', stats: ['timeout'] }, {}, 'ltc')
    await c.getAddressStats('a')
    check('H8 a backup success is not remembered as the last-good provider', pref().ltc !== 'BC', JSON.stringify(pref()))
    store.set('kailah.provider.v1', JSON.stringify({ ltc: 'BC' }))
    const log2 = []
    const c2 = ltc(log2, {}, {}, 'ltc')
    await c2.getAddressStats('a')
    check('H9 a saved preference naming the backup is ignored: the primary goes first', first(log2, 0) === 'LS', log2.join(' '))
  }
  {
    const log = []
    const c = ltc(log, { push: 'net' })
    const txid = await rejects(async () => (timed.value = await c.broadcast('00')))
    check('H10 a broadcast that never reached the primary goes out through the backup', txid === null && timed.value === 'txid-BC' && log.join(' ') === 'LS:push-net BC:push-ok', log.join(' '))
    const log2 = []
    const c2 = ltc(log2, { push: 'http' })
    const e = await rejects(() => c2.broadcast('00'))
    check('H11 a primary that rejects a transaction is final: the backup is not tried', e !== null && !log2.some((x) => x.startsWith('BC:')), log2.join(' '))
  }
  {
    const log = []
    const c = ltc(log, { tip: 'net', stats: ['net'] }, { tip: 'net', stats: ['net'] })
    const e = await rejects(() => c.getAddressStats('a'))
    check('H12 both down: the plain-words message, no guess', /Couldn't reach the network data service/.test(e?.message ?? ''), e?.message?.slice(0, 60))
  }
  delete globalThis.localStorage
}

console.log('--- I. BlockCypher as the Litecoin backup ---')
{
  const { BlockcypherProvider } = await import('../src/lib/blockcypher.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  const LTC = CHAINS.ltc
  const DOGE = CHAINS.doge
  const ltcSpec = LTC.providers.find((p) => p.kind === 'blockcypher')
  check('I1 Litecoin lists BlockCypher last, as a backup only (Bitcore is the first backup; check-bitcore)', LTC.providers[0]?.name === 'litecoinspace.org' && LTC.providers.length === 3 && LTC.providers.at(-1) === ltcSpec && ltcSpec?.backupOnly === true && ltcSpec.base === 'https://api.blockcypher.com/v1/ltc/main')
  check('I2 Dogecoin\'s BlockCypher stays a regular provider, first in its list', DOGE.providers[0].kind === 'blockcypher' && DOGE.providers[0].backupOnly !== true)
  const realFetch = globalThis.fetch
  const calls = []
  const replies = new Map()
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), at: realNow() })
    const path = String(url).replace(/^https:\/\/api\.blockcypher\.com\/v1\/(ltc|doge)\/main/, '')
    // the most specific route wins ('' is the chain root)
    const body = [...replies].filter(([k]) => (k === '' ? path === '' : path.startsWith(k))).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    return new Response(JSON.stringify(body ?? {}), { status: 200 })
  }
  const ltcBc = new BlockcypherProvider(ltcSpec, LTC)
  const dogeBc = new BlockcypherProvider(DOGE.providers[0], DOGE)
  check('I3 the Litecoin instance reports itself backup-only', ltcBc.backupOnly === true && dogeBc.backupOnly === false)

  // the chain root as BlockCypher served it for LTC on 2026-10-26
  replies.set('', { name: 'LTC.main', height: 3201935, high_fee_per_kb: 12133, medium_fee_per_kb: 9909, low_fee_per_kb: 8585 })
  const fees = await ltcBc.getFeeOptions()
  check('I4 Litecoin fees come from the chain root, per vbyte, rounded up', fees.map((f) => f.rate).join(',') === '13,10,9', fees.map((f) => `${f.label} ${f.rate}`).join(', '))
  const dogeFees = await dogeBc.getFeeOptions()
  check('I5 Dogecoin keeps its flat configured rate', dogeFees.length === 1 && dogeFees[0].rate === DOGE.fixedFeeRate)
  replies.set('', { name: 'LTC.main', height: 3201935 })
  check('I6 a chain root without estimates is an error, not a made-up fee', (await rejects(() => ltcBc.getFeeOptions())) !== null)

  const A = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
  const fullTx = (seq) => ({
    txs: [{ hash: 'aa'.repeat(32), block_height: -1, received: '2026-10-26T10:00:00Z', fees: 1000,
      inputs: [{ prev_hash: 'bb'.repeat(32), output_index: 0, output_value: 26674, addresses: [A], sequence: seq }],
      outputs: [{ value: 25674, addresses: ['ltc1qmpulet0rhxmpd2sy6upd8kgw9rjt67sls0wmc3'] }] }],
  })
  replies.set(`/addrs/${A}/full`, fullTx(0xfffffffd))
  const [rbf] = await ltcBc.getAddressTxs(A)
  check('I7 a Litecoin tx whose input signals BIP125 is replaceable (Speed up works)', rbf?.rbfSignaled === true && rbf.inputs[0].address === A && rbf.height === null)
  replies.set(`/addrs/${A}/full`, fullTx(0xffffffff))
  check('I8 ...and one with final sequences is not', (await ltcBc.getAddressTxs(A))[0]?.rbfSignaled === false)
  replies.set(`/addrs/${A}/full`, fullTx(0xfffffffd))
  check('I9 on Dogecoin a low sequence still never means replaceable', (await dogeBc.getAddressTxs(A))[0]?.rbfSignaled === false)

  calls.length = 0
  replies.set(`/addrs/${A}?unspentOnly`, { txrefs: [{ tx_hash: 'cc'.repeat(32), tx_output_n: 1, value: 5000 }] })
  const utxos = await ltcBc.getAddressUtxos(A)
  check('I10 Litecoin (segwit) UTXOs cost one request: no raw-hex fetches', calls.length === 1 && utxos.length === 1 && utxos[0].rawTxHex === undefined, `${calls.length} request(s)`)

  calls.length = 0
  await Promise.all([ltcBc.getTipHeight(), dogeBc.getTipHeight(), ltcBc.getTipHeight(), dogeBc.getTipHeight()])
  const gaps = calls.slice(1).map((c, k) => c.at - calls[k].at)
  check('I11 concurrent Litecoin and Dogecoin requests queue behind one gate, 500 ms apart', calls.length === 4 && gaps.every((g) => g >= 480), gaps.join(', ') + ' ms')
  globalThis.fetch = realFetch
}

console.log('--- J. after the 2026-10-27 audit: rate limits, start-up order, backups, writes after erase, BlockCypher limits ---')
{
  // BM6: Bitcore's limiter answers a visible 429; that is push-back, and
  // BlockCypher's budget is not spent to dodge it
  const log = []
  const c = client([
    provider('BC', log, { tip: 'net', burstLimited: false, budgetLimited: true }),
    provider('BT', log, { burstLimited: false, stats: ['ok', 'rl', 'ok'] }),
  ])
  await c.getAddressStats('a')
  const { value, err } = await timed(() => c.getAddressStats('a'))
  check('J1 a visible 429 from a provider that isn\'t burst-limited (Bitcore) pauses it and retries it (BM6)', err === null && value?.from === 'BT' && log.join(' ') === 'BT:ok BT:rl BT:ok', log.join(' '))
  check('J1b ...without spending a request of BlockCypher\'s hourly budget', !log.some((e) => e.startsWith('BC:')))
  const log2 = []
  const c2 = client([provider('BT', log2, { burstLimited: false, stats: ['ok', 'rl', 'ok'] }), provider('P2', log2, { stats: ['ok'] })])
  await c2.getAddressStats('a')
  await c2.getAddressStats('a')
  check('J1c an unmetered second provider still covers the pause at once, as before', log2.join(' ') === 'BT:ok BT:rl P2:ok', log2.join(' '))
}
{
  // BL8: the start-up probe keeps the configured order when the first answers
  const log = []
  const c = client([provider('P1', log, { tipDelay: 60 }), provider('P2', log)])
  await c.getAddressStats('a')
  check('J2 a slower but healthy first provider stays the daily driver (the fastest no longer wins) (BL8)', c.activeProvider() === 'P1' && log[0] === 'P1:ok', `${c.activeProvider()} / ${log.join(' ')}`)
  const log2 = []
  const c2 = client([provider('P1', log2, { tip: 'net', stats: ['net'] }), provider('P2', log2, { tipDelay: 30 })])
  await c2.getAddressStats('a')
  check('J2b a first provider that doesn\'t answer the probe is passed over', c2.activeProvider() === 'P2' && log2[0] === 'P2:ok', `${c2.activeProvider()} / ${log2.join(' ')}`)
}
{
  // BL7: the client says when a backup is answering, so polls slow down
  const log = []
  const c = createFailoverClient([provider('LS', log, { tip: 'net', stats: (n) => (n === 0 ? 'net' : 'ok') }), provider('BC', log, { burstLimited: false, backupOnly: true, budgetLimited: true })], undefined, TUNING)
  check('J3 a fresh client is not on a backup', c.onBackup() === false)
  await c.getAddressStats('a')
  check('J3b with the regular provider down, a backup answers and the client says so (BL7)', c.onBackup() === true && log.join(' ') === 'LS:net BC:ok', log.join(' '))
  advance(61_000)
  await c.getAddressStats('a')
  check('J3c once the regular provider answers again, it doesn\'t', c.onBackup() === false && log.at(-1) === 'LS:ok', log.join(' '))
}
{
  // BL9: no provider preference written after the wallet locked or was erased
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  }
  const { lockSecureStore } = await import('../src/lib/securestore.ts')
  const gated = (lock) => {
    let release
    const gate = new Promise((r) => (release = r))
    const p1 = { providerName: 'P1', getTipHeight: async () => 100, getAddressStats: async () => { await gate; throw new TypeError('Load failed') } }
    const p2 = { providerName: 'P2', getTipHeight: async () => 100, getAddressStats: async () => STATS }
    const c = createFailoverClient([p1, p2], 'btc', TUNING)
    const req = c.getAddressStats('a')
    return (async () => {
      await new Promise((r) => setTimeout(r, 10))
      if (lock) lockSecureStore() // the user locks (or erases) while the request is out
      release()
      await req
      return JSON.parse(store.get('kailah.provider.v1') ?? '{}').btc
    })()
  }
  check('J4 a failover remembers the provider that answered (control)', (await gated(false)) === 'P2')
  store.clear()
  check('J4b ...but not when the wallet locked or was erased while the request was out (BL9)', (await gated(true)) === undefined)
  delete globalThis.localStorage
}
{
  // BM7, BL4: BlockCypher serves every input and output up to its limit, a
  // transaction past it is marked partial, and a broadcast has a deadline
  const { BlockcypherProvider } = await import('../src/lib/blockcypher.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  const DOGE = CHAINS.doge
  const realFetch = globalThis.fetch
  const seen = []
  const D = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'
  const out = (n) => Array.from({ length: n }, (_, k) => ({ value: 1000 + k, addresses: [k === 0 ? D : 'DOther'] }))
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), signal: init?.signal })
    if (String(url).includes('/txs/push')) return new Response(JSON.stringify({ tx: { hash: 'ee'.repeat(32) } }), { status: 201 })
    return new Response(JSON.stringify({ txs: [
      { hash: 'a1'.repeat(32), block_height: 5, confirmed: '2026-10-01T00:00:00Z', fees: 1, vin_sz: 1, vout_sz: 30, inputs: [{ prev_hash: 'b1'.repeat(32), output_index: 0, output_value: 99_999, addresses: ['DExchange'] }], outputs: out(30) },
      { hash: 'a2'.repeat(32), block_height: 5, confirmed: '2026-10-01T00:00:00Z', fees: 1, vin_sz: 1, vout_sz: 900, inputs: [{ prev_hash: 'b2'.repeat(32), output_index: 0, output_value: 99_999, addresses: ['DExchange'] }], outputs: out(500) },
    ] }), { status: 200 })
  }
  const bc = new BlockcypherProvider(DOGE.providers[0], DOGE)
  const txs = await bc.getAddressTxs(D)
  check('J5 the history request asks for every input and output up to 500 (BlockCypher\'s default is 20) (BM7)', /[?&]txlimit=500\b/.test(seen[0]?.url ?? ''), seen[0]?.url)
  check('J5b a batch payout served whole is read whole', txs[0]?.outputs.length === 30 && txs[0]?.partial === undefined)
  check('J5c one with more outputs than were served is marked partial, not read as a wrong amount', txs[1]?.partial === true)
  seen.length = 0
  await bc.broadcast('00')
  check('J6 a BlockCypher broadcast has a deadline, so "Broadcasting…" can\'t hang forever (BL4)', seen[0]?.signal instanceof AbortSignal)
  globalThis.fetch = realFetch
}

console.log('\n--- K. practice Bitcoin: a second service, and polls that back off (review 2026-10-28) ---')
{
  // testnet4's second service used to be mempool.emzy.de, which answers tips
  // but 404s every address lookup: when mempool.space was busy or blocked,
  // a new wallet's practice Bitcoin card could only fail.
  const { CHAINS } = await import('../src/lib/networks.ts')
  const { buildProviders } = await import('../src/lib/api.ts')
  const tn = CHAINS['btc-testnet'].providers
  check('K1 practice Bitcoin: mempool.space, then blockstream.info as a backup with an hourly budget (700 an hour per IP)',
    tn.map((p) => p.name).join() === 'mempool.space,blockstream.info' &&
      tn.every((p) => p.kind === 'esplora') && tn[0].backupOnly !== true && tn[0].budgetLimited !== true &&
      tn[1].base === 'https://blockstream.info/testnet4/api' && tn[1].pageSize === 25 &&
      tn[1].backupOnly === true && tn[1].budgetLimited === true,
    tn.map((p) => `${p.name} ${p.base}`).join(', '))
  const built = buildProviders(CHAINS['btc-testnet'])
  check('K1c the esplora providers carry the spec\'s backup and budget flags',
    built[0].backupOnly === false && built[1].backupOnly === true && built[1].budgetLimited === true)
  const btc = buildProviders(CHAINS.btc)
  check('K1d mainnet Bitcoin: three mempool instances, then blockstream.info as a backup with an hourly budget (2026-10-29)',
    btc.map((p) => p.providerName).join() === 'mempool.space,mempool.emzy.de,mempool.bitaroo.net,blockstream.info' &&
      btc.slice(0, 3).every((p) => p.backupOnly === false && p.budgetLimited === false) &&
      btc[3].backupOnly === true && btc[3].budgetLimited === true,
    btc.map((p) => `${p.providerName}${p.backupOnly ? '(backup)' : ''}`).join())
  check('K1b no testnet4 service that can\'t look up addresses (mempool.emzy.de)', !tn.some((p) => p.base.includes('emzy')))
  check('K2 every practice Bitcoin service is on testnet4 (never testnet3\'s /testnet/api, another chain)',
    tn.every((p) => /\/testnet4\/api$/.test(p.base) && p.broadcastBase === undefined))

  // The real provider list behind a scripted network: `mode` says how
  // mempool.space answers ('down': no response; 'busy': a visible 429), and
  // `bs` how Blockstream does ('ok' or 'spent': its hourly cap's 429).
  const realFetch = globalThis.fetch
  const asked = []
  const net = { mode: 'down', bs: 'ok' }
  const STATS_JSON = { chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }
  globalThis.fetch = async (url) => {
    const u = String(url)
    asked.push(u)
    if (u.startsWith('https://mempool.space/')) {
      if (net.mode === 'down') throw new TypeError('Load failed')
      if (net.mode === 'busy') return new Response('Too Many Requests', { status: 429 })
      if (u.includes('/address/')) return new Response(JSON.stringify(STATS_JSON), { status: 200 })
    }
    if (u.startsWith('https://blockstream.info/testnet4/api/')) {
      if (net.bs === 'spent') return new Response('{"error":"Too Many Requests"}', { status: 429 })
      if (u.endsWith('/blocks/tip/height')) return new Response('157951', { status: 200 })
      if (u.includes('/address/')) return new Response(JSON.stringify(STATS_JSON), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const A = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl'
  const c = createFailoverClient(buildProviders(CHAINS['btc-testnet']), undefined, TUNING)
  let answer
  const err = await rejects(async () => (answer = await c.getAddressStats(A)))
  check('K3 with mempool.space unreachable, an address lookup is answered by blockstream.info',
    err === null && answer?.balance.confirmed === 4000n && answer?.txCount === 3, err?.message)
  check('K3b ...as a backup: the client says so (the card then polls every 10 minutes) and keeps mempool.space as its service',
    c.onBackup() === true && c.activeProvider() === 'mempool.space')
  let before = asked.length
  await c.getAddressStats('tb1qother')
  check('K3c while mempool.space cools down, the next lookup goes straight to the backup',
    asked.slice(before)[0]?.startsWith('https://blockstream.info/testnet4/api/address/'), asked.slice(before).join(' '))

  // Blockstream's 429 means this IP's hour is spent: never retried.
  net.bs = 'spent'
  before = asked.length
  const spent = await timed(() => c.getAddressStats(A))
  const bsAsked = asked.slice(before).filter((u) => u.startsWith('https://blockstream.info/')).length
  check('K3d a 429 from blockstream.info fails the lookup at once, without retrying into a spent budget',
    spent.err !== null && bsAsked === 1 && spent.ms < 1_000, `${bsAsked} request(s), ${spent.ms} ms`)

  // A merely busy mempool.space (a visible 429) is waited for, not dodged
  // through the backup's budget.
  const c2 = createFailoverClient(buildProviders(CHAINS['btc-testnet']), undefined, TUNING)
  net.mode = 'busy'
  net.bs = 'ok'
  before = asked.length
  setTimeout(() => (net.mode = 'ok'), 30)
  const waited = await rejects(() => c2.getAddressStats(A))
  const hosts = asked.slice(before).map((u) => new URL(u).host)
  check('K3e a rate-limited mempool.space is waited for and then answers; the backup is not spent on a mere rate limit',
    waited === null && hosts.length >= 2 && hosts.every((h) => h === 'mempool.space') && c2.onBackup() === false, hosts.join(' '))
  globalThis.fetch = realFetch

  const { POLL_BACKOFF_MS, afterScanFailure, pollDue } = await import('../src/lib/pollbackoff.ts')
  const t0 = 1_000_000
  let b
  const waits = []
  for (let k = 0; k < 7; k++) {
    b = afterScanFailure(b, t0)
    waits.push((b.retryAt - t0) / 60_000)
  }
  check('K4 each failed scan in a row doubles the wait between background polls, from 1 to 10 minutes',
    waits.join() === '1,2,4,8,10,10,10' && POLL_BACKOFF_MS.at(-1) === 600_000, waits.join())
  const one = afterScanFailure(undefined, t0)
  const { pollMayStart, REFRESH_MAX_MS } = await import('../src/lib/pollbackoff.ts')
  check('K7 a poll leaves an EVM, Solana or TRON refresh under way alone; one that never ended stops holding it after three minutes (review 2026-10-30)',
    pollMayStart(undefined, t0) && !pollMayStart(t0, t0 + 59_000) && !pollMayStart(t0, t0 + REFRESH_MAX_MS - 1) && pollMayStart(t0, t0 + REFRESH_MAX_MS) && REFRESH_MAX_MS === 180_000)
  check('K4b no backoff → due; during the wait → not due; at its end → due',
    pollDue(undefined, t0) && !pollDue(one, t0 + 59_999) && pollDue(one, t0 + 60_000))

  // App.tsx wiring: only background polls wait; a success clears the wait.
  const app = readFileSync('src/App.tsx', 'utf8')
  const silentUtxo = [...app.matchAll(/^.*refresh(?:Chain|Hw)\((?:chain|hw), \{ silent: true.*$/gm)]
  const pollFn = app.slice(app.indexOf('const poll = (cadence'), app.indexOf('const pollEvm ='))
  check('K5 App: every background UTXO poll asks pollDue first, for seed chains and Ledger accounts alike',
    silentUtxo.length === 2 && silentUtxo.every((m) => pollFn.includes(m[0])) &&
      /due\(chain\.id\)\)/.test(pollFn) && /due\(hardwareSlotKey\(hw\.record\)\)\)/.test(pollFn) && /pollDue\(pollBackoffRef\.current\[key\]/.test(pollFn),
    `${silentUtxo.length} silent UTXO refresh call(s)`)
  check('K5b App: a failed scan records the backoff, a finished one clears it, and lock/erase forgets it',
    /\.catch\(\(e: unknown\) => \{\s*if \(!isCurrent\(\)\) return\s*pollBackoffRef\.current\[key\] = afterScanFailure\(pollBackoffRef\.current\[key\], Date\.now\(\)\)/.test(app) &&
      /\.then\(\(state\) => \{\s*if \(!isCurrent\(\)\) return\s*delete pollBackoffRef\.current\[key\]/.test(app) &&
      /pendingManualScanRef\.current = \{\}\s*pollBackoffRef\.current = \{\}/.test(app))
  check('K5c App: nothing but the background poll consults the backoff (a refresh, unlock or mode change never waits)',
    (app.match(/pollDue\(/g) ?? []).length === 1)

  // ChainCard: a test network's failed check is a calm note, a real one an alert.
  const card = readFileSync('src/components/ChainCard.tsx', 'utf8')
  const testNote = card.slice(card.indexOf('!loading && !chain.mainnet &&'), card.indexOf('<div className="chain-address">'))
  const realAlert = card.slice(card.indexOf('!loading && chain.mainnet &&'), card.indexOf('!loading && !chain.mainnet &&'))
  check('K6 a test network\'s failed check shows a calm status note that says Kailah keeps trying',
    /className="chain-note" role="status"/.test(testNote) && !/role="alert"/.test(testNote) && /tries again on its own/.test(testNote) && /Get coins still work/.test(testNote))
  check('K6b a real network\'s failed check is still an alert with the scan\'s own message',
    /className="chain-error" role="alert"/.test(realAlert) && /\{error\}/.test(realAlert))
}

Date.now = realNow
console.log(failures === 0 ? '\nAll failover checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
