// Solana engine verification for Kailah Wallet.
//
// Run from the repo root: npx tsx scripts/check-sol.mjs
//
// Offline: SLIP-0010 ed25519 derivation against the OFFICIAL spec test
// vectors, an independent re-derivation of the wallet path, address
// validation, QR parsing, and a build+sign round-trip with the signature
// verified by @noble/curves directly.
// Live (devnet): a REAL end-to-end exercise — airdrop test SOL to the vector
// account, send some to a second derived account, confirm the transfer landed.
// Devnet coins are worthless by design; nothing here touches mainnet.

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-sol')
import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { ed25519 } from '@noble/curves/ed25519'
import * as solLib from 'micro-sol-signer'
import {
  SOL_CHAINS,
  slip10Ed25519,
  deriveSolKey,
  isValidSolAddress,
  parseSolScanned,
  prepareSolSend,
  broadcastSolSend,
  requestDevnetAirdrop,
  getSolBalance,
} from '../src/lib/sol.ts'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let failures = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : ` — ${detail}`))
  if (!cond) failures++
}
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`)

// --- 1. SLIP-0010 ed25519 against the OFFICIAL spec vectors ----------------
// https://github.com/satoshilabs/slips/blob/master/slip-0010.md  Test vector 1
{
  const seed = hexToBytes('000102030405060708090a0b0c0d0e0f')
  const m = slip10Ed25519(seed, [])
  check(
    'SLIP-0010 vector 1: master key',
    bytesToHex(m) === '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    bytesToHex(m),
  )
  const child = slip10Ed25519(seed, [0])
  check(
    "SLIP-0010 vector 1: m/0'",
    bytesToHex(child) === '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    bytesToHex(child),
  )
  const deep = slip10Ed25519(seed, [0, 1, 2, 2, 1000000000])
  check(
    "SLIP-0010 vector 1: m/0'/1'/2'/2'/1000000000'",
    bytesToHex(deep) === '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
    bytesToHex(deep),
  )
}

// --- 2. Wallet path: engine vs independent inline re-derivation ------------
const key = deriveSolKey(VECTOR_MNEMONIC)
{
  // Independent implementation, written from the SLIP-0010 spec text.
  const { mnemonicToSeedSync } = await import('@scure/bip39')
  const seed = mnemonicToSeedSync(VECTOR_MNEMONIC)
  let I = hmac(sha512, utf8ToBytes('ed25519 seed'), seed)
  let k = I.slice(0, 32)
  let c = I.slice(32)
  for (const idx of [44, 501, 0, 0]) {
    const data = new Uint8Array(37)
    data.set(k, 1)
    new DataView(data.buffer).setUint32(33, (idx + 0x80000000) >>> 0, false)
    I = hmac(sha512, c, data)
    k = I.slice(0, 32)
    c = I.slice(32)
  }
  const independentAddr = solLib.getAddress(k)
  check('wallet path: independent derivation agrees', independentAddr === key.address, key.address)
  console.log(`      vector account: ${key.address}`)
}

// --- 3. Address validation + QR parsing ------------------------------------
check('own address validates', isValidSolAddress(key.address))
check('garbage rejected', !isValidSolAddress('notanaddress'))
check('0x address rejected', !isValidSolAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'))
{
  const r = parseSolScanned(`solana:${key.address}?amount=1.5`)
  check('Solana Pay URI parses (address + amount)', r.address === key.address && r.amount === 1_500_000_000n)
  let msg = ''
  try { parseSolScanned('0x9858EfFD232B4033E47d90003D41EC34EcaEda94') } catch (e) { msg = e.message }
  check('0x input gets the friendly cross-family message', /Ethereum-style/.test(msg), msg)
}
{
  // Solana Pay spl-token: the amount is denominated in THAT token, never SOL.
  const usdcMainnet = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const r = parseSolScanned(`solana:${key.address}?amount=100&spl-token=${usdcMainnet}`)
  check(
    'spl-token URI: amount NOT parsed as SOL lamports',
    r.amount === undefined && r.splToken === usdcMainnet && r.tokenAmount === '100',
    JSON.stringify({ amount: r.amount?.toString(), splToken: r.splToken, tokenAmount: r.tokenAmount }),
  )
  const r2 = parseSolScanned(`solana:${key.address}?amount=1.5`)
  check('plain URI still yields SOL lamports', r2.amount === 1_500_000_000n && r2.splToken === undefined)
}

// --- 4. Offline build + sign round-trip ------------------------------------
{
  const dest = deriveSolKey(VECTOR_MNEMONIC, 1)
  const blockhash = solLib.getAddress(new Uint8Array(32).fill(3)) // any valid base58 32B
  const inst = solLib.sys.transferSol({ source: key.address, destination: dest.address, amount: 123456n })
  const unsigned = solLib.createTx(key.address, [inst], blockhash)
  const [sig, signed] = solLib.signTx(key.privateKey, unsigned)
  check('signTx returns signature + tx', typeof sig === 'string' && typeof signed === 'string')
  // Verify the ed25519 signature over the exact message bytes, independently:
  // a signed Solana tx is compact-u16 sig count + 64-byte sigs + the message.
  const bytes = Uint8Array.from(atob(signed), (ch) => ch.charCodeAt(0))
  const decoded = solLib.TransactionRaw.decode(bytes)
  check('decoded tx has exactly one signature', decoded.signatures.length === 1)
  const sigBytes = decoded.signatures[0]
  const msgBytes = bytes.slice(1 + 64) // 1-byte count (1) + one 64-byte signature
  const pub = ed25519.getPublicKey(key.privateKey)
  check('ed25519 signature verifies over the message', ed25519.verify(sigBytes, msgBytes, pub))
  dest.zero()
}

// --- 5. Live devnet end-to-end ---------------------------------------------
{
  const devnet = SOL_CHAINS['sol-devnet']
  const dest = deriveSolKey(VECTOR_MNEMONIC, 1)
  try {
    const before = await getSolBalance(devnet, key.address)
    console.log(`      devnet balance before: ${before} lamports`)
    let funded = before >= 20_000_000n
    if (!funded) {
      try {
        await requestDevnetAirdrop(key.address)
        // poll for the airdrop to land (devnet confirms in seconds)
        for (let i = 0; i < 15 && !funded; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          funded = (await getSolBalance(devnet, key.address)) >= 20_000_000n
        }
      } catch (e) {
        skip('devnet airdrop', `faucet limited: ${e.message}`)
      }
    }
    if (!funded) {
      skip('devnet e2e send', 'no devnet funds available this run')
    } else {
      const destBefore = await getSolBalance(devnet, dest.address)
      const prepared = await prepareSolSend({
        chain: devnet,
        key,
        to: dest.address,
        amount: 10_000_000n, // 0.01 test SOL
      })
      check('prepare: flat fee 5000 lamports', prepared.feeLamports === 5000n)
      const signature = await broadcastSolSend(key, prepared)
      check('broadcast accepted (signature returned)', typeof signature === 'string' && signature.length > 40)
      console.log(`      devnet tx: ${signature}`)
      let landed = false
      for (let i = 0; i < 15 && !landed; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        landed = (await getSolBalance(devnet, dest.address)) >= destBefore + 10_000_000n
      }
      check('recipient balance increased by the sent amount', landed)
    }
  } catch (e) {
    check('devnet e2e reachable', false, e.message)
  } finally {
    dest.zero()
  }
}

key.zero()
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
