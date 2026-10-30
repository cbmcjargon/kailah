// health-probes.mjs — what `npm run check:health` asks each service the wallet
// relies on, and how it reads the answers. Kept apart from the runner
// (check-health.mjs), with no network of its own, so check-headers can test it
// offline and prove it covers every host in the CSP.
//
// The services come from the wallet's own configs, so a new one is covered the
// day it is added. Each is asked the calls the wallet really makes: a server
// can answer "which network are you?" and nothing else, as cloudflare-eth.com
// did for who knows how long (found 2026-10-30), and only a real call shows it.

/** The three places the wallet runs. The extension's id doesn't matter: a server either allows extensions or it doesn't. */
export const WALLET_ORIGINS = [
  'https://kailah-wallet.netlify.app',
  'https://wallet.photoprompting.org',
  'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh',
]

// Public addresses with real history: the BIP39 test vector's, where it has any.
const TEST = {
  btc: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  'btc-testnet': 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',
  ltc: 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh',
  doge: 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC',
  evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  sol: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
  tron: 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX',
}

/** Blocks a service may trail the chain's leader by (about two minutes' worth; half an hour on Bitcoin). */
const LAG_BLOCKS = {
  btc: 3,
  'btc-testnet': 5,
  ltc: 6,
  doge: 10,
  base: 60,
  'base-sepolia': 60,
  ethereum: 10,
  arbitrum: 500,
  bnb: 100,
  sol: 300,
  'sol-devnet': 300,
}

const short = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 90)

/** The answer to a JSON-RPC call: `test(result)` says true or what's wrong; an error says itself. */
function rpcResult(text, test) {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return `not JSON: ${short(text)}`
  }
  if (j === null || typeof j !== 'object') return `not an answer: ${short(text)}`
  if (j.error !== undefined && j.error !== null) return short(j.error.message ?? JSON.stringify(j.error))
  return test(j.result)
}

const HEX = /^0x[0-9a-f]+$/i
const isHex = (r) => (typeof r === 'string' && HEX.test(r)) || `unexpected answer: ${short(JSON.stringify(r))}`

/**
 * Said to a transaction that can't be decoded: any real node refuses it in its
 * own words. These words mean the server can't take transactions at all.
 */
const CANNOT_SEND = /cannot fulfill|method not found|not supported|not allowed|disabled|forbidden|unauthori[sz]ed|api key|internal error/i
const refusesGarbage = (text) => {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return `not JSON: ${short(text)}`
  }
  if (j?.error === undefined || j?.error === null) return 'accepted a transaction that can\'t be decoded'
  const message = String(j.error.message ?? '')
  return CANNOT_SEND.test(message) ? `can't take transactions: ${short(message)}` : true
}

const post = (method, params) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})
const postJson = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function evmRpc(chain, url) {
  const a = TEST.evm
  const balanceOf = `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}`
  const call = (label, method, params, test = isHex) => ({
    label,
    url,
    init: post(method, params),
    check: (text) => rpcResult(text, test),
  })
  return {
    chainId: chain.id,
    network: chain.name,
    role: 'node',
    name: new URL(url).host,
    host: new URL(url).host,
    preflight: true,
    calls: [
      {
        label: 'latest block',
        url,
        init: post('eth_blockNumber', []),
        check: (text, ctx) =>
          rpcResult(text, (r) => {
            if (typeof r !== 'string' || !HEX.test(r)) return `unexpected answer: ${short(JSON.stringify(r))}`
            ctx.height = Number.parseInt(r, 16)
            return true
          }),
      },
      call('balance', 'eth_getBalance', [a, 'latest']),
      call('token balance', 'eth_call', [{ to: chain.token.address, data: balanceOf }, 'latest']),
      call('nonce', 'eth_getTransactionCount', [a, 'latest']),
      call('fee data', 'eth_getBlockByNumber', ['latest', false], (r) => (r !== null && typeof r === 'object') || 'no block'),
      call('gas estimate', 'eth_estimateGas', [{ from: a, to: a, value: '0x0' }]),
      { label: 'takes transactions', url, init: post('eth_sendRawTransaction', ['0x00']), check: refusesGarbage },
    ],
  }
}

function blockscout(chain) {
  const url = `${chain.blockscoutBase}/addresses/${TEST.evm}/transactions`
  return {
    chainId: chain.id,
    network: chain.name,
    role: 'explorer',
    name: new URL(url).host,
    host: new URL(url).host,
    calls: [{ label: 'history', url, check: (t) => t.includes('"items"') || `unexpected answer: ${short(t)}` }],
  }
}

function solRpc(chain, url) {
  const a = TEST.sol
  const call = (label, method, params, test = (r) => r !== undefined || 'no result') => ({
    label,
    url,
    init: post(method, params),
    check: (text) => rpcResult(text, test),
  })
  return {
    chainId: chain.id,
    network: chain.name,
    role: 'node',
    name: new URL(url).host,
    host: new URL(url).host,
    preflight: true,
    calls: [
      {
        label: 'block height',
        url,
        init: post('getEpochInfo', [{ commitment: 'confirmed' }]),
        check: (text, ctx) =>
          rpcResult(text, (r) => {
            if (typeof r?.blockHeight !== 'number') return 'no block height'
            ctx.height = r.blockHeight
            return true
          }),
      },
      call('balance', 'getBalance', [a, { commitment: 'confirmed' }]),
      call('account', 'getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]),
      call('blockhash', 'getLatestBlockhash', [{ commitment: 'confirmed' }], (r) => typeof r?.value?.blockhash === 'string' || 'no blockhash'),
      {
        label: 'history',
        url,
        init: post('getSignaturesForAddress', [a, { limit: 1, commitment: 'confirmed' }]),
        check: (text, ctx) =>
          rpcResult(text, (r) => {
            if (!Array.isArray(r)) return `unexpected answer: ${short(JSON.stringify(r))}`
            ctx.signature = r[0]?.signature
            return true
          }),
      },
      {
        label: 'a transaction',
        url,
        skip: (ctx) => ctx.signature === undefined,
        init: (ctx) => post('getTransaction', [ctx.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]),
        check: (text, ctx) =>
          rpcResult(text, (r) => {
            ctx.rawTx = Array.isArray(r?.transaction) ? r.transaction[0] : undefined
            return r !== null || 'it doesn\'t have a recent transaction'
          }),
      },
      {
        label: 'simulation',
        url,
        skip: (ctx) => ctx.rawTx === undefined,
        init: (ctx) => post('simulateTransaction', [ctx.rawTx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]),
        check: (text) => rpcResult(text, (r) => r?.value !== undefined || 'no simulation result'),
      },
      { label: 'takes transactions', url, init: post('sendTransaction', ['AAAA', { encoding: 'base64' }]), check: refusesGarbage },
    ],
  }
}

function tronApi(chain, tronAddressToHex) {
  const a = TEST.tron
  const noError = (test) => (text) => {
    let j
    try {
      j = JSON.parse(text)
    } catch {
      return `not JSON: ${short(text)}`
    }
    if (j?.Error !== undefined || j?.error !== undefined) return short(j.Error ?? j.error)
    return test(j)
  }
  const host = new URL(chain.api).host
  return {
    chainId: chain.id,
    network: chain.name,
    role: 'node',
    name: host,
    host,
    preflight: true,
    gapMs: 1_100, // TronGrid's keyless /v1 limit
    calls: [
      {
        label: 'latest block',
        url: `${chain.api}/wallet/getnowblock`,
        init: postJson({}),
        check: (text, ctx) =>
          noError((j) => {
            const n = j?.block_header?.raw_data?.number
            if (typeof n !== 'number') return 'no block'
            ctx.height = n
            return true
          })(text),
      },
      { label: 'account', url: `${chain.api}/wallet/getaccount`, init: postJson({ address: a, visible: true }), check: noError(() => true) },
      {
        label: 'USDT balance',
        url: `${chain.api}/wallet/triggerconstantcontract`,
        init: postJson({
          owner_address: a,
          contract_address: chain.usdt.contract,
          function_selector: 'balanceOf(address)',
          parameter: tronAddressToHex(a).slice(2).padStart(64, '0'),
          visible: true,
        }),
        check: noError((j) => Array.isArray(j?.constant_result) || 'no contract result'),
      },
      {
        label: 'history',
        url: `${chain.api}/v1/accounts/${a}/transactions?limit=1`,
        check: noError((j) => Array.isArray(j?.data) || 'no history list'),
      },
    ],
  }
}

function utxoProvider(chain, spec) {
  const a = TEST[chain.id]
  const host = new URL(spec.base).host
  const tipOk = (read) => (text, ctx) => {
    const n = read(text)
    if (!Number.isSafeInteger(n) || n <= 0) return `no block height: ${short(text)}`
    ctx.height = n
    return true
  }
  const fromJson = (text) => {
    try {
      return JSON.parse(text)?.height
    } catch {
      return undefined
    }
  }
  const calls =
    spec.kind === 'esplora'
      ? [
          { label: 'tip', url: `${spec.base}/blocks/tip/height`, check: tipOk((t) => (/^\d+$/.test(t.trim()) ? Number(t) : NaN)) },
          { label: 'address', url: `${spec.base}/address/${a}`, check: (t) => t.includes('chain_stats') || `can't look up addresses: ${short(t)}` },
        ]
      : spec.kind === 'blockcypher'
        ? [
            { label: 'tip', url: spec.base, check: tipOk(fromJson) },
            { label: 'address', url: `${spec.base}/addrs/${a}/balance`, check: (t) => t.includes('balance') || `can't look up addresses: ${short(t)}` },
          ]
        : [
            { label: 'tip', url: `${spec.base}/block/tip`, check: tipOk(fromJson) },
            { label: 'address', url: `${spec.base}/address/${a}?limit=1`, check: (t) => t.trim().startsWith('[') || `can't look up addresses: ${short(t)}` },
          ]
  return {
    chainId: chain.id,
    network: chain.name,
    role: 'data',
    name: spec.name,
    host,
    backup: spec.backupOnly === true,
    gapMs: spec.kind === 'blockcypher' ? 500 : 250,
    calls,
  }
}

/** Every service the wallet relies on, from its own configs. */
export function servicesFor({ CHAINS, EVM_CHAINS, SOL_CHAINS, TRON_CHAINS, tronAddressToHex }) {
  const services = []
  for (const chain of Object.values(CHAINS)) for (const spec of chain.providers) services.push(utxoProvider(chain, spec))
  for (const chain of Object.values(EVM_CHAINS)) {
    for (const url of chain.rpcs) services.push(evmRpc(chain, url))
    if (chain.blockscoutBase) services.push(blockscout(chain))
  }
  for (const chain of Object.values(SOL_CHAINS)) for (const url of chain.rpcs) services.push(solRpc(chain, url))
  for (const chain of Object.values(TRON_CHAINS)) services.push(tronApi(chain, tronAddressToHex))
  // prices.ts and solswap.ts build their URLs inline; check-headers holds this
  // list to the CSP, so a new host there can't go unprobed
  const prices = (name, url, test) => ({
    chainId: null,
    network: 'Prices',
    role: 'prices',
    name,
    host: new URL(url).host,
    calls: [{ label: 'price', url, check: (t) => test(t) || `unexpected answer: ${short(t)}` }],
  })
  services.push(
    prices('api.coinbase.com', 'https://api.coinbase.com/v2/prices/BTC-USD/spot', (t) => t.includes('amount')),
    prices('api.exchange.coinbase.com', 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=21600', (t) => t.trim().startsWith('[')),
    prices('api.coingecko.com', 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7', (t) => t.includes('"prices"')),
  )
  const jup =
    `https://api.jup.ag/swap/v2/build?inputMint=So11111111111111111111111111111111111111112` +
    `&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&taker=${TEST.sol}&slippageBps=50`
  services.push({
    chainId: null,
    network: 'Swaps',
    role: 'swaps',
    name: 'api.jup.ag',
    host: 'api.jup.ag',
    calls: [{ label: 'a route', url: jup, check: (t) => t.includes('swapInstruction') || `no route: ${short(t)}` }],
  })
  return services
}

const BUSY_WORDS = /rate.?limit|too many|limit exceeded|try again|overloaded|capacity|throttl/i

/**
 * One call's answer, as a state:
 *   ok         it did the job, and a browser at this origin may read it
 *   busy       it refused for now (too many requests): nothing to conclude
 *   bot-check  a bot check turned this script away: nothing to conclude
 *   down       a server error (see also classifyNoAnswer)
 *   broken     it answers, but can't do the job
 */
export function classifyAnswer({ status, text, acao, cfMitigated, origin, verdict }) {
  if (status === 429) return { state: 'busy', detail: 'too many requests just now' }
  if (status === 403 && (cfMitigated === true || /just a moment|cf-chl|challenge-platform/i.test(text))) {
    return { state: 'bot-check', detail: 'a bot check turned this script away' }
  }
  if (status >= 500) return { state: 'down', detail: `server error (HTTP ${status})` }
  if (status < 200 || status >= 300) {
    return BUSY_WORDS.test(text)
      ? { state: 'busy', detail: short(text) }
      : { state: 'broken', detail: `HTTP ${status}: ${short(text)}` }
  }
  if (verdict !== true) {
    return BUSY_WORDS.test(String(verdict)) ? { state: 'busy', detail: short(verdict) } : { state: 'broken', detail: String(verdict) }
  }
  if (acao !== '*' && acao !== origin) return { state: 'broken', detail: `browsers can't read its answers (${origin})` }
  return { state: 'ok', detail: '' }
}

export function classifyNoAnswer(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
  return { state: 'down', detail: timedOut ? 'no answer in time' : `no answer (${err?.cause?.code ?? err?.message ?? 'network error'})` }
}

/** Whether a browser at `origin` may POST JSON to the service, from its answer to a preflight. */
export function preflightProblem({ status, acao, acah, origin }) {
  if (status < 200 || status >= 300) return status === 429 ? null : `browsers at ${origin} are refused (HTTP ${status})`
  if (acao !== '*' && acao !== origin) return `browsers at ${origin} are refused`
  if (acah !== null && acah !== '*' && !/content-type/i.test(acah)) return `browsers at ${origin} can't send JSON`
  return null
}

/** Marks a service that trails the others on its chain by more than that chain allows. */
export function markLagging(results) {
  for (const r of results) {
    if (r.state !== 'ok' || r.height === undefined || r.chainId === null) continue
    const peers = results.filter((p) => p.chainId === r.chainId && p.role === r.role && p.height !== undefined)
    const leader = peers.reduce((best, p) => (p.height > best.height ? p : best), r)
    const behind = leader.height - r.height
    if (behind > (LAG_BLOCKS[r.chainId] ?? Infinity)) {
      r.state = 'lagging'
      r.detail = `${behind} blocks behind ${leader.name}`
    }
  }
  return results
}

/**
 * The verdict. A service that answers but can't do the job fails the check, and
 * so does a job nothing answered for. The rest is reported and passes: a busy
 * or silent service may be this machine's standing with it, not the service.
 */
export function verdictOf(results) {
  const fails = []
  const warns = []
  for (const r of results) {
    const who = `${r.network}: ${r.name}${r.backup ? ' (backup)' : ''}`
    if (r.state === 'broken') fails.push(`${who} answers but can't do the job: ${r.detail}.`)
    else if (r.state === 'down') warns.push(`${who} gave no usable answer here: ${r.detail}. Try again later, or from another network.`)
    else if (r.state === 'busy') warns.push(`${who} is refusing this machine for now: ${r.detail}.`)
    else if (r.state === 'bot-check') warns.push(`${who}: a bot check turned this script away, so it can't tell. Browsers usually get through.`)
    else if (r.state === 'lagging') warns.push(`${who} is ${r.detail}.`)
    else if (r.state === 'slow') warns.push(`${who} answered, but slowly (${(r.ms / 1000).toFixed(1)} s).`)
  }
  const jobs = new Map()
  for (const r of results) {
    const key = `${r.network}: ${r.role}`
    jobs.set(key, [...(jobs.get(key) ?? []), r])
  }
  for (const [job, list] of jobs) {
    if (list.every((r) => r.state === 'down')) fails.push(`${job}: nothing answered.`)
  }
  return { fails, warns, exitCode: fails.length > 0 ? 1 : 0 }
}
