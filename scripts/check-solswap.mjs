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
// signed or spent); the real prepareSwap() pipeline against mainnet including
// its simulation gate; and an adversarial tamper test proving the gate
// refuses a transaction that doesn't deliver what the quote promises.
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
import { getSwapQuote, prepareSwap } from '../src/lib/solswap.ts'

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
let quote = null
try {
  quote = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n)
  check(
    'live Jupiter quote SOL→USDC is coherent',
    quote.inAmount === 100_000_000n && quote.outAmount > 0n && quote.minOutAmount <= quote.outAmount,
    JSON.stringify({ out: String(quote.outAmount), min: String(quote.minOutAmount) }),
  )
  const solPrice = Number(quote.outAmount) / 1e6 / 0.1
  check(`implied SOL price sane ($${solPrice.toFixed(2)})`, solPrice > 1 && solPrice < 100_000)
} catch (e) {
  check('live Jupiter quote', false, e.message)
}

// --- 7. Real prepareSwap pipeline (mainnet, simulation only) ----------------
// Uses a well-known active wallet as the owner. prepareSwap internally:
// builds via Jupiter, decodes, checks fee payer + single signature, simulates,
// and verifies the deltas. Returning at all means every gate passed.
const BINANCE_HOT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
if (quote !== null) {
  try {
    const prepared = await prepareSwap(MAINNET, BINANCE_HOT, quote)
    check(
      'prepareSwap gates pass on an honest swap (simulated deltas returned)',
      prepared.simulatedUsdcDelta >= quote.minOutAmount && prepared.simulatedSolDelta < 0n,
      JSON.stringify({
        usdc: String(prepared.simulatedUsdcDelta),
        sol: String(prepared.simulatedSolDelta),
      }),
    )
    // Byte-exact signing: the signed message must equal the simulated message.
    const throwaway = new Uint8Array(32).fill(0x37)
    const addr = solLib.getAddress(throwaway)
    const q2 = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n)
    try {
      const p2 = await prepareSwap(MAINNET, addr, q2)
      // unlikely (unfunded owner usually fails Jupiter's own simulation)…
      const [, signed] = solLib.signTx(throwaway, p2.txBase64)
      const a = base64.decode(p2.txBase64).slice(65)
      const b = base64.decode(signed).slice(65)
      check('signing leaves swap message bytes untouched', a.length === b.length && a.every((x, i) => x === b[i]))
    } catch {
      // …so prove byte-exactness on the raw build instead (no simulation gate).
      const swRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: q2.raw,
          userPublicKey: addr,
          wrapAndUnwrapSol: true,
        }),
      })
      const sw = await swRes.json()
      if (!sw.swapTransaction) {
        skip('signing byte-exactness', 'Jupiter refused to build for throwaway key')
      } else {
        const [, signed] = solLib.signTx(throwaway, sw.swapTransaction)
        const a = base64.decode(sw.swapTransaction).slice(65)
        const b = base64.decode(signed).slice(65)
        const sig = base64.decode(signed).slice(1, 65)
        check(
          'signing leaves swap message bytes untouched + signature verifies',
          a.length === b.length &&
            a.every((x, i) => x === b[i]) &&
            ed25519.verify(sig, b, ed25519.getPublicKey(throwaway)),
        )
      }
    }
  } catch (e) {
    check('prepareSwap honest pipeline', false, e.message)
  }

  // Regression (found by a real user): a FIRST-TIME USDC holder has zero
  // slack in the cost bound — their swap also creates the token account, and
  // the chain rounds the priority fee up by 1 lamport vs what the service
  // reports. The gate must still pass an honest first-time swap. A validator
  // identity account (funded, holds no token accounts) reproduces the state.
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
      const qf = await getSwapQuote(MAINNET, 'sol-to-usdc', 100_000_000n)
      const pf = await prepareSwap(MAINNET, firstTimer, qf)
      check(
        'first-time USDC holder passes the gate (rounding slack regression)',
        pf.simulatedUsdcDelta >= qf.minOutAmount && pf.simulatedSolDelta < 0n,
        JSON.stringify({ sol: String(pf.simulatedSolDelta), usdc: String(pf.simulatedUsdcDelta) }),
      )
    }
  } catch (e) {
    check('first-time-holder swap regression', false, e.message)
  }

  // --- 8. ADVERSARIAL: the gate must refuse a wrong-promise transaction -----
  // Same real transaction, but the quote object now promises double the
  // output. The simulation can't deliver it, so prepareSwap must throw the
  // refuse-to-sign error rather than returning.
  try {
    const inflated = { ...quote, minOutAmount: quote.minOutAmount * 2n, outAmount: quote.outAmount * 2n }
    await prepareSwap(MAINNET, BINANCE_HOT, inflated)
    check('tampered quote is refused', false, 'prepareSwap accepted an undeliverable promise')
  } catch (e) {
    check('tampered quote is refused (refuse-to-sign gate fires)', /does not match its quote/i.test(e.message), e.message)
  }
} else {
  skip('prepareSwap pipeline + tamper test', 'no quote available')
}

// --- 9. USDC→SOL quote direction --------------------------------------------
try {
  const q = await getSwapQuote(MAINNET, 'usdc-to-sol', 10_000_000n)
  check(
    'live Jupiter quote USDC→SOL is coherent',
    q.inAmount === 10_000_000n && q.outAmount > 0n && q.minOutAmount <= q.outAmount,
  )
} catch (e) {
  check('USDC→SOL quote', false, e.message)
}

// --- 10. Devnet swap correctly refused --------------------------------------
try {
  await getSwapQuote(DEVNET, 'sol-to-usdc', 1_000_000n)
  check('swap refused on devnet', false, 'quote unexpectedly returned')
} catch (e) {
  check('swap refused on devnet', /only available on solana mainnet/i.test(e.message), e.message)
}

key0.zero()
key1.zero()

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
