// check-health.mjs — LIVE. Are the services the wallet relies on still doing
// their job? Run by hand with `npm run check:health` (`-- ethereum` narrows it
// to one network or host), and before every release.
//
// Each service gets the calls the wallet really makes, once, from this machine,
// and a browser's permission check for each place the wallet runs (both sites
// and the extension). See health-probes.mjs for what is asked and how answers
// are read. It costs a handful of requests per service, BlockCypher's ~100 an
// hour included (four of them).
//
// It exits 1 if a service answers but can't do its job, or a job has nothing
// answering at all. A service that is busy or silent, or a bot check that turns
// this script away, is reported but passes: that may be this machine's standing
// with the service. Open the wallet in a browser to be sure about those.

const store = new Map()
globalThis.localStorage ??= {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}

const { CHAINS } = await import('../src/lib/networks.ts')
const { EVM_CHAINS } = await import('../src/lib/evm.ts')
const { SOL_CHAINS } = await import('../src/lib/sol.ts')
const { TRON_CHAINS, tronAddressToHex } = await import('../src/lib/tron.ts')
const { WALLET_ORIGINS, classifyAnswer, classifyNoAnswer, markLagging, preflightProblem, servicesFor, verdictOf } =
  await import('./health-probes.mjs')

const TIMEOUT_MS = 12_000
const SLOW_MS = 6_000
const RETRY_MS = 1_500
const [ORIGIN] = WALLET_ORIGINS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(call, ctx) {
  const t0 = Date.now()
  const init = typeof call.init === 'function' ? call.init(ctx) : call.init
  try {
    const res = await fetch(call.url, {
      ...init,
      headers: { Origin: ORIGIN, ...init?.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    const verdict = res.ok ? call.check(text, ctx) : true
    return {
      ...classifyAnswer({
        status: res.status,
        text,
        acao: res.headers.get('access-control-allow-origin'),
        cfMitigated: res.headers.get('cf-mitigated') !== null,
        origin: ORIGIN,
        verdict,
      }),
      ms: Date.now() - t0,
    }
  } catch (e) {
    return { ...classifyNoAnswer(e), ms: Date.now() - t0 }
  }
}

/** Whether browsers at every place the wallet runs may use it. */
async function browserAccess(service, firstUrl) {
  for (const origin of WALLET_ORIGINS) {
    try {
      const res = service.preflight
        ? await fetch(firstUrl, {
            method: 'OPTIONS',
            headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        : await fetch(firstUrl, { headers: { Origin: origin }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      await res.arrayBuffer()
      const problem = preflightProblem({
        status: res.status,
        acao: res.headers.get('access-control-allow-origin'),
        acah: service.preflight ? res.headers.get('access-control-allow-headers') : null,
        origin,
      })
      if (problem !== null) return problem
    } catch {
      return null // no answer says nothing about permission, and the calls already showed it answers
    }
    await sleep(service.gapMs ?? 250)
  }
  return null
}

async function probe(service) {
  const ctx = {}
  const r = { ...service, calls: undefined, state: 'ok', detail: '', ms: 0 }
  for (const call of service.calls) {
    if (call.skip?.(ctx) === true) continue
    let a = await ask(call, ctx)
    // one glitch isn't a broken service: only a second bad answer counts
    if (a.state === 'broken' || a.state === 'down') {
      await sleep(RETRY_MS)
      a = await ask(call, ctx)
    }
    r.ms = Math.max(r.ms, a.ms)
    if (a.state !== 'ok') {
      r.state = a.state
      r.detail = `${call.label}: ${a.detail}`
      break
    }
    await sleep(service.gapMs ?? 250)
  }
  if (r.state === 'ok') {
    const problem = await browserAccess(service, service.calls[0].url)
    if (problem !== null) {
      r.state = 'broken'
      r.detail = problem
    } else if (r.ms > SLOW_MS) {
      r.state = 'slow'
    }
  }
  if (ctx.height !== undefined) r.height = ctx.height
  return r
}

const only = process.argv[2]?.toLowerCase()
const all = servicesFor({ CHAINS, EVM_CHAINS, SOL_CHAINS, TRON_CHAINS, tronAddressToHex })
const services = only === undefined ? all : all.filter((s) => `${s.network} ${s.chainId} ${s.host}`.toLowerCase().includes(only))
if (services.length === 0) {
  console.error(`No service matches "${only}".`)
  process.exit(2)
}

// One host at a time per host (they count requests per IP); hosts side by side.
const byHost = new Map()
for (const s of services) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s])
const results = (
  await Promise.all(
    [...byHost.values()].map(async (list) => {
      const out = []
      for (const s of list) out.push(await probe(s))
      return out
    }),
  )
).flat()
markLagging(results)

const place = (r) => services.findIndex((s) => s.network === r.network && s.name === r.name && s.role === r.role)
results.sort((a, b) => place(a) - place(b))

let network = null
for (const r of results) {
  if (r.network !== network) {
    network = r.network
    console.log(`\n${network}`)
  }
  const name = `${r.name}${r.backup ? ' (backup)' : ''}${r.role === 'explorer' ? ' (explorer)' : ''}`
  const heard = r.state === 'ok' || r.state === 'slow' || r.state === 'lagging' ? `${(r.ms / 1000).toFixed(1)} s` : ''
  console.log(`  ${r.state.padEnd(10)} ${name.padEnd(44)} ${heard}${r.detail ? `  ${r.detail}` : ''}`)
}

const { fails, warns, exitCode } = verdictOf(results)
const count = (state) => results.filter((r) => r.state === state).length
console.log(`\n${results.length} services: ${count('ok')} ok${warns.length > 0 ? `, ${warns.length} to look at` : ''}${fails.length > 0 ? `, ${fails.length} failing` : ''}.`)
if (warns.length > 0) {
  console.log('\nWorth a look (these can be this machine, not the service):')
  for (const w of warns) console.log(`  - ${w}`)
}
if (fails.length > 0) {
  console.log('\nNEEDS FIXING:')
  for (const f of fails) console.log(`  - ${f}`)
}
console.log(exitCode === 0 ? '\nHealthy: nothing here needs fixing.' : '\nNot healthy: see "NEEDS FIXING" above.')
process.exit(exitCode)
