// check-pending.mjs — OFFLINE (mock localStorage, mock fetch, no network).
//
// The in-flight send ledger (src/lib/pending.ts) is the persisted half of the
// double-pay guard: an ambiguous broadcast failure may still land, and the
// wallet must not let the user pay again until it knows. This suite proves:
//   A. the decision rules (block / allow / prune / TTL / same-nonce retry);
//      since the audit of 2026-10-26 (H1/M2): every attempt at a nonce stays
//      recorded, a mined one settles its whole nonce, an "unknown" one blocks
//      until it is old enough that an honest node would have shown it, and a
//      same-nonce retry must outbid what it replaces;
//   B. the EVM network lookup classifies only viem's explicit "not found" as
//      not-found, and every other failure as 'unreachable' (which blocks);
//   C. the wiring: a broadcast that dies mid-flight is still recorded, and
//      prepareEvmSend / assertNoSolInFlight actually consult the ledger;
//   D. UTXO entries (audit 2026-10-26, M1): an unseen attempt blocks for up
//      to 30 minutes, a seen one is dropped, a failed lookup blocks;
//   E. the providers' txSeen: an explicit 404 is "not seen", a 200 is
//      "seen", anything else throws (and so blocks).
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
  check('A5 a fresh attempt the network claims never to have seen still blocks (a node that took it would show it)', b?.reason === 'pending' && ledger.pendingEvm(CHAIN).length === 1)
  clearLedger(); rec(6, { ts: Date.now() - ledger.EVM_UNKNOWN_GRACE_MS - 1 }); s = stub('unknown-to-network'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A5b ...and is dropped once older than the grace period', b === null && ledger.pendingEvm(CHAIN).length === 0)

  clearLedger(); rec(7); s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, 7, s.fn)
  check('A6 same-nonce retry is not blocked by the attempt it replaces (which stays recorded, and is checked for having mined)', b === null && s.asked.length === 1 && ledger.pendingEvm(CHAIN).length === 1)

  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, 8, s.fn)
  check('A7 a different nonce is still blocked by it', b?.entry.nonce === 7)

  clearLedger(); ledger.recordPending({ kind: 'evm', chainId: 1, nonce: 1, hash: H(1), to: '0x00', ts: Date.now() })
  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check("A8 another chain's attempt does not block this chain", b === null && s.asked.length === 0)

  clearLedger(); rec(9, { ts: Date.now() - 25 * 3600 * 1000 })
  s = stub('pending'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A9 EVM records expire after 24 h', b === null && s.asked.length === 0)

  clearLedger(); rec(10); rec(10, { hash: H(1010) })
  check('A10 a second attempt at the same chain+nonce is recorded BESIDE the first (a retry never erases what it replaces)', ledger.pendingEvm(CHAIN).length === 2 && ledger.pendingEvm(CHAIN).map((p) => p.hash).sort().join() === [H(10), H(1010)].sort().join())
  rec(10); check('A10b the same hash recorded twice is one entry', ledger.pendingEvm(CHAIN).length === 2)
  // one of them mined: the nonce is settled, both go, and a retry at that nonce is told so
  s = stub((h) => (h === H(10) ? 'mined' : 'unknown-to-network')); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check('A10c when either attempt at a nonce mined, every attempt at that nonce is dropped', b === null && ledger.pendingEvm(CHAIN).length === 0 && s.asked.length === 2)
  clearLedger(); rec(10); rec(10, { hash: H(1010) })
  s = stub((h) => (h === H(10) ? 'mined' : 'unknown-to-network')); b = await ledger.evmInFlightBlock(CHAIN, 10, s.fn)
  check("A10d a same-nonce retry whose earlier attempt has mined is answered 'mined', not allowed", b?.reason === 'mined' && b.entry.hash === H(10) && ledger.pendingEvm(CHAIN).length === 0)
  // the retry B was refused by the node (underpriced, never in the pool) and the modal closed: A still blocks a NEW send
  clearLedger(); rec(10); rec(10, { hash: H(1010) })
  s = stub('unknown-to-network'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check("A10e both attempts 'unknown' right after the fact: still blocked (an honest node would show a tx it took)", b?.reason === 'pending' && ledger.pendingEvm(CHAIN).length === 2)
  clearLedger(); rec(10, { ts: Date.now() - ledger.EVM_UNKNOWN_GRACE_MS - 1 })
  s = stub('unknown-to-network'); b = await ledger.evmInFlightBlock(CHAIN, undefined, s.fn)
  check("A10f an 'unknown' attempt older than the grace period is forgotten", b === null && ledger.pendingEvm(CHAIN).length === 0)
  clearLedger(); rec(10, { maxFeePerGas: '1000', maxPriorityFeePerGas: '100' }); rec(10, { hash: H(1010), maxFeePerGas: '1500', maxPriorityFeePerGas: '90' })
  const fl = ledger.evmReplacementFloor(CHAIN, 10)
  check('A10g a same-nonce retry must outbid the highest recorded attempt by 10 %', fl?.maxFeePerGas === 1650n && fl?.maxPriorityFeePerGas === 110n, JSON.stringify(fl, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
  check('A10h no recorded attempt at a nonce → no floor', ledger.evmReplacementFloor(CHAIN, 11) === null)

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
  check('A14 Solana records without a recorded height expire after 90 s', sb === null && !askedOld)
  // audit M7: with a recorded last valid block height, the chain decides after 90 s
  const recSolH = (sig, ts, lastValidBlockHeight) => ledger.recordPending({ kind: 'sol', chainId: 'sol-devnet', signature: sig, ts, lastValidBlockHeight })
  recSolH('sigH', Date.now() - 91_000, 1000)
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 999)
  check('A14b 90 s old but the chain has not passed its last valid height: still blocks', sb?.reason === 'pending')
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => { throw new Error('no height') })
  check('A14c ...and when the height cannot be asked, it still blocks', sb?.reason === 'pending')
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 1001)
  check('A14d once the chain is past its last valid height, it is dropped', sb === null && ledger.pendingSol('sol-devnet').length === 0)
  recSolH('sigY', Date.now() - 30_000, 1000)
  let askedHeight = false
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => ((askedHeight = true), 5000))
  check('A14e younger than 90 s: blocks without consulting the height', sb?.reason === 'pending' && !askedHeight)
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  recSolH('sigZ', Date.now() - ledger.SOL_TTL_HARD_MS - 1, 10 ** 9)
  check('A14f nothing is held past the hard limit, whatever the height', (await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 1)) === null)

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
const net = { down: false, evm: {}, sol: {}, send: 'ok' }
const SOL_ERR = { processed: 'Transaction simulation failed: This transaction has already been processed', expired: 'Transaction simulation failed: Blockhash not found', other: 'Node is behind by 12 slots' }
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
    case 'eth_getTransactionByHash': {
      if (e.tx === 'neterr') throw new TypeError('fetch failed')
      if (e.tx === 'rpcerr') return reply(id, { error: { code: -32000, message: 'header not found' } })
      const st = e.byHash?.[params[0]] // 'pending' | 'mined' | undefined
      const present = st !== undefined ? st !== 'unknown' : e.tx === 'present'
      return reply(id, { result: present ? TX(params[0]) : null })
    }
    case 'eth_getTransactionReceipt': {
      if (e.receipt === 'neterr') throw new TypeError('fetch failed')
      const st = e.byHash?.[params[0]]
      const present = st !== undefined ? st === 'mined' : e.receipt === 'present'
      return reply(id, { result: present ? RECEIPT(params[0]) : null })
    }
    case 'eth_sendRawTransaction':
      if (net.send === 'neterr') throw new TypeError('fetch failed')
      if (net.send === 'rejected') return reply(id, { error: { code: -32000, message: 'insufficient funds for gas * price + value' } })
      if (net.send === 'known') return reply(id, { error: { code: -32000, message: 'already known' } })
      return reply(id, { result: params[0].slice(0, 66) })
    case 'eth_getBalance': return reply(id, { result: '0xde0b6b3a7640000' })
    case 'eth_call': return reply(id, { result: '0x' + '0'.repeat(64) })
    case 'eth_getBlockByNumber': return reply(id, { result: BLOCK })
    case 'eth_maxPriorityFeePerGas': return reply(id, { result: '0x1' })
    case 'eth_getTransactionCount': return reply(id, { result: e.nonce ?? '0x8' })
    case 'eth_getCode': return reply(id, { result: '0x' })
    case 'eth_chainId': return reply(id, { result: '0x14a34' })
    case 'sendTransaction':
      if (s.send === 'neterr') throw new TypeError('fetch failed')
      if (s.send && s.send !== 'ok') return reply(id, { error: { code: -32002, message: SOL_ERR[s.send] } })
      return reply(id, { result: 'sig' })
    case 'getBlockHeight': return reply(id, { result: s.height ?? 1 })
    case 'getBalance': return reply(id, { result: { context: { slot: 1 }, value: 1_000_000_000 } })
    case 'getLatestBlockhash': return reply(id, { result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 777 } } })
    case 'getMinimumBalanceForRentExemption': return reply(id, { result: 890880 })
    case 'getAccountInfo': return reply(id, { result: { context: { slot: 1 }, value: s.account ?? null } })
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
  check('C3 prepareEvmSend refuses while that attempt is in the mempool', /may still be on its way/.test(e2?.message ?? ''), e2?.message?.slice(0, 70))
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

console.log('--- C2. the same-nonce retry, end to end (audit H1/M2/M3) ---')
{
  const { deriveEvmKey, prepareEvmSend, broadcastEvmSend, EVM_CHAINS } = evm
  const CH = EVM_CHAINS['base-sepolia']
  const key = deriveEvmKey(MN)
  const to = '0x000000000000000000000000000000000000dEaD'
  const clear = () => { for (const p of ledger.pendingEvm(CH.chainId)) ledger.dropPending(p) }
  const prep = (extra = {}) => prepareEvmSend({ chain: CH, key, to, amount: 1000n, asset: 'gas', ...extra })
  // A: accepted by a node but the answer never arrives
  clear(); net.evm = { byHash: {}, nonce: '0x7' }; net.send = 'neterr'
  const A = await prep()
  check('C2.1 A prepares at the pending nonce', A.request.nonce === 7)
  const eA = await rejects(() => broadcastEvmSend(key, A))
  const hashA = ledger.pendingEvm(CH.chainId)[0]?.hash
  check('C2.2 A\'s broadcast fails with a network error and A stays recorded with its fees', eA !== null && ledger.pendingEvm(CH.chainId).length === 1 && BigInt(ledger.pendingEvm(CH.chainId)[0].maxFeePerGas) === A.request.maxFeePerGas)
  // B: the modal's same-nonce retry; the node holds A silently
  net.evm = { byHash: { [hashA]: 'pending' }, nonce: '0x8' }
  const B = await prep({ reuseNonce: 7 })
  check('C2.3 B re-signs at nonce 7 and outbids A by at least 10 %', B.request.nonce === 7 && B.request.maxFeePerGas >= (A.request.maxFeePerGas * 11n + 9n) / 10n && B.request.maxPriorityFeePerGas >= (A.request.maxPriorityFeePerGas * 11n + 9n) / 10n)
  net.send = 'neterr'
  await rejects(() => broadcastEvmSend(key, B))
  const hashes = ledger.pendingEvm(CH.chainId).map((p) => p.hash)
  check('C2.4 after B, BOTH attempts are on record', hashes.length === 2 && hashes.includes(hashA))
  // the modal is closed; A is in the pool: a new send must wait
  net.evm = { byHash: { [hashA]: 'pending' }, nonce: '0x8' }
  const eC = await rejects(() => prep())
  check('C2.5 a new send is refused while A is still in the mempool', /may still be on its way/.test(eC?.message ?? ''), eC?.message?.slice(0, 60))
  // the node now hides A and B: too young to forget → still refused
  net.evm = { byHash: {}, nonce: '0x8' }
  const eC2 = await rejects(() => prep())
  check("C2.6 ...and while the node claims it never saw either (younger than the grace period)", /may still be on its way/.test(eC2?.message ?? ''), eC2?.message?.slice(0, 60))
  // A mines: the nonce is settled, the new send goes through at 8
  net.evm = { byHash: { [hashA]: 'mined' }, nonce: '0x8' }
  const C = await prep()
  check('C2.7 once A has mined, both records are dropped and the next send takes nonce 8', C.request.nonce === 8 && ledger.pendingEvm(CH.chainId).length === 0)
  // the retry when A has already mined: told so, nothing re-sent
  clear(); net.evm = { byHash: {}, nonce: '0x7' }; net.send = 'neterr'
  const A2 = await prep(); await rejects(() => broadcastEvmSend(key, A2))
  const hA2 = ledger.pendingEvm(CH.chainId)[0].hash
  net.evm = { byHash: { [hA2]: 'mined' }, nonce: '0x8' }
  const eR = await rejects(() => prep({ reuseNonce: 7 }))
  check("C2.8 a retry whose first attempt has mined is told 'it went through' and prepares nothing", /went through after all/.test(eR?.message ?? ''), eR?.message?.slice(0, 60))
  // a definite rejection by the node drops the record at once; 'already known' keeps it
  clear(); net.evm = { byHash: {}, nonce: '0x7' }; net.send = 'rejected'
  const A3 = await prep(); await rejects(() => broadcastEvmSend(key, A3))
  check('C2.9 a node that answered with a rejection never took the tx: the record is dropped', ledger.pendingEvm(CH.chainId).length === 0)
  net.send = 'known'
  const A4 = await prep(); await rejects(() => broadcastEvmSend(key, A4))
  check("C2.10 'already known' means it IS in the pool: the record stays", ledger.pendingEvm(CH.chainId).length === 1)
  clear(); net.send = 'ok'; net.evm = { byHash: {}, nonce: '0x7' }
  // M3: tokens to the token contract, the zero address, or a contract
  const eT = await rejects(() => prepareEvmSend({ chain: CH, key, to: CH.token.address, amount: 1n, asset: 'token' }))
  check("C2.11 USDC to the USDC contract itself is refused", /token's own contract/.test(eT?.message ?? ''), eT?.message?.slice(0, 60))
  const eZ = await rejects(() => prepareEvmSend({ chain: CH, key, to: '0x0000000000000000000000000000000000000000', amount: 1n, asset: 'token' }))
  check('C2.12 USDC to the zero address is refused', /zero address/.test(eZ?.message ?? ''), eZ?.message?.slice(0, 60))
  const native = await prep()
  check('C2.13 an ordinary recipient is not flagged as a contract', native.recipientIsContract === false)
}

console.log('--- F. TRON entries and wiring (audit H2) ---')
{
  const tron = await import('../src/lib/tron.ts')
  const CH = tron.TRON_CHAINS['tron-nile']
  const clearTron = () => { for (const p of ledger.pendingTron(CH.id)) ledger.dropPending(p) }
  clearTron()
  const TX = 'f'.repeat(64)
  ledger.recordPending({ kind: 'tron', chainId: CH.id, txid: TX, to: 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', expiration: Date.now() + 60_000, ts: Date.now() })
  const b1 = await ledger.tronInFlightBlock(CH.id, async () => false)
  check('F1 an unseen attempt blocks until its expiration', b1?.reason === 'pending' && b1.entry.txid === TX)
  const b2 = await ledger.tronInFlightBlock(CH.id, async () => { throw new Error('down') })
  check('F2 a failed lookup blocks (unreachable)', b2?.reason === 'unreachable')
  const b3 = await ledger.tronInFlightBlock(CH.id, async () => true)
  check('F3 once the node knows it, the entry is dropped', b3 === null && ledger.pendingTron(CH.id).length === 0)
  ledger.recordPending({ kind: 'tron', chainId: CH.id, txid: 'e'.repeat(64), to: 'x', expiration: Date.now() - 1, ts: Date.now() - 70_000 })
  check('F4 an attempt past its own expiration no longer blocks', (await ledger.tronInFlightBlock(CH.id, async () => false)) === null)

  // wiring through the real tron.ts with a mock node
  const realFetch = globalThis.fetch
  const node = { seen: false, broadcast: 'ok', calls: [] }
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    node.calls.push(path)
    if (node.broadcast === 'neterr' && path.endsWith('/broadcasttransaction')) throw new TypeError('fetch failed')
    const body = (() => {
      if (path.endsWith('/gettransactionbyid')) return node.seen ? { txID: JSON.parse(init.body).value } : {}
      if (path.endsWith('/broadcasttransaction')) {
        if (node.broadcast === 'dup') return { result: false, code: 'DUP_TRANSACTION', message: '' }
        if (node.broadcast === 'rejected') return { result: false, code: 'SIGERROR', message: Buffer.from('validate signature error').toString('hex') }
        return { result: true }
      }
      return {}
    })()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const key = tron.deriveTronKey(MN, true)
  const prepared = { chain: CH, asset: 'trx', to: 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', amount: 1n, estimatedFeeSun: 0n, feeLimitSun: 0n, createsAccount: false,
    rawDataHex: '0a02aabb', rawData: {}, txID: 'd'.repeat(64), expiration: Date.now() + 60_000 }
  clearTron(); node.broadcast = 'neterr'
  const e1 = await rejects(() => tron.broadcastTronSend(key, prepared))
  check('F5 a broadcast whose answer never arrives keeps its record', e1 !== null && ledger.pendingTron(CH.id).length === 1 && ledger.pendingTron(CH.id)[0].txid === prepared.txID)
  node.seen = false
  const e2 = await rejects(() => tron.prepareTronSend(CH, key, 'trx', 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', 1n))
  check('F6 prepareTronSend refuses while that attempt is unseen and unexpired', /may still go through/.test(e2?.message ?? ''), e2?.message?.slice(0, 60))
  node.seen = true
  node.calls.length = 0
  const e3 = await rejects(() => tron.prepareTronSend(CH, key, 'trx', 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', 1n))
  check('F7 once the node reports it, the next prepare gets past the ledger (and fails later on the mock, not on the guard)', !/may still go through/.test(e3?.message ?? '') && ledger.pendingTron(CH.id).length === 0 && node.calls[0].endsWith('/gettransactionbyid'))
  clearTron(); node.broadcast = 'dup'
  const dup = await tron.broadcastTronSend(key, prepared).catch((e) => e)
  check('F8 DUP_TRANSACTION (the node already holds it) counts as success', dup === prepared.txID)
  clearTron(); node.broadcast = 'rejected'
  const e4 = await rejects(() => tron.broadcastTronSend(key, prepared))
  check('F9 a node that answered with a rejection never took it: the record is dropped', e4 !== null && ledger.pendingTron(CH.id).length === 0)
  clearTron(); node.broadcast = 'ok'
  await tron.broadcastTronSend(key, prepared)
  check('F10 a successful broadcast stays recorded until the node reports it', ledger.pendingTron(CH.id).length === 1)
  clearTron()
  key.zero()
  globalThis.fetch = realFetch
}

console.log('--- G. Solana: re-sending the same bytes (audit M7) ---')
{
  const devnet = sol.SOL_CHAINS['sol-devnet']
  net.sol = { send: 'ok' }
  check('G1 a resend the node accepts returns the same signature', (await sol.rebroadcastSol(devnet, 'sigA', 'AAAA')) === 'sigA')
  net.sol = { send: 'processed' }
  check('G2 "already processed" means the first try landed: success, same signature', (await sol.rebroadcastSol(devnet, 'sigA', 'AAAA')) === 'sigA')
  net.sol = { send: 'expired' }
  const ex = await rejects(() => sol.rebroadcastSol(devnet, 'sigA', 'AAAA'))
  check('G3 an expired blockhash is reported as expired (safe to start over)', ex instanceof sol.SolExpiredError)
  net.sol = { send: 'other' }
  const oe = await rejects(() => sol.rebroadcastSol(devnet, 'sigA', 'AAAA'))
  check('G4 any other failure keeps the signed bytes for another resend', oe instanceof sol.SolBroadcastError && oe.signed === 'AAAA' && oe.signature === 'sigA')
  net.sol = { send: 'neterr' }
  const ne = await rejects(() => sol.rebroadcastSol(devnet, 'sigA', 'AAAA'))
  check('G5 a network failure too', ne instanceof sol.SolBroadcastError && ne.signed === 'AAAA')
  // the broadcast error carries the signed bytes, and the record carries the height
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  const skey = sol.deriveSolKey(MN, 0, true)
  const unsigned = solLib.createTx(skey.address, [solLib.sys.transferSol({ source: skey.address, destination: '11111111111111111111111111111112', amount: 1n })], '11111111111111111111111111111111')
  net.sol = { send: 'neterr' }
  const be = await rejects(() => sol.broadcastSolSend(skey, { chain: devnet, asset: 'sol', to: '11111111111111111111111111111112', lastValidBlockHeight: 4242, amount: 1n, feeLamports: 5000n, rentLamports: 0n, unsigned, blockhash: '11111111111111111111111111111111' }))
  check('G6 a failed broadcast hands back the signed bytes and records the last valid height', be instanceof sol.SolBroadcastError && typeof be.signed === 'string' && be.signed.length > 0 && ledger.pendingSol('sol-devnet')[0]?.lastValidBlockHeight === 4242)
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  skey.zero()
  net.sol = {}
}

console.log('--- H. Solana Pay extras and the destination check (audit L11/L14) ---')
{
  const devnet = sol.SOL_CHAINS['sol-devnet']
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  const skey = sol.deriveSolKey(MN, 0, true)
  const TO = '11111111111111111111111111111112'
  const R1 = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb'
  net.sol = {}
  const p1 = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n, reference: [R1], memo: 'Order 42' })
  const raw = solLib.TransactionRaw.decode(Uint8Array.from(atob(p1.unsigned), (c) => c.charCodeAt(0)))
  const keys = raw.msg.data.keys
  const ixs = raw.msg.data.instructions
  const transfer = ixs[0], memo = ixs[1]
  check('H1 the transfer carries the reference as an extra read-only account', transfer !== undefined && transfer.keys.map((k) => keys[k]).includes(R1) && !raw.msg.data.header.requiredSignatures !== undefined && keys.indexOf(R1) >= raw.msg.data.header.requiredSignatures)
  check('H2 a memo instruction follows, signed by the payer', memo !== undefined && keys[memo.programIdx] === sol.MEMO_PROGRAM && new TextDecoder().decode(memo.data) === 'Order 42' && memo.keys.map((k) => keys[k]).includes(skey.address))
  check('H3 the prepared send reports them for the review', p1.reference.join() === R1 && p1.memo === 'Order 42' && p1.lastValidBlockHeight === 777)
  const p2 = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n })
  const raw2 = solLib.TransactionRaw.decode(Uint8Array.from(atob(p2.unsigned), (c) => c.charCodeAt(0)))
  check('H4 without extras the transaction is the plain transfer', raw2.msg.data.instructions.length === 1 && p2.memo === null && p2.reference.length === 0)
  net.sol = { account: { owner: solLib.TOKEN_PROGRAM, lamports: 2039280, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
  const e1 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n }))
  check('H5 SOL to a token account is refused (the USDC path already did this)', /token account, not a wallet/.test(e1?.message ?? ''), e1?.message?.slice(0, 60))
  net.sol = { account: { owner: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', lamports: 1, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
  const e2 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n }))
  check("H6 SOL to a program's account is refused", /belongs to a program/.test(e2?.message ?? ''), e2?.message?.slice(0, 60))
  net.sol = {}
  const e3 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n, memo: 'x'.repeat(300) }))
  check('H7 an oversized memo is refused at prepare too', /memo/.test(e3?.message ?? ''))
  skey.zero()
}

console.log('--- D. UTXO entries ---')
{
  const TX = 'a'.repeat(64)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: TX, to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', ts: Date.now() })
  const b1 = await ledger.utxoInFlightBlock('btc', async () => false)
  check('D1 an attempt the network does not report blocks the next send', b1?.reason === 'pending' && b1.entry.txid === TX)
  const asked = []
  const b2 = await ledger.utxoInFlightBlock('btc', async (t) => { asked.push(t); throw new Error('timeout') })
  check('D2 a failed lookup blocks too (unreachable), after asking about the right txid', b2?.reason === 'unreachable' && asked[0] === TX)
  check('D3 another chain is not blocked', (await ledger.utxoInFlightBlock('ltc', async () => false)) === null)
  const b3 = await ledger.utxoInFlightBlock('btc', async () => true)
  check('D4 once the network reports it, the entry is dropped', b3 === null && ledger.pendingUtxo('btc').length === 0)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: 'b'.repeat(64), to: 'x', ts: Date.now() - ledger.UTXO_TTL_MS - 1 })
  check('D5 an attempt older than 30 minutes no longer blocks', (await ledger.utxoInFlightBlock('btc', async () => false)) === null)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: 'c'.repeat(64), to: 'x', ts: Date.now() })
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: 'c'.repeat(64), to: 'x', ts: Date.now() })
  check('D6 the same txid recorded twice (a Retry) is one entry', ledger.pendingUtxo('btc').length === 1)
  await ledger.utxoInFlightBlock('btc', async () => true)
}

console.log('--- E. the providers\' txSeen ---')
{
  const { EsploraProvider } = await import('../src/lib/esplora.ts')
  const { BlockcypherProvider } = await import('../src/lib/blockcypher.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  const realFetch = globalThis.fetch
  const providers = [
    ['esplora', new EsploraProvider({ name: 'mock', kind: 'esplora', base: 'https://esplora.invalid/api', pageSize: 50 }, CHAINS.btc)],
    ['blockcypher', new BlockcypherProvider({ name: 'blockcypher', kind: 'blockcypher', base: 'https://api.blockcypher.com/v1/doge/main' }, CHAINS.doge)],
  ]
  for (const [name, p] of providers) {
    globalThis.fetch = async () => new Response(name === 'esplora' ? '{"confirmed":false}' : '{"hash":"x"}', { status: 200 })
    check(`E ${name}: 200 → seen`, (await p.txSeen('a'.repeat(64))) === true)
    globalThis.fetch = async () => new Response('Transaction not found', { status: 404 })
    check(`E ${name}: 404 → not seen`, (await p.txSeen('a'.repeat(64))) === false)
    globalThis.fetch = async () => new Response('busy', { status: 503 })
    check(`E ${name}: 503 → throws (the ledger blocks)`, (await rejects(() => p.txSeen('a'.repeat(64)))) !== null)
    globalThis.fetch = async () => { throw new TypeError('Load failed') }
    check(`E ${name}: a network failure → throws (the ledger blocks)`, (await rejects(() => p.txSeen('a'.repeat(64)))) !== null)
  }
  globalThis.fetch = realFetch
}

console.log(failures === 0 ? '\nAll pending-ledger checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
