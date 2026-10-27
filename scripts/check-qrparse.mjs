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


// --- BIP21 after the 2026-10-27 audit (BL3): a req- parameter the wallet
// doesn't know refuses the code; an unreadable amount is flagged, so the form
// clears the old amount; a code's amount replaces MAX.
{
  const refuse = (t) => { try { parseScannedPayment(t, CHAINS.btc); return '' } catch (e) { return e.message } }
  check('bip21: a req- parameter refuses the code (BIP21: unknown required parameters make it invalid)', /doesn't support \(req-/.test(refuse(`bitcoin:${BTC_ADDR}?amount=0.1&req-somethingnew=1`)))
  check('bip21: ...in any case', /doesn't support/.test(refuse(`bitcoin:${BTC_ADDR}?REQ-X=1`)))
  const bad = parseScannedPayment(`bitcoin:${BTC_ADDR}?amount=1,5`, CHAINS.btc)
  check('bip21: an unreadable amount keeps the address and says the amount was unreadable', bad.address === BTC_ADDR && bad.amount === undefined && bad.amountUnreadable === true)
  const good = parseScannedPayment(`bitcoin:${BTC_ADDR}?amount=0.5&label=x`, CHAINS.btc)
  check('bip21: a readable amount is not flagged', good.amount === 50_000_000n && good.amountUnreadable === undefined)
  const { readFileSync } = await import('node:fs')
  const send = readFileSync(new URL('../src/components/SendModal.tsx', import.meta.url), 'utf8')
  const solSend = readFileSync(new URL('../src/components/SolSendModal.tsx', import.meta.url), 'utf8')
  check('bip21: the send forms let a code\'s amount replace MAX and clear an unreadable one',
    /if \(scanned\.amount !== undefined\) \{\n\s+setSendMax\(false\)/.test(send) && /scanned\.amountUnreadable === true\) \{\n\s+setSendMax\(false\)\n\s+setAmountStr\(''\)/.test(send) &&
    /if \(r\.amount !== undefined\) \{\n\s+setSendMax\(false\)/.test(solSend))
}

// --- Solana Pay (src/lib/sol.ts parseSolScanned): reference and memo are
// carried (a merchant may not credit a payment without them), bad ones are
// refused rather than dropped (audit 2026-10-26, L14).
{
  const { parseSolScanned } = await import('../src/lib/sol.ts')
  const A = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
  const R1 = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb'
  const R2 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  const ok = (name, cond, detail = '') => check(`solana-pay: ${name}`, cond, detail)
  const r = parseSolScanned(`solana:${A}?amount=0.5&reference=${R1}&reference=${R2}&memo=Order%2042&label=Shop`)
  ok('address, amount, both references and the memo are read', r.address === A && r.amount === 500_000_000n && r.reference?.join() === [R1, R2].join() && r.memo === 'Order 42')
  const plain = parseSolScanned(`solana:${A}?amount=1`)
  ok('no reference/memo → neither is set', plain.reference === undefined && plain.memo === undefined)
  const t = () => parseSolScanned(`solana:${A}?reference=not-an-address`)
  let threw = false; try { t() } catch { threw = true }
  ok('an invalid reference is refused, not dropped', threw)
  threw = false; try { parseSolScanned(`solana:${A}?memo=${encodeURIComponent('x'.repeat(300))}`) } catch { threw = true }
  ok('an oversized memo is refused', threw)
  threw = false; try { parseSolScanned(`solana:${A}?memo=${encodeURIComponent('line\nbreak')}`) } catch { threw = true }
  ok('a memo with control characters is refused', threw)
  ok('five references are too many', (() => { try { parseSolScanned(`solana:${A}?` + [R1, R2, R1, R2, R1].map((x) => 'reference=' + x).join('&')); return false } catch { return true } })())

  // amounts are exact (bug audit 2026-10-27, BH6): the form used to fill
  // 0.123456 for a 0.123456789 SOL request, and the merchant never credited it
  const { solPayUnits } = await import('../src/lib/sol.ts')
  const refusal = (url) => { try { parseSolScanned(url); return '' } catch (e) { return e.message } }
  ok('a 9-decimal SOL amount is read to the lamport', parseSolScanned(`solana:${A}?amount=0.123456789`).amount === 123_456_789n)
  ok('more than 9 decimals is an invalid request, not a rounded one', /more decimal places than SOL has \(9\)/.test(refusal(`solana:${A}?amount=0.1234567891`)))
  ok('a malformed amount is refused, not dropped ("1,5", "abc", ".", "1e3", "-1")', ['1,5', 'abc', '.', '1e3', '-1'].every((a) => /isn't a valid number/.test(refusal(`solana:${A}?amount=${encodeURIComponent(a)}`))))
  ok('".5" and "5." are still read', parseSolScanned(`solana:${A}?amount=.5`).amount === 500_000_000n && parseSolScanned(`solana:${A}?amount=5.`).amount === 5_000_000_000n)
  const usdc = parseSolScanned(`solana:${A}?amount=12.345678&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
  ok('a token amount is kept as written for the form to read at the token\'s decimals', usdc.tokenAmount === '12.345678' && usdc.amount === undefined)
  ok('...exactly (USDC, 6 places), and one place more is refused', solPayUnits('12.345678', 6, 'USDC') === 12_345_678n && /more decimal places than USDC has \(6\)/.test((() => { try { solPayUnits('12.3456789', 6, 'USDC'); return '' } catch (e) { return e.message } })()))
}

// --- EIP-681 (src/lib/evm.ts parseEvmScanned): a payment request names its
// asset and amount; both used to be dropped, leaving the form on whatever
// asset it was on (bug audit 2026-10-27, BM16).
{
  const { parseEvmScanned, EVM_CHAINS } = await import('../src/lib/evm.ts')
  const USDC = EVM_CHAINS.base.token.address
  const R = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const ok = (name, cond, detail = '') => check(`eip-681: ${name}`, cond, detail)
  const fails = (url) => { try { parseEvmScanned(url, 8453); return '' } catch (e) { return e.message } }
  const t = parseEvmScanned(`ethereum:${USDC}@8453/transfer?address=${R}&uint256=25000000`, 8453)
  ok('a token request gives the recipient, the token contract and the amount in its smallest units', t.address === R && t.token?.toLowerCase() === USDC.toLowerCase() && t.amount === 25_000_000n, JSON.stringify({ ...t, amount: String(t.amount) }))
  ok('the amount may be written with an exponent (2.5e7)', parseEvmScanned(`ethereum:${USDC}@8453/transfer?address=${R}&uint256=2.5e7`, 8453).amount === 25_000_000n)
  const n = parseEvmScanned(`ethereum:${R}@8453?value=1.5e18`, 8453)
  ok('a plain request\'s value is wei, with no token', n.address === R && n.token === undefined && n.amount === 1_500_000_000_000_000_000n)
  ok('a plain address carries no amount', parseEvmScanned(R).amount === undefined)
  ok('an amount that isn\'t a whole number of units is refused, not rounded', /whole number/.test(fails(`ethereum:${R}@8453?value=1.23456789e3`)))
  ok('a malformed amount is refused', /isn't a valid number/.test(fails(`ethereum:${R}@8453?value=12abc`)) && /isn't a valid number/.test(fails(`ethereum:${USDC}@8453/transfer?address=${R}&uint256=-5`)))
  ok('a token request whose contract isn\'t an address is refused', /no valid token contract/.test(fails(`ethereum:usdc@8453/transfer?address=${R}&uint256=1`)))
  ok('another chain\'s request is still refused', /different network/.test(fails(`ethereum:${R}@1?value=1`)))
  const { readFileSync } = await import('node:fs')
  const modal = readFileSync(new URL('../src/components/EvmSendModal.tsx', import.meta.url), 'utf8')
  ok('the send form switches to the requested asset, refuses a token it doesn\'t send, and fills the amount exactly',
    /if \(r\.token\.toLowerCase\(\) !== sendable\.toLowerCase\(\)\)/.test(modal) && /setAsset\('token'\)/.test(modal) && /setAsset\('gas'\)/.test(modal) && /setAmountStr\(formatTypedAmount\(r\.amount, d\)\)/.test(modal))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
