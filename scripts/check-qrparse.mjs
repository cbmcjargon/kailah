// Standalone verification for src/lib/qrparse.ts.
// Run from the repo root: npx tsx scripts/check-qrparse.mjs
// Exits nonzero on any failed assertion.

import { CHAINS } from '../src/lib/networks.ts'
import { parseScannedPayment } from '../src/lib/qrparse.ts'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Expect a successful parse with the given address and amount (undefined = omitted). */
function checkParse(name, text, chain, wantAddress, wantAmount) {
  try {
    const got = parseScannedPayment(text, chain)
    const addrOk = got.address === wantAddress
    const amtOk = got.amount === wantAmount
    check(
      name,
      addrOk && amtOk,
      `got address=${got.address} amount=${got.amount ?? '(omitted)'}, ` +
        `want address=${wantAddress} amount=${wantAmount ?? '(omitted)'}`,
    )
  } catch (e) {
    check(name, false, `threw: "${e instanceof Error ? e.message : String(e)}"`)
  }
}

/** Expect parseScannedPayment to throw with a message matching msgRe. */
function checkThrows(name, text, chain, msgRe) {
  try {
    const got = parseScannedPayment(text, chain)
    check(name, false, `did not throw (got address=${got.address})`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msgRe.test(msg), `message: "${msg}"`)
  }
}

const BTC_ADDR = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const TB_ADDR = 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl'
const LTC_ADDR = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
const DOGE_ADDR = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'

// --- plain addresses -------------------------------------------------------
checkParse('plain bc1q on btc', BTC_ADDR, CHAINS.btc, BTC_ADDR, undefined)
checkParse('plain D-address on doge', DOGE_ADDR, CHAINS.doge, DOGE_ADDR, undefined)
checkParse('plain ltc1 on ltc', LTC_ADDR, CHAINS.ltc, LTC_ADDR, undefined)
checkParse('plain tb1q on btc-testnet', TB_ADDR, CHAINS['btc-testnet'], TB_ADDR, undefined)

// --- BIP21 URIs ------------------------------------------------------------
checkParse(
  'bitcoin: URI with amount+label',
  `bitcoin:${BTC_ADDR}?amount=0.001&label=x`,
  CHAINS.btc,
  BTC_ADDR,
  100000n,
)
checkParse(
  'ALL-CAPS URI: scheme, address, and AMOUNT key all normalize',
  `BITCOIN:${BTC_ADDR.toUpperCase()}?AMOUNT=0.5`,
  CHAINS.btc,
  BTC_ADDR,
  50000000n,
)
checkParse(
  'lowercase amount= also accepted',
  `bitcoin:${BTC_ADDR}?amount=0.5`,
  CHAINS.btc,
  BTC_ADDR,
  50000000n,
)
checkParse(
  'dogecoin: URI with whole-coin amount',
  `dogecoin:${DOGE_ADDR}?amount=12`,
  CHAINS.doge,
  DOGE_ADDR,
  1200000000n,
)
checkParse('litecoin: URI', `litecoin:${LTC_ADDR}`, CHAINS.ltc, LTC_ADDR, undefined)
checkParse(
  'ALL-CAPS litecoin URI lowercases the bech32 address',
  `LITECOIN:${LTC_ADDR.toUpperCase()}`,
  CHAINS.ltc,
  LTC_ADDR,
  undefined,
)
checkParse(
  'bitcoin: scheme with tb1q on btc-testnet',
  `bitcoin:${TB_ADDR}`,
  CHAINS['btc-testnet'],
  TB_ADDR,
  undefined,
)
checkParse('bitcoin:// tolerated', `bitcoin://${BTC_ADDR}`, CHAINS.btc, BTC_ADDR, undefined)
checkParse(
  'plain ALL-CAPS bech32 (no scheme) lowercases',
  BTC_ADDR.toUpperCase(),
  CHAINS.btc,
  BTC_ADDR,
  undefined,
)

// --- wrong-chain errors ----------------------------------------------------
checkThrows(
  'D-address scanned while sending btc',
  DOGE_ADDR,
  CHAINS.btc,
  /Dogecoin address.*sending Bitcoin\./,
)
checkThrows(
  'bc1q scanned while sending doge',
  BTC_ADDR,
  CHAINS.doge,
  /Bitcoin address.*sending Dogecoin\./,
)
checkThrows(
  'ltc1 scanned while sending btc',
  LTC_ADDR,
  CHAINS.btc,
  /Litecoin address.*sending Bitcoin\./,
)
checkThrows(
  'mainnet bc1q scanned while sending btc-testnet',
  BTC_ADDR,
  CHAINS['btc-testnet'],
  /Bitcoin address.*sending practice-network Bitcoin\./,
)
checkThrows(
  'testnet tb1q scanned while sending mainnet btc',
  TB_ADDR,
  CHAINS.btc,
  /practice-network Bitcoin address.*sending Bitcoin\./,
)
checkThrows(
  'dogecoin: scheme while sending btc',
  `dogecoin:${DOGE_ADDR}?amount=1`,
  CHAINS.btc,
  /Dogecoin payment code.*sending Bitcoin\./,
)
checkThrows(
  'bitcoin: scheme while sending ltc',
  `bitcoin:${BTC_ADDR}`,
  CHAINS.ltc,
  /Bitcoin payment code.*sending Litecoin\./,
)

// --- bad amount params: scan still succeeds, amount omitted ----------------
checkParse(
  'amount=abc ignored, address kept',
  `bitcoin:${BTC_ADDR}?amount=abc`,
  CHAINS.btc,
  BTC_ADDR,
  undefined,
)
checkParse(
  'amount=-1 ignored, address kept',
  `bitcoin:${BTC_ADDR}?amount=-1`,
  CHAINS.btc,
  BTC_ADDR,
  undefined,
)
checkParse(
  'amount=0.000000001 (9 decimals) ignored, address kept',
  `bitcoin:${BTC_ADDR}?amount=0.000000001`,
  CHAINS.btc,
  BTC_ADDR,
  undefined,
)
checkParse(
  'amount=0 omitted, address kept',
  `bitcoin:${BTC_ADDR}?amount=0`,
  CHAINS.btc,
  BTC_ADDR,
  undefined,
)

// --- junk and empty --------------------------------------------------------
checkThrows('junk text rejected', 'hello world, not an address', CHAINS.btc, /doesn't contain a valid Bitcoin address\./)
checkThrows('unknown scheme rejected', 'https://example.com/pay', CHAINS.btc, /doesn't contain a valid Bitcoin address\./)
checkThrows('empty string rejected', '', CHAINS.btc, /^The scanned code was empty\.$/)
checkThrows('whitespace-only rejected', '  \n\t ', CHAINS.btc, /^The scanned code was empty\.$/)
checkThrows(
  'corrupted bech32 (bad checksum) rejected, not misread as wrong chain',
  'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyx',
  CHAINS.btc,
  /doesn't contain a valid Bitcoin address\./,
)

// --- MWEB (MimbleWimble) stealth addresses ---------------------------------
const MWEB_ADDR =
  'ltcmweb1qq0e5tqymvj3gwsvrmex0hzsyfmus47pyqfeqjdrhy9awhpqgdax7yq60fwrte3sdvmmumeqmgvvry8yctpvgqhtwe8rrhgm2yy2eefyz3q2dhxxe'
checkThrows(
  'MWEB address on ltc gets the honest explanation, not a generic rejection',
  MWEB_ADDR,
  CHAINS.ltc,
  /private \(MWEB\) Litecoin address/,
)
checkThrows(
  'ALL-CAPS MWEB address also detected',
  MWEB_ADDR.toUpperCase(),
  CHAINS.ltc,
  /private \(MWEB\) Litecoin address/,
)
checkThrows(
  'litecoin: URI wrapping an MWEB address also detected',
  `litecoin:${MWEB_ADDR}?amount=1`,
  CHAINS.ltc,
  /private \(MWEB\) Litecoin address/,
)

// --- whitespace trim -------------------------------------------------------
checkParse('surrounding whitespace trimmed', `  ${BTC_ADDR}\n`, CHAINS.btc, BTC_ADDR, undefined)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
