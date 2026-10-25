// Solana staking verification for Kailah Wallet.
//
// Run from the repo root: npx tsx scripts/check-solstake.mjs
//
// Offline: instruction byte layouts (discriminants + lengths) for all four
// hand-built stake-program instructions.
// Live mainnet (read-only): validator list sanity, and a full simulated
// create+initialize+delegate for a funded third party — the runtime itself
// verifies the createWithSeed address derivation, so simulation success
// proves both the encodings and the derivation.
// Live devnet (REAL broadcasts, worthless coins): the entire lifecycle —
// create+delegate → deactivate (same epoch → instantly inactive) → withdraw,
// with the SOL returning to the main account. Skips gracefully if the
// devnet faucet is rate-limited and the balance can't fund a 1 SOL stake.

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-solstake')
import {
  SOL_CHAINS,
  deriveSolKey,
  getSolBalance,
  requestDevnetAirdrop,
  solRpc,
} from '../src/lib/sol.ts'
import {
  MAX_STAKE_ACCOUNTS,
  broadcastStakeAction,
  fetchStakeAccounts,
  fetchValidators,
  getMinimumStake,
  prepareCreateStake,
  prepareDeactivate,
  prepareWithdraw,
  stakeAccountAddress,
  stakeDeactivateIx,
  stakeDelegateIx,
  stakeInitializeIx,
  stakeWithdrawIx,
} from '../src/lib/solstake.ts'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let failures = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : ` — ${detail}`))
  if (!cond) failures++
}
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MAINNET = SOL_CHAINS.sol
const DEVNET = SOL_CHAINS['sol-devnet']
const A = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'

// --- 1. Offline: instruction byte layouts -----------------------------------
{
  const init = stakeInitializeIx(A, A)
  check('Initialize: 116 bytes, discriminant 0', init.data.length === 116 && init.data[0] === 0)
  check('Initialize: rent sysvar second', init.keys[1].address.startsWith('SysvarRent'))
  const del = stakeDelegateIx(A, A, A)
  check('Delegate: 4 bytes, discriminant 2', del.data.length === 4 && del.data[0] === 2)
  check('Delegate: 6 keys, authority signs', del.keys.length === 6 && del.keys[5].sign === true)
  const deact = stakeDeactivateIx(A, A)
  check('Deactivate: discriminant 5, 3 keys', deact.data[0] === 5 && deact.keys.length === 3)
  const wd = stakeWithdrawIx(A, A, A, 123n)
  check('Withdraw: 12 bytes, discriminant 4, amount LE', wd.data.length === 12 && wd.data[0] === 4 && wd.data[4] === 123)
}

// --- 2. Mainnet: validators + simulated full create+delegate ----------------
let validators = []
try {
  validators = await fetchValidators(MAINNET)
  check(
    'validator list: ≤20, all commission ≤10%, sorted by stake',
    validators.length > 0 &&
      validators.length <= 20 &&
      validators.every((v) => v.commission <= 10) &&
      validators[0].activatedSol >= validators[validators.length - 1].activatedSol,
  )
} catch (e) {
  check('validator list', false, e.message)
}

try {
  const votes = await solRpc(MAINNET, 'getVoteAccounts', [{}])
  let owner = null
  for (const v of votes.current.slice(0, 10)) {
    const bal = await solRpc(MAINNET, 'getBalance', [v.nodePubkey, {}])
      .then((r) => BigInt(r.value))
      .catch(() => 0n)
    if (bal > 2_000_000_000n) {
      owner = v.nodePubkey
      break
    }
  }
  const fakeKey = { address: owner, privateKey: new Uint8Array(32), zero() {} }
  const prepared = await prepareCreateStake(MAINNET, fakeKey, 1_000_000_000n, validators[0].votePubkey)
  const sim = await solRpc(MAINNET, 'simulateTransaction', [
    prepared.unsigned,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'jsonParsed', addresses: [prepared.stakeAccount] },
    },
  ])
  const post = sim.value.accounts?.[0]
  check(
    'mainnet sim: create+initialize+delegate executes, account delegated',
    sim.value.err == null && post?.data?.parsed?.type === 'delegated',
    JSON.stringify(sim.value.err) + ' ' + (sim.value.logs ?? []).slice(-2).join(' | '),
  )
  check(
    'runtime accepted the seed-derived address (derivation proven)',
    sim.value.err == null && prepared.stakeAccount === stakeAccountAddress(owner, 0),
  )
} catch (e) {
  check('mainnet stake simulation', false, e.message)
}

// --- 3. Devnet: REAL full lifecycle -----------------------------------------
const key0 = deriveSolKey(VECTOR_MNEMONIC, 0)
try {
  const minStake = await getMinimumStake(DEVNET)
  let bal = await getSolBalance(DEVNET, key0.address)
  const needed = minStake + 10_000_000n // stake + rent + fees headroom
  if (bal < needed) {
    try {
      await requestDevnetAirdrop(key0.address)
      for (let i = 0; i < 10 && bal < needed; i++) {
        await sleep(3000)
        bal = await getSolBalance(DEVNET, key0.address).catch(() => bal)
      }
    } catch (e) {
      // rate-limited faucet — handled below
    }
  }
  if (bal < needed) {
    skip('devnet lifecycle e2e', `balance ${bal} < ${needed} and faucet unavailable`)
  } else {
    const vals = await fetchValidators(DEVNET)
    check('devnet validators available', vals.length > 0)
    const before = await fetchStakeAccounts(DEVNET, key0.address)
    const created = await prepareCreateStake(DEVNET, key0, minStake, vals[0].votePubkey)
    const sig1 = await broadcastStakeAction(key0, created)
    console.log(`      devnet create+delegate tx: ${sig1}`)
    let view = null
    for (let i = 0; i < 15 && view == null; i++) {
      await sleep(3000)
      const accs = await fetchStakeAccounts(DEVNET, key0.address).catch(() => [])
      view = accs.find((a) => a.address === created.stakeAccount) ?? null
    }
    check(
      'e2e stake account live and activating/active',
      view != null && (view.state === 'activating' || view.state === 'active'),
      JSON.stringify(view),
    )

    const deact = await prepareDeactivate(DEVNET, key0, view)
    const sig2 = await broadcastStakeAction(key0, deact)
    console.log(`      devnet deactivate tx: ${sig2}`)
    let wdView = null
    for (let i = 0; i < 15 && (wdView == null || wdView.state !== 'withdrawable'); i++) {
      await sleep(3000)
      const accs = await fetchStakeAccounts(DEVNET, key0.address).catch(() => [])
      wdView = accs.find((a) => a.address === created.stakeAccount) ?? null
    }
    check(
      'e2e same-epoch deactivation → instantly withdrawable',
      wdView != null && wdView.state === 'withdrawable',
      JSON.stringify(wdView),
    )

    const balBefore = await getSolBalance(DEVNET, key0.address)
    const wd = await prepareWithdraw(DEVNET, key0, wdView)
    const sig3 = await broadcastStakeAction(key0, wd)
    console.log(`      devnet withdraw tx: ${sig3}`)
    let closed = false
    let balAfter = balBefore
    for (let i = 0; i < 15 && !closed; i++) {
      await sleep(3000)
      const accs = await fetchStakeAccounts(DEVNET, key0.address).catch(() => null)
      if (accs != null && !accs.some((a) => a.address === created.stakeAccount)) {
        closed = true
        balAfter = await getSolBalance(DEVNET, key0.address).catch(() => balBefore)
      }
    }
    check('e2e withdraw closes the stake account', closed)
    check(
      `e2e funds returned (+${balAfter - balBefore} lamports incl. rent)`,
      balAfter - balBefore >= wd.amount - 10_000n,
    )
    check('slot bookkeeping consistent', before.length <= MAX_STAKE_ACCOUNTS)
  }
} catch (e) {
  check('devnet lifecycle e2e', false, e.message)
}

key0.zero()
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
