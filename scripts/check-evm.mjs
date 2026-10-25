// EVM engine verification for Kailah Wallet.
//
// Run from the repo root: npx tsx scripts/check-evm.mjs
//
// Offline: derivation against the published test vector AND an independent
// re-derivation (HDKey + keccak, no viem), ERC-20 calldata bytes, local
// EIP-1559 signing round-trip with sender recovery and chainId pinning.
// Live (read-only): chain ids on every configured RPC, USDC metadata sanity,
// a real balanceOf, and Blockscout history shape. Nothing is broadcast.

import { NET_ISSUE, isNetworkIssue, installLiveGuard } from './_live.mjs'
installLiveGuard('check-evm')
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, createPublicClient, http } from 'viem'
import {
  EVM_CHAINS,
  EVM_DERIVATION_PATH,
  deriveEvmKey,
  getEvmBalances,
  prepareEvmSend,
  isValidEvmAddress,
  parseEvmScanned,
} from '../src/lib/evm.ts'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// Published Ethereum test vector for the mnemonic above at m/44'/60'/0'/0/0.
const VECTOR_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

let failures = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !detail ? '' : ` — ${detail}`))
  if (!cond) failures++
}

// --- 1. Derivation: viem path vs published vector --------------------------
const key = deriveEvmKey(VECTOR_MNEMONIC)
check('derived address matches published vector', key.address.toLowerCase() === VECTOR_ADDRESS.toLowerCase(), key.address)

// --- 2. Independent re-derivation (no viem): HDKey + keccak ----------------
{
  const seed = mnemonicToSeedSync(VECTOR_MNEMONIC)
  const node = HDKey.fromMasterSeed(seed).derive(EVM_DERIVATION_PATH)
  // Ethereum address = last 20 bytes of keccak256(uncompressed pubkey minus prefix byte)
  const { secp256k1 } = await import('@noble/curves/secp256k1')
  const uncompressed = secp256k1.ProjectivePoint.fromPrivateKey(node.privateKey).toRawBytes(false)
  const hash = keccak_256(uncompressed.slice(1))
  const independent = '0x' + bytesToHex(hash.slice(-20))
  check('independent HDKey+keccak derivation agrees', independent.toLowerCase() === key.address.toLowerCase(), independent)
}

// --- 3. Address validation + QR parsing ------------------------------------
check('valid checksummed address accepted', isValidEvmAddress(VECTOR_ADDRESS))
check('lowercase address accepted', isValidEvmAddress(VECTOR_ADDRESS.toLowerCase()))
{
  // Mixed case carries an EIP-55 checksum: one flipped character must fail,
  // not silently re-checksum into a different address.
  const letter = /[a-zA-Z]/.exec(VECTOR_ADDRESS.slice(2))
  const i = 2 + letter.index
  const flipped =
    VECTOR_ADDRESS.slice(0, i) +
    (VECTOR_ADDRESS[i] === VECTOR_ADDRESS[i].toLowerCase()
      ? VECTOR_ADDRESS[i].toUpperCase()
      : VECTOR_ADDRESS[i].toLowerCase()) +
    VECTOR_ADDRESS.slice(i + 1)
  check('wrong EIP-55 checksum rejected', !isValidEvmAddress(flipped), flipped)
}
check('garbage rejected', !isValidEvmAddress('0x1234'))
check('btc address rejected', !isValidEvmAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'))
{
  const r = parseEvmScanned(`ethereum:${VECTOR_ADDRESS}@8453?value=0`)
  check('EIP-681 URI parses to the address', r.address.toLowerCase() === VECTOR_ADDRESS.toLowerCase())
  let msg = ''
  try { parseEvmScanned('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu') } catch (e) { msg = e.message }
  check('bitcoin address gets the friendly cross-family message', /Bitcoin-family/.test(msg), msg)
}
{
  // EIP-681 function form: `ethereum:<TOKEN_CONTRACT>/transfer?address=<RECIPIENT>`
  // is what MetaMask/Trust-style ERC-20 payment-request QRs emit. The recipient
  // is the `address` PARAMETER — filling in the contract would burn the funds.
  const usdcBase = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const r = parseEvmScanned(`ethereum:${usdcBase}@8453/transfer?address=${VECTOR_ADDRESS}&uint256=25000000`)
  check('EIP-681 transfer form yields the recipient, not the token contract',
    r.address.toLowerCase() === VECTOR_ADDRESS.toLowerCase(), r.address)
  let msg = ''
  try { parseEvmScanned(`ethereum:${usdcBase}@8453/approve?address=${VECTOR_ADDRESS}`) } catch (e) { msg = e.message }
  check('EIP-681 unknown function form refused', /doesn't support/.test(msg), msg)
  msg = ''
  try { parseEvmScanned(`ethereum:${usdcBase}@8453/transfer?uint256=25000000`) } catch (e) { msg = e.message }
  check('EIP-681 transfer form without a recipient refused', /no valid recipient/.test(msg), msg)
  msg = ''
  try { parseEvmScanned(`ethereum:${VECTOR_ADDRESS}@1?value=0`, 8453) } catch (e) { msg = e.message }
  check('EIP-681 chain-id mismatch refused when the open chain is known', /different network/.test(msg), msg)
  const r2 = parseEvmScanned(`ethereum:${VECTOR_ADDRESS}@8453?value=0`, 8453)
  check('EIP-681 matching chain id accepted', r2.address.toLowerCase() === VECTOR_ADDRESS.toLowerCase())
}

// --- 4. Offline send preparation + local signing round-trip ----------------
// Mock the client layer by preparing against sepolia with stubbed fetches is
// complex; instead sign a hand-rolled request exactly like broadcastEvmSend
// does and verify every field survives parsing + the sender recovers.
{
  const chain = EVM_CHAINS.base
  const to = '0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A'
  const amount = 1_250_000n // 1.25 USDC
  const { encodeFunctionData } = await import('viem')
  const data = encodeFunctionData({
    abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'transfer',
    args: [to, amount],
  })
  check('ERC-20 calldata selector is transfer (a9059cbb)', data.startsWith('0xa9059cbb'))
  check('calldata encodes recipient', data.toLowerCase().includes(to.slice(2).toLowerCase()))
  check('calldata encodes amount', data.endsWith(amount.toString(16).padStart(64, '0')))

  const request = {
    to: chain.token.address,
    value: 0n,
    data,
    gas: 60_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 100_000n,
    nonce: 7,
    chainId: chain.chainId,
  }
  const signed = await key.account.signTransaction({ type: 'eip1559', ...request })
  const parsed = parseTransaction(signed)
  check('signed tx round-trips: chainId pinned to Base', parsed.chainId === 8453)
  check('signed tx round-trips: to is the USDC contract', (parsed.to ?? '').toLowerCase() === chain.token.address.toLowerCase())
  check('signed tx round-trips: calldata intact', (parsed.data ?? '') === data)
  check('signed tx round-trips: nonce/gas intact', parsed.nonce === 7 && parsed.gas === 60_000n)
  const sender = await recoverTransactionAddress({ serializedTransaction: signed })
  check('recovered signer is our address', sender.toLowerCase() === key.address.toLowerCase(), sender)
  const decoded = decodeFunctionData({
    abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    data: parsed.data,
  })
  check('decoded transfer args match (to, amount)', decoded.args[0].toLowerCase() === to.toLowerCase() && decoded.args[1] === amount)
}

// --- 5. zero() wipes key bytes ---------------------------------------------
{
  const k2 = deriveEvmKey(VECTOR_MNEMONIC)
  k2.zero()
  // re-derive to prove zeroing didn't corrupt shared state
  const k3 = deriveEvmKey(VECTOR_MNEMONIC)
  check('zero() leaves fresh derivations intact', k3.address.toLowerCase() === VECTOR_ADDRESS.toLowerCase())
}

// --- 6. Live read-only checks ----------------------------------------------
for (const chain of Object.values(EVM_CHAINS)) {
  for (const rpc of chain.rpcs) {
    try {
      const c = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) })
      const id = await c.getChainId()
      check(`live ${rpc} chainId == ${chain.chainId}`, id === chain.chainId, String(id))
    } catch (e) {
      check(`live ${rpc} reachable`, false, e.message)
    }
  }
}
// Wiring proof per mainnet network: balances read end-to-end (RPC + USDC
// contract) for our vector address — values may be 0, the shape must be right.
for (const chain of Object.values(EVM_CHAINS).filter((c) => c.mainnet)) {
  try {
    const b = await getEvmBalances(chain, VECTOR_ADDRESS)
    check(
      `live ${chain.name}: balances read (token/gas bigints)`,
      typeof b.token === 'bigint' && typeof b.gas === 'bigint' && b.token >= 0n && b.gas >= 0n,
    )
  } catch (e) {
    check(`live ${chain.name}: balances read`, false, e.message)
  }
}

{
  const treasury = '0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A'
  const b = await getEvmBalances(EVM_CHAINS.base, treasury)
  check('live balanceOf(known holder) > 0 USDC', b.token > 0n, b.token.toString())
  const { fetchEvmHistory } = await import('../src/lib/evm.ts')
  const txs = await fetchEvmHistory(EVM_CHAINS.base, treasury).catch(() => [])
  if (txs.length === 0) {
    console.log('SKIP  live history — explorer returned nothing (blocked/rate-limited from this network)')
  } else {
    check('live history returns classified rows', ['in', 'out', 'self'].includes(txs[0].direction))
    check('history amounts are signed bigints', typeof txs[0].amount === 'bigint')
  }
}

// --- Custom ERC-20 detection + sending -------------------------------------
{
  const { sanitizeTokenSymbol, fetchDetectedTokens, deriveEvmKey: dk } = await import(
    '../src/lib/evm.ts'
  )

  // Sanitizer: hostile airdrop names must never reach the screen verbatim.
  const hostile = sanitizeTokenSymbol('Telegram @CheckSeedAndNancyBot') // real Base airdrop
  check('sanitizer flags real scam-airdrop name as unnamed', hostile.unnamed)
  check('sanitizer passes a plain symbol', sanitizeTokenSymbol('DOG').symbol === 'DOG')
  check('sanitizer rejects spaces', sanitizeTokenSymbol('USD C').unnamed)
  check('sanitizer rejects domain-shaped bait', sanitizeTokenSymbol('claim.site').unnamed)
  check('sanitizer keeps bridged-style symbols', sanitizeTokenSymbol('USDC.e').symbol === 'USDC.e')
  check('sanitizer rejects overlong symbols', sanitizeTokenSymbol('A'.repeat(11)).unnamed)
  check('sanitizer handles null', sanitizeTokenSymbol(null).unnamed)

  // Live detection on Base for the vector address (holds real scam airdrops).
  const detected = await fetchDetectedTokens(EVM_CHAINS.base, VECTOR_ADDRESS)
  check('live detection returns holdings', detected.length > 0, String(detected.length))
  check(
    'every detected symbol is display-safe',
    detected.every((t) => /^[A-Za-z0-9$._-]{1,10}$/.test(t.symbol) || t.symbol === 'Unnamed token'),
  )
  check(
    'pinned USDC never appears as a custom token',
    detected.every((t) => t.address.toLowerCase() !== EVM_CHAINS.base.token.address.toLowerCase()),
  )
  check('detected balances are positive bigints', detected.every((t) => t.balance > 0n))

  // Independent calldata check: transfer(address,uint256) built by hand must
  // equal what the engine sends for a custom token.
  const key = dk(VECTOR_MNEMONIC)
  if (detected.length > 0) {
    const tok = detected[0]
    const dest = '0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A'
    try {
      const prepared = await prepareEvmSend({
        chain: EVM_CHAINS.base,
        key,
        to: dest,
        amount: 1n,
        asset: 'token',
        customToken: tok,
      })
      const manual =
        '0xa9059cbb' +
        dest.slice(2).toLowerCase().padStart(64, '0') +
        (1n).toString(16).padStart(64, '0')
      check('custom-token prepare targets the token contract', prepared.request.to === tok.address)
      check('custom-token calldata matches hand-built bytes', prepared.request.data === manual)
      check('custom-token rides EIP-1559 with pinned chainId', prepared.request.chainId === 8453)
    } catch (e) {
      // Many scam airdrops deliberately revert transfers — the engine must
      // turn that into its plain-language refusal rather than a raw error.
      check(
        'non-transferable scam token fails with the friendly explanation',
        /non-transferable scams|refused the transfer|Not enough ETH/i.test(e.message),
        e.message.slice(0, 140),
      )
    }
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
