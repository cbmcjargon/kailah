// check-swapgate.mjs — OFFLINE (recorded Jupiter answers, a fake chain, no network).
//
// The swap engine (src/lib/solswap.ts) builds SOL ↔ USDC swaps from Jupiter
// Swap V2 /build INSTRUCTIONS, assembles the transaction itself, and checks the
// exact bytes it would sign. Two real /build answers recorded on 2026-10-25
// (scripts/fixtures/jupiter-build-*.json, one per direction, with the on-chain
// contents of their lookup tables) drive this suite. It proves:
//   A. an honest build passes in both directions, and the compiled transaction
//      is the one Jupiter described: same instructions, accounts and data,
//      our compute-unit limit, a single signer, tables resolved from the chain;
//   B. the decoded Jupiter instruction must say what we asked: any change to
//      the amount, quoted output, slippage, platform fee, positive-slippage
//      share, variant or transfer authority is refused;
//   C. the build's shape is enforced: no "other" or tip instructions, v0 only,
//      only a unit-price compute-budget instruction, no foreign signer, no
//      second Jupiter instruction, no Approve, no CloseAccount paying someone
//      else, no program off the allow-list, no stake account;
//   D. lookup tables come from the chain, and Jupiter's list must agree;
//   E. the simulation must honor the decoded floor, and a failing simulation
//      stops the swap; a stale build is rebuilt; a 429 says "busy".
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { readFileSync } = await import('node:fs')
const { createHash } = await import('node:crypto')
const solLib = await import('micro-sol-signer')
const { base58, base64 } = await import('@scure/base')
const { unlockSecureStore } = await import('../src/lib/securestore.ts')
const { SOL_CHAINS } = await import('../src/lib/sol.ts')
const { stakeAccountAddress } = await import('../src/lib/solstake.ts')
const { getSwapQuote, prepareSwap, SWAP_SLIPPAGE_BPS } = await import('../src/lib/solswap.ts')

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

await unlockSecureStore('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')

const MAINNET = SOL_CHAINS.sol
const FIX = {
  'sol-to-usdc': JSON.parse(readFileSync('scripts/fixtures/jupiter-build-sol-to-usdc.json', 'utf8')),
  'usdc-to-sol': JSON.parse(readFileSync('scripts/fixtures/jupiter-build-usdc-to-sol.json', 'utf8')),
}
const OWNER = FIX['sol-to-usdc'].request.taker
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const SOL_BEFORE = 50_000_000_000n
const USDC_BEFORE = 1_000_000_000n
const UNITS_USED = 150_000

// --- the fake world ---------------------------------------------------------
let world
function resetWorld(direction) {
  const fx = FIX[direction]
  world = {
    direction,
    build: structuredClone(fx.build),
    tables: { ...fx.lookupTables },
    simulations: [],
    builds: 0,
    jupStatus: 200,
    simErr: null,
    // what the final simulation reports for our two accounts
    shortfall: 0n,
  }
}
const tokenAccountB64 = (amount) => {
  const b = new Uint8Array(165)
  new DataView(b.buffer).setBigUint64(64, amount, true)
  return base64.encode(b)
}
const rpcOk = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('https://api.jup.ag/')) {
    world.builds++
    if (world.jupStatus === 429) return new Response('{"error":"Rate limit exceeded"}', { status: 429 })
    return new Response(JSON.stringify(world.build), { status: 200 })
  }
  const { method, params } = JSON.parse(init.body)
  const q = world.build
  switch (method) {
    case 'getMultipleAccounts':
      return rpcOk({ value: params[0].map((a) => (world.tables[a] ? { data: [world.tables[a], 'base64'] } : null)) })
    case 'getLatestBlockhash':
      return rpcOk({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } })
    case 'getBalance':
      return rpcOk({ value: Number(SOL_BEFORE) })
    case 'getAccountInfo':
      return rpcOk({ value: { data: [tokenAccountB64(USDC_BEFORE), 'base64'] } })
    case 'getMinimumBalanceForRentExemption':
      return rpcOk(2_039_280)
    case 'getSignatureStatuses':
      return rpcOk({ value: params[0].map(() => null) })
    case 'simulateTransaction': {
      world.simulations.push(params[0])
      if (world.simErr) return rpcOk({ value: { err: world.simErr, logs: ['Program log: slippage exceeded'] } })
      const wanted = params[1].accounts?.addresses
      if (!wanted) return rpcOk({ value: { err: null, logs: [], unitsConsumed: UNITS_USED } })
      const inA = BigInt(q.inAmount), out = BigInt(q.outAmount) - world.shortfall
      const solAfter = world.direction === 'sol-to-usdc' ? SOL_BEFORE - inA - 6_000n : SOL_BEFORE + out - 6_000n
      const usdcAfter = world.direction === 'sol-to-usdc' ? USDC_BEFORE + out : USDC_BEFORE - inA
      return rpcOk({
        value: {
          err: null,
          logs: [],
          unitsConsumed: UNITS_USED,
          accounts: [
            { lamports: Number(solAfter) },
            { lamports: 2_039_280, data: { parsed: { info: { tokenAmount: { amount: usdcAfter.toString() } } } } },
          ],
        },
      })
    }
    default:
      throw new Error(`unexpected RPC ${method}`)
  }
}

const quoteFor = (direction, owner = OWNER) => getSwapQuote(MAINNET, direction, BigInt(FIX[direction].request.amount), owner)
async function run(direction, mutate, owner = OWNER) {
  resetWorld(direction)
  mutate?.(world)
  try {
    const quote = await quoteFor(direction, owner)
    return { prepared: await prepareSwap(MAINNET, owner, quote), err: null }
  } catch (e) {
    return { prepared: null, err: e }
  }
}
const refused = (r) => r.err !== null && /does not match its quote/.test(r.err.message)
const ixData = (w) => base64.decode(w.build.swapInstruction.data)
const setIxData = (w, d) => (w.build.swapInstruction.data = base64.encode(d))
const patchU16 = (d, off, v) => new DataView(d.buffer, d.byteOffset).setUint16(off, v, true)
const patchU64 = (d, off, v) => new DataView(d.buffer, d.byteOffset).setBigUint64(off, v, true)
const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const ix = (programId, accounts, data) => ({ programId, accounts, data: base64.encode(new Uint8Array(data)) })
const OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'

/** Resolve a compiled transaction back to {program, keys:[address…], data} with the fixture tables. */
function resolveCompiled(txB64, tables) {
  const raw = solLib.TransactionRaw.decode(base64.decode(txB64))
  const d = raw.msg.data
  const lists = Object.fromEntries(
    Object.entries(tables).map(([t, b64]) => {
      const by = base64.decode(b64)
      const out = []
      for (let o = 56; o + 32 <= by.length; o += 32) out.push(b58(by.subarray(o, o + 32)))
      return [t, out]
    }),
  )
  const accounts = [
    ...d.keys,
    ...(d.ALT ?? []).flatMap((l) => l.writableIndexes.map((i) => lists[l.account][i])),
    ...(d.ALT ?? []).flatMap((l) => l.readonlyIndexes.map((i) => lists[l.account][i])),
  ]
  return {
    signatures: raw.signatures.length,
    required: d.header.requiredSignatures,
    feePayer: d.keys[0],
    blockhash: d.blockhash,
    lookups: (d.ALT ?? []).map((l) => l.account),
    instructions: d.instructions.map((i) => ({ program: d.keys[i.programIdx], keys: i.keys.map((k) => accounts[k]), data: i.data })),
  }
}
const b58 = (u8) => base58.encode(u8)
const hex = (u8) => Buffer.from(u8).toString('hex')

console.log('--- A. honest builds pass, and compile to what Jupiter described ---')
for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
  const fx = FIX[direction]
  const r = await run(direction)
  check(`A ${direction}: prepareSwap accepts the honest build`, r.err === null, r.err?.message)
  if (!r.prepared) continue
  const p = r.prepared
  const floor = (BigInt(fx.build.outAmount) * BigInt(10_000 - SWAP_SLIPPAGE_BPS)) / 10_000n
  check(`A ${direction}: the guaranteed minimum is computed from the decoded route`, p.minOutAmount === floor, `${p.minOutAmount} vs ${floor} (Jupiter said ${fx.build.otherAmountThreshold})`)
  check(`A ${direction}: two simulations (measure, then the final bytes)`, world.simulations.length === 2)
  const tx = resolveCompiled(p.txBase64, fx.lookupTables)
  check(`A ${direction}: one signature, ours, and our blockhash`, tx.signatures === 1 && tx.required === 1 && tx.feePayer === OWNER && tx.blockhash === BLOCKHASH)
  const limitIx = tx.instructions[0]
  const limit = new DataView(limitIx.data.buffer, limitIx.data.byteOffset).getUint32(1, true)
  check(`A ${direction}: first instruction is our compute-unit limit, 1.2× the measured units`, limitIx.program === 'ComputeBudget111111111111111111111111111111' && limitIx.data[0] === 2 && limit === Math.ceil(UNITS_USED * 1.2), `${limit}`)
  const expected = [
    ...fx.build.computeBudgetInstructions,
    ...fx.build.setupInstructions,
    fx.build.swapInstruction,
    ...(fx.build.cleanupInstruction ? [fx.build.cleanupInstruction] : []),
  ]
  const got = tx.instructions.slice(1)
  const same =
    got.length === expected.length &&
    got.every((g, i) => g.program === expected[i].programId && hex(g.data) === hex(base64.decode(expected[i].data)) && g.keys.join() === expected[i].accounts.map((a) => a.pubkey).join())
  check(`A ${direction}: every other instruction is Jupiter's, byte for byte, with the same accounts in order`, same)
  check(`A ${direction}: lookups use only the tables Jupiter named, contents from the chain`, tx.lookups.every((t) => t in fx.lookupTables) && tx.lookups.length > 0, tx.lookups.length + ' tables')
  check(`A ${direction}: the swap instruction is decoded and Jupiter's program appears once`, got.filter((g) => g.program === JUP6).length === 1)
}

{
  // Signing must not touch the message the gate checked. A throwaway key takes
  // the recorded taker's place so the compiled transaction can be signed.
  const throwaway = new Uint8Array(32).fill(0x37)
  const addr = solLib.getAddress(throwaway)
  const r = await run('usdc-to-sol', (w) => {
    const b = w.build
    for (const i of [...b.computeBudgetInstructions, ...b.setupInstructions, b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : [])]) {
      for (const a of i.accounts) if (a.pubkey === OWNER) a.pubkey = addr
    }
  }, addr)
  if (r.err) {
    check('A signing the compiled swap leaves the message untouched', false, r.err.message)
  } else {
    const [, signed] = solLib.signTx(throwaway, r.prepared.txBase64)
    const before = base64.decode(r.prepared.txBase64).slice(65)
    const after = base64.decode(signed)
    const msg = after.slice(65)
    const { ed25519 } = await import('@noble/curves/ed25519')
    check(
      'A signing the compiled swap leaves the message byte-identical, and the signature verifies',
      before.length === msg.length && before.every((x, i) => x === msg[i]) && ed25519.verify(after.slice(1, 65), msg, ed25519.getPublicKey(throwaway)),
    )
  }
}

console.log('--- B. the Jupiter instruction must say what we asked ---')
const B = [
  ['in_amount changed', (w) => { const d = ixData(w); patchU64(d, 8, BigInt(w.build.inAmount) + 1n); setIxData(w, d) }],
  ['quoted_out_amount raised above the quote', (w) => { const d = ixData(w); patchU64(d, 16, BigInt(w.build.outAmount) * 2n); setIxData(w, d) }],
  ['slippage raised to 3%', (w) => { const d = ixData(w); patchU16(d, 24, 300); setIxData(w, d) }],
  ['a 0.5% platform fee slipped in', (w) => { const d = ixData(w); patchU16(d, 26, 50); setIxData(w, d) }],
  ['a positive-slippage share slipped in', (w) => { const d = ixData(w); patchU16(d, 28, 10); setIxData(w, d) }],
  ['the variant switched to exact-out', (w) => { const d = ixData(w); d.set(disc('exact_out_route_v2'), 0); setIxData(w, d) }],
  ['an unknown Jupiter instruction', (w) => { const d = ixData(w); d.set(disc('claim_token'), 0); setIxData(w, d) }],
  ['the transfer authority is someone else', (w) => { w.build.swapInstruction.accounts[0] = { pubkey: OTHER, isSigner: false, isWritable: false } }],
]
for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
  for (const [label, mutate] of B) {
    const r = await run(direction, mutate)
    check(`B ${direction}: ${label} → refused`, refused(r), r.err?.message?.slice(0, 50) ?? 'accepted!')
  }
}
{
  // The older route layout (route plan first, fields at the end) is decoded too.
  const v1 = (fee) => (w) => {
    const acc = w.build.swapInstruction.accounts
    // route's authority slot is 1: put us there, keep a plausible slot 0
    w.build.swapInstruction.accounts = [{ pubkey: acc[5].pubkey, isSigner: false, isWritable: false }, acc[0], ...acc.slice(1)]
    const tail = new Uint8Array(19)
    new DataView(tail.buffer).setBigUint64(0, BigInt(w.build.inAmount), true)
    new DataView(tail.buffer).setBigUint64(8, BigInt(w.build.outAmount), true)
    new DataView(tail.buffer).setUint16(16, SWAP_SLIPPAGE_BPS, true)
    tail[18] = fee
    setIxData(w, new Uint8Array([...disc('route'), 0, 0, 0, 0, ...tail]))
  }
  const ok = await run('sol-to-usdc', v1(0))
  check('B the older `route` layout with honest fields passes', ok.err === null, ok.err?.message?.slice(0, 60))
  check('B the older `route` layout with a platform fee is refused', refused(await run('sol-to-usdc', v1(50))))
}

console.log('--- C. the build\'s shape ---')
const swapAccts = (w) => w.build.swapInstruction.accounts
const C = [
  ['an "other" instruction', (w) => { w.build.otherInstructions = [ix('ComputeBudget111111111111111111111111111111', [], [3, 1, 0, 0, 0, 0, 0, 0, 0])] }],
  ['a tip instruction', (w) => { w.build.tipInstruction = ix('11111111111111111111111111111111', [{ pubkey: OWNER, isSigner: true, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }], [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }],
  ['transaction version 1', (w) => { w.build.transactionVersion = 1 }],
  ['a compute-unit LIMIT from Jupiter', (w) => { w.build.computeBudgetInstructions.push(ix('ComputeBudget111111111111111111111111111111', [], [2, 0x40, 0x42, 0x0f, 0])) }],
  ['a heap-frame request', (w) => { w.build.computeBudgetInstructions = [ix('ComputeBudget111111111111111111111111111111', [], [1, 0, 0, 4, 0])] }],
  ['a second signer', (w) => { w.build.setupInstructions[0].accounts.push({ pubkey: OTHER, isSigner: true, isWritable: false }) }],
  ['a second Jupiter instruction', (w) => { w.build.setupInstructions.push(structuredClone(w.build.swapInstruction)) }],
  ['a token Approve', (w) => { w.build.setupInstructions.push(ix('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', [{ pubkey: swapAccts(w)[1].pubkey, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: false }, { pubkey: OWNER, isSigner: true, isWritable: false }], [4, 255, 255, 255, 255, 255, 255, 255, 255])) }],
  ['a CloseAccount that pays someone else', (w) => { w.build.cleanupInstruction = ix('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', [{ pubkey: swapAccts(w)[1].pubkey, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: OWNER, isSigner: true, isWritable: false }], [9]) }],
  ['a program off the allow-list', (w) => { w.build.setupInstructions.push(ix('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', [], [104, 105])) }],
  ['our stake account referenced', (w) => { swapAccts(w).push({ pubkey: stakeAccountAddress(OWNER, 0), isSigner: false, isWritable: true }) }],
  ['a malformed account entry', (w) => { swapAccts(w)[3] = { pubkey: 'not-an-address', isSigner: false, isWritable: false } }],
]
for (const [label, mutate] of C) {
  const r = await run('sol-to-usdc', mutate)
  check(`C ${label} → refused`, refused(r), r.err?.message?.slice(0, 50) ?? 'accepted!')
}
{
  resetWorld('sol-to-usdc')
  const quote = await quoteFor('sol-to-usdc')
  const e = await rejects(() => prepareSwap(MAINNET, OTHER, quote))
  check('C a quote built for another address is refused for ours', /does not match its quote/.test(e?.message ?? ''), e?.message?.slice(0, 50))
}

console.log('--- D. lookup tables ---')
{
  const t = Object.keys(FIX['sol-to-usdc'].lookupTables)[0]
  const r1 = await run('sol-to-usdc', (w) => { w.build.addressesByLookupTableAddress[t][3] = OTHER })
  check('D Jupiter\'s list disagrees with the chain → refused', refused(r1), r1.err?.message?.slice(0, 50))
  const r2 = await run('sol-to-usdc', (w) => { delete w.tables[t] })
  check('D a table the chain doesn\'t have → refused', r2.err !== null, r2.err?.message?.slice(0, 50))
  const r3 = await run('sol-to-usdc', (w) => { w.build.addressesByLookupTableAddress[t].pop() })
  check('D Jupiter listing a prefix of a table (it grew since) still passes', r3.err === null, r3.err?.message?.slice(0, 60))
}

console.log('--- E. simulation, staleness, rate limits, the quote itself ---')
{
  const r1 = await run('sol-to-usdc', (w) => { w.shortfall = BigInt(w.build.outAmount) / 100n }) // 1% short of the quote
  check('E the simulated output falls below the decoded floor → refused', refused(r1), r1.err?.message?.slice(0, 50))
  const r2 = await run('usdc-to-sol', (w) => { w.shortfall = BigInt(w.build.outAmount) / 100n })
  check('E same for USDC → SOL', refused(r2), r2.err?.message?.slice(0, 50))
  const r3 = await run('sol-to-usdc', (w) => { w.simErr = { InstructionError: [3, { Custom: 6001 }] } })
  check('E a failing simulation stops the swap before signing', /fails in simulation/.test(r3.err?.message ?? ''), r3.err?.message?.slice(0, 60))
  const r4 = await run('sol-to-usdc', (w) => { w.build.otherAmountThreshold = (BigInt(w.build.otherAmountThreshold) - 1000n).toString() })
  check('E Jupiter reporting a lower minimum than its own route → refused', refused(r4), r4.err?.message?.slice(0, 50))

  resetWorld('sol-to-usdc')
  const quote = await quoteFor('sol-to-usdc')
  quote.builtAt -= 31_000
  const before = world.builds
  const p = await rejects(() => prepareSwap(MAINNET, OWNER, quote))
  check('E a build older than 30 s is rebuilt before preparing', p === null && world.builds === before + 1, `${world.builds - before} rebuild(s)`)

  resetWorld('sol-to-usdc')
  world.jupStatus = 429
  const busy = await rejects(() => quoteFor('sol-to-usdc'))
  check('E a 429 from Jupiter says "busy" in plain words', /busy right now/.test(busy?.message ?? ''), busy?.message?.slice(0, 60))

  resetWorld('sol-to-usdc')
  world.build.inAmount = '1'
  const wrongAmt = await rejects(() => quoteFor('sol-to-usdc'))
  check('E a quote for a different amount than asked → refused', /does not match its quote/.test(wrongAmt?.message ?? ''))
  resetWorld('sol-to-usdc')
  world.build.outputMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  const wrongMint = await rejects(() => quoteFor('sol-to-usdc'))
  check('E a quote for a different token than asked → refused', /does not match its quote/.test(wrongMint?.message ?? ''))
  const devnet = await rejects(() => getSwapQuote(SOL_CHAINS['sol-devnet'], 'sol-to-usdc', 1_000_000n, OWNER))
  check('E swapping stays mainnet-only', /only available on Solana mainnet/.test(devnet?.message ?? ''))
}

console.log(failures === 0 ? '\nAll swap-gate checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
