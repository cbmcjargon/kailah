// check-swapgate.mjs — OFFLINE (recorded Jupiter answers, a fake chain, no network).
//
// The swap engine (src/lib/solswap.ts) builds SOL ↔ USDC swaps from Jupiter
// Swap V2 /build INSTRUCTIONS, assembles the transaction itself, and checks the
// exact bytes it would sign. Real /build answers recorded on 2026-10-25 drive
// this suite: two with Kailah's 0.5% fee (jupiter-build-fee-*.json, the honest
// builds) and two without (jupiter-build-*.json), each with the on-chain
// contents of its lookup tables. It proves:
//   A. an honest build passes in both directions, and the compiled transaction
//      is the one Jupiter described: same instructions, accounts and data,
//      our compute-unit limit, a single signer, tables resolved from the chain;
//   B. the decoded Jupiter instruction must say what we asked: any change to
//      the amount, quoted output, slippage, fee rate, fee account,
//      positive-slippage share, variant or transfer authority is refused, and
//      so is a build that drops Kailah's fee;
//   C. the build's shape is enforced: no "other" or tip instructions, v0 only,
//      only a unit-price compute-budget instruction, no foreign signer, no
//      second Jupiter instruction, no Approve, no CloseAccount paying someone
//      else, no program off the allow-list, no stake account;
//   D. lookup tables come from the chain, and Jupiter's list must agree;
//   E. the simulation must honor the decoded floor and pay the fee account
//      exactly 0.5% (not less, not more), and a failing simulation stops the
//      swap; a stale build is rebuilt; a 429 says "busy";
//   G. the fee wallet itself swaps with no fee (its USDC account is the fee
//      account), and nothing else can claim that exemption;
//   H. a route through a third token closes the token account it opens, so
//      its rent comes back instead of tripping the SOL-cost bound;
//   J. the audit of 2026-10-26: no top-level token transfers, no lamports to
//      anyone but us, token accounts opened only for us, the older `route`
//      forms refused, the swap's source/destination/mints pinned to our own
//      accounts, and the input side must move by exactly the input.
//   K. a route that fails its test run in one exchange (a live 0xffff,
//      2026-10-27): the failing exchange is named from the innermost log
//      line, ONE fresh route is built around it and passes the whole gate
//      again (a tampered fresh route is still refused), plumbing failures
//      are not re-routed, and the market-price check behind the review.
//   M. the 2026-10-29 upgrades: the rate and route the form and review show
//      come from the quote itself, a Jupiter swap reads as a swap in Solana
//      activity (never as "Received" the coin it bought), and the form's quote
//      refreshes every 20 s only while the form shows one and the page is
//      visible, keeping the old quote on screen until the new one lands.
//   P. a route too large for one transaction (live 2026-10-29: 1,708 bytes)
//      is caught before anything is simulated, rebuilt ONCE with Jupiter's
//      maxAccounts, and the smaller route passes the whole gate again (a
//      tampered one is still refused); still too large ends in plain words.
//   N. Solana activity reads version-1 transactions (a real one, recorded
//      2026-10-29: solana-history-v1-tx.json), which it used to skip, and
//      still skips what it can't read safely: a version the node refuses, a
//      version it doesn't know, account and balance lists that don't line up.
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
const { SOL_CHAINS, solUsdcAta } = await import('../src/lib/sol.ts')
const { stakeAccountAddress } = await import('../src/lib/solstake.ts')
const { getSwapQuote, prepareSwap, swapFeeBpsFor, swapSolShort, SWAP_SOL_FLOOR, SWAP_SLIPPAGE_BPS, SWAP_FEE_BPS, SWAP_FEE_ACCOUNT, SWAP_FEE_WALLET, innermostFailure, routeLabels, swapMarketGap, MARKET_GAP_WARN_PCT } = await import('../src/lib/solswap.ts')

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
const load = (name) => JSON.parse(readFileSync(`scripts/fixtures/jupiter-build-${name}.json`, 'utf8'))
const FIX = { 'sol-to-usdc': load('fee-sol-to-usdc'), 'usdc-to-sol': load('fee-usdc-to-sol') }
const NOFEE = { 'sol-to-usdc': load('sol-to-usdc'), 'usdc-to-sol': load('usdc-to-sol') }
const OWNER = FIX['sol-to-usdc'].request.taker
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const SOL_BEFORE = 50_000_000_000n
const USDC_BEFORE = 1_000_000_000n
const FEE_BEFORE = 37_211_240n
const UNITS_USED = 150_000

// --- the fake world ---------------------------------------------------------
let world
function resetWorld(direction, fixtures = FIX) {
  const fx = fixtures[direction]
  world = {
    direction,
    build: structuredClone(fx.build),
    tables: { ...fx.lookupTables },
    simulations: [],
    builds: 0,
    jupStatus: 200,
    simErr: null,
    // what the final simulation reports for our two accounts and the fee account
    shortfall: 0n,
    feeSkew: 0n,
    feeAccountMissing: false,
    // the fee the fake chain pays out (0 when the fee wallet swaps for itself)
    feeBps: SWAP_FEE_BPS,
    jupUrls: [],
    // token accounts that already exist on the fake chain, beyond our USDC one
    existing: new Set(),
    // the swap leaves a remainder in an intermediate account, so closing it fails
    dust: false,
    // lamports in a wSOL account the owner already had (the unwrap returns them)
    wsolLamports: 0n,
    // the route spent this much LESS of the input than it said (0 = honest)
    solSpendShort: 0n,
    usdcSpendShort: 0n,
    // simulations that fail, in order ({ err, logs }); later ones pass
    simFailures: [],
    // Jupiter's program → exchange-name list, and how often it was asked
    labelMap: {},
    labelStatus: 200,
    labelAsks: 0,
    // applied to the build Jupiter returns for a re-route (excludeDexes)
    onReroute: null,
    // applied to the build Jupiter returns for a smaller route (maxAccounts)
    onSmaller: null,
  }
}
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const wsolAtaOf = (owner) => solLib.tokenAddress({ mint: WSOL_MINT, owner, tokenProgram: solLib.TOKEN_PROGRAM })
const tokenAccountB64 = (amount) => {
  const b = new Uint8Array(165)
  new DataView(b.buffer).setBigUint64(64, amount, true)
  return base64.encode(b)
}
const rpcOk = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u === 'https://api.jup.ag/swap/v2/program-id-to-label') {
    world.labelAsks++
    if (world.labelStatus === 429) return new Response('{"error":"Rate limit exceeded"}', { status: 429 })
    return new Response(JSON.stringify(world.labelMap), { status: 200 })
  }
  if (u.startsWith('https://api.jup.ag/')) {
    if (u.includes('excludeDexes=') && world.onReroute) {
      world.onReroute(world)
      world.onReroute = null
    }
    if (u.includes('maxAccounts=') && world.onSmaller) {
      world.onSmaller(world)
      world.onSmaller = null
    }
    world.builds++
    world.jupUrls.push(u)
    if (world.jupStatus === 429) return new Response('{"error":"Rate limit exceeded"}', { status: 429 })
    return new Response(JSON.stringify(world.build), { status: 200 })
  }
  const { method, params } = JSON.parse(init.body)
  const q = world.build
  switch (method) {
    case 'getMultipleAccounts':
      return rpcOk({
        value: params[0].map((a) =>
          world.tables[a] ? { data: [world.tables[a], 'base64'] } : world.existing.has(a) ? { data: ['', 'base64'], lamports: 2_039_280 } : null,
        ),
      })
    case 'getLatestBlockhash':
      return rpcOk({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } })
    case 'getBalance':
      return rpcOk({ value: Number(SOL_BEFORE) })
    case 'getAccountInfo':
      world.accountReads?.push(params)
      if (params[0] === SWAP_FEE_ACCOUNT) return rpcOk({ value: world.feeAccountMissing ? null : { data: [tokenAccountB64(FEE_BEFORE), 'base64'] } })
      if (params[0] === wsolAtaOf(OWNER) || params[0] === wsolAtaOf(SWAP_FEE_WALLET)) {
        return rpcOk({ value: world.wsolLamports > 0n ? { lamports: Number(world.wsolLamports), data: ['', 'base64'] } : null })
      }
      // a first-time USDC holder has no USDC account yet
      if (world.usdcAtaMissing && params[0] === solUsdcAta(MAINNET, OWNER)) return rpcOk({ value: null })
      return rpcOk({ value: { data: [tokenAccountB64(USDC_BEFORE), 'base64'] } })
    case 'getMinimumBalanceForRentExemption':
      return rpcOk(2_039_280)
    case 'getSignatureStatuses':
      return rpcOk({ value: params[0].map(() => null) })
    case 'simulateTransaction': {
      world.simulations.push(params[0])
      if (world.simFailures.length > 0) {
        const f = world.simFailures.shift()
        return rpcOk({ value: { err: f.err, logs: f.logs, unitsConsumed: 171_000 } })
      }
      if (world.simErr) return rpcOk({ value: { err: world.simErr, logs: ['Program log: slippage exceeded'] } })
      const rent = strandedRent(params[0])
      if (rent === null) return rpcOk({ value: { err: { InstructionError: [9, { Custom: 11 }] }, logs: ['Program log: Error: Non-native account can only be closed if its balance is zero'] } })
      const wanted = params[1].accounts?.addresses
      if (!wanted) return rpcOk({ value: { err: null, logs: [], unitsConsumed: UNITS_USED } })
      const inA = BigInt(q.inAmount), out = BigInt(q.outAmount) - world.shortfall
      // Jupiter's measured arithmetic: selling SOL, the fee is 0.5% of the
      // gross USDC output; buying SOL, 0.5% of the USDC input.
      const bps = BigInt(world.feeBps)
      let userUsdc, fee
      if (bps === 0n) {
        fee = 0n
        userUsdc = world.direction === 'sol-to-usdc' ? out : -inA
      } else if (world.direction === 'sol-to-usdc') {
        const gross = (out * 10_000n + 9_999n - bps) / (10_000n - bps)
        fee = (gross * bps) / 10_000n
        userUsdc = gross - fee
      } else {
        fee = (inA * bps) / 10_000n
        userUsdc = -inA
      }
      world.fee = fee + world.feeSkew + (world.feeRaceOnce ?? 0n)
      // another user's swap fee landing between the reads and this simulation, once
      world.feeRaceOnce = 0n
      const solAfter =
        (world.direction === 'sol-to-usdc'
          ? SOL_BEFORE - inA - 6_000n + world.wsolLamports + world.solSpendShort - (world.usdcAtaMissing ? 2_039_280n : 0n)
          : SOL_BEFORE + out - 6_000n) - rent
      if (world.direction === 'usdc-to-sol') userUsdc += world.usdcSpendShort
      // the fee wallet's own USDC account IS the fee account
      const ataBefore = wanted[1] === SWAP_FEE_ACCOUNT ? FEE_BEFORE : world.usdcAtaMissing ? 0n : USDC_BEFORE
      const usdcAfter = ataBefore + userUsdc + (wanted[1] === SWAP_FEE_ACCOUNT ? world.fee : 0n)
      return rpcOk({
        value: {
          err: null,
          logs: [],
          unitsConsumed: UNITS_USED,
          accounts: [
            { lamports: Number(solAfter) },
            { lamports: 2_039_280, data: { parsed: { info: { tokenAmount: { amount: usdcAfter.toString() } } } } },
            ...(wanted.length > 2 ? [{ lamports: 2_039_280, data: { parsed: { info: { tokenAmount: { amount: (FEE_BEFORE + world.fee).toString() } } } } }] : []),
          ],
        },
      })
    }
    default:
      throw new Error(`unexpected RPC ${method}`)
  }
}

const quoteFor = (direction, owner = OWNER) => getSwapQuote(MAINNET, direction, BigInt(FIX[direction].request.amount), owner)
async function run(direction, mutate, owner = OWNER, fixtures = FIX) {
  resetWorld(direction, fixtures)
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
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const allIxs = (b) => [...b.computeBudgetInstructions, ...b.setupInstructions, b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : [])]
/** Re-address a recorded build to `who`: their address and their own token accounts take the taker's. */
function retarget(w, who) {
  const b = w.build
  const moved = new Map([[solUsdcAta(MAINNET, OWNER), solUsdcAta(MAINNET, who)]])
  for (const i of b.setupInstructions) {
    if (i.programId === ATA_PROGRAM && i.accounts[2].pubkey === OWNER) {
      moved.set(i.accounts[1].pubkey, solLib.tokenAddress({ mint: i.accounts[3].pubkey, owner: who, tokenProgram: i.accounts[5].pubkey }))
    }
  }
  for (const i of allIxs(b)) for (const a of i.accounts) a.pubkey = a.pubkey === OWNER ? who : moved.get(a.pubkey) ?? a.pubkey
}

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

// The chain's rent: an intermediate token account this transaction opens and
// leaves open costs us its rent; one it also closes costs nothing, unless the
// swap left a remainder in it (world.dust) and the close fails (null).
const BASE_MINTS = ['So11111111111111111111111111111111111111112', MAINNET.usdc.mint]
function strandedRent(txB64) {
  const ixs = resolveCompiled(txB64, world.tables).instructions
  const opened = ixs
    .filter((i) => i.program === ATA_PROGRAM && !BASE_MINTS.includes(i.keys[3]) && !world.existing.has(i.keys[1]))
    .map((i) => i.keys[1])
  const closed = new Set(ixs.filter((i) => i.program !== ATA_PROGRAM && i.data.length === 1 && i.data[0] === 9).map((i) => i.keys[0]))
  if (world.dust && opened.some((a) => closed.has(a))) return null
  return BigInt(opened.filter((a) => !closed.has(a)).length) * 2_039_280n
}
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
  check(`A ${direction}: the fee shown is what the simulation paid Kailah's account`, p.swapFee === world.fee && p.swapFee > 0n, `${p.swapFee} USDC units`)
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
  const r = await run('usdc-to-sol', (w) => retarget(w, addr), addr)
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
  ['the fee raised to 1%', (w) => { const d = ixData(w); patchU16(d, 26, 100); setIxData(w, d) }],
  ['the fee dropped to 0', (w) => { const d = ixData(w); patchU16(d, 26, 0); setIxData(w, d) }],
  ['the fee account swapped for another', (w) => { w.build.swapInstruction.accounts[10] = { pubkey: OTHER, isSigner: false, isWritable: true } }],
  ['a positive-slippage share slipped in', (w) => { const d = ixData(w); patchU16(d, 28, 10); setIxData(w, d) }],
  ['the variant switched to exact-out', (w) => { const d = ixData(w); d.set(disc('exact_out_route_v2'), 0); setIxData(w, d) }],
  ['an unknown Jupiter instruction', (w) => { const d = ixData(w); d.set(disc('claim_token'), 0); setIxData(w, d) }],
  ['the transfer authority is someone else', (w) => { w.build.swapInstruction.accounts[0] = { pubkey: OTHER, isSigner: false, isWritable: false } }],
]
for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
  const simulated = []
  for (const [label, mutate] of B) {
    const r = await run(direction, mutate)
    check(`B ${direction}: ${label} → refused`, refused(r), r.err?.message?.slice(0, 50) ?? 'accepted!')
    if (world.simulations.length > 0) simulated.push(label)
  }
  check(`B ${direction}: every tampered field is refused before anything is simulated`, simulated.length === 0, simulated.join('; '))
}
{
  // The older route layout (route plan first, fields at the end) is decoded
  // too: authority in slot 1, the named platform_fee_account in slot 6.
  const v1 = (fee, feeAccount = SWAP_FEE_ACCOUNT) => (w) => {
    const acc = w.build.swapInstruction.accounts
    const plain = (k) => ({ pubkey: acc[k].pubkey, isSigner: false, isWritable: acc[k].isWritable })
    w.build.swapInstruction.accounts = [
      plain(5), acc[0], plain(1), plain(2), plain(7), plain(4),
      { pubkey: feeAccount, isSigner: false, isWritable: true }, plain(8), plain(9), ...acc.slice(11),
    ]
    const tail = new Uint8Array(19)
    new DataView(tail.buffer).setBigUint64(0, BigInt(w.build.inAmount), true)
    new DataView(tail.buffer).setBigUint64(8, BigInt(w.build.outAmount), true)
    new DataView(tail.buffer).setUint16(16, SWAP_SLIPPAGE_BPS, true)
    tail[18] = fee
    setIxData(w, new Uint8Array([...disc('route'), 0, 0, 0, 0, ...tail]))
  }
  const ok = await run('sol-to-usdc', v1(SWAP_FEE_BPS))
  check('B the older `route` layout is refused even with honest fields (its fields sit after the route plan; the program ignores trailing bytes)', refused(ok) && world.simulations.length === 0, ok.err?.message?.slice(0, 50) ?? 'accepted!')
  check('B the older `route` layout with a higher fee is refused', refused(await run('sol-to-usdc', v1(100))))
  check('B the older `route` layout paying another fee account is refused', refused(await run('sol-to-usdc', v1(SWAP_FEE_BPS, OTHER))))
}
for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
  const r = await run(direction, undefined, OWNER, NOFEE)
  check(`B ${direction}: a real build WITHOUT Kailah's fee is refused`, refused(r), r.err?.message?.slice(0, 50) ?? 'accepted!')
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

console.log('--- F. the fee account gets exactly 0.5% ---')
for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
  for (const [label, skew] of [['2 units less than 0.5%', -2n], ['2 units more than 0.5% (overcharging the user)', 2n]]) {
    const r = await run(direction, (w) => { w.feeSkew = skew })
    check(`F ${direction}: the fee account receiving ${label} → refused`, refused(r), r.err?.message?.slice(0, 50) ?? 'accepted!')
  }
  const r0 = await run(direction, (w) => { w.feeSkew = -(10n ** 12n) })
  check(`F ${direction}: the fee account receiving nothing → refused`, refused(r0), r0.err?.message?.slice(0, 50) ?? 'accepted!')
  const r1 = await run(direction, (w) => { w.feeSkew = 1n })
  check(`F ${direction}: a one-unit rounding difference is tolerated`, r1.err === null, r1.err?.message?.slice(0, 60))
}
{
  const r = await run('sol-to-usdc', (w) => { w.feeAccountMissing = true })
  check('F a missing fee account stops the swap with a plain message, before signing', /Swaps are unavailable right now/.test(r.err?.message ?? ''), r.err?.message?.slice(0, 60))
  check('F the fee account constant is the fee wallet\'s USDC account', solUsdcAta(MAINNET, SWAP_FEE_WALLET) === SWAP_FEE_ACCOUNT && SWAP_FEE_BPS === 50)
  resetWorld('sol-to-usdc')
  const quote = await quoteFor('sol-to-usdc')
  const est = quote.estimatedFee
  check('F the form\'s fee estimate is 0.5% of the gross output', est > 0n && est * 10_000n / (quote.outAmount + est) >= 49n && est * 10_000n / (quote.outAmount + est) <= 50n, `${est}`)
}

console.log('--- G. the fee wallet swaps for itself ---')
{
  // Its USDC account IS the fee account, so it pays no fee (a swap from it
  // used to be refused: the fee check saw the whole output land in the fee
  // account). The fee-free recordings, retargeted at the fee wallet: its own
  // address and token accounts take the recorded taker's.
  const feeWalletAta = (mint, tokenProgram) => solLib.tokenAddress({ mint, owner: SWAP_FEE_WALLET, tokenProgram })
  const asFeeWallet = (w) => {
    retarget(w, SWAP_FEE_WALLET)
    w.feeBps = 0
  }
  check('G the fee wallet pays no fee; every other wallet pays 0.5%', swapFeeBpsFor(MAINNET, SWAP_FEE_WALLET) === 0 && swapFeeBpsFor(MAINNET, OWNER) === SWAP_FEE_BPS)
  // the form holds a typed amount only to what a swap surely needs: the base
  // fee and the temporary wrapped-SOL deposit (0.002044 SOL); it refused at
  // 0.005 / 0.003 SOL, turning away swaps that went through (review 2026-10-28)
  check('G2 a swap is held back only when it surely can\'t fit: base fee + the returned temporary deposit, not a fixed 0.005 / 0.003 SOL',
    SWAP_SOL_FLOOR === 2_044_280n &&
      !swapSolShort('sol-to-usdc', 10_000_000n, 12_500_000n) && swapSolShort('sol-to-usdc', 10_000_000n, 12_000_000n) &&
      !swapSolShort('usdc-to-sol', 1_000_000n, 2_500_000n) && swapSolShort('usdc-to-sol', 1_000_000n, 2_000_000n))
  for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
    const r = await run(direction, asFeeWallet, SWAP_FEE_WALLET, NOFEE)
    check(`G ${direction}: the fee wallet's swap passes, with no fee`, r.err === null && r.prepared?.swapFee === 0n && r.prepared?.swapFeeBps === 0, r.err?.message?.slice(0, 60))
    if (direction === 'sol-to-usdc') {
      // this recorded route runs through a Token-2022 stablecoin (2b1kV6…)
      const t22 = NOFEE[direction].build.setupInstructions.find((i) => i.programId === ATA_PROGRAM && i.accounts[5].pubkey === solLib.TOKEN_PROGRAM2022)
      const last = r.prepared && resolveCompiled(r.prepared.txBase64, NOFEE[direction].lookupTables).instructions.at(-1)
      check(
        'G sol-to-usdc: its recorded route through a Token-2022 token closes that account at the end',
        t22 !== undefined && last?.program === solLib.TOKEN_PROGRAM2022 && hex(last.data) === '09' &&
          last.keys.join() === [feeWalletAta(t22.accounts[3].pubkey, solLib.TOKEN_PROGRAM2022), SWAP_FEE_WALLET, SWAP_FEE_WALLET].join(),
      )
    }
    check(`G ${direction}: its build request asks Jupiter for no fee`, world.jupUrls.length > 0 && world.jupUrls.every((u) => !u.includes('platformFeeBps') && !u.includes('feeAccount')))
    check(`G ${direction}: the review shows the full output as received`, r.prepared !== null && (direction === 'sol-to-usdc' ? r.prepared.simulatedUsdcDelta === BigInt(NOFEE[direction].build.outAmount) : r.prepared.simulatedUsdcDelta === -BigInt(NOFEE[direction].build.inAmount)))
    const charged = await run(direction, (w) => { asFeeWallet(w); w.feeBps = SWAP_FEE_BPS }, SWAP_FEE_WALLET, FIX)
    check(`G ${direction}: a build that charges the fee wallet a fee anyway is refused`, refused(charged), charged.err?.message?.slice(0, 50) ?? 'accepted!')
  }
  resetWorld('sol-to-usdc')
  await quoteFor('sol-to-usdc')
  check('G a normal wallet\'s build request asks for exactly 0.5% into the fee account', world.jupUrls.at(-1).includes(`platformFeeBps=${SWAP_FEE_BPS}`) && world.jupUrls.at(-1).includes(`feeAccount=${SWAP_FEE_ACCOUNT}`))
  resetWorld('sol-to-usdc')
  const q = await quoteFor('sol-to-usdc')
  const e = await rejects(() => prepareSwap(MAINNET, OWNER, { ...q, feeBps: 0 }))
  check('G a quote object claiming "no fee" for a normal wallet is refused (the rate comes from the owner)', /does not match its quote/.test(e?.message ?? ''))
}

console.log('--- H. a route through a third token closes the account it opens ---')
{
  const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
  const ataOf = (owner, mint, tokenProgram = solLib.TOKEN_PROGRAM) => solLib.tokenAddress({ mint, owner, tokenProgram })
  // Jupiter's createATA (idempotent): payer, account, wallet, mint, system, token program
  const openAta = (wallet, mint, tokenProgram = solLib.TOKEN_PROGRAM, account = ataOf(wallet, mint, tokenProgram)) =>
    ix(ATA_PROGRAM, [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ], [1])
  const via = (...args) => (w) => { w.build.setupInstructions.push(openAta(...args)) }
  const isCloseOf = (i, account, program = solLib.TOKEN_PROGRAM) =>
    i.program === program && hex(i.data) === '09' && i.keys.join() === [account, OWNER, OWNER].join()
  const usd1 = ataOf(OWNER, USD1)
  for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
    const plain = await run(direction)
    const r = await run(direction, via(OWNER, USD1))
    check(`H ${direction}: a route that opens a USD1 account for us passes`, r.err === null, r.err?.message?.slice(0, 60))
    if (!r.prepared) continue
    const tx = resolveCompiled(r.prepared.txBase64, FIX[direction].lookupTables)
    check(`H ${direction}: the last instruction closes that account, rent back to us`, isCloseOf(tx.instructions.at(-1), usd1))
    check(`H ${direction}: the units were measured with the close in place`, isCloseOf(resolveCompiled(world.simulations[0], world.tables).instructions.at(-1), usd1))
    check(`H ${direction}: the rent is not part of the swap's SOL cost`, r.prepared.simulatedSolDelta === plain.prepared?.simulatedSolDelta, `${r.prepared.simulatedSolDelta} vs ${plain.prepared?.simulatedSolDelta}`)
  }
  {
    const r = await run('sol-to-usdc', (w) => { via(OWNER, USD1)(w); w.existing.add(usd1) })
    const tx = r.prepared && resolveCompiled(r.prepared.txBase64, FIX['sol-to-usdc'].lookupTables)
    check('H a USD1 account we already have is left open (no close added)', r.err === null && tx !== null && !tx.instructions.some((i) => i.keys[0] === usd1 && hex(i.data) === '09'), r.err?.message?.slice(0, 60))
    const t22 = ataOf(OWNER, USD1, solLib.TOKEN_PROGRAM2022)
    const r2 = await run('sol-to-usdc', via(OWNER, USD1, solLib.TOKEN_PROGRAM2022))
    const tx2 = r2.prepared && resolveCompiled(r2.prepared.txBase64, FIX['sol-to-usdc'].lookupTables)
    check('H a Token-2022 intermediate is closed by the Token-2022 program', r2.err === null && tx2 !== null && isCloseOf(tx2.instructions.at(-1), t22, solLib.TOKEN_PROGRAM2022), r2.err?.message?.slice(0, 60))
    const r3 = await run('sol-to-usdc', (w) => { via(OWNER, USD1)(w); w.dust = true })
    check('H a close that fails (the swap left a remainder) stops the swap before signing', /fails in simulation/.test(r3.err?.message ?? ''), r3.err?.message?.slice(0, 60))
  }
  for (const [label, mutate] of [
    ['an intermediate account that is not our derived address', via(OWNER, USD1, solLib.TOKEN_PROGRAM, OTHER)],
    ['an intermediate account under an unknown token program', via(OWNER, USD1, OTHER)],
  ]) {
    const r = await run('sol-to-usdc', mutate)
    check(`H ${label} → refused before anything is simulated`, refused(r) && world.simulations.length === 0, r.err?.message?.slice(0, 50) ?? 'accepted!')
  }
  for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
    const r = await run(direction, via(OTHER, USD1))
    check(`H ${direction}: opening a token account for SOMEONE ELSE → refused before anything is simulated`, refused(r) && world.simulations.length === 0, r.err?.message?.slice(0, 50) ?? 'accepted!')
  }
}

console.log('--- J. the audit of 2026-10-26 ---')
{
  const TOKEN = solLib.TOKEN_PROGRAM, TOKEN22 = solLib.TOKEN_PROGRAM2022
  const USDT_ATA = solLib.tokenAddress({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', owner: OWNER, tokenProgram: TOKEN })
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return [...b] }
  const transfer = (prog) => ix(prog, [{ pubkey: USDT_ATA, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: OWNER, isSigner: true, isWritable: false }], [3, ...u64(5_000_000n)])
  const transferChecked = (prog) => ix(prog, [{ pubkey: USDT_ATA, isSigner: false, isWritable: true }, { pubkey: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', isSigner: false, isWritable: false }, { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: OWNER, isSigner: true, isWritable: false }], [12, ...u64(5_000_000n), 6])
  const sysTransfer = (to, lamports) => ix('11111111111111111111111111111111', [{ pubkey: OWNER, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], [2, 0, 0, 0, ...u64(lamports)])
  const initAccount = (ownerOf) => ix(TOKEN, [{ pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, { pubkey: ownerOf, isSigner: false, isWritable: false }, { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false }], [1])
  const initAccount3 = (ownerOf) => ix(TOKEN, [{ pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: WSOL_MINT, isSigner: false, isWritable: false }], [18, ...base58.decode(ownerOf)])
  const beforeSim = (r) => refused(r) && world.simulations.length === 0
  const J = [
    ['a Token Transfer out of our USDT account, in setup', (w) => { w.build.setupInstructions.push(transfer(TOKEN)) }],
    ['a Token TransferChecked out of our USDT account, as cleanup', (w) => { w.build.cleanupInstruction = transferChecked(TOKEN) }],
    ['a Token-2022 TransferChecked, in setup', (w) => { w.build.setupInstructions.push(transferChecked(TOKEN22)) }],
    ['a System Transfer of lamports to a third party', (w) => { w.build.setupInstructions.push(sysTransfer(OTHER, 400_000n)) }],
    ['a token account initialized for someone else (InitializeAccount)', (w) => { w.build.setupInstructions.push(initAccount(OTHER)) }],
    ['a token account initialized for someone else (InitializeAccount3)', (w) => { w.build.setupInstructions.push(initAccount3(OTHER)) }],
    ['an ATA-program instruction that is not create (RecoverNested)', (w) => { const c = structuredClone(w.build.setupInstructions[0]); c.data = base64.encode(new Uint8Array([2])); w.build.setupInstructions.push(c) }],
    ['the source slot pointing at a different account of ours', (w) => { swapAccts(w)[1] = { ...swapAccts(w)[1], pubkey: USDT_ATA } }],
    ['the destination slot pointing elsewhere', (w) => { swapAccts(w)[2] = { ...swapAccts(w)[2], pubkey: OTHER } }],
    ['the source mint changed', (w) => { swapAccts(w)[3] = { ...swapAccts(w)[3], pubkey: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' } }],
    ['the destination mint changed', (w) => { swapAccts(w)[4] = { ...swapAccts(w)[4], pubkey: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' } }],
    ['the token program slot set to Token-2022', (w) => { swapAccts(w)[5] = { ...swapAccts(w)[5], pubkey: TOKEN22 } }],
  ]
  for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
    for (const [label, mutate] of J) {
      const r = await run(direction, mutate)
      check(`J ${direction}: ${label} → refused before anything is simulated`, beforeSim(r), r.err?.message?.slice(0, 50) ?? (world.simulations.length ? 'simulated first' : 'accepted!'))
    }
    const ours = await run(direction, (w) => { w.build.setupInstructions.push(sysTransfer(wsolAtaOf(OWNER), 1_000n), initAccount3(OWNER)) })
    check(`J ${direction}: a System Transfer to our own wSOL account and a token account initialized for us still pass`, ours.err === null, ours.err?.message?.slice(0, 60))
  }
  {
    // shared_accounts_route_v2: the recorded route_v2 reshaped to the shared layout
    const shared = (mutate) => (w) => {
      const acc = swapAccts(w)
      const plain = (k) => ({ pubkey: acc[k].pubkey, isSigner: false, isWritable: acc[k].isWritable })
      w.build.swapInstruction.accounts = [
        { pubkey: OTHER, isSigner: false, isWritable: false }, acc[0], acc[1],
        { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true },
        acc[2], plain(3), plain(4), plain(5), plain(6), plain(8), plain(9), ...acc.slice(10),
      ]
      const d = ixData(w)
      setIxData(w, new Uint8Array([...disc('shared_accounts_route_v2'), 0, ...d.subarray(8)]))
      mutate?.(w)
    }
    const ok = await run('sol-to-usdc', shared())
    check('J shared_accounts_route_v2 with our accounts in its slots passes', ok.err === null && ok.prepared?.swapFee > 0n, ok.err?.message?.slice(0, 60))
    const bad = await run('sol-to-usdc', shared((w) => { swapAccts(w)[2] = { ...swapAccts(w)[2], pubkey: USDT_ATA } }))
    check('J shared_accounts_route_v2 with the source slot moved → refused', beforeSim(bad), bad.err?.message?.slice(0, 50) ?? 'accepted!')
  }
  {
    const r1 = await run('usdc-to-sol', (w) => { w.usdcSpendShort = 1n })
    check('J usdc-to-sol: the route spending less USDC than the input → refused', refused(r1), r1.err?.message?.slice(0, 50) ?? 'accepted!')
    const r2 = await run('sol-to-usdc', (w) => { w.solSpendShort = 2_000n })
    check('J sol-to-usdc: the route spending less SOL than the input → refused', refused(r2), r2.err?.message?.slice(0, 50) ?? 'accepted!')
    const r3 = await run('sol-to-usdc', (w) => { w.wsolLamports = 3_000_000n })
    check('J sol-to-usdc: a wSOL account we already had, returned by the unwrap, is not mistaken for a shortfall', r3.err === null, r3.err?.message?.slice(0, 60))
  }
}

console.log('--- K. a route that fails in one exchange is named and re-routed once ---')
{
  const BISON = 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi'
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  // what the RPC returned for the failure seen live, with the exchange's own lines kept
  const exchangeFails = (program = BISON, code = '0xffff') => ({
    err: { InstructionError: [5, { Custom: parseInt(code, 16) }] },
    logs: [
      `Program ${JUP6} invoke [1]`,
      'Program log: Instruction: RouteV2',
      `Program ${program} invoke [2]`,
      `Program ${program} consumed 12000 of 1300000 compute units`,
      `Program ${program} failed: custom program error: ${code}`,
      `Program ${JUP6} consumed 143814 of 1372870 compute units`,
      `Program ${JUP6} failed: custom program error: ${code}`,
    ],
  })
  // the same, with the exchange's lines cut from the logs (only Jupiter's remain)
  const truncated = (code = '0xffff') => ({
    err: { InstructionError: [5, { Custom: parseInt(code, 16) }] },
    logs: ['Log truncated', `Program ${JUP6} consumed 143814 of 1372870 compute units`, `Program ${JUP6} failed: custom program error: ${code}`],
  })
  const excluded = (w) => w.jupUrls.filter((u) => u.includes('excludeDexes=')).map((u) => decodeURIComponent(u.split('excludeDexes=')[1].split('&')[0]))

  const f = innermostFailure(exchangeFails().logs)
  check('K the innermost failing program is the exchange, not Jupiter repeating it', f?.program === BISON && f?.reason === 'custom program error: 0xffff', JSON.stringify(f))
  check('K no "failed" line → no culprit', innermostFailure(['Program log: slippage exceeded']) === null)
  check('K the route plan names its exchanges in order, each once',
    routeLabels(FIX['sol-to-usdc'].build).join() === 'BisonFi' &&
      routeLabels(NOFEE['sol-to-usdc'].build).join() === '1DEX,Whirlpool,Manifest,Meteora DLMM' &&
      routeLabels({ routePlan: [{ swapInfo: { label: 'A,B' } }, { swapInfo: { label: 7 } }, null] }).length === 0)

  for (const direction of ['sol-to-usdc', 'usdc-to-sol']) {
    // the exchange program each recorded route calls (BisonFi; TesseraV)
    const prog = direction === 'sol-to-usdc' ? BISON : 'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH'
    const label = routeLabels(FIX[direction].build)[0]
    const r = await run(direction, (w) => {
      w.simFailures = [exchangeFails(prog)]
      w.labelMap = { [prog]: label }
    })
    check(`K ${direction}: an exchange failing the test run → one fresh route around it, which passes the whole gate`,
      r.err === null && r.prepared?.reroutedAround === `the exchange ${label}` && r.prepared.swapFee > 0n && world.builds === 2 && excluded(world).join() === label && world.labelAsks === 1,
      r.err?.message?.slice(0, 80) ?? `${r.prepared?.reroutedAround} builds=${world.builds} excl=${excluded(world)}`)
  }
  {
    const r = await run('sol-to-usdc')
    check('K a route that passes first time is not re-routed and asks nothing more', r.err === null && r.prepared.reroutedAround === null && world.builds === 1 && world.labelAsks === 0)
  }
  {
    // the fresh route is dishonest: its simulated outcome falls 1% below its own floor
    const r = await run('sol-to-usdc', (w) => {
      w.simFailures = [exchangeFails()]
      w.labelMap = { [BISON]: 'BisonFi' }
      w.onReroute = (w2) => { w2.shortfall = BigInt(w2.build.outAmount) / 100n }
    })
    check('K a fresh route that does not honor the quote is refused like any other', refused(r) && world.builds === 2, r.err?.message?.slice(0, 60) ?? 'accepted!')
    const r2 = await run('sol-to-usdc', (w) => {
      w.simFailures = [exchangeFails()]
      w.labelMap = { [BISON]: 'BisonFi' }
      w.onReroute = (w2) => { const d = ixData(w2); patchU16(d, 24, 300); setIxData(w2, d) }
    })
    check('K a fresh route with its slippage raised is refused before it is simulated', refused(r2) && world.simulations.length === 1, r2.err?.message?.slice(0, 60) ?? 'accepted!')
  }
  {
    const r = await run('sol-to-usdc', (w) => {
      w.simFailures = [exchangeFails(), exchangeFails(BISON, '0x1')]
      w.labelMap = { [BISON]: 'BisonFi' }
    })
    const m = r.err?.message ?? ''
    check('K both routes failing → refused once, naming both, and no third try',
      r.prepared === null && /not signed or sent/.test(m) && /The exchange BisonFi rejected the first route, and the exchange BisonFi rejected a fresh one \(custom program error: 0x1\)/.test(m) && /try again in a minute/.test(m) && world.builds === 2,
      m.slice(0, 160))
  }
  {
    const r = await run('sol-to-usdc', (w) => {
      w.simFailures = [{ err: { InstructionError: [3, { Custom: 1 }] }, logs: [`Program ${TOKEN} invoke [1]`, 'Program log: Error: insufficient funds', `Program ${TOKEN} failed: custom program error: 0x1`] }]
    })
    check('K a failure in the transaction\'s own plumbing is not re-routed; a shortfall says so in plain words (bug audit 2026-10-27, BM21)',
      r.prepared === null && world.builds === 1 && /^The swap was not signed: there isn't enough of the token you're paying with/.test(r.err?.message ?? ''), r.err?.message?.slice(0, 120))
    const r2 = await run('sol-to-usdc', (w) => { w.simFailures = [{ err: 'InsufficientFundsForFee', logs: [] }] })
    check('K a failure with no logs is not re-routed (and a fee shortfall is said plainly)', r2.prepared === null && world.builds === 1 && /not signed: there isn't enough SOL for the network fee/.test(r2.err?.message ?? ''), r2.err?.message?.slice(0, 120))
    const r3 = await run('sol-to-usdc', (w) => { w.simErr = { InstructionError: [3, { Custom: 6001 }] } })
    check('K the older failing-simulation shape still stops the swap, with no re-route', r3.prepared === null && world.builds === 1 && /fails in simulation/.test(r3.err?.message ?? ''))
  }
  {
    const slip = { err: { InstructionError: [5, { Custom: 6001 }] }, logs: [`Program ${JUP6} invoke [1]`, 'Program log: Error: SlippageToleranceExceeded', `Program ${JUP6} failed: custom program error: 0x1771`] }
    const r = await run('sol-to-usdc', (w) => { w.simFailures = [slip] })
    check('K Jupiter\'s own failure (the price moved) → a fresh quote, excluding no exchange',
      r.err === null && r.prepared.reroutedAround === "Jupiter's router" && world.builds === 2 && excluded(world).length === 0 && world.labelAsks === 0,
      r.err?.message?.slice(0, 80) ?? `${world.builds} builds`)
    const r2 = await run('sol-to-usdc', (w) => { w.simFailures = [slip, slip] })
    check('K …and says so in plain words when the fresh one fails too', /a fresh one \(the price moved past the 0\.5% slippage limit\)/.test(r2.err?.message ?? ''), r2.err?.message?.slice(0, 160))
  }
  {
    const r = await run('sol-to-usdc', (w) => { w.simFailures = [truncated()] })
    check('K exchange lines cut from the logs: a one-exchange route still names it',
      r.err === null && r.prepared.reroutedAround === 'the exchange BisonFi' && excluded(world).join() === 'BisonFi' && world.labelAsks === 0,
      r.err?.message?.slice(0, 80) ?? r.prepared?.reroutedAround)
    const r2 = await run('sol-to-usdc', (w) => {
      w.build.routePlan = [...w.build.routePlan, { swapInfo: { label: 'Meteora DLMM' } }]
      w.simFailures = [truncated()]
    })
    check('K …and a route through several exchanges routes around all of them, naming none',
      r2.err === null && r2.prepared.reroutedAround === 'an exchange on the route' && excluded(world).join() === 'BisonFi,Meteora DLMM',
      r2.err?.message?.slice(0, 80) ?? `${r2.prepared?.reroutedAround} excl=${excluded(world)}`)
    check('K exchange names with spaces are URL-encoded', world.jupUrls.some((u) => u.includes('excludeDexes=BisonFi,Meteora%20DLMM')))
    const r3 = await run('sol-to-usdc', (w) => {
      w.build.routePlan = [...w.build.routePlan, { swapInfo: { label: 'Kipseli' } }]
      w.simFailures = [exchangeFails()]
      w.labelStatus = 429
    })
    check('K Jupiter\'s name list unavailable → route around every exchange on the failed route',
      r3.err === null && r3.prepared.reroutedAround === 'an exchange on the route' && excluded(world).join() === 'BisonFi,Kipseli',
      r3.err?.message?.slice(0, 80) ?? excluded(world).join())
    const r4 = await run('sol-to-usdc', (w) => {
      w.simFailures = [exchangeFails()]
      w.labelMap = { [BISON]: 'BisonFi&excludeDexes=,x' }
    })
    check('K a name from Jupiter\'s list that is not a plain name is ignored',
      r4.err === null && r4.prepared.reroutedAround === 'the exchange BisonFi' && excluded(world).join() === 'BisonFi',
      r4.err?.message?.slice(0, 80) ?? r4.prepared?.reroutedAround)
  }
  {
    resetWorld('sol-to-usdc')
    const bad = await rejects(() => getSwapQuote(MAINNET, 'sol-to-usdc', 1_000_000n, OWNER, ['Orca,Raydium']))
    check('K an exclusion that is not a plain name is refused before any request', /does not match its quote/.test(bad?.message ?? '') && world.builds === 0)
  }
  {
    // the market check behind the form AND the review (display only)
    const g0 = swapMarketGap('sol-to-usdc', 1_000_000_000n, 100_000_000n, 100, 1, 6)
    const g5 = swapMarketGap('sol-to-usdc', 1_000_000_000n, 95_000_000n, 100, 1, 6)
    const gUp = swapMarketGap('usdc-to-sol', 100_000_000n, 1_010_000_000n, 100, 1, 6)
    const g4 = swapMarketGap('usdc-to-sol', 100_000_000n, 960_000_000n, 100, 1, 6)
    check('K market gap: a fair quote is ~0%, 5% under is flagged, buying SOL is priced the other way round',
      Math.abs(g0.pct) < 1e-9 && g5.pct > MARKET_GAP_WARN_PCT && Math.abs(g5.pct - 5) < 1e-9 && gUp.pct < 0 && Math.abs(g4.pct - 4) < 1e-9 && MARKET_GAP_WARN_PCT === 3,
      JSON.stringify([g0?.pct, g5?.pct, gUp?.pct, g4?.pct]))
    check('K market gap: no price, no verdict',
      swapMarketGap('sol-to-usdc', 1n, 1n, undefined, 1, 6) === null && swapMarketGap('usdc-to-sol', 1n, 1n, 100, undefined, 6) === null && swapMarketGap('sol-to-usdc', 1n, 1n, 0, 1, 6) === null)
  }
}

console.log('--- L. the 2026-10-27 audit: shortfalls in plain words, the form\'s quote and reserve, reviews that expire ---')
{
  const { swapShortfall } = await import('../src/lib/solswap.ts')
  const SYS = '11111111111111111111111111111111'
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const fail = (program, reason) => [`Program ${program} invoke [2]`, `Program ${program} failed: ${reason}`]
  check('L1 the System program\'s 0x1 (not enough lamports) reads as not enough SOL, swap a little less (BM21)',
    /isn't enough SOL for the swap/.test(swapShortfall({ InstructionError: [3, { Custom: 1 }] }, fail(SYS, 'custom program error: 0x1')) ?? ''))
  check('L1b ...as does a "Transfer: insufficient lamports" log line', /isn't enough SOL/.test(swapShortfall(null, ['Transfer: insufficient lamports 1000, need 2039280']) ?? ''))
  check('L2 the Token program\'s 0x1 reads as not enough of the token', /isn't enough of the token/.test(swapShortfall({ InstructionError: [4, { Custom: 1 }] }, fail(TOKEN, 'custom program error: 0x1')) ?? ''))
  check('L3 InsufficientFundsForRent reads as the rent minimum, InsufficientFundsForFee as the fee',
    /rent minimum/.test(swapShortfall({ InsufficientFundsForRent: { account_index: 0 } }, []) ?? '') && /network fee/.test(swapShortfall('InsufficientFundsForFee', []) ?? ''))
  check('L4 an exchange\'s failure is not a shortfall (it is named and re-routed, K)', swapShortfall({ InstructionError: [3, { Custom: 6001 }] }, fail('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'custom program error: 0x1771')) === null)

  const { readFileSync } = await import('node:fs')
  const swapForm = readFileSync(new URL('../src/components/SolSwapModal.tsx', import.meta.url), 'utf8')
  check('L5 the form\'s quote sequence moves on before any early return, so a quote in flight can\'t land on a cleared amount (BM20)',
    /useEffect\(\(\) => \{\n    const seq = \+\+quoteSeqRef\.current/.test(swapForm))
  check('L5b Continue takes only the quote for what the form says now (direction and amount) (BM20)',
    /quote\.direction !== direction \|\| quote\.inAmount !== parsedAmount\) return/.test(swapForm))
  check('L5c the review and success screens label the swap by its own direction, not the toggle (BM20)',
    /step\.prepared\.direction : direction/.test(swapForm) && /rs\.fmtIn\(step\.prepared\.inAmount\)\} \{rs\.inSymbol\}/.test(swapForm) && !/\{fmtIn\(step\.prepared/.test(swapForm))
  check('L6 the form checks the SOL the swap surely needs before quoting (BM21; the floor itself is G2)',
    /swapSolShort\(direction, parsedAmount, state\.balance\)/.test(swapForm) && /\|\| solShort\)/.test(swapForm))
  const sendForm = readFileSync(new URL('../src/components/SolSendModal.tsx', import.meta.url), 'utf8')
  const stakeForm = readFileSync(new URL('../src/components/SolStakeModal.tsx', import.meta.url), 'utf8')
  const sol = await import('../src/lib/sol.ts')
  check('L7 a review left open past SOL_REVIEW_FRESH_MS (45 s, inside a blockhash\'s life) is prepared again before signing — send, stake and swap (BM17)',
    sol.SOL_REVIEW_FRESH_MS === 45_000 &&
      /Date\.now\(\) - step\.at > SOL_REVIEW_FRESH_MS \? handleContinue\(true\)/.test(sendForm) &&
      /Date\.now\(\) - step\.at > SOL_REVIEW_FRESH_MS \? runPrepare\(step\.redo, true\)/.test(stakeForm) &&
      /if \(Date\.now\(\) - step\.at > SOL_REVIEW_FRESH_MS\) \{\n\s+setExpiredNote\(true\)/.test(swapForm))

  // BL24: the shared fee account, and the balance reads' commitment
  const calm = await run('usdc-to-sol')
  const baseSims = world.simulations.length
  const raced = await run('usdc-to-sol', (w) => {
    w.feeRaceOnce = 1_234n
    w.accountReads = []
  })
  check('L8 another user\'s fee landing between the reads and the simulation no longer refuses an honest swap: it is measured again (BL24)',
    calm.err === null && raced.err === null && raced.prepared !== null && world.simulations.length === baseSims + 1, raced.err?.message?.slice(0, 80) ?? `${world.simulations.length} vs ${baseSims} simulations`)
  check('L8b the balances are read at the simulation\'s own commitment ("confirmed", not the finalized default)',
    world.accountReads.length > 0 && world.accountReads.every((p) => p[1]?.commitment === 'confirmed'))
  const skewed = await run('usdc-to-sol', (w) => { w.feeSkew = 5_000n })
  check('L8c a fee that is wrong on every measurement is still refused, after the second look', refused(skewed) && world.simulations.length === baseSims + 1, skewed.err?.message?.slice(0, 60) ?? 'accepted!')

  // BL27: the review shows the deposit that opens a first-time holder's USDC account
  const firstUsdc = await run('sol-to-usdc', (w) => { w.usdcAtaMissing = true })
  check('L9 a first-time USDC holder\'s swap carries the one-time account deposit for the review (BL27)', firstUsdc.err === null && firstUsdc.prepared?.accountDepositLamports === 2_039_280n, firstUsdc.err?.message?.slice(0, 80))
  const holder = await run('sol-to-usdc')
  check('L9b ...and an existing holder\'s carries none', holder.prepared?.accountDepositLamports === 0n)
  check('L9c the review shows it, and the stake form can try the validator list again (BL28)',
    /USDC account deposit \(one-time\)/.test(swapForm) && /setValidatorTry\(\(n\) => n \+ 1\)/.test(readFileSync(new URL('../src/components/SolStakeModal.tsx', import.meta.url), 'utf8')))
}

console.log('--- M. the 2026-10-29 upgrades: rate, route, swaps in activity, a quote that stays current ---')
{
  const { swapRate } = await import('../src/lib/solswap.ts')
  const { isSwapDelta } = await import('../src/lib/sol.ts')
  const SOL = 1_000_000_000n
  check('M1 the rate is USDC units per whole SOL, either way round, rounded down',
    swapRate('sol-to-usdc', SOL, 182_310_000n) === 182_310_000n &&
      swapRate('sol-to-usdc', SOL / 2n, 91_155_000n) === 182_310_000n &&
      swapRate('usdc-to-sol', 182_310_000n, SOL) === 182_310_000n &&
      swapRate('usdc-to-sol', 10_000_000n, 3n * SOL) === 3_333_333n)
  check('M1b ...and there is none for an empty side', swapRate('sol-to-usdc', 0n, 5n) === null && swapRate('usdc-to-sol', 5n, 0n) === null)
  const sell = await run('sol-to-usdc')
  const buy = await run('usdc-to-sol')
  check('M2 the review\'s route is the prepared build\'s own exchanges (recorded: BisonFi, TesseraV)',
    sell.err === null && sell.prepared.route.join() === 'BisonFi' && buy.err === null && buy.prepared.route.join() === 'TesseraV',
    `${sell.prepared?.route} / ${buy.prepared?.route} ${sell.err?.message ?? ''}${buy.err?.message ?? ''}`)
  check('M2b ...and its rate is the recorded quote\'s: 0.1 SOL for 10.047972 USDC is 100.47972 USDC per SOL',
    swapRate(sell.prepared.direction, sell.prepared.inAmount, sell.prepared.outAmount) === 100_479_720n)
  const after = await run('sol-to-usdc', (w) => { w.build.routePlan = [{ swapInfo: { label: 'Orca <script>' } }, { swapInfo: { label: 'Raydium CLMM' } }] })
  check('M2c a route label that isn\'t a plain exchange name is left out (only routeLabels\' names reach the screen)',
    after.err === null && after.prepared.route.join() === 'Raydium CLMM', after.prepared?.route?.join() ?? after.err?.message)

  const J = { failed: false, viaJupiter: true, otherTokenMoved: false }
  check('M3 through Jupiter, SOL out and USDC in, or USDC out and SOL in, is a swap',
    isSwapDelta(-100_006_000n, 10_047_972n, J) && isSwapDelta(98_527_520n, -10_000_000n, J))
  check('M3b receiving USDC alone, sending USDC (SOL paid the fee or a deposit), or SOL alone is not',
    !isSwapDelta(0n, 5_000_000n, J) && !isSwapDelta(-2_044_280n, -5_000_000n, J) &&
      !isSwapDelta(-5_000n, 0n, J) && !isSwapDelta(1_000n, 1_000n, J))
  check('M3c a failed transaction is never a swap', !isSwapDelta(-100_006_000n, 10_047_972n, { ...J, failed: true }))
  check('M3d without Jupiter\'s program, a fee paid in SOL beside USDC arriving (a claim, a refund) is not a swap (seen live 2026-10-29)',
    !isSwapDelta(-9_000n, 2_070n, { ...J, viaJupiter: false }) && !isSwapDelta(-100_006_000n, 10_047_972n, { ...J, viaJupiter: false }))
  check('M3f nor is a swap of another token into USDC (that token went down), its SOL leg only the fee',
    !isSwapDelta(-12_000n, 2_500_000n, { ...J, otherTokenMoved: true }))
  const { JUPITER_V6_PROGRAM } = await import('../src/lib/sol.ts')
  const gateSrc = readFileSync(new URL('../src/lib/solswap.ts', import.meta.url), 'utf8')
  check('M3e history\'s Jupiter program is the one the swap gate allows',
    gateSrc.includes(`const JUPITER_V6_PROGRAM = '${JUPITER_V6_PROGRAM}'`) && JUPITER_V6_PROGRAM.startsWith('JUP6'))
  const solLibSrc = readFileSync(new URL('../src/lib/sol.ts', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../src/components/SolCard.tsx', import.meta.url), 'utf8')
  check('M4 activity marks each row with isSwapDelta, and the card names a swap before "Received"/"Sent"',
    /swap: isSwapDelta\(delta, usdcDelta, \{\s*failed: s\.err != null,\s*viaJupiter: keys\.some\(\(k\) => k\.pubkey === JUPITER_V6_PROGRAM\),\s*otherTokenMoved: otherTokenMoved\(tx\?\.meta, chain\.usdc\.mint, address\),\s*\}\)/.test(solLibSrc) &&
      card.indexOf('Swapped SOL →') > 0 && card.indexOf('Swapped SOL →') < card.indexOf("? 'Received'") &&
      /t\.swap \? \(\s*<IconSwap/.test(card))

  const form = readFileSync(new URL('../src/components/SolSwapModal.tsx', import.meta.url), 'utf8')
  check('M5 the quote refreshes every 20 s, only on the form, with a quote shown, while the page is visible',
    /const QUOTE_REFRESH_MS = 20_000/.test(form) &&
      /if \(step\.kind !== 'form' \|\| !hasQuote\) return/.test(form) &&
      /document\.visibilityState === 'visible'\) setRefreshTick/.test(form))
  check('M5b a refresh keeps the shown quote until its replacement lands, and a failed one keeps it unless stale',
    /if \(!isRefresh\) \{\s*setQuote\(null\)/.test(form) &&
      /if \(isRefresh && shown !== null && Date\.now\(\) - shown\.builtAt < QUOTE_STALE_MS\) return/.test(form))
  check('M5c the form and the review show the rate and the route',
    /1 SOL ≈ \{quoteRate\}/.test(form) && /via \{quoteRoute\.join/.test(form) && /<dt>Rate<\/dt>/.test(form) && /<dt>Route<\/dt>/.test(form))
}

console.log('--- N. Solana activity reads version-1 transactions ---')
{
  const { fetchSolHistory, SOL_HISTORY_TX_VERSION } = await import('../src/lib/sol.ts')
  const rec = JSON.parse(readFileSync('scripts/fixtures/solana-history-v1-tx.json', 'utf8'))
  const ME = rec.tx.transaction.message.accountKeys.find((k) => k.signer).pubkey
  const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
  // base58 signatures of the right length, one per scripted transaction
  const sig = (c) => c.repeat(88)
  const legacy = {
    version: 'legacy', blockTime: rec.tx.blockTime - 60,
    meta: { err: null, fee: 5000, preBalances: [1_000_000, 100], postBalances: [994_900, 5_200], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [{ pubkey: OTHER, signer: true }, { pubkey: ME, signer: false }] } },
  }
  const misaligned = structuredClone(legacy)
  misaligned.meta.preBalances = [1_000_000]
  misaligned.meta.postBalances = [994_900]
  const unknownVersion = { ...structuredClone(legacy), version: 7 }
  // through Jupiter: another token of ours went down as USDC came in, SOL paid the fee
  const USDC_MINT = MAINNET.usdc.mint
  const BONKISH = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
  const tokenToUsdc = {
    version: 0, blockTime: rec.tx.blockTime - 120,
    meta: {
      err: null, fee: 5000, preBalances: [50_000_000, 1], postBalances: [49_995_000, 1],
      preTokenBalances: [{ accountIndex: 1, owner: ME, mint: BONKISH, uiTokenAmount: { amount: '900000' } }, { accountIndex: 1, owner: ME, mint: USDC_MINT, uiTokenAmount: { amount: '0' } }],
      postTokenBalances: [{ accountIndex: 1, owner: ME, mint: BONKISH, uiTokenAmount: { amount: '0' } }, { accountIndex: 1, owner: ME, mint: USDC_MINT, uiTokenAmount: { amount: '3000000' } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: ME, signer: true }, { pubkey: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', signer: false }] } },
  }
  const txs = new Map([
    [rec.signature, { tx: rec.tx, version: 1 }],
    [sig('B'), { tx: null, version: 2 }],
    [sig('C'), { tx: legacy, version: 'legacy' }],
    [sig('D'), { tx: misaligned, version: 'legacy' }],
    [sig('E'), { tx: unknownVersion, version: 0 }],
    [sig('F'), { tx: tokenToUsdc, version: 0 }],
  ])
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body)
    const answer = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    if (method === 'getSignaturesForAddress') {
      if (params[0] !== ME) return answer([])
      return answer([...txs.keys()].map((signature, k) => ({ signature, blockTime: rec.tx.blockTime - k, err: null })))
    }
    if (method === 'getTransaction') {
      const want = params[1]?.maxSupportedTransactionVersion
      asked.push(want)
      const t = txs.get(params[0])
      // the node's own refusal of a version above the ceiling asked for
      if (typeof t.version === 'number' && (want === undefined || t.version > want)) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32015, message: `Transaction version (${t.version}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${t.version}` } }), { status: 200 })
      }
      return answer(t.tx)
    }
    throw new Error(`unexpected RPC ${method}`)
  }
  const rows = await fetchSolHistory(MAINNET, ME)
  globalThis.fetch = realFetch
  const v1 = rows.find((r) => r.signature === rec.signature)
  // seven requests for six transactions: the one a server refuses is asked of the second server too
  check('N1 history asks for transactions up to version 1, every time', SOL_HISTORY_TX_VERSION === 1 && asked.length === 7 && asked.every((v) => v === 1), asked.join())
  check('N2 the recorded version-1 transaction is in Activity with its own SOL and USDC changes (−11,816 lamports, +2,491 USDC units)',
    v1 !== undefined && v1.amount === -11_816n && v1.usdcAmount === 2_491n && v1.direction === 'in' && v1.time === rec.tx.blockTime && !v1.failed,
    v1 === undefined ? 'missing' : `${v1.amount} ${v1.usdcAmount} ${v1.direction}`)
  check('N3 ...and the swap rule reads it like any other: Jupiter ran, SOL went out, USDC came in, and the token it passed through ended where it began (an arbitrage loop), so it is named a swap',
    v1?.swap === true)
  const plain = rows.find((r) => r.signature === sig('C'))
  check('N4 an older (legacy) transaction reads exactly as before', plain !== undefined && plain.amount === 5_100n && plain.direction === 'in' && plain.counterparty === OTHER)
  check('N5 a version the node refuses (2), a version history doesn\'t know (7) and lists that don\'t line up are skipped; nothing else is lost',
    rows.length === 3 && !rows.some((r) => [sig('B'), sig('D'), sig('E')].includes(r.signature)), rows.map((r) => r.signature.slice(0, 4)).join())
  const t2u = rows.find((r) => r.signature === sig('F'))
  check('N6 a swap of another token into USDC through Jupiter (that token went down, SOL paid only the fee) is not "Swapped SOL → USDC"; it reads as the USDC received',
    t2u !== undefined && t2u.swap === false && t2u.usdcAmount === 3_000_000n && t2u.direction === 'in')
}

console.log('--- P. a route too large for one transaction asks once for a smaller one ---')
{
  const { SMALLER_ROUTE_MAX_ACCOUNTS } = await import('../src/lib/solswap.ts')
  // 30 more accounts on the swap instruction, none in a lookup table: 960 more bytes
  const extra = Array.from({ length: 30 }, (_, i) => ({ pubkey: base58.encode(new Uint8Array(32).fill(i + 1)), isSigner: false, isWritable: false }))
  const bloat = (w) => { w.build.swapInstruction.accounts = [...w.build.swapInstruction.accounts, ...extra] }
  const honest = (w) => { w.build = structuredClone(FIX[w.direction].build) }
  const capped = (w) => w.jupUrls.filter((u) => u.includes(`&maxAccounts=${SMALLER_ROUTE_MAX_ACCOUNTS}`)).length

  await run('sol-to-usdc')
  const ordinarySims = world.simulations.length
  const r = await run('sol-to-usdc', (w) => { bloat(w); w.onSmaller = honest })
  check('P1 an oversized route is never simulated; Jupiter is asked once more, capped at 32 accounts, and that route passes the whole gate',
    r.err === null && r.prepared.simplerRoute === true && r.prepared.swapFee > 0n && world.builds === 2 && capped(world) === 1 && world.jupUrls[0].includes('maxAccounts') === false,
    r.err?.message?.slice(0, 80) ?? `builds=${world.builds} capped=${capped(world)}`)
  check('P1b ...and the oversized route was never simulated: exactly as many simulations as an ordinary swap',
    r.err === null && ordinarySims >= 2 && world.simulations.length === ordinarySims, `${world.simulations.length} vs ${ordinarySims}`)
  const fits = await run('usdc-to-sol')
  check('P2 a route that fits is not rebuilt, and says so', fits.err === null && fits.prepared.simplerRoute === false && world.builds === 1)
  const still = await run('sol-to-usdc', (w) => { bloat(w) })
  check('P3 a smaller route still too large ends in plain words: nothing signed, nothing simulated, no third request',
    /too large to fit in one Solana transaction.*nothing was signed/i.test(still.err?.message ?? '') && world.simulations.length === 0 && world.builds === 2,
    still.err?.message?.slice(0, 90))
  const tampered = await run('sol-to-usdc', (w) => {
    bloat(w)
    w.onSmaller = (w2) => { honest(w2); w2.build.swapInstruction.accounts[10] = { ...w2.build.swapInstruction.accounts[10], pubkey: OTHER } }
  })
  check('P4 the smaller route goes through every check: one with its fee account swapped is refused', refused(tampered), tampered.err?.message?.slice(0, 60) ?? 'accepted!')
  const busy = await run('sol-to-usdc', (w) => { bloat(w); w.onSmaller = (w2) => { w2.jupStatus = 429 } })
  check('P5 Jupiter busy when asked for the smaller route: plain words, nothing signed', /too large to fit|busy/i.test(busy.err?.message ?? ''), busy.err?.message?.slice(0, 80))
  const form = readFileSync(new URL('../src/components/SolSwapModal.tsx', import.meta.url), 'utf8')
  check('P6 the review says when the route is the simpler one', /step\.prepared\.simplerRoute &&/.test(form) && /too large to fit in one Solana transaction/.test(form))
}

console.log(failures === 0 ? '\nAll swap-gate checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
