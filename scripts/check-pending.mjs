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
//      "seen", anything else throws (and so blocks);
//   I. lost answers (bug audit 2026-10-27, BH1/BM1/BM2/BM3/BM11): esplora asks
//      /tx/:txid (its /status path says 200 for anything); an attempt whose
//      broadcast failed and then landed is REPORTED before any new send
//      (kept up to a day), a clean one dropped silently; every engine's
//      broadcast tells a refusal (record dropped) from a lost answer (record
//      kept, marked failed); EVM asks each RPC and keeps every answer;
//      Solana's height is the block height, not the slot; TRON holds by this
//      device's clock and re-sends the SAME bytes; another window's record
//      is seen;
//   J. before a Speed up (BH5): a payment sent since that the network doesn't
//      show yet blocks it (a scan can't see what it spends); the transaction
//      being replaced, and attempts the network shows, don't.
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
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 999)
  check('A14e younger than 90 s, its blockhash still valid: blocks', sb?.reason === 'pending')
  let askedHeight = false
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => ((askedHeight = true), 1001))
  check('A14e2 ...but once the chain is past its last valid height it can\'t land, however young: dropped (bug audit BM17; it held sends 90 s)', sb === null && askedHeight && ledger.pendingSol('sol-devnet').length === 0)
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
const SOL_ERR = { processed: 'Transaction simulation failed: This transaction has already been processed', expired: 'Transaction simulation failed: Blockhash not found', other: 'Node is behind by 12 slots', rent: 'Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent' }
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
      return reply(id, { result: present ? { ...RECEIPT(params[0]), status: e.reverted?.includes(params[0]) ? '0x0' : '0x1' } : null })
    }
    case 'eth_sendRawTransaction':
      if (net.send === 'neterr') throw new TypeError('fetch failed')
      if (net.send === 'rejected') return reply(id, { error: { code: -32000, message: 'insufficient funds for gas * price + value' } })
      if (net.send === 'known') return reply(id, { error: { code: -32000, message: 'already known' } })
      if (net.send === 'nonce-low') return reply(id, { error: { code: -32000, message: 'nonce too low: next nonce 8, tx nonce 7' } })
      return reply(id, { result: params[0].slice(0, 66) })
    case 'eth_getBalance': return reply(id, { result: '0xde0b6b3a7640000' })
    case 'eth_call': return reply(id, { result: '0x' + '0'.repeat(64) })
    case 'eth_getBlockByNumber': return reply(id, { result: BLOCK })
    case 'eth_maxPriorityFeePerGas': return reply(id, { result: '0x1' })
    // 'latest' counts mined transactions only; unset, nothing has mined
    case 'eth_getTransactionCount': return reply(id, { result: params[1] === 'latest' ? (e.latestNonce ?? '0x0') : (e.nonce ?? '0x8') })
    case 'eth_getCode': return reply(id, { result: '0x' })
    case 'eth_chainId': return reply(id, { result: '0x14a34' })
    case 'sendTransaction':
      if (s.send === 'neterr') throw new TypeError('fetch failed')
      if (s.send && s.send !== 'ok') return reply(id, { error: { code: -32002, message: SOL_ERR[s.send] } })
      return reply(id, { result: 'sig' })
    case 'getBlockHeight': return reply(id, { result: s.height ?? 1 })
    case 'getEpochInfo': return reply(id, { result: { blockHeight: s.height ?? 1, absoluteSlot: (s.height ?? 1) + 22_000_000, epoch: s.epoch ?? 500 } })
    case 'getMultipleAccounts': return reply(id, { result: { context: { slot: 1 }, value: params[0].map((_, i) => s.stakeAccounts?.[i] ?? null) } })
    case 'getBalance': return reply(id, { result: { context: { slot: 1 }, value: 1_000_000_000 } })
    case 'getLatestBlockhash': return reply(id, { result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 777 } } })
    case 'getMinimumBalanceForRentExemption': return reply(id, { result: 890880 })
    case 'getAccountInfo': return reply(id, { result: { context: { slot: 1 }, value: s.accounts?.[params[0]] ?? s.account ?? null } })
    case 'getSignatureStatuses':
      if (s.status === 'neterr') throw new TypeError('fetch failed')
      return reply(id, { result: { context: { slot: 1 }, value: [s.status === 'seen' || s.status === 'seen-failed' ? { slot: 1, confirmations: null, err: s.status === 'seen-failed' ? { InstructionError: [0, { Custom: 1 }] } : null, confirmationStatus: 'confirmed' } : null] } })
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
  check('C3 prepareEvmSend refuses while that attempt is in the mempool, and says it is waiting (no "ten minutes"; bug audit BM15)', e2 instanceof evm.EvmSendWaiting && e2.entry.nonce === 7 && /still waiting to be confirmed/.test(e2.message) && !/ten minutes/.test(e2.message), e2?.message?.slice(0, 70))
  net.evm = { tx: 'neterr', receipt: 'missing' }
  e2 = await rejects(send)
  check("C4 prepareEvmSend refuses when it can't check", /Couldn't check/.test(e2?.message ?? ''), e2?.message?.slice(0, 70))
  e2 = await rejects(() => evm.prepareEvmSend({ chain: BASE_SEPOLIA, key, to: '0x1111111111111111111111111111111111111111', amount: 1000n, asset: 'gas', reuseNonce: 7 }))
  check('C5 …but allows the same-nonce retry that replaces it', e2 === null, e2?.message)
  net.evm = { tx: 'present', receipt: 'present' }
  e2 = await rejects(send)
  check("C6 once the failed attempt has mined, a new send is told it went through (bug audit BH1), not silently allowed",
    e2 instanceof ledger.EarlierSendLanded && /went through after all/.test(e2.message) && ledger.pendingEvm(CHAIN).length === 1, e2?.message?.slice(0, 70))
  ledger.dismissLanded(e2.entry)
  e2 = await rejects(send)
  check('C6b ...and once the user says send again anyway, the record is gone and sending works', e2 === null && ledger.pendingEvm(CHAIN).length === 0, e2?.message)

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
  check('C11 once the failed attempt is seen, the next prepare says it went through (bug audit BH1)',
    se instanceof ledger.EarlierSendLanded && ledger.pendingSol('sol-devnet').length === 1, se?.message?.slice(0, 70))
  ledger.dismissLanded(se.entry)
  se = await rejects(() => sol.assertNoSolInFlight(devnet))
  check('C11b ...dismissed, the record is gone and sending works again', se === null && ledger.pendingSol('sol-devnet').length === 0, se?.message)
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
  check('C2.5 a new send is refused while A is still in the mempool', eC instanceof evm.EvmSendWaiting, eC?.message?.slice(0, 60))
  // BM15: from there the form can replace it — the same nonce at a higher fee
  const R = await prep({ reuseNonce: eC?.entry?.nonce }).catch((x) => x)
  const floor = ledger.evmReplacementFloor(CH.chainId, 7)
  check('C2.5b "Replace it": the waiting send\'s nonce, outbidding every attempt on record by at least 10 % (BM15)',
    R?.request?.nonce === 7 && floor !== null && R.request.maxFeePerGas >= floor.maxFeePerGas && R.request.maxPriorityFeePerGas >= floor.maxPriorityFeePerGas, R?.message ?? `nonce ${R?.request?.nonce}`)
  // the node now hides A and B: too young to forget → still refused
  net.evm = { byHash: {}, nonce: '0x8' }
  const eC2 = await rejects(() => prep())
  check("C2.6 ...and while the node claims it never saw either (younger than the grace period)", eC2 instanceof evm.EvmSendWaiting, eC2?.message?.slice(0, 60))
  // A mines: the nonce is settled. A's broadcast had failed, so a new send is
  // first told that it went through (bug audit BH1); sent anyway, it takes 8
  net.evm = { byHash: { [hashA]: 'mined' }, nonce: '0x8' }
  const eL = await rejects(() => prep())
  check('C2.7 once A (whose broadcast failed) has mined, a new send is told it went through', eL instanceof ledger.EarlierSendLanded && eL.entry.hash === hashA, eL?.message?.slice(0, 60))
  ledger.dismissLanded(eL.entry)
  const C = await prep()
  check('C2.7b dismissed: every attempt at nonce 7 is dropped and the next send takes nonce 8', C.request.nonce === 8 && ledger.pendingEvm(CH.chainId).length === 0)
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
  // BM14: a retry at a nonce the chain has already used (not by an attempt
  // on record) is refused before signing, and the records stay
  clear(); net.evm = { byHash: {}, nonce: '0x7' }; net.send = 'neterr'
  const A5 = await prep(); await rejects(() => broadcastEvmSend(key, A5))
  net.evm = { byHash: {}, nonce: '0x8', latestNonce: '0x8' }
  const eU = await rejects(() => prep({ reuseNonce: 7 }))
  check('C2.10b a retry at a nonce the chain has already used is told so, prepares nothing, and keeps the record (BM14)',
    eU instanceof evm.EvmNonceSettled && /already been used/.test(eU.message) && ledger.pendingEvm(CH.chainId).length === 1, eU?.message?.slice(0, 70))
  net.evm = { byHash: { [ledger.pendingEvm(CH.chainId)[0].hash]: 'pending' }, nonce: '0x8', latestNonce: '0x7' }
  const B5 = await prep({ reuseNonce: 7 }).catch((x) => x)
  check('C2.10c ...while a nonce the chain has not used yet is still retried at the same nonce', B5?.request?.nonce === 7, B5?.message)
  // every node refusing "nonce too low": the form must stop retrying that nonce
  clear(); net.evm = { byHash: {}, nonce: '0x7' }; net.send = 'nonce-low'
  const A6 = await prep(); const eN = await rejects(() => broadcastEvmSend(key, A6))
  net.send = 'rejected'
  const A7 = await prep(); const eI = await rejects(() => broadcastEvmSend(key, A7))
  check('C2.10d a "nonce too low" refusal is definite and says the nonce is used; other refusals don\'t (BM14)',
    eN instanceof evm.EvmBroadcastError && eN.definite && eN.nonceUsed === true && eI instanceof evm.EvmBroadcastError && eI.definite && eI.nonceUsed === false && ledger.pendingEvm(CH.chainId).length === 0)
  {
    const { readFileSync } = await import('node:fs')
    const modal = readFileSync(new URL('../src/components/EvmSendModal.tsx', import.meta.url), 'utf8')
    check('C2.10e ...and the send form drops its retry nonce on it (no loop of "nonce too low")', /else if \(e\.nonceUsed\) \{\s*setRetryNonce\(null\)/.test(modal))
  }
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
  check('F7 once the node reports the failed attempt, the next prepare says it went through instead of building a second payment (bug audit BH1; this used to pass silently)',
    e3 instanceof ledger.EarlierSendLanded && ledger.pendingTron(CH.id).length === 1 && node.calls[0].endsWith('/gettransactionbyid'), e3?.message?.slice(0, 60))
  ledger.dismissLanded(e3.entry)
  const e3b = await rejects(() => tron.prepareTronSend(CH, key, 'trx', 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', 1n))
  check('F7b dismissed: the next prepare gets past the ledger (and fails later on the mock, not on the guard)', !(e3b instanceof ledger.EarlierSendLanded) && !/may still go through/.test(e3b?.message ?? '') && ledger.pendingTron(CH.id).length === 0)
  clearTron(); node.broadcast = 'dup'
  const dup = await tron.broadcastTronSend(key, prepared).catch((e) => e)
  check('F8 DUP_TRANSACTION (the node already holds it) counts as success', dup === prepared.txID)
  clearTron(); node.broadcast = 'rejected'
  const e4 = await rejects(() => tron.broadcastTronSend(key, prepared))
  check('F9 a node that answered with a rejection never took it: the record is dropped', e4 !== null && ledger.pendingTron(CH.id).length === 0)
  const { sentToAddresses } = await import('../src/lib/sentlog.ts')
  clearTron(); node.broadcast = 'rejected'
  await rejects(() => tron.broadcastTronSend(key, { ...prepared, to: 'TRmZH7sn1PkHk5zW4fk2AEzywkE4PTbFmh', txID: 'e'.repeat(64) }))
  check('F9b ...nor does its recipient become trusted in the send log (bug audit 2026-10-27, BL19)', !sentToAddresses(CH.id).includes('TRmZH7sn1PkHk5zW4fk2AEzywkE4PTbFmh') && sentToAddresses(CH.id).includes(prepared.to))
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
  const p1 = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1_000_000n, reference: [R1], memo: 'Order 42' })
  const raw = solLib.TransactionRaw.decode(Uint8Array.from(atob(p1.unsigned), (c) => c.charCodeAt(0)))
  const keys = raw.msg.data.keys
  const ixs = raw.msg.data.instructions
  const memo = ixs[0], transfer = ixs[1]
  check('H1 the transfer carries the reference as an extra read-only account', transfer !== undefined && transfer.keys.map((k) => keys[k]).includes(R1) && !raw.msg.data.header.requiredSignatures !== undefined && keys.indexOf(R1) >= raw.msg.data.header.requiredSignatures)
  check('H2 the memo instruction comes immediately BEFORE the transfer, signed by the payer (Solana Pay; bug audit 2026-10-27, BM19)', ixs.length === 2 && memo !== undefined && keys[memo.programIdx] === sol.MEMO_PROGRAM && new TextDecoder().decode(memo.data) === 'Order 42' && memo.keys.map((k) => keys[k]).includes(skey.address) && keys[transfer.programIdx] === solLib.SYS_PROGRAM)
  check('H3 the prepared send reports them for the review', p1.reference.join() === R1 && p1.memo === 'Order 42' && p1.lastValidBlockHeight === 777)
  const p2 = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1_000_000n })
  const raw2 = solLib.TransactionRaw.decode(Uint8Array.from(atob(p2.unsigned), (c) => c.charCodeAt(0)))
  check('H4 without extras the transaction is the plain transfer', raw2.msg.data.instructions.length === 1 && p2.memo === null && p2.reference.length === 0)
  net.sol = { account: { owner: solLib.TOKEN_PROGRAM, lamports: 2039280, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
  const e1 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1_000_000n }))
  check('H5 SOL to a token account is refused (the USDC path already did this)', /token account, not a wallet/.test(e1?.message ?? ''), e1?.message?.slice(0, 60))
  net.sol = { account: { owner: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', lamports: 1, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
  const e2 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1_000_000n }))
  check("H6 SOL to a program's account is refused", /belongs to a program/.test(e2?.message ?? ''), e2?.message?.slice(0, 60))
  net.sol = {}
  const e3 = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1_000_000n, memo: 'x'.repeat(300) }))
  check('H7 an oversized memo is refused at prepare too', /memo/.test(e3?.message ?? ''))
  // USDC to a first-time holder: [open their token account, memo, transfer]
  const tokenData = new Uint8Array(165)
  tokenData.set([0x40, 0x42, 0x0f], 64) // 1 USDC
  const tokenAccount = { owner: solLib.TOKEN_PROGRAM, lamports: 2039280, data: [btoa(String.fromCharCode(...tokenData)), 'base64'], executable: false, rentEpoch: 0 }
  net.sol = { accounts: { [sol.solUsdcAta(devnet, skey.address)]: tokenAccount } }
  const pu = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'usdc', to: TO, amount: 1000n, reference: [R1], memo: 'Order 42' }).catch((e) => e)
  const rawU = pu?.unsigned !== undefined ? solLib.TransactionRaw.decode(Uint8Array.from(atob(pu.unsigned), (c) => c.charCodeAt(0))) : null
  const keysU = rawU?.msg.data.keys ?? []
  const progs = (rawU?.msg.data.instructions ?? []).map((ix) => keysU[ix.programIdx])
  const tU = rawU?.msg.data.instructions[2]
  check('H8 a USDC payment: open the account, then the memo, then the transfer (with the reference)', progs.join() === [solLib.ASSOCIATED_TOKEN_PROGRAM, sol.MEMO_PROGRAM, solLib.TOKEN_PROGRAM].join() && tU?.keys.map((k) => keysU[k]).includes(R1), progs.join() || pu?.message)
  net.sol = {}
  // BM18: SOL to an address that has never held any must open it at the rent-exempt minimum
  const low = await rejects(() => sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 890_879n }))
  check('H9 SOL below the rent-exempt minimum to an address that has never held SOL is refused before signing (BM18)', /never held SOL/.test(low?.message ?? '') && /0\.00089088 SOL/.test(low?.message ?? ''), low?.message?.slice(0, 80))
  const atMin = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 890_880n }).catch((e) => e)
  check('H9b ...exactly the minimum is fine', atMin?.amount === 890_880n, atMin?.message)
  net.sol = { account: { owner: solLib.SYS_PROGRAM, lamports: 5, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
  const toExisting = await sol.prepareSolSend({ chain: devnet, key: skey, asset: 'sol', to: TO, amount: 1000n }).catch((e) => e)
  check('H9c ...and an address that already exists takes any amount', toExisting?.amount === 1000n, toExisting?.message)
  net.sol = {}
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

console.log('--- I. lost answers: the guard after a failed broadcast (bug audit 2026-10-27) ---')
{
  const { EsploraProvider } = await import('../src/lib/esplora.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  const utxo = await import('../src/lib/utxosend.ts')
  const tron = await import('../src/lib/tron.ts')
  const mockRpc = globalThis.fetch // the JSON-RPC mock above
  const clearUtxo = (id = 'btc') => { for (const p of ledger.pendingUtxo(id)) ledger.dropPending(p) }
  const tick = () => new Promise((r) => setTimeout(r, 30))

  // --- UTXO ---
  const asked = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    asked.push(u)
    return u.endsWith('/status') ? new Response('{"confirmed":false}', { status: 200 }) : new Response('Transaction not found', { status: 404 })
  }
  const ep = new EsploraProvider({ name: 'mock', kind: 'esplora', base: 'https://esplora.invalid/api', pageSize: 50 }, CHAINS.btc)
  const fake = await ep.txSeen('ab'.repeat(32))
  check('I1 esplora: a txid that never existed is NOT seen (asks /tx/:txid; the /status path says 200 for anything, which switched the guard off)',
    fake === false && asked.at(-1) === `https://esplora.invalid/api/tx/${'ab'.repeat(32)}`, asked.at(-1))
  globalThis.fetch = mockRpc

  clearUtxo()
  const TXa = '1'.repeat(64)
  const recA = { kind: 'utxo', chainId: 'btc', txid: TXa, to: 'bc1qrecipient', ts: Date.now() }
  ledger.recordPending(recA)
  ledger.markPendingFailed(recA)
  let b = await ledger.utxoInFlightBlock('btc', async () => true)
  check('I2 a UTXO attempt whose broadcast failed and which is now seen → "landed", kept until dismissed', b?.reason === 'landed' && b.entry.txid === TXa && ledger.pendingUtxo('btc').length === 1)
  ledger.dismissLanded(b.entry)
  check('I2b dismissed ("Send again anyway") → gone, and the next send is allowed', (await ledger.utxoInFlightBlock('btc', async () => true)) === null && ledger.pendingUtxo('btc').length === 0)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: '2'.repeat(64), to: 'x', ts: Date.now() })
  b = await ledger.utxoInFlightBlock('btc', async () => true)
  check('I3 an attempt that went out cleanly is dropped silently once seen (no notice after a success)', b === null && ledger.pendingUtxo('btc').length === 0)

  const old = Date.now() - ledger.UTXO_TTL_MS - 60_000
  ledger.recordPending({ ...recA, ts: old, failed: true })
  b = await ledger.utxoInFlightBlock('btc', async () => true)
  check('I4 a failed attempt that lands after the 30-minute window is still reported (a retry hours later is caught)', b?.reason === 'landed')
  ledger.dismissLanded(b.entry)
  ledger.recordPending({ ...recA, ts: old, failed: true })
  b = await ledger.utxoInFlightBlock('btc', async () => { throw new Error('down') })
  check('I4b past its window a failed lookup no longer blocks, and the record is kept for the next check', b === null && ledger.pendingUtxo('btc').length === 1)
  b = await ledger.utxoInFlightBlock('btc', async () => false)
  check('I4c never seen, past its window: forgotten (it is not coming)', b === null && ledger.pendingUtxo('btc').length === 0)
  ledger.recordPending({ ...recA, ts: Date.now() - ledger.FAILED_KEEP_MS - 1, failed: true })
  check('I4d a failed record is kept at most a day', ledger.pendingUtxo('btc').length === 0)

  const built = { txid: '3'.repeat(64), hex: '00', toAddress: 'bc1qpayee' }
  const client = (fn) => ({ broadcast: fn })
  clearUtxo()
  let r = await utxo.broadcastUtxo(client(async () => { throw new Error('mempool.space: sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}') }), CHAINS.btc, built).catch((e) => e)
  check('I5 "already in block chain" is the network saying it has it: success', r === built.txid)
  clearUtxo()
  r = await utxo.broadcastUtxo(client(async () => { throw new Error('mempool.space: sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}') }), CHAINS.btc, built).catch((e) => e)
  check('I5b a node refusal drops the record (no 30-minute hold) and says nothing was sent', r instanceof utxo.UtxoBroadcastError && r.definite === true && /Nothing was sent/.test(r.message) && ledger.pendingUtxo('btc').length === 0)
  r = await utxo.broadcastUtxo(client(async () => { throw new Error('mempool.space broadcast failed (HTTP 502)') }), CHAINS.btc, built).catch((e) => e)
  check('I5c anything unclear keeps the record, marked failed', r instanceof utxo.UtxoBroadcastError && r.definite === false && ledger.pendingUtxo('btc')[0]?.failed === true)
  clearUtxo()
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: '4'.repeat(64), to: 'x', ts: Date.now() })
  await utxo.broadcastUtxo(client(async () => '5'.repeat(64)), CHAINS.btc, { txid: '5'.repeat(64), hex: '00', toAddress: 'bc1qpayee' }, { replaces: '4'.repeat(64) })
  check('I5d a Speed up that went out supersedes the record of the transaction it replaces', ledger.pendingUtxo('btc').map((p) => p.txid).join() === '5'.repeat(64))
  {
    const { sentToAddresses } = await import('../src/lib/sentlog.ts')
    const to = (a) => ({ txid: '6'.repeat(64), hex: '00', toAddress: a })
    await utxo.broadcastUtxo(client(async () => { throw new Error('mempool.space: sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}') }), CHAINS.btc, to('bc1qrefusedonly')).catch(() => null)
    await utxo.broadcastUtxo(client(async () => { throw new Error('mempool.space broadcast failed (HTTP 502)') }), CHAINS.btc, to('bc1qmaybepaid')).catch(() => null)
    const log = sentToAddresses('btc')
    check('I5e the send log trusts an address paid or maybe paid, never one the node refused (bug audit 2026-10-27, BL19)', !log.includes('bc1qrefusedonly') && log.includes('bc1qmaybepaid') && log.includes('bc1qpayee'), log.join())
    clearUtxo()
  }
  clearUtxo()
  const o = utxo.utxoBroadcastOutcome
  check('I6 classification: no answer/timeout → unclear; already known → known; node refusals and 429 → refused; anything else → unclear',
    o(new TypeError('Load failed')) === 'ambiguous' && o(new Error('Broadcast failed: could not reach any provider (x)')) === 'ambiguous' &&
      o(new Error('The operation timed out')) === 'ambiguous' && o(new Error('txn-already-in-mempool')) === 'known' &&
      o(new Error('blockcypher: Error validating transaction: Transaction with hash x already exists.')) === 'known' &&
      o(new Error('blockcypher: Error validating transaction: bad signature')) === 'rejected' && o(new Error('bitcore: TX decode failed')) === 'rejected' &&
      o(new Error('bitcore: Rate Limited')) === 'rejected' && o(new Error('something odd')) === 'ambiguous')

  // --- EVM: each RPC asked, every answer kept ---
  const { deriveEvmKey, prepareEvmSend, broadcastEvmSend, EVM_CHAINS } = evm
  // Base Sepolia's config has one RPC; the same chain with two shows the
  // per-RPC rule (the client cache is keyed by chain id, so reads still go
  // to the mock; the broadcast asks prepared.chain.rpcs)
  const CH = { ...EVM_CHAINS['base-sepolia'], rpcs: ['https://rpc-one.invalid', 'https://rpc-two.invalid'] }
  const key = deriveEvmKey(MN)
  const clearEvm = () => { for (const p of ledger.pendingEvm(CH.chainId)) ledger.dropPending(p) }
  const answers = {}
  const sendAsked = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method !== 'eth_sendRawTransaction') return mockRpc(url, init)
    const a = answers[String(url)] ?? 'ok'
    sendAsked.push(String(url))
    const j = (obj, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...obj }), { status, headers: { 'content-type': 'application/json' } })
    if (a === 'neterr') throw new TypeError('fetch failed')
    if (a === '504') return new Response('<html>Gateway Timeout</html>', { status: 504 })
    if (a === '429json') return j({ error: { code: -32005, message: 'rate limit exceeded' } }, 429)
    if (a === 'refused') return j({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } })
    if (a === 'known') return j({ error: { code: -32010, message: 'AlreadyKnown' } })
    return j({ result: '0x' + '00'.repeat(32) })
  }
  const [R1, R2] = CH.rpcs
  const prep = (extra = {}) => prepareEvmSend({ chain: CH, key, to: '0x000000000000000000000000000000000000dEaD', amount: 1000n, asset: 'gas', ...extra })
  net.evm = { byHash: {}, nonce: '0x7' }
  clearEvm(); answers[R1] = '504'; answers[R2] = '429json'; sendAsked.length = 0
  const A = await prep()
  let eb = await rejects(() => broadcastEvmSend(key, A))
  check('I7 EVM: RPC 1 answers 504 (it may have taken it), RPC 2 a JSON 429 → the record is KEPT, marked failed (the last RPC used to decide, and erased it)',
    eb instanceof evm.EvmBroadcastError && eb.definite === false && ledger.pendingEvm(CH.chainId)[0]?.failed === true && sendAsked.length === 2)
  clearEvm(); answers[R1] = 'refused'; answers[R2] = 'refused'
  eb = await rejects(() => broadcastEvmSend(key, A))
  check('I7b refused by every RPC asked → the record goes, in plain words: nothing was sent', eb instanceof evm.EvmBroadcastError && eb.definite === true && /Nothing was sent/.test(eb.message) && ledger.pendingEvm(CH.chainId).length === 0)
  clearEvm(); answers[R1] = 'neterr'; answers[R2] = 'refused'
  eb = await rejects(() => broadcastEvmSend(key, A))
  check('I7c one RPC unclear, the other refusing → kept (not every node refused)', eb?.definite === false && ledger.pendingEvm(CH.chainId).length === 1)
  clearEvm(); answers[R1] = '429json'; answers[R2] = '429json'
  eb = await rejects(() => broadcastEvmSend(key, A))
  check('I7f every RPC answering only a JSON rate-limit error is not a refusal: kept, marked failed', eb?.definite === false && ledger.pendingEvm(CH.chainId)[0]?.failed === true)
  {
    const { sentToAddresses } = await import('../src/lib/sentlog.ts')
    clearEvm(); answers[R1] = 'refused'; answers[R2] = 'refused'
    const RX = await prepareEvmSend({ chain: CH, key, to: '0x00000000000000000000000000000000000beef1', amount: 1000n, asset: 'gas' })
    await rejects(() => broadcastEvmSend(key, RX))
    const log = sentToAddresses(CH.id).map((a) => a.toLowerCase())
    check('I7g a send every RPC refused leaves its recipient untrusted; one that may have gone out (I7) is trusted (BL19)', !log.includes('0x00000000000000000000000000000000000beef1') && log.includes('0x000000000000000000000000000000000000dead'), log.join())
    clearEvm()
  }
  clearEvm(); answers[R1] = 'known'; sendAsked.length = 0
  const hk = await broadcastEvmSend(key, A).catch((e) => e)
  check('I7d "AlreadyKnown" (Nethermind) means the node holds it: success', typeof hk === 'string' && hk.startsWith('0x') && sendAsked.length === 1)
  clearEvm(); answers[R1] = 'ok'; sendAsked.length = 0
  await broadcastEvmSend(key, A)
  check('I7e accepted by RPC 1: RPC 2 is not asked', sendAsked.length === 1 && sendAsked[0] === R1)
  clearEvm(); answers[R1] = 'neterr'; answers[R2] = 'neterr'
  const A2 = await prep()
  await rejects(() => broadcastEvmSend(key, A2))
  const h2 = ledger.pendingEvm(CH.chainId)[0].hash
  net.evm = { byHash: { [h2]: 'mined' }, nonce: '0x8', reverted: [h2] }
  const eR = await rejects(() => prep({ reuseNonce: 7 }))
  check('I8 a same-nonce retry whose first attempt REVERTED is told it failed on chain (nonce used, nothing paid), not "went through"', eR instanceof evm.EvmNonceSettled && /failed there/.test(eR.message) && ledger.pendingEvm(CH.chainId).length === 0, eR?.message?.slice(0, 70))
  clearEvm(); net.evm = { byHash: {}, nonce: '0x7' }
  const A3 = await prep(); await rejects(() => broadcastEvmSend(key, A3))
  const h3 = ledger.pendingEvm(CH.chainId)[0].hash
  net.evm = { byHash: { [h3]: 'mined' }, nonce: '0x8', reverted: [h3] }
  const eN = await rejects(() => prep())
  check('I8b a new send after a failed attempt that reverted is allowed (nothing was paid)', eN === null && ledger.pendingEvm(CH.chainId).length === 0, eN?.message)
  clearEvm()
  globalThis.fetch = mockRpc
  net.evm = {}

  // --- Solana ---
  const methods = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    methods.push(body.method)
    if (body.method === 'getEpochInfo') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { blockHeight: 440103210, absoluteSlot: 462077494 } }), { status: 200 })
    if (body.method === 'getBlockHeight') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 462077487 }), { status: 200 })
    return mockRpc(url, init)
  }
  const hgt = await sol.solBlockHeight(sol.SOL_CHAINS.sol)
  check('I9 Solana block height comes from getEpochInfo (publicnode answers getBlockHeight with the slot)', hgt === 440103210 && methods.includes('getEpochInfo') && !methods.includes('getBlockHeight'))
  globalThis.fetch = mockRpc
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  ledger.recordPending({ kind: 'sol', chainId: 'sol-devnet', signature: 'sigSlot', ts: Date.now() - 100_000, lastValidBlockHeight: 440096936 })
  let sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 462077487)
  check('I9b a "height" millions above the last valid height (a slot) is no proof of expiry: the attempt still holds', sb?.reason === 'pending')
  sb = await ledger.solInFlightBlock('sol-devnet', async () => false, async () => 440096937)
  check('I9c a real height just past it: expired and dropped', sb === null && ledger.pendingSol('sol-devnet').length === 0)
  ledger.recordPending({ kind: 'sol', chainId: 'sol-devnet', signature: 'sigF', ts: Date.now() - 100_000, lastValidBlockHeight: 1000, failed: true })
  sb = await ledger.solInFlightBlock('sol-devnet', async () => true, async () => 2000)
  check('I9d a failed attempt whose window closed but which DID land is reported, not dropped unasked', sb?.reason === 'landed')
  ledger.dismissLanded(sb.entry)
  const devnet = sol.SOL_CHAINS['sol-devnet']
  const skey = sol.deriveSolKey(MN, 0, true)
  const mk = () => solLib.createTx(skey.address, [solLib.sys.transferSol({ source: skey.address, destination: '11111111111111111111111111111112', amount: 1n })], '11111111111111111111111111111111')
  const ssend = () => sol.broadcastSolSend(skey, { chain: devnet, asset: 'sol', to: '11111111111111111111111111111112', lastValidBlockHeight: 4242, amount: 1n, feeLamports: 5000n, rentLamports: 0n, unsigned: mk(), blockhash: '11111111111111111111111111111111' })
  net.sol = { send: 'rent' }
  let er = await rejects(ssend)
  check('I10 Solana: a preflight refusal is final — plain words, no resend offered, record gone (no 90 s lock)',
    er !== null && !(er instanceof sol.SolBroadcastError) && /minimum balance/.test(er.message) && ledger.pendingSol('sol-devnet').length === 0, er?.message?.slice(0, 80))
  {
    const { sentToAddresses } = await import('../src/lib/sentlog.ts')
    const REFUSED_TO = 'So11111111111111111111111111111111111111112'
    await rejects(() => sol.broadcastSolSend(skey, { chain: devnet, asset: 'sol', to: REFUSED_TO, lastValidBlockHeight: 4242, amount: 1n, feeLamports: 5000n, rentLamports: 0n, unsigned: mk(), blockhash: '11111111111111111111111111111111' }))
    check('I10a ...and its recipient is not trusted in the send log (bug audit 2026-10-27, BL19)', !sentToAddresses('sol-devnet').includes(REFUSED_TO))
  }
  net.sol = { send: 'expired', height: 5000 }
  er = await rejects(ssend)
  check('I10b an expired blockhash the chain never saw, the chain past its last valid height: "did not go through", record gone', er instanceof sol.SolExpiredError && ledger.pendingSol('sol-devnet').length === 0)
  net.sol = { send: 'expired', height: 4000 }
  er = await rejects(ssend)
  check('I10e "blockhash not found" while the chain says the window is still open (a lagging node): not called expired — kept, marked failed, the same bytes can be re-sent (BM17)',
    er instanceof sol.SolBroadcastError && !(er instanceof sol.SolExpiredError) && ledger.pendingSol('sol-devnet')[0]?.failed === true, er?.message?.slice(0, 80))
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  net.sol = { send: 'expired', status: 'seen' }
  const sok = await ssend().catch((e) => e)
  check('I10c an expired blockhash whose transaction DID land (an earlier try): success, not "did not go through"', typeof sok === 'string')
  // BL25: landed, but failed there
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  net.sol = { send: 'expired', status: 'seen-failed', height: 5000 }
  const lf = await rejects(ssend)
  check('I10f an attempt that landed but FAILED on chain is not reported as a success: nothing was sent, record gone (bug audit 2026-10-27, BL25)', lf?.message === sol.SOL_LANDED_FAILED && ledger.pendingSol('sol-devnet').length === 0, lf?.message?.slice(0, 60))
  net.sol = { status: 'seen-failed' }
  check('I10g solTxStatus tells ok, failed and unseen apart', (await sol.solTxStatus(devnet, 'x')) === 'failed' && ((net.sol = { status: 'seen' }), await sol.solTxStatus(devnet, 'x')) === 'ok' && ((net.sol = {}), await sol.solTxStatus(devnet, 'x')) === 'unseen')
  ledger.recordPending({ kind: 'sol', chainId: 'sol-devnet', signature: 'sigFailedLanded', to: '11111111111111111111111111111112', ts: Date.now(), failed: true, lastValidBlockHeight: 10 ** 9 })
  net.sol = { status: 'seen-failed' }
  const nf = await rejects(() => sol.assertNoSolInFlight(devnet))
  check('I10h a lost-answer attempt that landed but failed: the next send hears it failed (nothing paid), not "it went through", and may go ahead',
    nf !== null && !(nf instanceof ledger.EarlierSendLanded) && /failed there, so nothing was paid/.test(nf.message) && ledger.pendingSol('sol-devnet').length === 0, nf?.message?.slice(0, 70))
  net.sol = {}
  check('I10i ...and the guard is clear for the next try', (await rejects(() => sol.assertNoSolInFlight(devnet))) === null)
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  net.sol = { send: 'neterr' }
  er = await rejects(ssend)
  check('I10d no answer: the record stays, marked failed and naming the recipient, and the error carries the same bytes',
    er instanceof sol.SolBroadcastError && typeof er.signed === 'string' && ledger.pendingSol('sol-devnet')[0]?.failed === true && ledger.pendingSol('sol-devnet')[0]?.to === '11111111111111111111111111111112')
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  net.sol = {}
  skey.zero()

  // --- TRON ---
  const CHT = tron.TRON_CHAINS['tron-nile']
  const clearT = () => { for (const p of ledger.pendingTron(CHT.id)) ledger.dropPending(p) }
  const node = { bcast: 'neterr', seen: false, bodies: [] }
  const jr = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/broadcasttransaction')) {
      node.bodies.push(init.body)
      if (node.bcast === 'neterr') throw new TypeError('fetch failed')
      if (node.bcast === 'expired') return jr({ result: false, code: 'TRANSACTION_EXPIRATION_ERROR', message: Buffer.from('Transaction expired').toString('hex') })
      return jr({ result: true })
    }
    if (path.endsWith('/gettransactionbyid')) return jr(node.seen ? { txID: JSON.parse(init.body).value } : {})
    return jr({})
  }
  const tkey = tron.deriveTronKey(MN, true)
  const nodeNow = Date.now()
  const tprep = { chain: CHT, asset: 'trx', to: 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M', amount: 1n, estimatedFeeSun: 0n, feeLimitSun: 0n, createsAccount: false,
    rawDataHex: '0a02aabb', rawData: {}, txID: 'c'.repeat(64), expiration: nodeNow + 60_000, timestamp: nodeNow }
  clearT()
  const realNow = Date.now
  Date.now = () => realNow() + 120_000 // this device's clock runs two minutes fast
  const te = await rejects(() => tron.broadcastTronSend(tkey, tprep))
  const trec = ledger.pendingTron(CHT.id)
  const tblk = await ledger.tronInFlightBlock(CHT.id, async () => false)
  Date.now = realNow
  check('I11 TRON with the device clock two minutes fast: a lost answer leaves a record that blocks (it used to be dropped as it was written)',
    te instanceof tron.TronBroadcastError && trec.length === 1 && trec[0].failed === true && tblk?.reason === 'pending')
  node.bcast = 'ok'
  const again = await tron.rebroadcastTron(CHT, te)
  check('I11b "Send again" posts the SAME signed body', again === tprep.txID && node.bodies.length === 2 && node.bodies[0] === node.bodies[1])
  node.bcast = 'expired'; node.seen = true
  check('I11c an expiry answer for a transaction the chain DID see: success', (await tron.rebroadcastTron(CHT, te)) === tprep.txID)
  node.seen = false
  const tx2 = await rejects(() => tron.rebroadcastTron(CHT, te))
  check('I11d an expiry answer for one the chain never saw: expired (safe to start over), record gone', tx2 instanceof tron.TronExpiredError && ledger.pendingTron(CHT.id).length === 0)
  const envErr = await rejects(async () => tron.assertTronEnvelope({ expiration: BigInt(Date.now() + 3_600_000), timestamp: 0n, feeLimit: 0n, contracts: [] }, 0n))
  check("I11e an expiry an hour off this device's clock names the clock, not just the node", /device's clock/.test(envErr?.message ?? ''), envErr?.message?.slice(0, 60))
  clearT()
  tkey.zero()
  globalThis.fetch = mockRpc

  // --- another window of the wallet ---
  const storeB = await import('../src/lib/securestore.ts?window=b')
  await storeB.unlockSecureStore(MN)
  clearUtxo('ltc')
  await tick()
  storeB.secureSet('pending', [{ kind: 'utxo', chainId: 'ltc', txid: '9'.repeat(64), to: 'ltc1qx', ts: Date.now(), failed: true }])
  await tick()
  const bx = await ledger.utxoInFlightBlock('ltc', async () => false)
  check("I12 another window's record is seen: every check re-reads the ledger from storage first", bx?.reason === 'pending' && bx.entry.txid === '9'.repeat(64))
  ledger.recordPending({ kind: 'utxo', chainId: 'ltc', txid: '8'.repeat(64), to: 'ltc1qy', ts: Date.now() })
  await tick()
  await storeB.refreshSecure('pending')
  const inB = storeB.secureGet('pending')
  check("I12b ...and a record written afterwards keeps the other window's entry instead of overwriting it", Array.isArray(inB) && inB.length === 2)
  storeB.lockSecureStore()
  clearUtxo('ltc')
}

console.log('--- J. before a Speed up: attempts the network does not show yet (bug audit 2026-10-27, BH5) ---')
{
  const clearUtxo = (id) => { for (const p of ledger.pendingUtxo(id)) ledger.dropPending(p) }
  clearUtxo('btc')
  const A = 'a'.repeat(64), C = 'c'.repeat(64), OLD = 'e'.repeat(64)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: A, to: 'bc1qrecipientA', ts: Date.now() })
  const asked = []
  const j1 = await ledger.utxoUnseenBlock('btc', async (t) => (asked.push(t), false), A)
  check('J1 the transaction being replaced does not block its own Speed up (it is not even asked about)', j1 === null && asked.length === 0)
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: C, to: 'bc1qrecipientC', ts: Date.now() })
  const j2 = await ledger.utxoUnseenBlock('btc', async (t) => t === A, A)
  check('J2 a payment sent since, not on the network yet, blocks it: its coins are invisible to the scan', j2?.reason === 'pending' && j2.entry.txid === C)
  const j3 = await ledger.utxoUnseenBlock('btc', async () => { throw new Error('timeout') }, A)
  check('J3 a failed lookup blocks too (unreachable)', j3?.reason === 'unreachable' && j3.entry.txid === C)
  ledger.markPendingFailed(ledger.pendingUtxo('btc').find((p) => p.txid === C))
  const j4 = await ledger.utxoUnseenBlock('btc', async () => true, A)
  check('J4 once the network shows it, the scan sees its coins: no block, and its record is kept (the next send still reports a landed one)', j4 === null && ledger.pendingUtxo('btc').some((p) => p.txid === C && p.failed === true))
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: OLD, to: 'bc1qold', ts: Date.now() - ledger.UTXO_TTL_MS - 1 })
  const j5 = await ledger.utxoUnseenBlock('btc', async (t) => t !== OLD, A)
  check('J5 an attempt older than the 30-minute window does not block', j5 === null)
  check('J6 another chain\'s attempt does not block', (await ledger.utxoUnseenBlock('ltc', async () => false, A)) === null)
  clearUtxo('btc')

  // BL47: a UTXO attempt holds back only the account that sent it
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: C, to: 'bc1qfromseed', ts: Date.now(), account: 'seed' })
  const fromLedger = await ledger.utxoInFlightBlock('btc', async () => false, 'ledger:btc:abcd')
  const fromSeed = await ledger.utxoInFlightBlock('btc', async () => false, 'seed')
  check('J7 a seed send not on the network yet holds back the seed account\'s next send, not a Ledger account\'s on the same chain (their coins are separate; BL47)',
    fromLedger === null && fromSeed?.reason === 'pending')
  check('J7b ...and a Speed up from the Ledger account is not held back by it either', (await ledger.utxoUnseenBlock('btc', async () => false, A, 'ledger:btc:abcd')) === null)
  clearUtxo('btc')
  ledger.recordPending({ kind: 'utxo', chainId: 'btc', txid: C, to: 'bc1qolder', ts: Date.now() })
  check('J7c an older record with no account still holds back every account (it could be any)', (await ledger.utxoInFlightBlock('btc', async () => false, 'ledger:btc:abcd'))?.reason === 'pending')
  clearUtxo('btc')
  const { readFileSync } = await import('node:fs')
  const send = readFileSync(new URL('../src/components/SendModal.tsx', import.meta.url), 'utf8')
  check('J7d the send form records and checks by account', /utxoInFlightBlock\(chain\.id, \(txid\) => client\.txSeen\(txid\), ledgerAccountKey\(account\)\)/.test(send) && /broadcastUtxo\(client, chain, built, \{ account: ledgerAccountKey\(account\) \}\)/.test(send))
}

console.log('--- K. the Solana stake view (bug audit 2026-10-27, BL26) ---')
{
  const solstake = await import('../src/lib/solstake.ts')
  const devnet = sol.SOL_CHAINS['sol-devnet']
  for (const p of ledger.pendingSol('sol-devnet')) ledger.dropPending(p)
  const skey = sol.deriveSolKey(MN, 0, true)
  const stakeAcc = (lamports, activationEpoch, deactivationEpoch) => ({
    owner: 'Stake11111111111111111111111111111111111111', lamports, executable: false, rentEpoch: 0,
    data: { parsed: { info: { stake: { delegation: { voter: 'Vote111111111111111111111111111111111111111', activationEpoch: String(activationEpoch), deactivationEpoch: String(deactivationEpoch) } } } } },
  })
  net.sol = { epoch: 500, stakeAccounts: [stakeAcc(3_000_000, 500, 500)] }
  const [same] = await solstake.fetchStakeAccounts(devnet, skey.address)
  check('K1 a stake deactivated in the epoch it was activated never took effect: withdrawable at once, not "winding down"', same?.state === 'withdrawable', same?.state)
  net.sol = { epoch: 500, stakeAccounts: [stakeAcc(3_000_000, 400, 500)] }
  const [winding] = await solstake.fetchStakeAccounts(devnet, skey.address)
  check('K1b ...while one active before and deactivated now is still winding down', winding?.state === 'deactivating')
  // the dashboard saw 2 000 000 lamports; rewards have since made it 2 500 000
  net.sol = { epoch: 501, stakeAccounts: [stakeAcc(2_500_000, 400, 500)] }
  const stale = { ...winding, lamports: 2_000_000n, state: 'withdrawable' }
  const wd = await solstake.prepareWithdraw(devnet, skey, stale).catch((e) => e)
  check('K2 Withdraw takes the account as it is now, not the stale view (BL26)', wd?.amount === 2_500_000n, wd?.message ?? String(wd?.amount))
  net.sol = { epoch: 500, stakeAccounts: [stakeAcc(2_500_000, 400, 500)] }
  const early = await rejects(() => solstake.prepareWithdraw(devnet, skey, { ...winding, state: 'withdrawable' }))
  check('K2b ...and refuses when the fresh read says it is still cooling down', /cooling down/.test(early?.message ?? ''), early?.message?.slice(0, 60))
  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  check('K3 a stake that is activating or winding down is re-read on quick polls (its state changes at the epoch, no balance moving)', /prev\.txs\.length === 0 \|\| stakeMoving\)/.test(app))
  net.sol = {}
  skey.zero()
}

console.log(failures === 0 ? '\nAll pending-ledger checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
