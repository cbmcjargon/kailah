// Standalone derivation check for src/lib/keys.ts against published BIP84
// test vectors and structural address validation.
//
// Run from the repo root: npx tsx scripts/check-keys.mjs

import { deriveKey } from '../src/lib/keys.ts'
import { CHAINS } from '../src/lib/networks.ts'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { p2wpkh } from '@scure/btc-signer'
import { bech32, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Published BIP84 test vectors for the mnemonic above.
const BIP84_ADDR_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const BIP84_ADDR_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'

let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// --- btc mainnet: must match the published BIP84 vector exactly ---
const btcKey = deriveKey(VECTOR_MNEMONIC, CHAINS.btc)
console.log(`btc          ${btcKey.address}   (${btcKey.path})`)
check(
  'btc m/84\'/0\'/0\'/0/0 matches BIP84 vector',
  btcKey.address === BIP84_ADDR_0,
  `got ${btcKey.address}, want ${BIP84_ADDR_0}`,
)

// --- second BIP84 vector at index 1, derived directly via HDKey ---
const seed = mnemonicToSeedSync(VECTOR_MNEMONIC)
const node1 = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'/0/1")
const addr1 = p2wpkh(node1.publicKey, CHAINS.btc.network).address
console.log(`btc (idx 1)  ${addr1}   (m/84'/0'/0'/0/1)`)
check(
  'btc m/84\'/0\'/0\'/0/1 matches BIP84 vector',
  addr1 === BIP84_ADDR_1,
  `got ${addr1}, want ${BIP84_ADDR_1}`,
)

// --- btc-testnet: structural bech32 validation ---
const tKey = deriveKey(VECTOR_MNEMONIC, CHAINS['btc-testnet'])
console.log(`btc-testnet  ${tKey.address}   (${tKey.path})`)
check('btc-testnet starts with tb1q', tKey.address.startsWith('tb1q'), tKey.address)
let tbDecoded = null
try {
  tbDecoded = bech32.decode(tKey.address)
} catch (e) {
  tbDecoded = null
}
check(
  'btc-testnet is valid bech32 with hrp tb',
  tbDecoded !== null && tbDecoded.prefix === 'tb',
  tbDecoded ? `hrp ${tbDecoded.prefix}` : 'bech32 decode failed',
)

// --- doge: structural base58check validation ---
const dKey = deriveKey(VECTOR_MNEMONIC, CHAINS.doge)
console.log(`doge         ${dKey.address}   (${dKey.path})`)
check('doge starts with D', dKey.address.startsWith('D'), dKey.address)
let dogePayload = null
try {
  dogePayload = createBase58check(sha256).decode(dKey.address)
} catch (e) {
  dogePayload = null
}
check(
  'doge base58check decodes with version byte 0x1e and 20-byte hash',
  dogePayload !== null && dogePayload[0] === 0x1e && dogePayload.length === 21,
  dogePayload
    ? `version 0x${dogePayload[0].toString(16)}, length ${dogePayload.length}`
    : 'base58check decode failed',
)

// --- ltc: structural bech32 validation ---
const lKey = deriveKey(VECTOR_MNEMONIC, CHAINS.ltc)
console.log(`ltc          ${lKey.address}   (${lKey.path})`)
check('ltc starts with ltc1q', lKey.address.startsWith('ltc1q'), lKey.address)
let ltcDecoded = null
try {
  ltcDecoded = bech32.decode(lKey.address)
} catch (e) {
  ltcDecoded = null
}
check(
  'ltc is valid bech32 with hrp ltc',
  ltcDecoded !== null && ltcDecoded.prefix === 'ltc',
  ltcDecoded ? `hrp ${ltcDecoded.prefix}` : 'bech32 decode failed',
)

// --- sanity: key material shape ---
check('btc privateKey is 32 bytes', btcKey.privateKey.length === 32)
check('btc publicKey is 33 bytes (compressed)', btcKey.publicKey.length === 33)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
