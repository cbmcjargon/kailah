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
//      the attempt and wait limits, and never yields a made-up result.
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
function provider(name, log, { tip = 'ok', stats = ['ok'], burstLimited = true } = {}) {
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
    getTipHeight: () => (tip === 'ok' ? Promise.resolve(100) : Promise.reject(new TypeError('Load failed'))),
    getAddressStats: () => act(typeof stats === 'function' ? stats(n++) : stats[Math.min(n++, stats.length - 1)]),
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
  const c = client([provider('BC', log, { stats: ['ok', refusal], burstLimited: false }), provider('P2', log, { tip: 'net', stats: ['http'] })])
  await c.getAddressStats('a')
  const m = log.length
  await rejects(() => c.getAddressStats('a'))
  check(`D4 a provider without burstLimited (BlockCypher: hourly budget) is not retried after '${refusal}'`, log.slice(m).join(' ') === `BC:${refusal} P2:http`, log.slice(m).join(' '))
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

Date.now = realNow
console.log(failures === 0 ? '\nAll failover checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
