// check-amounts.mjs — OFFLINE (mock RPCs, no network).
//
// Fees, balances and amounts that the 2026-10-27 bug audit found wrong.
// This suite proves:
//   A. EVM: every native send is estimated — Arbitrum's plain transfer needs
//      ~21.5k gas, and the old hardcoded 21 000 failed every ETH send there;
//      an ordinary account on an L1 chain keeps exactly 21 000; Base's L1
//      data fee is reserved (MAX leaves room for it, the fee shown includes
//      it, a token send's ETH check counts it); native sends to 0x0 refused;
//      fees from the RPC are held to 1,000 gwei a gas (100 priority) (A11);
//   B. TRON: USDT balance read from the token contract (a never-activated
//      holder's USDT used to read 0); USDT fees at the chain's own energy
//      price (100 sun, not 420) minus the account's spare energy, plus
//      bandwidth when short; the fee cap sized from the estimate (and a
//      refusal when costs are abnormal); a test run the contract refuses is
//      refused; TRX fees for new and existing recipients;
//      Also (B9-B11): the zero address and the USDT contract are refused,
//      other contracts flagged; zero-value TRC-20 rows aren't history; a
//      rate-limited history half keeps its rows; a 429 reads plainly;
//   C. typed amounts: a decimal comma works on every form ("0,5"), a number
//      that reads as a thousands grouping on this device ("1,234" in the US)
//      or carries two marks is refused, and every amount the wallet fills
//      in (a scanned request, Max) reads back exactly in every locale;
//   E. UTXO fee rates from any service are clamped to 1-1,000 sat/vB.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils')
const { sha256 } = await import('@noble/hashes/sha2')
const { unlockSecureStore } = await import('../src/lib/securestore.ts')
const evm = await import('../src/lib/evm.ts')
const tron = await import('../src/lib/tron.ts')

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
await unlockSecureStore(MN)
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
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

// ===========================================================================
// A. EVM — a JSON-RPC mock; `net` decides the answers
const ORACLE = '0x420000000000000000000000000000000000000f'
const net = { balance: 10n ** 16n, token: 0n, estimate: 21000n, estimateErr: false, l1: 750_648_592n, l1Err: false, code: '0x' }
const BLOCK = { number: '0x10', hash: '0x' + '22'.repeat(32), parentHash: '0x' + '33'.repeat(32), baseFeePerGas: '0x3b9aca00',
  timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', difficulty: '0x0', transactions: [], logsBloom: '0x' + '00'.repeat(256),
  miner: '0x0000000000000000000000000000000000000000', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: '0x' + '44'.repeat(32),
  size: '0x1', stateRoot: '0x' + '55'.repeat(32), receiptsRoot: '0x' + '66'.repeat(32), transactionsRoot: '0x' + '77'.repeat(32), uncles: [] }
const hex32 = (v) => '0x' + v.toString(16).padStart(64, '0')
const evmFetch = async (_url, init) => {
  const { id, method, params } = JSON.parse(init.body)
  const ok = (result) => json({ jsonrpc: '2.0', id, result })
  const err = (message) => json({ jsonrpc: '2.0', id, error: { code: -32000, message } })
  switch (method) {
    case 'eth_getBalance': return ok('0x' + net.balance.toString(16))
    case 'eth_call':
      if (String(params[0]?.to).toLowerCase() === ORACLE) return net.l1Err ? err('execution reverted') : ok(hex32(net.l1))
      return ok(hex32(net.token))
    case 'eth_getBlockByNumber': return ok(net.baseFee === undefined ? BLOCK : { ...BLOCK, baseFeePerGas: '0x' + net.baseFee.toString(16) })
    case 'eth_maxPriorityFeePerGas': return ok('0x' + (net.priority ?? 10_000_000n).toString(16))
    case 'eth_getTransactionCount': return ok('0x3')
    case 'eth_getCode': return net.codeErr ? err('mock: getCode down') : ok(net.code)
    case 'eth_estimateGas': return net.estimateErr === 'revert' ? err('execution reverted') : net.estimateErr ? err('header not found') : ok('0x' + net.estimate.toString(16))
    case 'eth_chainId': return ok('0x1')
    default: return err(`mock: no ${method}`)
  }
}
globalThis.fetch = evmFetch

console.log('--- A. EVM fees ---')
{
  const key = evm.deriveEvmKey(MN)
  const TO = '0x1111111111111111111111111111111111111111'
  const send = (chain, extra = {}) => evm.prepareEvmSend({ chain, key, to: TO, amount: 10n ** 15n, asset: 'gas', ...extra })
  const { arbitrum, ethereum, base } = evm.EVM_CHAINS

  net.estimate = 21491n
  const a = await send(arbitrum).catch((e) => e)
  check('A1 Arbitrum: a plain ETH transfer is estimated (21 491) and gets headroom, not the hardcoded 21 000 that failed every send', a.request?.gas === (21491n * 12n) / 10n, String(a.request?.gas ?? a.message))
  net.estimate = 21000n
  const e = await send(ethereum).catch((e) => e)
  check('A2 Ethereum: an ordinary recipient keeps exactly 21 000', e.request?.gas === 21000n && e.feeWei === 21000n * e.request.maxFeePerGas)
  net.estimateErr = true
  const ea = await rejects(() => send(arbitrum))
  check("A3 Arbitrum, estimate unavailable: refused in plain words (21 000 can't work there)", /Couldn't work out the network fee/.test(ea?.message ?? ''), ea?.message?.slice(0, 60))
  const ee = await send(ethereum).catch((e) => e)
  check('A3b ...while an L1 chain falls back to 21 000 for an ordinary recipient', ee.request?.gas === 21000n)
  net.estimateErr = 'revert'
  const er = await rejects(() => send(ethereum))
  const ra = await rejects(() => send(arbitrum))
  check('A3c a test run the recipient reverts says the contract refused ETH, on any chain (it read "try again in a moment"; review 2026-10-28)',
    /refused ETH in a test run/.test(er?.message ?? '') && /refused ETH in a test run/.test(ra?.message ?? ''), er?.message?.slice(0, 60))
  net.estimateErr = false

  net.estimate = 21000n
  const m = await send(base, { sendMax: true }).catch((e) => e)
  const l1Reserve = (net.l1 * 3n + 1n) / 2n
  check("A4 Base MAX leaves the L1 data fee (oracle's upper bound, half again as headroom) — it used to leave 0 and be refused",
    m.request !== undefined && m.amount === net.balance - 21000n * m.request.maxFeePerGas - l1Reserve && m.feeWei === 21000n * m.request.maxFeePerGas + l1Reserve,
    `amount ${m.amount}, fee ${m.feeWei}`)
  const plain = await send(base).catch((e) => e)
  check('A4b ...and an ordinary Base send shows the L1 fee in its network fee', plain.request !== undefined && plain.feeWei === 21000n * plain.request.maxFeePerGas + l1Reserve)
  const eth = await send(ethereum, { sendMax: true }).catch((e) => e)
  check('A4c a non-OP chain adds no L1 fee', eth.request !== undefined && eth.feeWei === 21000n * eth.request.maxFeePerGas && eth.amount === net.balance - eth.feeWei)
  net.l1Err = true
  const mo = await rejects(() => send(base, { sendMax: true }))
  check("A5 Base oracle unreadable: MAX refuses (it can't leave the right amount)", /data fee/.test(mo?.message ?? ''), mo?.message?.slice(0, 60))
  const po = await send(base).catch((e) => e)
  check('A5b ...an ordinary send still prepares', po.request !== undefined && po.feeWei === 21000n * po.request.maxFeePerGas)
  net.l1Err = false
  const z = await rejects(() => evm.prepareEvmSend({ chain: base, key, to: '0x0000000000000000000000000000000000000000', amount: 1n, asset: 'gas' }))
  check('A6 native ETH to the zero address is refused (tokens already were)', /zero address/.test(z?.message ?? ''))
  net.balance = 0n; net.token = 5_000_000n; net.estimate = 60000n
  const t = await rejects(() => evm.prepareEvmSend({ chain: base, key, to: TO, amount: 1_000_000n, asset: 'token' }))
  check("A7 Base token send with no ETH: the fee it says is needed includes the L1 data fee", /Not enough ETH/.test(t?.message ?? ''), t?.message?.slice(0, 60))
  net.balance = 10n ** 16n; net.token = 0n

  // BL20: the recipient's code
  net.codeErr = true
  const ce = await rejects(() => send(ethereum))
  check("A9 a failed code lookup refuses the send instead of reading as \"no code\" (bug audit 2026-10-27, BL20)", /Couldn't check the recipient/.test(ce?.message ?? ''), ce?.message?.slice(0, 60))
  net.codeErr = false
  net.token = 5_000_000n; net.estimate = 60000n
  const tokenSend = (chain) => evm.prepareEvmSend({ chain, key, to: TO, amount: 1_000_000n, asset: 'token' }).catch((e) => e)
  net.code = '0xef0100' + 'ab'.repeat(20)
  const d7702 = await tokenSend(ethereum)
  check('A9b an EIP-7702 account (a delegation, with a key behind it) is a wallet, not a contract', d7702?.recipientIsContract === false, d7702?.message)
  net.code = '0x6080604052'
  const dc = await tokenSend(ethereum)
  check('A9c ...while real contract code still is', dc?.recipientIsContract === true, dc?.message)
  net.code = '0x'
  // BL21: Arbitrum counts L1 data as gas
  net.estimate = 500_000n
  const arb = await tokenSend(arbitrum)
  check('A10 an Arbitrum token send whose gas includes expensive L1 data (500k) prepares (bug audit BL21)', arb?.request?.gas === 600_000n, arb?.message ?? String(arb?.request?.gas))
  const l1 = await tokenSend(ethereum)
  check('A10b ...while 500k on an L1 chain is still refused as unusual', /unusually large amount of gas/.test(l1?.message ?? ''), l1?.message?.slice(0, 60))
  net.estimate = 21000n; net.token = 0n
  // Both fee numbers come from the RPC: a hostile one could otherwise hand
  // most of a MAX send to the block producer (review 2026-10-29: untested).
  const GWEI = 10n ** 9n
  net.balance = 10n ** 18n; net.baseFee = 50_000n * GWEI; net.priority = 5_000n * GWEI
  const hot = await send(ethereum).catch((e) => e)
  check('A11 an RPC asking 50,000 gwei a gas (5,000 priority) gets the ceilings: 1,000 gwei max, 100 gwei priority',
    hot?.request?.maxFeePerGas === 1_000n * GWEI && hot?.request?.maxPriorityFeePerGas === 100n * GWEI,
    hot?.message ?? `${hot?.request?.maxFeePerGas} / ${hot?.request?.maxPriorityFeePerGas}`)
  check('A11b ...and the fee shown is what those ceilings allow (21,000 gas × 1,000 gwei = 0.021 ETH)', hot?.feeWei === 21_000n * 1_000n * GWEI, String(hot?.feeWei))
  net.baseFee = 1n * GWEI; net.priority = GWEI / 100n
  const calm = await send(ethereum).catch((e) => e)
  check('A11c a market fee under the ceilings is used as quoted, with headroom (control)', calm?.request?.maxFeePerGas < 1_000n * GWEI && calm?.request?.maxPriorityFeePerGas === GWEI / 100n, calm?.message ?? String(calm?.request?.maxFeePerGas))
  net.baseFee = undefined; net.priority = undefined; net.balance = 10n ** 16n
  key.zero()
}

// BL22: an RPC that hung is passed over while another of the chain's answers
{
  evm.evmTuning.rpcTimeoutMs = 150
  evm.evmTuning.rpcDownMs = 5_000
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = (url, init) => {
    asked.push(String(url))
    if (String(url).includes('hang.invalid')) {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }
    const body = JSON.parse(init.body)
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  const chain = { ...evm.EVM_CHAINS.base, id: 'hang-test', rpcs: ['https://hang.invalid', 'https://ok.invalid'] }
  const c = evm.getEvmClient(chain)
  const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  let t = Date.now()
  const b1 = await c.getBalance({ address: ADDR }).catch((e) => e)
  const d1 = Date.now() - t
  const before = asked.length
  t = Date.now()
  const b2 = await c.getBalance({ address: ADDR }).catch((e) => e)
  const d2 = Date.now() - t
  check('A8 the first call through an RPC that hangs waits out its timeout, then the next RPC answers', b1 === 16n && d1 >= 140, `${b1} in ${d1} ms`)
  check('A8b later calls pass the hung RPC over and go straight to the next (bug audit 2026-10-27, BL22)', b2 === 16n && d2 < 100 && !asked.slice(before).some((u) => u.includes('hang')), `${b2} in ${d2} ms`)
  const solo = evm.getEvmClient({ ...evm.EVM_CHAINS.base, id: 'hang-solo', rpcs: ['https://hang.invalid'] })
  await solo.getBalance({ address: ADDR }).catch(() => null)
  const n = asked.length
  await solo.getBalance({ address: ADDR }).catch(() => null)
  check('A8c a chain whose only RPC hung still asks it (nothing else to try)', asked.length > n && asked.at(-1).includes('hang'))
  globalThis.fetch = realFetch
  evm.evmTuning.rpcTimeoutMs = 15_000
  evm.evmTuning.rpcDownMs = 60_000
}

// ===========================================================================
// B. TRON — a mock TronGrid that builds honest raw transactions
const varint = (n) => {
  const out = []
  let v = BigInt(n)
  for (;;) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) out.push(b | 0x80)
    else { out.push(b); break }
  }
  return out
}
const len = (num, bytes) => [...varint((num << 3) | 2), ...varint(bytes.length), ...Array.from(bytes)]
const vint = (num, n) => [...varint(num << 3), ...varint(n)]
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)))
const str = (s) => Array.from(new TextEncoder().encode(s))
const addrB = (a) => hexToBytes(tron.tronAddressToHex(a))
const anyWrap = (typeNum, url, inner) => cat(vint(1, typeNum), len(2, cat(len(1, str(url)), len(2, inner))))
let counter = 0
const top = (contract, extra = []) => {
  const now = Date.now() + counter++
  return cat(len(1, hexToBytes('aabb')), len(4, hexToBytes('0011223344556677')), vint(8, now + 60_000), len(11, contract), vint(14, now), extra)
}
const tn = {
  accounts: {}, // address -> { balance } | undefined (never activated)
  usdt: {}, // address -> units
  energyUsed: 64285,
  ret: 'SUCCESS',
  energyFee: 100,
  resources: {},
  bodies: [],
}
const tronFetch = async (url, init) => {
  const path = new URL(String(url)).pathname
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  tn.bodies.push({ path, body, at: Date.now() })
  if (path === '/wallet/getaccount') {
    const a = tn.accounts[body.address]
    return json(a ? { address: body.address, ...a } : {})
  }
  if (path === '/wallet/getchainparameters') {
    return json({ chainParameter: [
      { key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: tn.energyFee },
      { key: 'getCreateAccountFee', value: 100000 }, { key: 'getCreateNewAccountFeeInSystemContract', value: 1000000 },
    ] })
  }
  if (path === '/wallet/getaccountresource') return json(tn.resources[body.address] ?? {})
  if (path === '/wallet/triggerconstantcontract') {
    if (body.function_selector === 'balanceOf(address)') {
      const owner = body.owner_address
      return json({ result: { result: true }, constant_result: [BigInt(tn.usdt[owner] ?? 0).toString(16).padStart(64, '0')] })
    }
    return json({ result: { result: true }, energy_used: tn.energyUsed, transaction: { ret: [{ ret: tn.ret }] } })
  }
  if (path === '/wallet/createtransaction') {
    const raw = top(anyWrap(1, 'type.googleapis.com/protocol.TransferContract', cat(len(1, addrB(body.owner_address)), len(2, addrB(body.to_address)), vint(3, body.amount))))
    return json({ raw_data: {}, raw_data_hex: bytesToHex(raw), txID: bytesToHex(sha256(raw)), visible: true })
  }
  if (path === '/wallet/triggersmartcontract') {
    const data = hexToBytes('a9059cbb' + body.parameter)
    const raw = top(anyWrap(31, 'type.googleapis.com/protocol.TriggerSmartContract', cat(len(1, addrB(body.owner_address)), len(2, addrB(body.contract_address)), len(4, data))), vint(18, body.fee_limit))
    return json({ result: { result: true }, transaction: { raw_data: {}, raw_data_hex: bytesToHex(raw), txID: bytesToHex(sha256(raw)) } })
  }
  if (path.endsWith('/transactions/trc20')) {
    if (tn.trc20 === 'fail') return new Response('{"Error":"request rate exceeded"}', { status: 429 })
    return json({ data: tn.trc20 ?? [] })
  }
  if (path.endsWith('/transactions')) {
    if (tn.native === 'fail') return new Response('{"Error":"request rate exceeded"}', { status: 429 })
    return json({ data: tn.native ?? [] })
  }
  return json({ Error: `mock: unhandled ${path}` })
}

console.log('--- B. TRON balances and fees ---')
{
  globalThis.fetch = tronFetch
  tron.tronTuning.gapMs = 0
  tron.tronTuning.v1GapMs = 0
  const CH = tron.TRON_CHAINS.tron
  const key = tron.deriveTronKey(MN)
  const ME = key.address
  const TO = 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M'
  const INACTIVE = 'TRmZH7sn1PkHk5zW4fk2AEzywkE4PTbFmh'

  tn.usdt[INACTIVE] = 201_980_000
  const held = await tron.getTronUsdtBalance(CH, INACTIVE)
  check('B1 USDT held by a never-activated address is read from the contract (201.98, not 0)', held === 201_980_000n)

  const usdt = (amount = 1_000_000n) => tron.prepareTronSend(CH, key, 'usdt', TO, amount)
  tn.accounts[ME] = { balance: 20_000_000 }
  tn.accounts[TO] = { balance: 1 }
  tn.usdt[ME] = 50_000_000
  tn.energyUsed = 64285
  tn.bodies.length = 0
  const p1 = await usdt().catch((e) => e)
  const smart = tn.bodies.find((b) => b.path === '/wallet/triggersmartcontract')
  check('B2 USDT to an existing holder: 64 285 energy × 100 sun + 350 bytes of bandwidth = 6.7785 TRX (the old estimate said ~27 and refused a 20-TRX wallet)',
    p1?.estimatedFeeSun === 6_778_500n, String(p1?.estimatedFeeSun ?? p1?.message))
  check('B2b ...and the fee cap is 30 TRX (half again the energy cost, never below 30)', p1?.feeLimitSun === 30_000_000n && smart?.body.fee_limit === 30_000_000)

  tn.energyUsed = 130285
  tn.accounts[ME] = { balance: 10_000_000 }
  const r3 = await rejects(() => usdt())
  check('B3 a fresh recipient (130 285 energy) costs about 13.3785 TRX, and a 10-TRX wallet is told so', /about 13\.3785 TRX/.test(r3?.message ?? ''), r3?.message?.slice(0, 80))

  tn.accounts[ME] = { balance: 1_000_000 }
  tn.resources[ME] = { EnergyLimit: 200_000, EnergyUsed: 0, freeNetLimit: 600, freeNetUsed: 0 }
  const p4 = await usdt().catch((e) => e)
  check("B4 a staker with spare energy and bandwidth pays nothing extra, so 1 TRX is enough (the old code ignored staking and refused)", p4?.estimatedFeeSun === 0n, String(p4?.estimatedFeeSun ?? p4?.message))
  tn.resources[ME] = {}

  tn.accounts[ME] = { balance: 100_000_000 }
  tn.energyFee = 420
  tron.clearTronPriceCache()
  const p5 = await usdt().catch((e) => e)
  check('B5 if governance raised energy back to 420 sun, the cap grows with the estimate (82.0796 TRX), so the send cannot run out of energy',
    p5?.feeLimitSun === 82_079_550n && p5?.estimatedFeeSun === 54_719_700n + 350_000n, `${p5?.feeLimitSun} / ${p5?.estimatedFeeSun ?? p5?.message}`)
  // partly staked at that price: 100 000 energy spare, 30 285 burned. The cap
  // covers ALL the energy (java-tron counts staked energy against it too);
  // sized from the burn (12.7 TRX → the 30 TRX floor = 71 428 energy) it ran out
  tn.resources[ME] = { EnergyLimit: 100_000, EnergyUsed: 0 }
  const p5b = await usdt().catch((e) => e)
  check('B5b ...and a partly staked account\'s cap still covers all 130 285 energy, not just the part it burns (review 2026-10-28)',
    p5b?.feeLimitSun === 82_079_550n && p5b?.estimatedFeeSun === 30_285n * 420n + 350_000n, `${p5b?.feeLimitSun} / ${p5b?.estimatedFeeSun ?? p5b?.message}`)
  tn.resources[ME] = { EnergyLimit: 200_000, EnergyUsed: 0 }
  tn.energyFee = 1200
  tron.clearTronPriceCache()
  const r5c = await rejects(() => usdt())
  check('B5c a staker whose energy at the price would need a cap above 150 TRX is told energy is too expensive, not signed to fail', /unusually expensive/.test(r5c?.message ?? ''), r5c?.message?.slice(0, 70))
  tn.resources[ME] = {}
  tn.energyFee = 2000
  tron.clearTronPriceCache()
  const r6 = await rejects(() => usdt())
  check('B6 abnormally expensive network (a cap above 150 TRX would be needed): refused, not signed with a huge cap', /unusually high/.test(r6?.message ?? ''), r6?.message?.slice(0, 70))
  tn.energyFee = 100
  tron.clearTronPriceCache()

  tn.ret = 'REVERT'
  const r7 = await rejects(() => usdt())
  check('B7 a test run the USDT contract refuses is refused (it would fail on chain and still burn TRX)', /refused this transfer in a test run/.test(r7?.message ?? ''), r7?.message?.slice(0, 70))
  tn.ret = 'SUCCESS'

  const trx = (to) => tron.prepareTronSend(CH, key, 'trx', to, 1_000_000n)
  tn.accounts[ME] = { balance: 50_000_000 }
  const NEWBIE = 'TXtrbmfwZ2LxtoCveEhZT86fTss1w8rwJE'
  const t1 = await trx(NEWBIE).catch((e) => e)
  check('B8 TRX to an address that does not exist yet costs the account-creation fees (1.1 TRX)', t1?.createsAccount === true && t1?.estimatedFeeSun === 1_100_000n, String(t1?.estimatedFeeSun ?? t1?.message))
  tn.resources[ME] = { freeNetLimit: 600, freeNetUsed: 100 }
  const t2 = await trx(TO).catch((e) => e)
  check('B8b TRX to an existing account with spare free bandwidth costs nothing', t2?.estimatedFeeSun === 0n)
  tn.resources[ME] = { freeNetLimit: 600, freeNetUsed: 600 }
  const t3 = await trx(TO).catch((e) => e)
  check('B8c ...and with none spare, 270 bytes at the chain price (0.27 TRX)', t3?.estimatedFeeSun === 270_000n)
  tn.resources[ME] = { freeNetLimit: 600, freeNetUsed: 400, NetLimit: 1000, NetUsed: 800 }
  const t3b = await trx(TO).catch((e) => e)
  check('B8d 200 free + 200 staked bytes spare don\'t cover 270: a transaction draws on one pool, never both (review 2026-10-28)', t3b?.estimatedFeeSun === 270_000n, String(t3b?.estimatedFeeSun ?? t3b?.message))
  tn.resources[ME] = {}

  // BM23: where nothing comes back
  tn.accounts[ME] = { balance: 50_000_000 }
  tn.usdt[ME] = 10_000_000
  const refused = async (to, asset = 'usdt') => (await tron.prepareTronSend(CH, key, asset, to, 1_000_000n).catch((e) => e))?.message ?? ''
  check('B9 USDT to the USDT contract itself is refused before signing (bug audit 2026-10-27, BM23)', /token contract itself/.test(await refused(CH.usdt.contract)))
  check('B9b ...and anything to the zero address', /zero address/.test(await refused('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')) && /zero address/.test(await refused('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'trx')))
  const CONTRACT = tron.hexAddrToBase58('41' + 'ab'.repeat(20))
  tn.accounts[CONTRACT] = { type: 'Contract' }
  const toContract = await tron.prepareTronSend(CH, key, 'usdt', CONTRACT, 1_000_000n).catch((e) => e)
  check('B9c another contract is allowed but flagged for the review (as on EVM)', toContract?.recipientIsContract === true, toContract?.message)
  const toWallet = await tron.prepareTronSend(CH, key, 'usdt', TO, 1_000_000n).catch((e) => e)
  check('B9d a wallet is not flagged', toWallet?.recipientIsContract === false, toWallet?.message)
  delete tn.accounts[CONTRACT]

  // BM24 + BM22: history
  const trc = (id, from, to, value) => ({ transaction_id: id.repeat(32), from, to, value, token_info: { address: CH.usdt.contract }, block_timestamp: 1_760_000_000_000 })
  const nat = (id, from, to, amount) => ({ txID: id.repeat(32), block_timestamp: 1_760_000_100_000, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: tron.tronAddressToHex(from), to_address: tron.tronAddressToHex(to), amount } } }] }, ret: [{ contractRet: 'SUCCESS' }] })
  tn.trc20 = [trc('a1', ME, TO, '5000000'), trc('a2', ME, 'TPoisonxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '0')]
  tn.native = [nat('b1', TO, ME, 2_000_000)]
  const h1 = await tron.fetchTronHistory(CH, ME)
  check('B10 a zero-value TRC-20 transfer (poisoning bait) is not history; real rows are (BM24)', h1.map((t) => t.id.slice(0, 2)).sort().join() === 'a1,b1', h1.map((t) => t.id).join())
  tn.trc20 = 'fail'
  const h2 = await tron.fetchTronHistory(CH, ME, h1)
  check('B11 a rate-limited half keeps its previous rows (BM22): USDT rows survive while TRX is re-read', h2.map((t) => t.id.slice(0, 2)).sort().join() === 'a1,b1', h2.map((t) => t.id).join())
  tn.trc20 = [trc('a1', ME, TO, '5000000')]
  tn.native = 'fail'
  const h2b = await tron.fetchTronHistory(CH, ME, h1)
  check('B11a ...and the other way round: TRX rows survive while USDT is re-read', h2b.map((t) => t.id.slice(0, 2)).sort().join() === 'a1,b1', h2b.map((t) => t.id).join())
  tn.trc20 = 'fail'
  const h3 = await tron.fetchTronHistory(CH, ME, h1).catch((e) => e)
  check('B11b both halves failing is an error (the caller keeps what it had)', h3 instanceof Error)
  check('B11c ...and a 429 reads in plain words, marked as a rate limit', /busy \(too many requests/.test(h3?.message ?? '') && h3?.rateLimited === true, h3?.message)
  delete tn.trc20
  delete tn.native
  // BL29, BL35: a failed USDT send is history; ids are checked
  const usdtCall = (amountUnits, to) => 'a9059cbb' + '0'.repeat(24) + tron.tronAddressToHex(to).slice(2) + amountUnits.toString(16).padStart(64, '0')
  tn.native = [
    { txID: 'c1'.repeat(32), block_timestamp: 1_760_000_200_000, ret: [{ contractRet: 'OUT_OF_ENERGY' }],
      raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: tron.tronAddressToHex(ME), contract_address: tron.tronAddressToHex(CH.usdt.contract), data: usdtCall(7_000_000n, TO) } } }] } },
    { txID: 'c2'.repeat(32), block_timestamp: 1_760_000_300_000, ret: [{ contractRet: 'SUCCESS' }],
      raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: tron.tronAddressToHex(ME), contract_address: tron.tronAddressToHex(CH.usdt.contract), data: usdtCall(1n, TO) } } }] } },
    { ...nat('b1', TO, ME, 2_000_000), txID: '../../#evil' },
  ]
  tn.trc20 = []
  const h4 = await tron.fetchTronHistory(CH, ME)
  const failedRow = h4.find((t) => t.id === 'c1'.repeat(32))
  check('B13 a USDT send that failed on chain shows as a failed send of its amount to its recipient (it never showed; BL29)',
    failedRow?.failed === true && failedRow.asset === 'usdt' && failedRow.amount === -7_000_000n && failedRow.counterparty === TO, JSON.stringify(failedRow, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
  check('B13b a successful contract call is not listed from the native feed (TRC-20 history covers it), and an id that isn\'t a txid is dropped (BL35)',
    !h4.some((t) => t.id === 'c2'.repeat(32)) && !h4.some((t) => t.id.includes('evil')), h4.map((t) => t.id.slice(0, 6)).join())
  delete tn.native
  delete tn.trc20
  check('B14 a tron: code with a query still gives its address (BL34)', tron.parseTronScanned(`tron:${TO}?amount=5`).address === TO && tron.parseTronScanned(`tron://${TO}`).address === TO)

  // BL33: MAX
  tn.accounts[ME] = { balance: 50_000_000 }
  tn.resources[ME] = { freeNetLimit: 600, freeNetUsed: 600 }
  const mx = await tron.prepareTronSend(CH, key, 'trx', TO, 0n, { sendMax: true }).catch((e) => e)
  check('B15 TRX MAX sends everything after this send\'s own network cost (BL33)', mx?.amount === 50_000_000n - 270_000n && mx?.estimatedFeeSun === 270_000n, mx?.message ?? String(mx?.amount))
  tn.usdt[ME] = 12_345_678
  const mu = await tron.prepareTronSend(CH, key, 'usdt', TO, 0n, { sendMax: true }).catch((e) => e)
  check('B15b USDT MAX sends the whole USDT balance', mu?.amount === 12_345_678n, mu?.message ?? String(mu?.amount))
  tn.resources[ME] = {}

  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const modal = readFileSync(new URL('../src/components/TronSendModal.tsx', import.meta.url), 'utf8')
  const stakeModal = readFileSync(new URL('../src/components/TronStakeModal.tsx', import.meta.url), 'utf8')
  check('B16 the TRON stake overview names the representative a vote goes to, and the review says what a vote replaces (BL30)',
    /Vote all for \{/.test(stakeModal) && /This replaces your current votes/.test(stakeModal))
  check('B16b a reload shows its own loading screen and lands on the overview only if nothing else started (BL31)',
    /setStep\(\{ kind: 'loading' \}\)\n    Promise\.all\(\[fetchTronStake/.test(stakeModal) && /cur\.kind === 'loading' \? \{ kind: 'overview' \} : cur/.test(stakeModal))
  check('B16c a TRON review left open past TRON_REVIEW_FRESH_MS is built again before signing — send and stake (BL32); the send form has MAX (BL33)',
    tron.TRON_REVIEW_FRESH_MS === 45_000 && /Date\.now\(\) - step\.at > TRON_REVIEW_FRESH_MS \? handleContinue\(true\)/.test(modal) && /Date\.now\(\) - step\.at > TRON_REVIEW_FRESH_MS \? runPrepare\(step\.redo, true\)/.test(stakeModal) && /setSendMax\(\(v\) => !v\)/.test(modal))
  // BM22: /v1 history requests one a second (here 200 ms), the rest at their own pace
  tron.tronTuning.v1GapMs = 200
  tn.bodies.length = 0
  await Promise.all([tron.fetchTronHistory(CH, ME), tron.getTronUsdtBalance(CH, ME)])
  const v1 = tn.bodies.filter((b) => b.path.startsWith('/v1/'))
  const gaps = v1.slice(1).map((b, k) => b.at - v1[k].at)
  const other = tn.bodies.find((b) => !b.path.startsWith('/v1/'))
  check('B12 TronGrid\'s /v1 history endpoints are paced apart (one a second in the app), other calls don\'t wait for them',
    v1.length === 2 && gaps.every((g) => g >= 190) && other !== undefined && other.at - v1[0].at < 150, `${gaps.join(', ')} ms; other after ${other?.at - v1[0]?.at} ms`)
  tron.tronTuning.v1GapMs = 0
  // the stake view's requests go through the same pacing (they skipped it)
  const tronstake = await import('../src/lib/tronstake.ts')
  tron.tronTuning.gapMs = 150
  tn.bodies.length = 0
  await tronstake.fetchTronStake(CH, ME).catch(() => null)
  const st = tn.bodies.filter((b) => b.path === '/wallet/getaccount' || b.path === '/wallet/getReward')
  check('B12b TRON stake requests are paced with every other TRON request (review 2026-10-28; they went out together)',
    st.length === 2 && st[1].at - st[0].at >= 140, `${st.length} requests, ${st[1]?.at - st[0]?.at} ms apart`)
  tron.tronTuning.gapMs = 0
  check('B11d the dashboard hands the previous rows to the refresh, and the TRON review warns about a contract recipient',
    /fetchTronHistory\(chain, key\.address, prev\.txs\)/.test(app) && /step\.prepared\.recipientIsContract === true/.test(modal))
  key.zero()
}

// ===========================================================================
// C. Typed amounts — the decimal comma (BH7) and exact fills (BH6)
console.log('--- C. typed amounts ---')
{
  const { readTypedAmount, formatTypedAmount } = await import('../src/lib/format.ts')
  const US = { decimal: '.', group: ',' }
  const DE = { decimal: ',', group: '.' }
  const FR = { decimal: ',', group: ' ' }
  const read = (s, local, d = 8) => readTypedAmount(s, d, 'BTC', '0.5', local)
  const amt = (s, local, d) => read(s, local, d).amount

  check('C1 a decimal comma reads as the decimal mark (Germany, France, and the US too)',
    amt('0,5', DE) === 50_000_000n && amt('1,25', FR) === 125_000_000n && amt('2,5', US) === 250_000_000n && amt(',5', DE) === 50_000_000n)
  check('C1b ...and so does a dot, everywhere (as before)', amt('0.5', DE) === 50_000_000n && amt('0.5', US) === 50_000_000n && amt('12.', US) === 1_200_000_000n && amt('.5', FR) === 50_000_000n)
  check('C1c a comma is the decimal mark where it is not the grouping mark, whatever follows', amt('1,234', DE) === 123_400_000n && amt('1,234', FR) === 123_400_000n)
  const amb = read('1,234', US)
  check('C2 "1,234" in the US could be a thousand: refused, with both readings offered', amb.amount === null && /could mean 1234 or 1\.234/.test(amb.error ?? '') && /1,2340/.test(amb.error ?? ''), amb.error ?? '')
  const ambDe = read('1.234', DE)
  check('C2b ...and "1.234" in Germany likewise', ambDe.amount === null && /could mean 1234 or 1,234/.test(ambDe.error ?? ''), ambDe.error ?? '')
  check('C2c a grouping shape needs a leading 1–9 and exactly three digits after: "0,123", "1,23", "1,2345" are decimals',
    amt('0,123', US) === 12_300_000n && amt('1,23', US) === 123_000_000n && amt('1,2345', US) === 123_450_000n)
  const two = read('1,234.5', US)
  check('C3 two marks ("1,234.5", "1.234,5", "1,234,567") are refused', two.amount === null && /without thousands separators/.test(two.error ?? '') && read('1.234,5', DE).amount === null && read('1,234,567', US).amount === null)
  check('C3b the hint uses this device\'s mark', /1234,5/.test(read('1.234,5', DE).error ?? '') && /1234\.5/.test(two.error ?? ''))
  check('C4 junk, spaces, signs and a bare mark are refused', ['abc', '1 000', '-1', '+1', '.', ',', '1e5', '0x10'].every((s) => read(s, US).amount === null && read(s, US).error !== null))
  check('C4b the plain-number hint is written the device\'s way', /like 0,5/.test(read('abc', DE).error ?? '') && /like 0\.5/.test(read('abc', US).error ?? ''))
  check('C5 more places than the asset has are refused, either mark', /at most 8 decimal places/.test(read('0,123456789', DE).error ?? '') && /at most 6/.test(readTypedAmount('1.1234567', 6, 'USDC', '1', US).error ?? ''))
  check('C6 zero is refused, an empty field is neither amount nor error', /more than zero/.test(read('0,0', DE).error ?? '') && read('  ', US).amount === null && read('', US).error === null)

  // every exact amount written into a field reads back unchanged, in every locale
  const samples = [1n, 9n, 10n, 123n, 1_000n, 123_456_789n, 1_234_000_000n, 10_250_000_000n, 1_000_000_000_000n, 999_999_999n]
  let roundTrip = true
  for (const local of [US, DE, FR, { decimal: '.', group: '’' }])
    for (const d of [6, 8, 9, 18])
      for (const v of samples) if (readTypedAmount(formatTypedAmount(v, d, local), d, 'X', '1', local).amount !== v) roundTrip = false
  check('C7 a filled amount (scanned request, Max) reads back exactly in every locale (the US, Germany, France, Switzerland)', roundTrip)
  check('C7b ...written with the device\'s mark, every digit kept', formatTypedAmount(123_456_789n, 9, DE) === '0,123456789' && formatTypedAmount(123_456_789n, 9, US) === '0.123456789')

  // the forms: every amount field reads through readTypedAmount, every fill through formatTypedAmount
  const { readFileSync } = await import('node:fs')
  const forms = ['SendModal', 'EvmSendModal', 'SolSendModal', 'SolSwapModal', 'SolStakeModal', 'TronSendModal', 'TronStakeModal']
  const src = Object.fromEntries(forms.map((f) => [f, readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), 'utf8')]))
  const notShared = forms.filter((f) => !/readTypedAmount\(amountStr,/.test(src[f]) || /\\d\*\\\.\?\\d\*/.test(src[f]) || /parseCoinAmount\(amountStr/.test(src[f]))
  check('C8 all seven amount fields parse through readTypedAmount (no private dot-only parser left)', notShared.length === 0, notShared.join(', '))
  const fills = forms.flatMap((f) => [...src[f].matchAll(/setAmountStr\(([^)]*\)?)\)/g)].map((m) => [f, m[1]]))
    .filter(([, arg]) => arg !== "''" && arg !== 'e.target.value')
  const badFills = fills.filter(([, arg]) => !arg.startsWith('formatTypedAmount('))
  check('C9 every programmatic fill writes the exact amount the device\'s way', fills.length >= 4 && badFills.length === 0, badFills.map((x) => x.join(': ')).join('; '))
  check('C10 the Solana send review and success screens show the exact amount (not 6 decimals)', /const fmtAmount = \(v: bigint\) => formatCoin\(v, decimals\)/.test(src.SolSendModal))
}

// ===========================================================================
// D. EVM after the 2026-10-27 audit's LOWs: error text, reverted rows, tiny
// fees, and the dashboard's alerts, history and errors
console.log('--- D. EVM: errors, history, display, alerts ---')
{
  const base = evm.EVM_CHAINS.base
  const OTHER_ADDR = '0x1111111111111111111111111111111111111111'
  const viemLike = Object.assign(new Error('HTTP request failed.\n\nStatus: 0\nURL: https://mainnet.base.org\nRequest body: {"method":"eth_sendRawTransaction","params":["0x02f8' + 'ab'.repeat(120) + '"]}\n\nVersion: viem@2.21.0'), { shortMessage: 'HTTP request failed.', name: 'HttpRequestError' })
  const t1 = evm.evmErrorText(viemLike, base)
  check('D1 a viem error reads as plain words: no URL, no request body, no signed bytes, no version (BL13)', /Couldn't reach the Base network/.test(t1) && !/https?:|0x02f8|viem@|Request body/.test(t1), t1)
  check('D1b a revert reads as the contract refusing in a test run', /refused this transfer in a test run/.test(evm.evmErrorText({ shortMessage: 'Execution reverted with reason: x.', message: 'Execution reverted...' })))
  const t2 = evm.evmErrorText(new Error('Something odd: 0x' + 'cd'.repeat(60) + ' at https://rpc.example/key'))
  check('D1c anything else keeps its first line, without a long hex blob or a URL', !/https?:/.test(t2) && !/cdcdcdcd/.test(t2) && /Something odd/.test(t2), t2)
  check('D1d our own one-line messages pass through unchanged', evm.evmErrorText(new Error('That is the zero address. Anything sent there is lost for good.')) === 'That is the zero address. Anything sent there is lost for good.')
  {
    const lost = new evm.EvmBroadcastError("The network didn't confirm it received this send (request timed out). It may still go through.", false)
    const ledger = await import('../src/lib/pending.ts')
    const waiting = new evm.EvmSendWaiting({ kind: 'evm', chainId: 8453, nonce: 3, hash: '0x' + '1'.repeat(64), to: OTHER_ADDR, ts: Date.now() }, `Your send from 3 minutes ago (to ${OTHER_ADDR.slice(0, 8)}…) on Arbitrum One`)
    const landed = new ledger.EarlierSendLanded({ kind: 'evm', chainId: 8453, nonce: 3, hash: '0x' + '1'.repeat(64), to: OTHER_ADDR, ts: Date.now() }, `Your send from 3 minutes ago (to ${OTHER_ADDR.slice(0, 8)}…) on Arbitrum One`)
    check('D1e the wallet\'s own warnings pass whole: a lost broadcast mentioning a timeout is not "your coins are safe", and "still waiting" / "went through" aren\'t cut (review 2026-10-28)',
      evm.evmErrorText(lost, base) === lost.message && evm.evmErrorText(waiting, base) === waiting.message && waiting.message.length > 200 && evm.evmErrorText(landed, base) === landed.message)
  }

  // BL15: a reverted send is not a completed one
  const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const OTHER = '0x1111111111111111111111111111111111111111'
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('token-transfers')) return new Response(JSON.stringify({ items: [] }), { status: 200 })
    return new Response(JSON.stringify({ items: [
      { hash: '0x' + 'a1'.repeat(32), timestamp: '2026-10-01T00:00:00Z', from: { hash: ME }, to: { hash: OTHER }, value: '1000', status: 'error' },
      { hash: '0x' + 'a2'.repeat(32), timestamp: '2026-10-01T00:00:00Z', from: { hash: ME }, to: { hash: OTHER }, value: '2000', status: 'ok' },
      { hash: '0x' + 'a3'.repeat(32), timestamp: '2026-10-01T00:00:00Z', from: { hash: OTHER }, to: { hash: ME }, value: '3000', status: 'error' },
    ] }), { status: 200 })
  }
  const rows = await evm.fetchEvmHistory(base, ME)
  globalThis.fetch = realFetch
  const byHash = Object.fromEntries(rows.map((r) => [r.hash.slice(2, 4), r]))
  check('D2 a reverted send is marked failed, a confirmed one is not, and a reverted incoming payment never arrived (BL15)',
    byHash.a1?.failed === true && byHash.a2?.failed === undefined && byHash.a3 === undefined, rows.map((r) => `${r.hash.slice(2, 4)}:${r.failed ?? ''}`).join())

  // BL16: tiny amounts
  check('D3 a fee below the sixth place keeps two significant digits instead of reading 0.000000 (BL16)',
    evm.formatEvmAmount(412_345_678n, 18) === '0.00000000041' && evm.formatEvmAmount(1n, 18) === '0.000000000000000001' && evm.formatEvmAmount(1_234_567_000_000_000n, 18) === '0.001234' && evm.formatEvmAmount(0n, 18) === '0' && evm.formatEvmAmount(-412_345_678n, 18) === '-0.00000000041')

  // the dashboard's side (App, Dashboard, EvmCard), read from the source
  const { readFileSync } = await import('node:fs')
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const app = read('App.tsx')
  check('D4 an EVM history is read again for a few polls after its balance changed (the explorer can lag; BL17)',
    /if \(changed\) evmHistoryDueRef\.current\[chain\.id\] = 3/.test(app) && /prev\.txs\.length === 0 \|\| due > 0\)/.test(app))
  check('D5 payment alerts: the gas coin too, through lib/alerts.ts, practice marked (BL18)',
    /alertGrowth\(chain, chain\.gas\.symbol, prev\.gas, b\.gas/.test(app) && /receivedAmount\(alertBookRef\.current, `\$\{chain\.id\}:\$\{asset\}`, shown, now, Date\.now\(\)\)/.test(app) && /chain\.mainnet \? '' : ' \(practice\)'/.test(app))
  {
    // the rules themselves (review 2026-10-28: a blanket quiet window per
    // chain swallowed a real payment that came in beside a swap, for good)
    const { newAlertBook, expectCredit, receivedAmount, OWN_CREDIT_MS } = await import('../src/lib/alerts.ts')
    const K = 'sol:USDC'
    let book = newAlertBook()
    const t0 = 1_000_000
    check('D5a a balance that grew alerts the growth, once (a second refresh with the same balance says nothing)',
      receivedAmount(book, K, 5_000_000n, 7_000_000n, t0) === 2_000_000n && receivedAmount(book, K, 5_000_000n, 7_000_000n, t0) === null)
    book = newAlertBook()
    expectCredit(book, K, 10_000_000n, t0)
    check('D5b the wallet\'s own swap credit (said before it went out) is silent, a little above its quote included',
      receivedAmount(book, K, 0n, 10_200_000n, t0 + 5_000) === null)
    book = newAlertBook()
    expectCredit(book, K, 10_000_000n, t0)
    check('D5c ...but a real payment that lands beside it still alerts, less only what the swap may have credited',
      receivedAmount(book, K, 0n, 110_000_000n, t0 + 5_000) === 110_000_000n - 10_500_000n)
    book = newAlertBook()
    expectCredit(book, K, 10_000_000n, t0)
    receivedAmount(book, K, 0n, 10_000_000n, t0 + 5_000)
    check('D5d ...and once the swap\'s credit is used up, a later payment in the window alerts (less the bit of headroom left)',
      receivedAmount(book, K, 0n, 30_000_000n, t0 + 20_000) === 20_000_000n - 500_000n)
    book = newAlertBook()
    expectCredit(book, K, 10_000_000n, t0)
    check('D5e a credit nobody saw arrive expires: a payment after the window alerts in full',
      receivedAmount(book, K, 0n, 10_000_000n, t0 + OWN_CREDIT_MS + 1) === 10_000_000n)
    check('D5f a swap, a SOL stake withdrawal and a TRON claim / withdrawal / unstake each say what they may credit BEFORE they broadcast',
      /onOwnCredit\(prepared\.direction === 'sol-to-usdc' \? chain\.usdc\.symbol : 'SOL', prepared\.outAmount\)\n    broadcastSwap\(/.test(read('components/SolSwapModal.tsx')) &&
        /if \(prepared\.kind === 'withdraw'\) onOwnCredit\('SOL', prepared\.amount\)\n    broadcastStakeAction\(/.test(read('components/SolStakeModal.tsx')) &&
        /onOwnCredit\('TRX', stake\.unclaimedReward \+ ready\)\n    \}\n    settle\(broadcastTronSend/.test(read('components/TronStakeModal.tsx')) &&
        !/ownAction/.test(app + read('components/Dashboard.tsx')))
  }
  const card = read('components/EvmCard.tsx')
  check('D6 the BNB card names BNB, rows have unique keys, and a refresh the user asked for shows its error even when a poll superseded it (BL23)',
    /chain\.gasPrimary === true \? chain\.gas\.symbol : chain\.token\.symbol/.test(card) && /\$\{t\.direction\}-\$\{i\}/.test(card) && (app.match(/const manualFailed = manualWaitingRef\.current\[chain\.id\] === true/g) ?? []).length === 3)
  check('D7 the EVM send form shows errors through evmErrorText (BL13)', (read('components/EvmSendModal.tsx').match(/evmErrorText\(e, chain\)/g) ?? []).length === 2)
}

console.log('--- E. UTXO fee rates from any service are clamped (review 2026-10-29) ---')
{
  const { toRate, EsploraProvider } = await import('../src/lib/esplora.ts')
  const { CHAINS } = await import('../src/lib/networks.ts')
  check('E1 toRate rounds up, floors at 1 and caps at 1,000 sat/vB; nonsense reads as 1',
    toRate(4.2) === 5n && toRate(0.2) === 1n && toRate(0) === 1n && toRate(-7) === 1n && toRate(1_000_000) === 1000n &&
      toRate(NaN) === 1n && toRate(Infinity) === 1n && toRate(999.01) === 1000n)
  const realFetch = globalThis.fetch
  const answer = {}
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/v1/fees/recommended')) return answer.recommended ? new Response(JSON.stringify(answer.recommended)) : new Response('not found', { status: 404 })
    if (u.endsWith('/fee-estimates')) return new Response(JSON.stringify(answer.estimates))
    return new Response('not found', { status: 404 })
  }
  answer.recommended = { fastestFee: 1e9, halfHourFee: 5_000, hourFee: -3 }
  const mp = await new EsploraProvider(CHAINS.btc.providers[0], CHAINS.btc).getFeeOptions()
  check('E2 a mempool-style service asking a billion sat/vB is held to 1,000; a negative rate reads as 1',
    mp.map((f) => f.rate).join() === '1000,1000,1', mp.map((f) => f.rate).join())
  answer.recommended = null
  answer.estimates = { 1: 4_000_000, 3: 12.5, 6: 'x' }
  const bs = await new EsploraProvider(CHAINS.btc.providers.find((p) => p.name === 'blockstream.info'), CHAINS.btc).getFeeOptions()
  check('E3 an esplora /fee-estimates answer is clamped the same way',
    bs.map((f) => f.rate).join() === '1000,13,1', bs.map((f) => f.rate).join())
  globalThis.fetch = realFetch
  const { readFileSync } = await import('node:fs')
  const src = (f) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8')
  check('E4 BlockCypher and Bitcore fee answers go through the same toRate',
    /return toRate\(perKb \/ 1000\)/.test(src('blockcypher.ts')) && /return toRate\(Math\.round\(r\.feerate \* 1e8\) \/ 1000\)/.test(src('bitcore.ts')))
}

console.log(failures === 0 ? '\nAll amount checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
