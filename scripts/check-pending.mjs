// check-pending.mjs — OFFLINE (mock localStorage, mock fetch, no network).
//
// The in-flight send ledger (src/lib/pending.ts) is the persisted half of the
// double-pay guard: an ambiguous broadcast failure may still land, and the
// wallet must not let the user pay again until it knows. This suite proves:
//   A. the decision rules (block / allow / prune / TTL / same-nonce retry);
//   B. the EVM network lookup classifies only viem's explicit "not found" as
//      not-found, and every other failure as 'unreachable' (which blocks);
//   C. the wiring: a broadcast that dies mid-flight is still recorded, and
//      prepareEvmSend / assertNoSolInFlight actually consult the ledger.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}

const { unlockSecureStore, lockSecureStore } = await import('../src/lib/securestore.ts')
const ledger = await import('../src/lib/pending.ts')
const evm = await import('../src/lib/evm.ts')
const sol = await import('../src/lib/sol.ts')
const solLib = await import('micro-sol-signer')
const { keccak256 } = await import('viem')

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
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

await unlockSecureStore(MN)
const BASE_SEPOLIA = evm.EVM_CHAINS['base-sepolia']
const CHAIN = BASE_SEPOLIA.chainId
const H = (n) => '0x' + n.toString(16).padStart(64, '0')
const clearLedger = () => {
  for (const p of ledger.pendingEvm(CHAIN)) ledger.dropPending(p)
  for (const p of ledger.pendingEvm(1)) ledger.dropPending(p)
  for (const id of ['sol', 'sol-devnet']) for (const p of ledger.pendingSol(id)) ledger.dropPending(p)
}

// ===========================================================================
console.log('--- A. decision rules ---')
{
  const rec = (nonce, extra = {}) =>
    ledger.recordPending({ kind: 'evm', chainId: CHAIN, nonce, hash: H(nonce), to: '0x000000000000000000000000000000000000dEaD', ts: Date.now(), ...extra })
  const stub = (status) => {
    const asked = []
    return { asked, fn: async (h) => (asked.push(h), typeof status === 'function' ? status(h) : status) }
  }

  clearLedger(); rec(5)
  let s = stub('pending'); let b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A1 EVM pending attempt blocks a new send', b?.reason === 'pending' && b.entry.nonce === 5)
  check('A1b …and stays recorded', ledger.pendingEvm(CHAIN).length === 1)

  s = stub('unreachable'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check("A2 EVM 'unreachable' blocks (couldn't check is not safe)", b?.reason === 'unreachable' && ledger.pendingEvm(CHAIN).length === 1)

  s = stub(() => { throw new Error('boom') }); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A3 EVM lookup that throws blocks as unreachable', b?.reason === 'unreachable')

  s = stub('mined'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A4 EVM mined attempt is dropped and allows the send', b === null && ledger.pendingEvm(CHAIN).length === 0)

  rec(6); s = stub('unknown-to-network'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A5 EVM attempt the network never saw is dropped', b === null && ledger.pendingEvm(CHAIN).length === 0)

  rec(7); s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, 7, s.fn)
  check('A6 same-nonce retry is not blocked by the attempt it replaces', b === null && s.asked.length === 0 && ledger.pendingEvm(CHAIN).length === 1)

  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, 8, s.fn)
  check('A7 a different nonce is still blocked by it', b?.entry.nonce === 7)

  clearLedger(); ledger.recordPending({ kind: 'evm', chainId: 1, nonce: 1, hash: H(1), to: '0x00', ts: Date.now() })
  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check("A8 another chain's attempt does not block this chain", b === null && s.asked.length === 0)

  clearLedger(); rec(9, { ts: Date.now() - 25 * 3600 * 1000 })
  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A9 EVM records expire after 24 h', b === null && s.asked.length === 0)

  clearLedger(); rec(10); rec(10, { hash: H(1010) })
  check('A10 re-recording the same chain+nonce replaces the old attempt', ledger.pendingEvm(CHAIN).length === 1 && ledger.pendingEvm(CHAIN)[0].hash === H(1010))

  clearLedger()
  const recSol = (sig, ts = Date.now()) => ledger.recordPending({ kind: 'sol', chainId: 'sol-devnet', signature: sig, ts })
  recSol('sigA'); let sb = await ledger.solInFlightBlock('sol-devnet', async () => false)
  check('A11 Solana unseen signature blocks', sb?.reason === 'pending' && sb.entry.signature === 'sigA')
  sb = await ledger.solInFlightBlock('sol-devnet', async () => { throw new Error('rpc down') })
  check('A12 Solana lookup failure blocks (bounded by the 90 s TTL)', sb?.reason === 'unreachable' && ledger.pendingSol('sol-devnet').length === 1)
  sb = await ledger.solInFlightBlock('sol-devnet', async () => true)
  check('A13 Solana seen signature is dropped and allows the send', sb === null && ledger.pendingSol('sol-devnet').length === 0)
  recSol('sigOld', Date.now() - 91_000)
  let askedOld = false; sb = await ledger.solInFlightBlock('sol-devnet', async () => ((askedOld = true), false))
  check('A14 Solana records expire after 90 s (blockhash window)', sb === null && !askedOld)

  rec(11); await new Promise((r) => setTimeout(r, 50))
  lockSecureStore()
  check('A15 locked: the ledger is not readable', ledger.pendingEvm(CHAIN).length === 0)
  await unlockSecureStore(MN)
  check('A16 unlock restores it from the encrypted store', ledger.pendingEvm(CHAIN).some((p) => p.nonce === 11))
  check('A17 …and it is ciphertext at rest', typeof store.get('kailah.sec.pending') === 'string' && !store.get('kailah.sec.pending').includes(H(11).slice(2, 20)))
  clearLedger()
}

// ===========================================================================
// Mock JSON-RPC network for EVM (viem) and Solana. `net` decides answers.
const net = { down: false, evm: {}, sol: {} }
const TX = (hash) => ({
  hash, nonce: '0x7', blockHash: null, blockNumber: null, transactionIndex: null,
  from: '0x9858effd232b4033e47d90003d41ec34ecaeda94', to: '0x000000000000000000000000000000000000dead',
  value: '0x1', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', gasPrice: '0x1',
  input: '0x', type: '0x2', chainId: '0x14a34', v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', accessList: [],
})
const RECEIPT = (hash) => ({
  transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: '0x10',
  from: '0x9858effd232b4033e47d90003d41ec34ecaeda94', to: '0x000000000000000000000000000000000000dead',
  cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null,
  logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2',
})
const BLOCK = { number: '0x10', hash: '0x' + '22'.repeat(32), parentHash: '0x' + '33'.repeat(32), baseFeePerGas: '0x1',
  timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', difficulty: '0x0', transactions: [], logsBloom: '0x' + '00'.repeat(256),
  miner: '0x0000000000000000000000000000000000000000', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: '0x' + '44'.repeat(32),
  size: '0x1', stateRoot: '0x' + '55'.repeat(32), receiptsRoot: '0x' + '66'.repeat(32), transactionsRoot: '0x' + '77'.repeat(32), uncles: [] }
const reply = (id, payload) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (_url, init) => {
  if (net.down) throw new TypeError('fetch failed')
  const req = JSON.parse(init.body)
  const { id, method, params } = req
  const e = net.evm, s = net.sol
  switch (method) {
    case 'eth_getTransactionByHash':
      if (e.tx === 'neterr') throw new TypeError('fetch failed')
      if (e.tx === 'rpcerr') return reply(id, { error: { code: -32000, message: 'header not found' } })
      return reply(id, { result: e.tx === 'present' ? TX(params[0]) : null })
    case 'eth_getTransactionReceipt':
      if (e.receipt === 'neterr') throw new TypeError('fetch failed')
      return reply(id, { result: e.receipt === 'present' ? RECEIPT(params[0]) : null })
    case 'eth_getBalance': return reply(id, { result: '0xde0b6b3a7640000' })
    case 'eth_call': return reply(id, { result: '0x' + '0'.repeat(64) })
    case 'eth_getBlockByNumber': return reply(id, { result: BLOCK })
    case 'eth_maxPriorityFeePerGas': return reply(id, { result: '0x1' })
    case 'eth_getTransactionCount': return reply(id, { result: '0x8' })
    case 'eth_getCode': return reply(id, { result: '0x' })
    case 'eth_chainId': return reply(id, { result: '0x14a34' })
    case 'getSignatureStatuses':
      if (s.status === 'neterr') throw new TypeError('fetch failed')
      return reply(id, { result: { context: { slot: 1 }, value: [s.status === 'seen' ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null] } })
    default:
      return reply(id, { error: { code: -32601, message: `mock: no ${method}` } })
  }
}

// ===========================================================================
console.log('--- B. EVM network lookup classification ---')
{
  const st = (tx, receipt) => ((net.evm = { tx, receipt }), evm.evmAttemptStatus(BASE_SEPOLIA, H(42)))
  check("B1 tx not found -> 'unknown-to-network'", (await st('missing', 'missing')) === 'unknown-to-network')
  check("B2 tx found, no receipt -> 'pending'", (await st('present', 'missing')) === 'pending')
  check("B3 tx found, receipt found -> 'mined'", (await st('present', 'present')) === 'mined')
  check("B4 network failure on the tx lookup -> 'unreachable' (old code read this as never-seen and dropped the guard)", (await st('neterr', 'missing')) === 'unreachable')
  check("B5 RPC error response -> 'unreachable'", (await st('rpcerr', 'missing')) === 'unreachable')
  check("B6 network failure on the receipt lookup -> 'unreachable'", (await st('present', 'neterr')) === 'unreachable')
}

// ===========================================================================
console.log('--- C. wiring: record before broadcast, prepare consults the ledger ---')
{
  clearLedger()
  const key = evm.deriveEvmKey(MN)
  const request = { to: '0x000000000000000000000000000000000000dEaD', value: 1n, data: undefined, gas: 21000n,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 7, chainId: CHAIN }
  const prepared = { chain: BASE_SEPOLIA, asset: 'gas', to: request.to, amount: 1n, feeWei: 21000n, request }
  net.down = true
  const err = await rejects(() => evm.broadcastEvmSend(key, prepared))
  net.down = false
  const expectHash = keccak256(await key.account.signTransaction({ type: 'eip1559', ...request }))
  const rec = ledger.pendingEvm(CHAIN)
  check('C1 EVM broadcast that dies mid-flight still left a record', err !== null && rec.length === 1 && rec[0].nonce === 7)
  check('C2 …keyed by the hash of the exact signed bytes', rec[0]?.hash === expectHash)

  const send = () => evm.prepareEvmSend({ chain: BASE_SEPOLIA, key, to: '0x1111111111111111111111111111111111111111', amount: 1000n, asset: 'gas' })
  net.evm = { tx: 'present', receipt: 'missing' }
  let e2 = await rejects(send)
  check('C3 prepareEvmSend refuses while that attempt is in the mempool', /still waiting to confirm/.test(e2?.message ?? ''), e2?.message?.slice(0, 70))
  net.evm = { tx: 'neterr', receipt: 'missing' }
  e2 = await rejects(send)
  check("C4 prepareEvmSend refuses when it can't check", /Couldn't check/.test(e2?.message ?? ''), e2?.message?.slice(0, 70))
  e2 = await rejects(() => evm.prepareEvmSend({ chain: BASE_SEPOLIA, key, to: '0x1111111111111111111111111111111111111111', amount: 1000n, asset: 'gas', reuseNonce: 7 }))
  check('C5 …but allows the same-nonce retry that replaces it', e2 === null, e2?.message)
  net.evm = { tx: 'present', receipt: 'present' }
  e2 = await rejects(send)
  check('C6 once mined, the record is dropped and sending works again', e2 === null && ledger.pendingEvm(CHAIN).length === 0, e2?.message)

  // Solana: same two properties through the real broadcast + prepare guard.
  clearLedger()
  const skey = sol.deriveSolKey(MN)
  const devnet = sol.SOL_CHAINS['sol-devnet']
  const ix = solLib.sys.transferSol({ source: skey.address, destination: '11111111111111111111111111111112', amount: 1n })
  const unsigned = solLib.createTx(skey.address, [ix], '11111111111111111111111111111111')
  net.down = true
  const serr = await rejects(() => sol.broadcastSolSend(skey, { chain: devnet, asset: 'sol', to: '11111111111111111111111111111112', amount: 1n, feeLamports: 5000n, rentLamports: 0n, unsigned, blockhash: '11111111111111111111111111111111' }))
  net.down = false
  const srec = ledger.pendingSol('sol-devnet')
  check('C7 Solana broadcast that dies mid-flight still left a record', serr instanceof sol.SolBroadcastError && srec.length === 1)
  check('C8 …keyed by the signature the error carries', srec[0]?.signature === serr?.signature)
  net.sol = { status: 'unseen' }
  let se = await rejects(() => sol.assertNoSolInFlight(devnet))
  check('C9 Solana prepare refuses while the attempt is unseen', /may still go through/.test(se?.message ?? ''), se?.message?.slice(0, 60))
  net.sol = { status: 'neterr' }
  se = await rejects(() => sol.assertNoSolInFlight(devnet))
  check("C10 Solana prepare refuses when it can't check (old code allowed the send)", /Couldn't check/.test(se?.message ?? ''), se?.message?.slice(0, 60))
  net.sol = { status: 'seen' }
  se = await rejects(() => sol.assertNoSolInFlight(devnet))
  check('C11 once seen, the record is dropped and sending works again', se === null && ledger.pendingSol('sol-devnet').length === 0, se?.message)
}

console.log(failures === 0 ? '\nAll pending-ledger checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
