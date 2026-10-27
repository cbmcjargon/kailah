// check-bitcore.mjs — OFFLINE (recorded Bitcore answers, a fake network).
//
// Dogecoin had one data service, BlockCypher, whose ~100 requests an hour are
// shared with Litecoin's backup; on 2026-10-27 litecoinspace.org lagged,
// Litecoin leaned on BlockCypher, and both coins showed "Couldn't reach the
// network data service". Bitcore (BitPay's public API, src/lib/bitcore.ts) is
// now Dogecoin's second service and Litecoin's first backup. Real answers
// recorded on 2026-10-27 (scripts/fixtures/bitcore-answers.json) drive this
// suite. It proves:
//   A. the provider lists (Dogecoin: BlockCypher + Bitcore; Litecoin:
//      litecoinspace, then Bitcore, then BlockCypher as backups), and that
//      every provider host is in both copies of the CSP and in PRIVACY.md;
//   B. transactions parse from /populated: amounts, fee, height, inputs,
//      outputs by index, BIP125 only on Litecoin, pending first, deeply
//      confirmed ones kept, malformed answers refused;
//   C. balances come from the unspent coins (a coin a pending send is
//      spending is not counted twice), an unused address costs one request,
//      coins being spent or conflicting are never offered, and a list that
//      could be cut short or names another address is refused;
//   D. Dogecoin's legacy funding txs come from the other provider, are kept
//      only when they hash to their txid, cost one request per session, and
//      the other provider's outage never reads as Bitcore's;
//   E. txSeen, broadcast (a rejection is final, never retried elsewhere),
//      fees (0.00001 LTC/kB is exactly 1 per vbyte), and a 429;
//   F. failover: Dogecoin rides out BlockCypher's limit on Bitcore, Litecoin
//      reaches Bitcore before BlockCypher, and backups are never raced;
//   G. requests to the host queue 330 ms apart (bitcore-node allows 200 a
//      minute);
//   H. one transaction Bitcore can't describe is left out of the history,
//      not the address's whole history; a rate limit or an outage still
//      fails the call.
const { readFileSync } = await import('node:fs')
const { BitcoreProvider, bitcoreBalance, bitcoreTxInfo } = await import('../src/lib/bitcore.ts')
const { BlockcypherProvider } = await import('../src/lib/blockcypher.ts')
const { buildProviders, createFailoverClient } = await import('../src/lib/api.ts')
const { CHAINS } = await import('../src/lib/networks.ts')
const { cachedRawTx, clearRawTxCache, txidOfRawHex } = await import('../src/lib/rawtxcache.ts')

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

const F = JSON.parse(readFileSync('scripts/fixtures/bitcore-answers.json', 'utf8'))
const DOGE = CHAINS.doge
const LTC = CHAINS.ltc
const D = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'
const L = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
const FUND = F.dogeRawHex.txid
const NET_WORDS = /timed? ?out|abort|load failed|failed to fetch|networkerror/i
const DEFAULT_GAP = BitcoreProvider.requestGapMs
BitcoreProvider.requestGapMs = 0

// --- the fake network ---------------------------------------------------------
// Each host gets a handler (path, init) → Response, or throws like a browser's
// CORS-less refusal. Every request is logged.
const log = []
let hosts = {}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const text = (body, status) => new Response(body, { status })
const refuse = () => {
  throw new TypeError('Load failed')
}
globalThis.fetch = async (url, init) => {
  const u = String(url)
  for (const [prefix, handler] of Object.entries(hosts)) {
    if (u.startsWith(prefix)) {
      const path = u.slice(prefix.length)
      log.push({ host: prefix, path, method: init?.method ?? 'GET', body: init?.body, at: Date.now() })
      return handler(path, init)
    }
  }
  throw new Error(`unexpected request ${u}`)
}
const BC_DOGE = 'https://api.bitcore.io/api/DOGE/mainnet'
const BC_LTC = 'https://api.bitcore.io/api/LTC/mainnet'
const CY_DOGE = 'https://api.blockcypher.com/v1/doge/main'
const CY_LTC = 'https://api.blockcypher.com/v1/ltc/main'
const ESPLORA = 'https://litecoinspace.org/api'
const reset = (h) => {
  hosts = h
  log.length = 0
  clearRawTxCache()
}
const calls = (prefix) => log.filter((r) => r.host === prefix)
const coin = (address, o) => ({ chain: 'X', network: 'mainnet', coinbase: false, mintIndex: 0, spentTxid: '', spentHeight: -2, address, script: '', value: 1000, confirmations: -1, sequenceNumber: 4294967295, ...o })
const tx = (n) => n.toString(16).padStart(64, '0')
/** a minimal /populated answer for txid `id`, paying `address` */
const populated = (id, address, o = {}) => ({
  txid: id, network: 'mainnet', chain: 'X', blockHeight: 100, blockTime: '2026-10-01T00:00:00.000Z', blockTimeNormalized: '2026-10-01T00:00:00.000Z',
  fee: 1000, inputCount: 1, outputCount: 1, confirmations: 10,
  coins: { inputs: [coin('Lsomeone', { mintTxid: tx(999), mintIndex: 0, value: 6000, spentTxid: id, spentHeight: 100, sequenceNumber: 0xffffffff })], outputs: [coin(address, { mintTxid: id, value: 5000 })] },
  ...o,
})

const doge = (rawHex) => new BitcoreProvider(DOGE.providers.find((p) => p.kind === 'bitcore'), DOGE, rawHex)
const ltc = () => new BitcoreProvider(LTC.providers.find((p) => p.kind === 'bitcore'), LTC)

console.log('--- A. provider lists, CSP, privacy policy ---')
{
  const d = DOGE.providers
  const l = LTC.providers
  check('A1 Dogecoin: BlockCypher then Bitcore, both regular',
    d.map((p) => p.name).join() === 'blockcypher,bitcore' && d.every((p) => p.backupOnly !== true) && d[1].kind === 'bitcore' && d[1].base === BC_DOGE)
  check('A2 Litecoin: litecoinspace, then Bitcore and BlockCypher as backups, in that order',
    l.map((p) => p.name).join() === 'litecoinspace.org,bitcore,blockcypher' && l.map((p) => p.backupOnly === true).join() === 'false,true,true' && l[1].base === BC_LTC)
  const csp = (file, re) => new Set(readFileSync(file, 'utf8').match(re)[1].trim().split(/\s+/))
  const headers = csp('public/_headers', /connect-src([^;]*);/)
  const netlify = csp('.netlify/netlify.toml', /connect-src([^;]*);/)
  check('A3 both CSP copies list the same connect-src hosts', [...headers].sort().join() === [...netlify].sort().join(), `${headers.size} vs ${netlify.size}`)
  const providerHosts = new Set(Object.values(CHAINS).flatMap((c) => c.providers.flatMap((p) => [p.base, p.broadcastBase].filter(Boolean).map((b) => new URL(b).origin))))
  const missing = [...providerHosts].filter((h) => !headers.has(h))
  check('A4 every UTXO provider host is allowed by the CSP (Bitcore included)', missing.length === 0 && headers.has('https://api.bitcore.io'), missing.join(', '))
  const privacy = readFileSync('PRIVACY.md', 'utf8')
  const unlisted = [...providerHosts].map((h) => new URL(h).host).filter((h) => !privacy.includes(h))
  check('A5 PRIVACY.md names every UTXO provider host', unlisted.length === 0, unlisted.join(', '))
}

console.log('--- B. transactions from /populated ---')
{
  const dp = F.dogePopulated
  const info = bitcoreTxInfo(dp, dp.txid, false)
  check('B1 the recorded Dogecoin tx: height, fee, 3 inputs with their prevouts, 2 outputs',
    info.height === 6116929 && info.fee === 5_220_000n && info.inputs.length === 3 && info.outputs.length === 2 &&
      info.inputs[0].prevTxid === dp.coins.inputs[0].mintTxid && info.inputs[0].prevVout === dp.coins.inputs[0].mintIndex &&
      info.outputs[0].value === BigInt(dp.coins.outputs.find((o) => o.mintIndex === 0).value) && info.time === Math.floor(Date.parse(dp.blockTime) / 1000))
  check('B2 its inputs (sequence 0xfffffffe) do not signal BIP125', dp.coins.inputs.every((c) => c.sequenceNumber === 0xfffffffe) && bitcoreTxInfo(dp, dp.txid, true).rbfSignaled === false)
  const signals = structuredClone(dp)
  signals.coins.inputs[1].sequenceNumber = 0xfffffffd
  check('B3 one input below 0xfffffffe signals it on Litecoin, but on Dogecoin never means replaceable',
    bitcoreTxInfo(signals, dp.txid, true).rbfSignaled === true && bitcoreTxInfo(signals, dp.txid, false).rbfSignaled === false)
  const lp = F.ltcPopulated
  const li = bitcoreTxInfo(lp, lp.txid, true)
  check('B4 the recorded Litecoin tx with final sequences is not replaceable', li.rbfSignaled === false && li.outputs.length === lp.outputCount)
  const shuffled = structuredClone(lp)
  shuffled.coins.outputs.reverse()
  const si = bitcoreTxInfo(shuffled, lp.txid, true)
  check('B5 outputs land at their own index whatever order they arrive in', si.outputs.map((o) => o.value).join() === li.outputs.map((o) => o.value).join())
  const gap = structuredClone(lp)
  gap.outputCount = 3
  gap.coins.outputs[1].mintIndex = 2
  const gi = bitcoreTxInfo(gap, lp.txid, true)
  check('B6 an output Bitcore doesn\'t store (OP_RETURN) holds the place with no value', gi.outputs.length === 3 && gi.outputs[1].address === null && gi.outputs[1].value === 0n && gi.outputs[2].value === li.outputs[1].value)
  const bad = []
  const mutate = (fn) => { const p = structuredClone(lp); fn(p); return rejects(async () => bitcoreTxInfo(p, lp.txid, true)) }
  bad.push(await mutate((p) => { p.txid = tx(1) }))
  bad.push(await mutate((p) => { p.coins.outputs[0].mintIndex = 7 }))
  bad.push(await mutate((p) => { p.coins.outputs[0].value = 1.5 }))
  bad.push(await mutate((p) => { p.coins.inputs[0].value = -1 }))
  bad.push(await mutate((p) => { p.coins.inputs[0].mintTxid = 'zz' }))
  bad.push(await mutate((p) => { p.outputCount = 1 }))
  bad.push(await mutate((p) => { p.coins = null }))
  check('B7 a wrong txid, an out-of-range index, a fractional or negative amount, a bad prevout, a short output count or no coins → refused', bad.every((e) => e !== null), bad.map((e) => (e ? 'refused' : 'ACCEPTED')).join(','))

  // history through the provider: the recorded coin list for the test wallet's address
  reset({
    [BC_DOGE]: (path) => {
      if (path.startsWith(`/address/${D}?limit=`)) return json(F.dogeCoins)
      const m = /^\/tx\/([0-9a-f]{64})\/populated$/.exec(path)
      if (m) return json(m[1] === dp.txid ? dp : populated(m[1], D, { confirmations: 200 }))
      return text('not found', 404)
    },
  })
  const p = doge()
  const h1 = await p.getAddressTxs(D)
  const ids = [...new Set(F.dogeCoins.flatMap((c) => [c.mintTxid, c.spentTxid]).filter((t) => t))]
  check('B8 history = every tx that created or spent one of its coins, newest first', h1.length === ids.length && h1[0].height >= h1.at(-1).height && h1.some((t) => t.txid === dp.txid), `${h1.length} txs`)
  const fetched = calls(BC_DOGE).filter((c) => c.path.endsWith('/populated')).length
  const h2 = await p.getAddressTxs(D)
  const refetched = calls(BC_DOGE).filter((c) => c.path.endsWith('/populated')).length - fetched
  check('B9 deeply confirmed txs are kept: the next scan re-reads only the coin list', refetched === 0 && h2.length === h1.length, `${refetched} refetched`)

  reset({
    [BC_LTC]: (path) => {
      if (path.startsWith(`/address/${L}?limit=`)) {
        return json([coin(L, { mintTxid: tx(1), mintHeight: 500 }), coin(L, { mintTxid: tx(2), mintHeight: -1 }), coin(L, { mintTxid: tx(3), mintHeight: -3 })])
      }
      const m = /^\/tx\/([0-9a-f]{64})\/populated$/.exec(path)
      return json(populated(m[1], L, m[1] === tx(2) ? { blockHeight: -1, confirmations: 0 } : {}))
    },
  })
  const h3 = await ltc().getAddressTxs(L)
  check('B10 a pending tx comes first; a conflicting one is not history', h3.map((t) => t.txid).join() === [tx(2), tx(1)].join() && h3[0].height === null)
}

console.log('--- C. balances and spendable coins ---')
{
  const coins = [
    coin(L, { mintTxid: tx(1), mintHeight: 100, value: 1000 }), // confirmed, unspent
    coin(L, { mintTxid: tx(2), mintHeight: 90, value: 5000, spentTxid: tx(9), spentHeight: -1 }), // a pending send spends it
    coin(L, { mintTxid: tx(9), mintIndex: 1, mintHeight: -1, value: 3000 }), // that send's change
    coin(L, { mintTxid: tx(4), mintHeight: -3, value: 7000 }), // conflicting
  ]
  const b = bitcoreBalance(coins)
  check('C1 a pending send: confirmed still holds the spent coin, unconfirmed moves it out and the change in', b.confirmed === 6000n && b.unconfirmed === -2000n && b.confirmed + b.unconfirmed === 4000n, `${b.confirmed} / ${b.unconfirmed}`)
  reset({
    [BC_LTC]: (path) => {
      if (path === `/address/${L}?limit=1`) return json([coins[0]])
      if (path.startsWith(`/address/${L}?unspent=true`)) return json(coins)
      if (path === '/address/ltc1qunused?limit=1') return json([])
      return text('unexpected', 500)
    },
  })
  const p = ltc()
  const s = await p.getAddressStats(L)
  check('C2 a used address: the balance from its unspent coins, in two requests, never /balance',
    s.balance.confirmed === 6000n && s.balance.unconfirmed === -2000n && s.txCount > 0 && log.length === 2 && !log.some((r) => r.path.includes('/balance')))
  log.length = 0
  const empty = await p.getAddressStats('ltc1qunused')
  check('C3 an address that never had a coin: unused and empty, in one request', empty.txCount === 0 && empty.balance.confirmed === 0n && log.length === 1)
  const u = await p.getAddressUtxos(L)
  check('C4 spendable coins: the confirmed one and the pending change, not the coin being spent or the conflicting one',
    u.map((x) => `${x.txid.slice(-1)}:${x.vout}:${x.value}:${x.confirmed}`).join() === `1:0:1000:true,9:1:3000:false` && u.every((x) => x.rawTxHex === undefined))
  hosts[BC_LTC] = () => json([coin(L, { mintTxid: tx(1), mintHeight: 100 }), coin('ltc1qsomeoneelse', { mintTxid: tx(2), mintHeight: 100 })])
  check('C5 a coin list naming another address → refused', /malformed coin list/.test((await rejects(() => p.getAddressUtxos(L)))?.message ?? ''))
  hosts[BC_LTC] = () => json(Array.from({ length: 1000 }, (_, i) => coin(L, { mintTxid: tx(i + 1), mintHeight: 100, value: 1 })))
  check('C6 a full page of 1000 coins (maybe cut short) → refused, never a partial balance', /too many coins/.test((await rejects(() => p.getAddressUtxos(L)))?.message ?? ''))
  for (const [what, v] of [['fractional', 1.5], ['negative', -1], ['text', '1000'], ['unsafe', 2 ** 60]]) {
    hosts[BC_LTC] = () => json([coin(L, { mintTxid: tx(1), mintHeight: 100, value: v })])
    check(`C7 a ${what} amount → refused`, (await rejects(() => p.getAddressUtxos(L))) !== null)
  }
}

console.log('--- D. Dogecoin\'s legacy funding txs ---')
{
  const unspent = [coin(D, { mintTxid: FUND, mintIndex: 0, mintHeight: 6116929, value: 214674000000 })]
  check('D0 the recorded raw bytes hash to their txid', txidOfRawHex(F.dogeRawHex.hex) === FUND)
  let asked = 0
  let serve = () => F.dogeRawHex.hex
  const p = doge(async (id) => {
    asked++
    return serve(id)
  })
  reset({ [BC_DOGE]: () => json(unspent) })
  const u1 = await p.getAddressUtxos(D)
  const u2 = await p.getAddressUtxos(D)
  check('D1 the funding tx comes from the other provider once, verified, and is kept for the session',
    asked === 1 && u1[0].rawTxHex === F.dogeRawHex.hex && u2[0].rawTxHex === F.dogeRawHex.hex && cachedRawTx(FUND) === F.dogeRawHex.hex)
  check('D2 getRawTxHex serves the kept bytes', (await p.getRawTxHex(FUND)) === F.dogeRawHex.hex)
  check('D3 ...and otherwise says it has no such endpoint, so the next provider is asked', /no raw transaction endpoint/.test((await rejects(() => p.getRawTxHex(tx(5))))?.message ?? ''))
  clearRawTxCache()
  serve = () => F.dogeRawHex.hex.slice(0, -2) + (F.dogeRawHex.hex.endsWith('00') ? '01' : '00')
  const forged = await rejects(() => p.getAddressUtxos(D))
  check('D4 bytes that are not that transaction → refused and not kept', /not that transaction/.test(forged?.message ?? '') && cachedRawTx(FUND) === undefined)
  serve = () => {
    throw new TypeError('Load failed')
  }
  const down = await rejects(() => p.getAddressUtxos(D))
  check('D5 the other provider refusing (a CORS-less 429) surfaces as a plain error, not Bitcore\'s outage',
    down !== null && !(down instanceof TypeError) && !NET_WORDS.test(down.message), down?.message)
  asked = 0
  reset({ [BC_LTC]: () => json([coin(L, { mintTxid: tx(1), mintHeight: 100 })]) })
  const lp = new BitcoreProvider(LTC.providers[1], LTC, async () => { asked++; return '' })
  await lp.getAddressUtxos(L)
  check('D6 Litecoin (segwit) never asks for raw bytes', asked === 0)

  // BlockCypher's Dogecoin coins use the same cache
  reset({
    [CY_DOGE]: (path) => {
      if (path.startsWith(`/addrs/${D}?unspentOnly`)) return json({ txrefs: [{ tx_hash: FUND, tx_output_n: 0, value: 214674000000 }] })
      if (path.startsWith(`/txs/${FUND}?includeHex`)) return json({ hash: FUND, hex: F.dogeRawHex.hex })
      return text('{"error":"unexpected"}', 500)
    },
  })
  const cy = new BlockcypherProvider(DOGE.providers[0], DOGE)
  await cy.getAddressUtxos(D)
  const first = calls(CY_DOGE).length
  const again = await cy.getAddressUtxos(D)
  check('D7 BlockCypher fetches a funding tx once per session too', first === 2 && calls(CY_DOGE).length === 3 && again[0].rawTxHex === F.dogeRawHex.hex, `${first} then ${calls(CY_DOGE).length - first}`)
  clearRawTxCache()
  hosts[CY_DOGE] = (path) =>
    path.startsWith('/txs/') ? json({ hash: FUND, hex: '00' + F.dogeRawHex.hex.slice(2) }) : json({ txrefs: [{ tx_hash: FUND, tx_output_n: 0, value: 1 }] })
  check('D8 ...and refuses bytes that are not that transaction', /not tx/.test((await rejects(() => cy.getAddressUtxos(D)))?.message ?? ''))
}

console.log('--- E. txSeen, broadcast, fees, rate limits ---')
{
  const p = ltc()
  reset({ [BC_LTC]: (path) => (path === `/tx/${tx(1)}` ? json({ txid: tx(1) }) : path === `/tx/${tx(2)}` ? text(F.notFound.text, F.notFound.status) : text('boom', 500)) })
  check('E1 txSeen: known → true; the recorded 404 → false; a 500 → an error, not a guess',
    (await p.txSeen(tx(1))) === true && (await p.txSeen(tx(2))) === false && (await rejects(() => p.txSeen(tx(3)))) !== null)
  reset({ [BC_LTC]: (path, init) => (path === '/tx/send' && init.method === 'POST' ? json({ txid: tx(7).toUpperCase() }) : text('no', 404)) })
  const id = await p.broadcast('0200')
  const sent = log[0]
  check('E2 broadcast posts {rawTx} as JSON to /tx/send and returns the txid', id === tx(7) && sent.method === 'POST' && JSON.parse(sent.body).rawTx === '0200')
  reset({ [BC_LTC]: () => text(F.sendInvalid.text, F.sendInvalid.status) })
  check('E3 the recorded rejection ("TX decode failed") is surfaced as is', (await rejects(() => p.broadcast('0100')))?.message === F.sendInvalid.text)
  hosts[BC_LTC] = () => json({ ok: true })
  check('E4 a success without a txid is not taken for one', /did not include/.test((await rejects(() => p.broadcast('0100')))?.message ?? ''))

  reset({ [BC_LTC]: (path) => (path.startsWith('/fee/') ? json(F.ltcFee2) : text('no', 404)) })
  const fees = await p.getFeeOptions()
  check('E5 Litecoin fees: the recorded 0.00001 LTC/kB is exactly 1 per vbyte (not a float\'s 2), at 2/6/12 blocks',
    fees.map((f) => f.rate).join() === '1,1,1' && log.map((r) => r.path).join() === '/fee/2,/fee/6,/fee/12')
  hosts[BC_LTC] = () => json({ feerate: 0.00012345, blocks: 2 })
  check('E6 a busier estimate rounds up per vbyte', (await p.getFeeOptions())[0].rate === 13n)
  hosts[BC_LTC] = () => json({ feerate: -1, blocks: 2 })
  check('E7 no estimate → an error, not a made-up fee', (await rejects(() => p.getFeeOptions())) !== null)
  log.length = 0
  const dogeFees = await doge().getFeeOptions()
  check('E8 Dogecoin keeps its flat configured rate, with no request', dogeFees.length === 1 && dogeFees[0].rate === DOGE.fixedFeeRate && log.length === 0)
  reset({ [BC_LTC]: () => text('Too many requests', 429) })
  const limited = await rejects(() => p.getTipHeight())
  check('E9 a visible 429 is marked as a rate limit', limited?.rateLimited === true)
  reset({ [BC_DOGE]: (path) => (path === '/block/tip' ? json(F.dogeTip) : text('no', 404)) })
  check('E10 the recorded chain tip', (await doge().getTipHeight()) === F.dogeTip.height)
}

console.log('--- F. failover ---')
{
  const statsCoins = (a) => (path) =>
    path === '/block/tip' ? json({ height: 1000 }) : path.startsWith(`/address/${a}?limit=1`) ? json([coin(a, { mintTxid: tx(1), mintHeight: 10, value: 42 })]) : path.startsWith(`/address/${a}?unspent`) ? json([coin(a, { mintTxid: tx(1), mintHeight: 10, value: 42 })]) : text('no', 404)
  // Dogecoin: BlockCypher out of budget (a CORS-less 429 reads as "Load failed")
  reset({ [CY_DOGE]: refuse, [BC_DOGE]: statsCoins(D) })
  let c = createFailoverClient(buildProviders(DOGE))
  const s = await c.getAddressStats(D)
  check('F1 Dogecoin with BlockCypher refusing: Bitcore serves the scan', s.balance.confirmed === 42n && c.activeProvider() === 'bitcore')
  await new Promise((r) => setTimeout(r, 700)) // BlockCypher's probe waits in its own 500 ms queue
  check('F2 the start-up race asked each Dogecoin service for its tip once', calls(CY_DOGE).length === 1 && calls(BC_DOGE).filter((r) => r.path === '/block/tip').length === 1, log.map((r) => r.host.slice(8, 22) + r.path).join(' '))

  // Dogecoin coins through the client: Bitcore lists them, BlockCypher serves the bytes
  reset({
    [CY_DOGE]: (path) => (path.startsWith(`/txs/${FUND}?includeHex`) ? json({ hash: FUND, hex: F.dogeRawHex.hex }) : path === '' ? refuse() : text('{"error":"no"}', 500)),
    [BC_DOGE]: (path) => (path === '/block/tip' ? json({ height: 1000 }) : path.startsWith(`/address/${D}`) ? json([coin(D, { mintTxid: FUND, mintIndex: 0, mintHeight: 6116929, value: 214674000000 })]) : text('no', 404)),
  })
  c = createFailoverClient(buildProviders(DOGE))
  const us = await c.getAddressUtxos(D)
  check('F3 Bitcore\'s Dogecoin coins carry the funding tx BlockCypher served', us.length === 1 && us[0].rawTxHex === F.dogeRawHex.hex && c.activeProvider() === 'bitcore')
  clearRawTxCache()
  hosts[CY_DOGE] = refuse
  check('F4 with BlockCypher refusing those bytes too, the coins are unavailable (the scan flags them)', (await rejects(() => c.getAddressUtxos(D))) !== null)
  const after = await c.getAddressStats(D)
  check('F5 ...but Bitcore is not cooled down for it: balances still come from Bitcore', after.balance.confirmed === 214674000000n && c.activeProvider() === 'bitcore')

  // a rejection from Bitcore is final; only a request that never left may go elsewhere
  reset({ [CY_DOGE]: (path) => (path === '' ? refuse() : json({ tx: { hash: tx(8) } })), [BC_DOGE]: (path) => (path === '/block/tip' ? json({ height: 1000 }) : text(F.sendInvalid.text, 500)) })
  c = createFailoverClient(buildProviders(DOGE))
  await c.getTipHeight()
  const rejected = await rejects(() => c.broadcast('0100'))
  check('F6 a broadcast Bitcore rejects is not retried on BlockCypher', rejected?.message === F.sendInvalid.text && !log.some((r) => r.path === '/txs/push'))
  hosts[BC_DOGE] = (path) => (path === '/tx/send' ? refuse() : json({ height: 1000 }))
  check('F7 one that never reached Bitcore (no response) goes to BlockCypher', (await c.broadcast('0100')) === tx(8) && log.some((r) => r.path === '/txs/push'))

  // Litecoin: litecoinspace down → Bitcore, never BlockCypher
  reset({ [ESPLORA]: refuse, [BC_LTC]: statsCoins(L), [CY_LTC]: () => json({ balance: 1, unconfirmed_balance: 0, final_n_tx: 1 }) })
  c = createFailoverClient(buildProviders(LTC))
  const ls = await c.getAddressStats(L)
  check('F8 Litecoin with litecoinspace down: Bitcore serves; BlockCypher is untouched', ls.balance.confirmed === 42n && calls(CY_LTC).length === 0 && calls(BC_LTC).length > 0)
  check('F9 no start-up race on Litecoin (one regular service): the backups weren\'t probed', !log.some((r) => r.path === '/block/tip' || r.path === ''))
  check('F10 a backup\'s success is not remembered: litecoinspace stays the active service', c.activeProvider() === 'litecoinspace.org')
  reset({ [ESPLORA]: refuse, [BC_LTC]: refuse, [CY_LTC]: () => json({ balance: 7, unconfirmed_balance: 0, final_n_tx: 1 }) })
  c = createFailoverClient(buildProviders(LTC))
  const lb = await c.getAddressStats(L)
  check('F11 with Bitcore down as well, BlockCypher is the last backup', lb.balance.confirmed === 7n && calls(CY_LTC).length === 1)
  reset({ [ESPLORA]: (path) => (path.startsWith(`/address/${L}`) ? json({ chain_stats: { funded_txo_sum: 9, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }) : text('no', 404)), [BC_LTC]: refuse, [CY_LTC]: refuse })
  c = createFailoverClient(buildProviders(LTC))
  const healthy = await c.getAddressStats(L)
  check('F12 with litecoinspace healthy, neither backup is asked', healthy.balance.confirmed === 9n && calls(BC_LTC).length === 0 && calls(CY_LTC).length === 0)
}

console.log('--- G. one request gate per host ---')
{
  BitcoreProvider.requestGapMs = DEFAULT_GAP
  reset({ [BC_DOGE]: () => json({ height: 5 }), [BC_LTC]: () => json({ height: 6 }) })
  const d = doge()
  const l = ltc()
  await Promise.all([d.getTipHeight(), l.getTipHeight(), d.getTipHeight(), l.getTipHeight()])
  const gaps = log.slice(1).map((r, k) => r.at - log[k].at)
  check('G1 concurrent Dogecoin and Litecoin requests to Bitcore queue 330 ms apart: under bitcore-node\'s 200 a minute (it was 250 ms, 240 a minute; bug audit 2026-10-27, BM6)',
    DEFAULT_GAP >= 330 && log.length === 4 && gaps.every((g) => g >= DEFAULT_GAP - 10), `${DEFAULT_GAP} ms default; ` + gaps.join(', ') + ' ms')
  BitcoreProvider.requestGapMs = 0
}

console.log('--- H. one transaction Bitcore can\'t describe (bug audit 2026-10-27, BL6) ---')
{
  const coins = [coin(D, { mintTxid: tx(1), mintHeight: 600 }), coin(D, { mintTxid: tx(2), mintHeight: 500 }), coin(D, { mintTxid: tx(3), mintHeight: 400 })]
  const huge = populated(tx(2), D, {
    coins: {
      inputs: [coin('DExchangeHot', { mintTxid: tx(99), mintIndex: 0, value: 15_000_000_000_000_000, spentTxid: tx(2), spentHeight: 500 })],
      outputs: [coin(D, { mintTxid: tx(2), value: 5000 })],
    },
  })
  const answering = (special) => (path) => {
    if (path.startsWith(`/address/${D}`)) return json(coins)
    const m = /^\/tx\/([0-9a-f]{64})\/populated$/.exec(path)
    if (m) return special(m[1]) ?? json(populated(m[1], D))
    return text('no', 404)
  }
  const ids = (list) => list.map((t) => t.txid).sort().join()
  reset({ [BC_DOGE]: answering((id) => (id === tx(2) ? json(huge) : null)) })
  const h1 = await rejects(async () => (answering.got = await doge().getAddressTxs(D)))
  check('H1 an exchange input past 2^53 koinu leaves that one transaction out, not the address\'s whole history', h1 === null && ids(answering.got) === [tx(1), tx(3)].join(), h1?.message)
  reset({ [BC_DOGE]: answering((id) => (id === tx(2) ? text(F.notFound.text, F.notFound.status) : null)) })
  const h2 = await rejects(async () => (answering.got = await doge().getAddressTxs(D)))
  check('H2 so does a txid the coin list names but /populated answers 404 for', h2 === null && ids(answering.got) === [tx(1), tx(3)].join(), h2?.message)
  reset({ [BC_DOGE]: answering((id) => (id === tx(2) ? text('Too many requests', 429) : null)) })
  const h3 = await rejects(() => doge().getAddressTxs(D))
  check('H3 a rate limit still fails the call, for the failover client to pause and retry', h3?.rateLimited === true)
  reset({ [BC_DOGE]: answering((id) => (id === tx(2) ? text('boom', 500) : null)) })
  check('H4 and so does a server error', (await rejects(() => doge().getAddressTxs(D))) !== null)
}

console.log(failures === 0 ? '\nAll Bitcore checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
