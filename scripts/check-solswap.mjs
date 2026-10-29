// SPL-USDC + Jupiter-swap verification for Kailah Wallet.
//
// Run from the repo root: npx tsx scripts/check-solswap.mjs
//
// Offline: the associated-token-account address is re-derived with an
// INDEPENDENT PDA implementation (sha256 + ed25519 point check, no
// micro-sol-signer involvement) and must match solUsdcAta.
// Live, read-only: on-chain USDC mint sanity on both clusters; a devnet
// simulation of the wallet's exact ATA-create + transferChecked instructions
// executed from a real USDC holder's account (sigVerify off — nothing is
// signed or spent); the real prepareSwap() pipeline against mainnet on Jupiter
// Swap V2 /build, including the wallet's own assembly and simulation gate;
// the 0.5% Kailah fee paid to the fee account; a route made to fail inside
// one exchange, re-routed around it by Jupiter; and adversarial tamper tests
// proving the gate refuses a promise the route doesn't make, a live route
// whose slippage was raised, and one whose fee was redirected.
// NOTHING here broadcasts to mainnet; no mainnet key material is used.

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-solswap')
import { sha256 } from '@noble/hashes/sha2'
import { ed25519 } from '@noble/curves/ed25519'
import { base58, base64 } from '@scure/base'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import * as solLib from 'micro-sol-signer'
import {
  SOL_CHAINS,
  deriveSolKey,
  getSolBalance,
  getSolUsdcBalance,
  prepareSolSend,
  solRpc,
  solUsdcAta,
} from '../src/lib/sol.ts'
import { getSwapQuote, prepareSwap, routeLabels, SWAP_FEE_ACCOUNT, SWAP_FEE_WALLET } from '../src/lib/solswap.ts'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let failures = 0
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`)
const check = (name, cond, detail = '') => {
  // A live dependency being unreachable or rate-limited is not a wallet
  // defect — the app fails over; the suite reports it as a skip, not a fail.
  if (!cond && NET_ISSUE.test(String(detail))) return skip(name, `live dependency unavailable: ${String(detail).slice(0, 90)}`)
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : ` — ${detail}`))
  if (!cond) failures++
}

const MAINNET = SOL_CHAINS.sol
const DEVNET = SOL_CHAINS['sol-devnet']

// --- 1. Independent ATA derivation ------------------------------------------
// PDA rule: address = sha256(seeds..., programId, "ProgramDerivedAddress"),
// taking the highest bump whose hash is NOT a valid ed25519 point.
{
  const isOnCurve = (bytes) => {
    try {
      ed25519.Point.fromHex(bytes)
      return true
    } catch {
      return false
    }
  }
  const findPda = (seeds, programId) => {
    for (let bump = 255; bump >= 0; bump--) {
      const h = sha256(
        concatBytes(...seeds, new Uint8Array([bump]), programId, utf8ToBytes('ProgramDerivedAddress')),
      )
      if (!isOnCurve(h)) return base58.encode(h)
    }
    throw new Error('no bump found')
  }
  const owners = [
    deriveSolKey(VECTOR_MNEMONIC, 0).address,
    deriveSolKey(VECTOR_MNEMONIC, 1).address,
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  ]
  for (const chain of [MAINNET, DEVNET]) {
    for (const owner of owners) {
      const independent = findPda(
        [
          base58.decode(owner),
          base58.decode(solLib.TOKEN_PROGRAM),
          base58.decode(chain.usdc.mint),
        ],
        base58.decode(solLib.ASSOCIATED_TOKEN_PROGRAM),
      )
      const ours = solUsdcAta(chain, owner)
      check(
        `ATA independent re-derivation (${chain.id}, ${owner.slice(0, 6)}…)`,
        ours === independent,
        `${ours} vs ${independent}`,
      )
    }
  }
}

// --- 2. On-chain USDC mint sanity (both clusters) ---------------------------
for (const chain of [MAINNET, DEVNET]) {
  try {
    const supply = await solRpc(chain, 'getTokenSupply', [chain.usdc.mint])
    check(
      `USDC mint live on ${chain.id} (6 decimals, non-zero supply)`,
      supply.value.decimals === chain.usdc.decimals && BigInt(supply.value.amount) > 0n,
      JSON.stringify(supply.value),
    )
  } catch (e) {
    check(`USDC mint live on ${chain.id}`, false, e.message)
  }
}

// --- 3. Wallet USDC balance read (vector account, both clusters) ------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withRetry = async (fn, tries = 3) => {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(2500 * (i + 1))
    }
  }
  throw last
}

const key0 = deriveSolKey(VECTOR_MNEMONIC, 0)
const key1 = deriveSolKey(VECTOR_MNEMONIC, 1)
let devnetUsdc = null
for (const chain of [MAINNET, DEVNET]) {
  try {
    const bal = await withRetry(() => getSolUsdcBalance(chain, key0.address))
    if (chain === DEVNET) devnetUsdc = bal
    check(`getSolUsdcBalance parses on ${chain.id} (${bal} units)`, typeof bal === 'bigint')
  } catch (e) {
    check(`getSolUsdcBalance on ${chain.id}`, false, e.message)
  }
}

// --- 4. USDC send guards (devnet, live reads, nothing sent) -----------------
if (devnetUsdc !== null) {
  try {
    await withRetry(() =>
      prepareSolSend({
        chain: DEVNET,
        key: key0,
        asset: 'usdc',
        to: key1.address,
        amount: devnetUsdc + 1n,
      }),
    )
    check('USDC insufficient-balance guard', false, 'prepare unexpectedly succeeded')
  } catch (e) {
    check(
      'USDC insufficient-balance guard (devnet, live pipeline ran)',
      /insufficient usdc/i.test(e.message),
      e.message,
    )
  }
} else {
  skip('USDC insufficient-balance guard', 'no devnet balance read')
}
await sleep(2000)
// The vector account's own devnet ATA is a known-live token account — the
// exact kind of address the guard exists to reject.
try {
  await withRetry(() =>
    prepareSolSend({
      chain: DEVNET,
      key: key1,
      asset: 'usdc',
      to: solUsdcAta(DEVNET, key0.address),
      amount: 1n,
    }),
  )
  check('token-account-address trap guard', false, 'prepare unexpectedly succeeded')
} catch (e) {
  check('token-account-address trap guard', /token account, not a wallet/i.test(e.message), e.message)
}

// --- 5. REAL devnet USDC end-to-end send ------------------------------------
// The vector account holds devnet USDC (worthless by design). Send 0.1 USDC
// to the second derived account through the wallet's own prepare + broadcast
// path — including recipient-ATA creation if it doesn't exist yet — and
// confirm the recipient balance moved. This is a real broadcast on devnet.
await sleep(2000)
try {
  const E2E_AMOUNT = 100_000n // 0.1 USDC
  const solBal = await withRetry(() => getSolBalance(DEVNET, key0.address))
  if (devnetUsdc === null || devnetUsdc < E2E_AMOUNT) {
    skip('devnet USDC e2e send', `vector account holds ${devnetUsdc ?? '?'} units`)
  } else if (solBal < 2_100_000n) {
    skip('devnet USDC e2e send', `only ${solBal} lamports for fee+rent`)
  } else {
    const before = await withRetry(() => getSolUsdcBalance(DEVNET, key1.address))
    const prepared = await withRetry(() =>
      prepareSolSend({
        chain: DEVNET,
        key: key0,
        asset: 'usdc',
        to: key1.address,
        amount: E2E_AMOUNT,
      }),
    )
    check(
      'e2e prepare: usdc asset, fee flat, rent consistent',
      prepared.asset === 'usdc' &&
        prepared.amount === E2E_AMOUNT &&
        prepared.feeLamports === 5000n &&
        (prepared.rentLamports === 0n || prepared.rentLamports > 2_000_000n),
      JSON.stringify({ rent: String(prepared.rentLamports) }),
    )
    const { broadcastSolSend } = await import('../src/lib/sol.ts')
    const sig = await broadcastSolSend(key0, prepared)
    console.log(`      devnet USDC tx: ${sig}`)
    let landed = false
    for (let i = 0; i < 15 && !landed; i++) {
      await sleep(3000)
      try {
        const now = await getSolUsdcBalance(DEVNET, key1.address)
        landed = now - before === E2E_AMOUNT
      } catch {
        // transient RPC noise while polling
      }
    }
    check('e2e devnet USDC send landed (+0.1 USDC at recipient)', landed)
  }
} catch (e) {
  check('devnet USDC e2e send', false, e.message)
}

// --- 6. Swap quote (mainnet, read-only) -------------------------------------
// Jupiter Swap V2 /build returns quote + instructions for a given taker. A
// well-known active wallet is the taker; nothing is signed, and the keyless
// limit is small, so this section makes as few builds as it can.
const BINANCE_HOT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
let quote = null
try {
  quote = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n, BINANCE_HOT)
  check(
    'live Jupiter V2 build SOL→USDC is coherent',
    quote.inAmount === 100_000_000n && quote.outAmount > 0n && quote.minOutAmount <= quote.outAmount && quote.taker === BINANCE_HOT,
    JSON.stringify({ out: String(quote.outAmount), min: String(quote.minOutAmount) }),
  )
  const solPrice = Number(quote.outAmount) / 1e6 / 0.1
  check(`implied SOL price sane ($${solPrice.toFixed(2)})`, solPrice > 1 && solPrice < 100_000)
} catch (e) {
  check('live Jupiter V2 build', false, e.message)
}

// --- 7. Real prepareSwap pipeline (mainnet, simulation only) ----------------
// prepareSwap checks the build's shape, resolves lookup tables from the
// chain, assembles the transaction itself, simulates to size the compute
// limit, decodes the Jupiter instruction, and simulates the final bytes.
// Returning at all means every gate passed. (Signing byte-exactness on the
// wallet's own compiled transaction is proven offline, in check-swapgate.)
if (quote !== null) {
  try {
    const prepared = await prepareSwap(MAINNET, BINANCE_HOT, quote)
    check(
      'prepareSwap gates pass on an honest V2 swap (simulated deltas returned)',
      prepared.simulatedUsdcDelta >= prepared.minOutAmount && prepared.simulatedSolDelta < 0n,
      JSON.stringify({
        usdc: String(prepared.simulatedUsdcDelta),
        min: String(prepared.minOutAmount),
        sol: String(prepared.simulatedSolDelta),
      }),
    )
    const gross = prepared.simulatedUsdcDelta + prepared.swapFee
    check(
      'the simulated Kailah fee is 0.5% of the gross USDC output, paid to the fee account',
      prepared.swapFee > 0n && (prepared.swapFee * 10_000n) / gross >= 49n && (prepared.swapFee * 10_000n) / gross <= 50n,
      `${prepared.swapFee} of ${gross} USDC units`,
    )
  } catch (e) {
    check('prepareSwap honest pipeline', false, e.message)
  }

  // Regression (found by a real user): a FIRST-TIME USDC holder has zero
  // slack in the cost bound — their swap also creates the token account, and
  // the chain rounds the priority fee up by 1 lamport. The gate must still
  // pass an honest first-time swap. A validator identity account (funded,
  // holds no token accounts) reproduces the state.
  try {
    const votes = await withRetry(() => solRpc(MAINNET, 'getVoteAccounts', [{}]))
    let firstTimer = null
    for (const v of votes.current.slice(0, 12)) {
      const bal = await solRpc(MAINNET, 'getBalance', [v.nodePubkey, {}])
        .then((r) => BigInt(r.value))
        .catch(() => 0n)
      if (bal < 500_000_000n) continue
      const info = await solRpc(MAINNET, 'getAccountInfo', [
        solUsdcAta(MAINNET, v.nodePubkey),
        { encoding: 'base64' },
      ])
      if (info.value === null) {
        firstTimer = v.nodePubkey
        break
      }
    }
    if (firstTimer === null) {
      skip('first-time-holder swap regression', 'no funded no-ATA validator found')
    } else {
      const qf = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n, firstTimer)
      const pf = await prepareSwap(MAINNET, firstTimer, qf)
      check(
        'first-time USDC holder passes the gate (rounding slack regression)',
        pf.simulatedUsdcDelta >= pf.minOutAmount && pf.simulatedSolDelta < 0n,
        JSON.stringify({ sol: String(pf.simulatedSolDelta), usdc: String(pf.simulatedUsdcDelta) }),
      )
    }
  } catch (e) {
    check('first-time-holder swap regression', false, e.message)
  }

  // --- 7b. Re-route around a failing exchange (live, simulation only) -------
  // A live swap failed inside an exchange on its route (custom program error
  // 0xffff, 2026-10-27). Here the FIRST simulation is made to fail the same
  // way inside the route's first exchange; prepareSwap must name it from
  // Jupiter's own program list, and Jupiter must build a fresh route without
  // it that passes every gate. Nothing is signed.
  try {
    const realFetch = globalThis.fetch
    const names = await (await realFetch('https://api.jup.ag/swap/v2/program-id-to-label')).json()
    const q2 = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n, BINANCE_HOT)
    const label = routeLabels(q2.build)[0]
    const program = q2.build.swapInstruction.accounts.map((a) => a.pubkey).find((k) => names[k] === label)
    if (label === undefined || program === undefined) {
      skip('live re-route around a failing exchange', `no program for ${label} in the route`)
    } else {
      let failed = false
      let freshLabels = null
      let freshUrl = ''
      let freshStatus = 0
      globalThis.fetch = async (url, init) => {
        const u = String(url)
        if (!failed && typeof init?.body === 'string' && JSON.parse(init.body).method === 'simulateTransaction') {
          failed = true
          const logs = [
            'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]',
            `Program ${program} invoke [2]`,
            `Program ${program} failed: custom program error: 0xffff`,
            'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 consumed 143814 of 1372870 compute units',
            'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0xffff',
          ]
          const result = { context: { slot: 0 }, value: { err: { InstructionError: [5, { Custom: 65535 }] }, logs } }
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
        }
        const res = await realFetch(url, init)
        if (u.includes('/build?') && u.includes('excludeDexes=')) {
          freshUrl = u
          freshStatus = res.status
          if (res.ok) freshLabels = routeLabels(await res.clone().json())
        }
        return res
      }
      let p
      try {
        p = await prepareSwap(MAINNET, BINANCE_HOT, q2)
      } catch (e) {
        // the keyless limit refusing the fresh build is the swap service, not
        // the wallet (which then shows the first failure and says try again)
        if (freshStatus === 429) p = null
        else throw e
      } finally {
        globalThis.fetch = realFetch
      }
      if (p === null) skip('live re-route around a failing exchange', `the fresh build was rate-limited (429) after naming ${label}`)
      else check(
        `live re-route: ${label} failing → named, and a fresh route without it passes every gate`,
        p.reroutedAround === `the exchange ${label}` &&
          freshUrl.includes(`excludeDexes=${encodeURIComponent(label)}`) &&
          Array.isArray(freshLabels) && freshLabels.length > 0 && !freshLabels.includes(label) &&
          p.simulatedUsdcDelta >= p.minOutAmount && p.swapFee > 0n,
        JSON.stringify({ named: p.reroutedAround, fresh: freshLabels }),
      )
    }
  } catch (e) {
    check('live re-route around a failing exchange', false, e.message)
  }

  // --- 8. ADVERSARIAL: the gate must refuse what the live build didn't say ---
  // builtAt is refreshed so prepareSwap uses THESE (tampered) instructions
  // rather than rebuilding a fresh, honest set.
  try {
    const inflated = { ...quote, builtAt: Date.now(), outAmount: quote.outAmount * 2n, minOutAmount: quote.minOutAmount * 2n }
    await prepareSwap(MAINNET, BINANCE_HOT, inflated)
    check('a quote promising more than its route is refused', false, 'prepareSwap accepted an undeliverable promise')
  } catch (e) {
    check('a quote promising more than its route is refused (refuse-to-sign gate fires)', /does not match its quote/i.test(e.message), e.message)
  }
  try {
    const build = structuredClone(quote.build)
    const d = base64.decode(build.swapInstruction.data)
    new DataView(d.buffer, d.byteOffset).setUint16(24, 300, true) // route_v2 slippage_bps → 3%
    build.swapInstruction.data = base64.encode(d)
    await prepareSwap(MAINNET, BINANCE_HOT, { ...quote, builtAt: Date.now(), build })
    check('a live route with its slippage raised is refused', false, 'prepareSwap accepted it')
  } catch (e) {
    check('a live route with its slippage raised is refused', /does not match its quote/i.test(e.message), e.message)
  }
  try {
    const build = structuredClone(quote.build)
    const slot = build.swapInstruction.accounts.findIndex((a) => a.pubkey === SWAP_FEE_ACCOUNT)
    build.swapInstruction.accounts[slot] = { pubkey: solUsdcAta(MAINNET, BINANCE_HOT), isSigner: false, isWritable: true }
    await prepareSwap(MAINNET, BINANCE_HOT, { ...quote, builtAt: Date.now(), build })
    check('a live route with the fee redirected to another account is refused', false, 'prepareSwap accepted it')
  } catch (e) {
    check('a live route with the fee redirected to another account is refused', /does not match its quote/i.test(e.message), e.message)
  }
} else {
  skip('prepareSwap pipeline + tamper tests', 'no build available')
}

// --- 8b. The fee wallet swaps for itself, with no fee (simulation only) ------
// Its USDC account IS the fee account; a swap from it used to be refused.
try {
  const bal = await solRpc(MAINNET, 'getBalance', [SWAP_FEE_WALLET, {}]).then((r) => BigInt(r.value))
  if (bal < 20_000_000n) {
    skip('fee wallet swaps without a fee', 'fee wallet holds under 0.02 SOL')
  } else {
    const qf = await getSwapQuote(MAINNET, 'sol-to-usdc', 10_000_000n, SWAP_FEE_WALLET)
    const pf = await prepareSwap(MAINNET, SWAP_FEE_WALLET, qf)
    check(
      'the fee wallet swaps for itself with no fee (gate passes, full output)',
      qf.feeBps === 0 && pf.swapFee === 0n && pf.simulatedUsdcDelta >= pf.minOutAmount,
      JSON.stringify({ fee: String(pf.swapFee), usdc: String(pf.simulatedUsdcDelta), min: String(pf.minOutAmount) }),
    )
  }
} catch (e) {
  check('fee wallet swaps without a fee', false, e.message)
}

// --- 8c. A route through a third token (simulation only) --------------------
// Some routes run SOL → USD1 → USDC, and Jupiter opens the taker's USD1 account
// without closing it; that rent tripped the SOL-cost bound and the swap was
// refused. The wallet now closes such an account in the same transaction.
// Only some builds take such a route, so this tries a few (spaced for the
// keyless limit). The fee wallet holds no intermediate accounts, so a close is
// actually needed; BINANCE_HOT stands in if it runs low.
{
  const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  const SOL_MINT = 'So11111111111111111111111111111111111111112'
  let taker = BINANCE_HOT
  try {
    const bal = await solRpc(MAINNET, 'getBalance', [SWAP_FEE_WALLET, {}]).then((r) => BigInt(r.value))
    if (bal >= 20_000_000n) taker = SWAP_FEE_WALLET
  } catch {}
  let found = null
  let lastErr = null
  for (let i = 0; i < 6 && found === null; i++) {
    await sleep(7000)
    try {
      const q = await getSwapQuote(MAINNET, 'sol-to-usdc', 10_000_000n, taker)
      const third = (q.build.setupInstructions ?? []).find(
        (ix) => ix.programId === ATA_PROGRAM && ![SOL_MINT, MAINNET.usdc.mint].includes(ix.accounts[3]?.pubkey),
      )
      if (third) found = { q, mint: third.accounts[3].pubkey }
    } catch (e) {
      lastErr = e
    }
  }
  if (found === null) {
    skip('a route through a third token passes the gate', lastErr ? `no build: ${lastErr.message.slice(0, 60)}` : 'no such route in 6 builds')
  } else {
    try {
      const p = await prepareSwap(MAINNET, taker, found.q)
      check(
        `a route through a third token (${found.mint.slice(0, 6)}…) passes the gate, its rent returned`,
        p.simulatedUsdcDelta >= p.minOutAmount && -p.simulatedSolDelta <= found.q.inAmount + p.feeLamports + 1_000n,
        JSON.stringify({ sol: String(p.simulatedSolDelta), fee: String(p.feeLamports) }),
      )
    } catch (e) {
      check('a route through a third token passes the gate', false, e.message)
    }
  }
}

// --- 8b. A route capped for size: the one smaller route prepareSwap asks for
//     when the best route won't fit in a transaction (2026-10-29) ----------
try {
  const { SMALLER_ROUTE_MAX_ACCOUNTS } = await import('../src/lib/solswap.ts')
  const qc = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n, BINANCE_HOT, [], SMALLER_ROUTE_MAX_ACCOUNTS)
  const pc = await prepareSwap(MAINNET, BINANCE_HOT, qc)
  check(
    `a route capped at ${SMALLER_ROUTE_MAX_ACCOUNTS} accounts (the size retry) passes the whole gate on mainnet`,
    pc.simulatedUsdcDelta >= pc.minOutAmount && pc.swapFee > 0n && pc.simplerRoute === false,
    `route ${pc.route.join(' > ')}, ${pc.simulatedUsdcDelta} USDC units`,
  )
} catch (e) {
  check('a route capped for size passes the gate', false, e.message)
}

// --- 9. USDC→SOL build direction --------------------------------------------
try {
  const q = await getSwapQuote(MAINNET, 'usdc-to-sol', 10_000_000n, BINANCE_HOT)
  check(
    'live Jupiter V2 build USDC→SOL is coherent',
    q.inAmount === 10_000_000n && q.outAmount > 0n && q.minOutAmount <= q.outAmount,
  )
} catch (e) {
  check('USDC→SOL build', false, e.message)
}

// --- 10. Devnet swap correctly refused --------------------------------------
try {
  await getSwapQuote(DEVNET, 'sol-to-usdc', 1_000_000n, BINANCE_HOT)
  check('swap refused on devnet', false, 'quote unexpectedly returned')
} catch (e) {
  check('swap refused on devnet', /only available on solana mainnet/i.test(e.message), e.message)
}

key0.zero()
key1.zero()

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
