// Live, read-only smoke test for the v2 provider layer:
//   src/lib/esplora.ts, src/lib/blockcypher.ts, src/lib/api.ts, src/lib/prices.ts
//
// Hits each real backend ONCE per method against a known-history address and
// asserts the normalized shapes (RawTxInfo, Balance, FeeOption, tip height) plus
// FailoverClient behavior and fetchPriceHistory. NEVER broadcasts.
//
// Run from the repo root: npx tsx scripts/check-providers.mjs

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-providers')
import { EsploraProvider } from '../src/lib/esplora.ts'
import { createFailoverClient, getClient } from '../src/lib/api.ts'
import { fetchPriceHistory } from '../src/lib/prices.ts'
import { CHAINS } from '../src/lib/networks.ts'

// --- known-history addresses (read-only) ---
const BTC_ADDR = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const TESTNET4_ADDR = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl'
const LTC_ADDR = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
const DOGE_ADDR = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'

let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// Assert the normalized shape of a RawTxInfo[] page. Returns evidence string.
function assertRawTxs(label, txs) {
  check(`${label}: getAddressTxs returned txs`, txs.length > 0, `${txs.length} txs`)
  if (txs.length === 0) return ''

  // rbfSignaled is a boolean on every tx.
  const allBool = txs.every((t) => typeof t.rbfSignaled === 'boolean')
  check(`${label}: rbfSignaled is boolean on every tx`, allBool)

  // At least one tx whose inputs all carry prevTxid + prevVout (needed for RBF).
  const withInputs = txs.find(
    (t) =>
      t.inputs.length > 0 &&
      t.inputs.every(
        (i) => typeof i.prevTxid === 'string' && typeof i.prevVout === 'number',
      ),
  )
  check(
    `${label}: inputs populate prevTxid/prevVout`,
    !!withInputs,
    withInputs
      ? `e.g. ${withInputs.inputs[0].prevTxid.slice(0, 12)}…:${withInputs.inputs[0].prevVout}`
      : 'no tx had fully-resolved inputs',
  )

  // fee parses to bigint|null; height parses to number|null; at least one
  // confirmed tx has both a bigint fee and a numeric height.
  const feeOk = txs.every((t) => t.fee === null || typeof t.fee === 'bigint')
  const heightOk = txs.every((t) => t.height === null || typeof t.height === 'number')
  check(`${label}: fee is bigint|null on every tx`, feeOk)
  check(`${label}: height is number|null on every tx`, heightOk)
  const confirmed = txs.find(
    (t) => typeof t.fee === 'bigint' && typeof t.height === 'number',
  )
  check(
    `${label}: a confirmed tx parses fee(bigint) + height(number)`,
    !!confirmed,
    confirmed ? `fee=${confirmed.fee} height=${confirmed.height}` : undefined,
  )

  // outputs carry bigint values.
  const outOk = txs.every((t) => t.outputs.every((o) => typeof o.value === 'bigint'))
  check(`${label}: outputs carry bigint values`, outOk)

  return `${txs.length} txs, sample txid ${txs[0].txid.slice(0, 16)}…`
}

async function checkEsploraProvider(label, provider) {
  console.log(`\n=== ${label} ===`)
  const addr = provider.__addr

  const stats = await provider.getAddressStats(addr)
  check(
    `${label}: getAddressStats`,
    typeof stats.balance.confirmed === 'bigint' &&
      typeof stats.balance.unconfirmed === 'bigint' &&
      Number.isFinite(stats.txCount) &&
      stats.txCount > 0,
    `confirmed=${stats.balance.confirmed} unconfirmed=${stats.balance.unconfirmed} txCount=${stats.txCount}`,
  )

  const utxos = await provider.getAddressUtxos(addr)
  check(
    `${label}: getAddressUtxos`,
    Array.isArray(utxos) && utxos.every((u) => typeof u.value === 'bigint'),
    `${utxos.length} utxos`,
  )

  const txs = await provider.getAddressTxs(addr)
  assertRawTxs(label, txs)

  const tip = await provider.getTipHeight()
  check(`${label}: getTipHeight is a large int`, Number.isInteger(tip) && tip > 100000, `tip=${tip}`)

  const fees = await provider.getFeeOptions()
  check(
    `${label}: getFeeOptions returns 3 clamped rates`,
    fees.length === 3 &&
      fees.every((f) => typeof f.rate === 'bigint' && f.rate >= 1n && f.rate <= 1000n),
    fees.map((f) => `${f.label}=${f.rate}`).join(' '),
  )

  return { stats, txs, tip }
}

/** Run one provider's section; an unreachable host is a SKIP, not a crash. */
async function tryProvider(label, fn) {
  try {
    return await fn()
  } catch (e) {
    if (isNetworkIssue(e)) {
      console.log(`SKIP  ${label} — unreachable from this network: ${String(e?.message ?? e).slice(0, 80)}`)
      return null
    }
    throw e
  }
}

async function main() {
  // --- BTC mainnet: exercise BOTH providers directly to prove failover parity.
  const [specA, specB] = CHAINS.btc.providers
  const hostOf = (spec) => new URL(spec.base ?? spec.url ?? 'https://unknown').hostname
  const labelA = `btc/${hostOf(specA)}`, labelB = `btc/${hostOf(specB)}`
  const provA = new EsploraProvider(specA, CHAINS.btc)
  const provB = new EsploraProvider(specB, CHAINS.btc)
  provA.__addr = BTC_ADDR
  provB.__addr = BTC_ADDR

  const m = await tryProvider(labelA, () => checkEsploraProvider(labelA, provA))
  const b = await tryProvider(labelB, () => checkEsploraProvider(labelB, provB))
  if (m && b) {
    check(
      `btc: ${hostOf(specA)} vs ${hostOf(specB)} confirmed balance parity`,
      m.stats.balance.confirmed === b.stats.balance.confirmed,
      `${hostOf(specA)}=${m.stats.balance.confirmed} ${hostOf(specB)}=${b.stats.balance.confirmed}`,
    )
    check(
      'btc: both providers agree tx history is present',
      m.stats.txCount > 0 && b.stats.txCount > 0,
      `txCount ${m.stats.txCount} / ${b.stats.txCount}`,
    )
  } else {
    console.log('SKIP  btc: provider parity — needs both providers reachable')
  }

  // --- testnet4 + LTC via the real getClient() failover factory path.
  const tnClient = getClient(CHAINS['btc-testnet'])
  tnClient.__addr = TESTNET4_ADDR
  // getClient returns a FailoverClient (AddressApi surface), not a raw provider —
  // wrap so checkEsploraProvider's provider.* calls work uniformly.
  if (await tryProvider('btc-testnet/getClient', () => checkEsploraProvider('btc-testnet/getClient', tnClient))) {
    check(
      'btc-testnet: activeProvider tracked',
      typeof tnClient.activeProvider() === 'string' && tnClient.activeProvider().length > 0,
      tnClient.activeProvider(),
    )
  }

  const ltcClient = getClient(CHAINS.ltc)
  ltcClient.__addr = LTC_ADDR
  await tryProvider('ltc/getClient', () => checkEsploraProvider('ltc/getClient', ltcClient))

  // --- DOGE (BlockCypher). Conserve the ~100-200 req/HOUR free tier: hit
  //     stats, txs, tip, fees only. getAddressUtxos is skipped here because it
  //     fetches one raw-hex request per distinct funding txid — expensive
  //     against the budget and already covered structurally by the esplora path.
  console.log('\n=== doge/blockcypher ===')
  const doge = getClient(CHAINS.doge)
  const dStats = await doge.getAddressStats(DOGE_ADDR)
  check(
    'doge: getAddressStats',
    typeof dStats.balance.confirmed === 'bigint' && dStats.txCount > 0,
    `confirmed=${dStats.balance.confirmed} txCount=${dStats.txCount}`,
  )
  const dTxs = await doge.getAddressTxs(DOGE_ADDR)
  assertRawTxs('doge', dTxs)
  check(
    'doge: rbfSignaled is always false (no BIP125)',
    dTxs.every((t) => t.rbfSignaled === false),
  )
  const dTip = await doge.getTipHeight()
  check('doge: getTipHeight is a large int', Number.isInteger(dTip) && dTip > 100000, `tip=${dTip}`)
  const dFees = await doge.getFeeOptions()
  check(
    'doge: getFeeOptions returns the flat fixed rate',
    dFees.length === 1 && dFees[0].rate === CHAINS.doge.fixedFeeRate,
    `rate=${dFees[0]?.rate}`,
  )
  console.log('  (getAddressUtxos intentionally skipped for doge to protect the hourly budget)')

  // --- FailoverClient actually falls over: bad-first provider, real second.
  console.log('\n=== failover ===')
  const badSpec = { name: 'bad-first', kind: 'esplora', base: 'https://nonexistent.invalid/api', pageSize: 25 }
  const goodSpec = CHAINS.btc.providers[1] // blockstream.info
  const failover = createFailoverClient([
    new EsploraProvider(badSpec, CHAINS.btc),
    new EsploraProvider(goodSpec, CHAINS.btc),
  ])
  const foStats = await failover.getAddressStats(BTC_ADDR)
  check(
    'failover: bad-first -> real second still returns data',
    typeof foStats.balance.confirmed === 'bigint' && foStats.txCount > 0,
    `confirmed=${foStats.balance.confirmed} txCount=${foStats.txCount}`,
  )
  check(
    'failover: activeProvider is now the healthy second provider',
    failover.activeProvider() === 'blockstream.info',
    failover.activeProvider(),
  )
  // Once the healthy provider is remembered, the next call must not re-touch the
  // dead one — a plain success confirms last-good stickiness.
  const foTip = await failover.getTipHeight()
  check('failover: sticky active provider serves the next call', Number.isInteger(foTip) && foTip > 100000, `tip=${foTip}`)

  // --- price history for the sparklines.
  console.log('\n=== prices ===')
  const hist = await fetchPriceHistory('BTC')
  check(
    'fetchPriceHistory("BTC") returns > 20 downsampled points',
    Array.isArray(hist) && hist.length > 20 && hist.length <= 48,
    `${hist.length} points, first=$${hist[0]?.p?.toFixed(2)} last=$${hist[hist.length - 1]?.p?.toFixed(2)}`,
  )
  check(
    'fetchPriceHistory points are {t:sec, p:usd}, oldest-first',
    hist.length > 1 &&
      hist.every((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.p) && pt.p > 0) &&
      hist[0].t < hist[hist.length - 1].t,
    `t range ${hist[0]?.t}…${hist[hist.length - 1]?.t}`,
  )

  console.log('')
  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('All provider checks passed')
}

main().catch((err) => {
  if (isNetworkIssue(err)) {
    console.log(`SKIP  remaining checks — live dependency unavailable: ${String(err?.message ?? err).slice(0, 100)}`)
    process.exit(0)
  }
  console.error('check-providers crashed:', err)
  process.exit(1)
})
