// check-sitedemo.mjs — OFFLINE (no network). The marketing site's live demo,
// site/rob/index.html ("Try to rob Kailah"), stages four attacks in the visitor's
// browser against copies of the wallet's own checks in site/rob-checks.js: the
// lookalike-address check (src/lib/lookalike.ts), the TRON send check
// (tron.ts decodeTronRawTx, assertTronEnvelope, and prepareTronSend's TRX
// path with verifyTxId) and a Dogecoin coin's ID (rawtxcache.ts). The page
// says a test holds those copies to the wallet's code; this is that test.
// It proves:
//   A. the copies give the wallet's verdict, word for word, on 81,200 cases
//      from a seeded generator (SITEDEMO_SEED=<n> replays a run), and the
//      page's list of cases says the same numbers;
//   B. the wallet code the copy follows by hand still reads as it assumes:
//      prepareTronSend's TRX check and verifyTxId, plus the two Dogecoin
//      signing checks the page names (a change there must reach the page);
//   C. every staged TRON attack ends as the page says, by the wallet's check;
//   D. every poisoning button does what its label says, by the wallet's
//      lookalike check, and one character fewer is quiet; so does the first
//      challenge's fake, and Alex's own address reads as the contact;
//   E. the Dogecoin modes, by rawtxcache itself: the true bytes are kept,
//      the 25 DOGE lie and every one-bit change of the true bytes refused;
//   F. the words the page quotes are the wallet's (LookalikeWarning,
//      RecipientNote, EvmSendWaiting, TRON's refusals), and so are its
//      numbers (the 10 % replacement bump, the 30-minute UTXO hold);
//   G. the page keeps the site's rules: index.html's CSP, no inline script,
//      style or handler, only its own files, no version to go stale, every id
//      rob.js asks for, no HTML sink, network or storage API in its scripts;
//      the home page and the sitemap link it; its four challenges ask their
//      questions in order and deal only cases C, D and E test; and an element
//      marked hidden stays hidden.
import { readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// evm.ts and pending.ts reach for storage when called; nothing here persists
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const look = await import('../src/lib/lookalike.ts')
const tron = await import('../src/lib/tron.ts')
const rawtx = await import('../src/lib/rawtxcache.ts')
const pending = await import('../src/lib/pending.ts')
const evm = await import('../src/lib/evm.ts')
await import('../site/rob-checks.js')
const P = globalThis.KAILAH

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
const n = (x) => x.toLocaleString('en-US')
const robHtml = read('site/rob/index.html')
const robJs = read('site/rob.js')
const robChecks = read('site/rob-checks.js')
const tronSrc = read('src/lib/tron.ts')

// ---------------------------------------------------------------- seeded cases
const SEED = process.env.SITEDEMO_SEED !== undefined ? Number(process.env.SITEDEMO_SEED) >>> 0 : randomInt(0, 2 ** 32)
console.log(`seed ${SEED} (SITEDEMO_SEED=${SEED} replays this run)`)
function sfc32(a, b, c, d) {
  return () => {
    a |= 0
    b |= 0
    c |= 0
    d |= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
}
const next = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, SEED)
for (let i = 0; i < 15; i++) next()
const int = (lo, hi) => lo + Math.floor((next() / 4294967296) * (hi - lo)) // [lo, hi)
const chance = (p) => next() / 4294967296 < p
const bytes = (len) => Uint8Array.from({ length: len }, () => next() & 0xff)
const pick = (list) => list[int(0, list.length)]
const addr = {
  sol: () => P.b58encode(bytes(32)),
  tron: () => P.b58checkEncode(P.concat(new Uint8Array([0x41]), bytes(20))),
  evm: () => '0x' + P.hex(bytes(20)),
}

const tally = {}
const differ = {}
const first = {}
function agree(group, wallet, page, detail) {
  tally[group] = (tally[group] ?? 0) + 1
  if (wallet === page) return
  differ[group] = (differ[group] ?? 0) + 1
  first[group] ??= `${detail}\n    wallet: ${String(wallet).slice(0, 240)}\n    page:   ${String(page).slice(0, 240)}`
}

// TRON's refusals, as tron.ts words them (module-private constants)
const tronMessage = (name) => tronSrc.match(new RegExp(`\\nconst ${name} =\\s*(['"])(.*?)\\1\\n`, 's'))?.[2]
const WALLET = { UNEXPECTED: tronMessage('UNEXPECTED'), CLOCK_OR_NODE: tronMessage('CLOCK_OR_NODE'), MISMATCH: tronMessage('MISMATCH') }

// prepareTronSend's TRX path and verifyTxId, as B pins them
function walletVerdict(reply, owner, to, amount) {
  try {
    if (!reply.raw_data_hex) throw new Error(WALLET.MISMATCH)
    const decoded = tron.decodeTronRawTx(reply.raw_data_hex)
    tron.assertTronEnvelope(decoded, 0n)
    const c = decoded.contracts[0]
    if (
      decoded.contracts.length !== 1 ||
      c === undefined ||
      c.type !== 'TransferContract' ||
      c.owner !== owner ||
      c.to !== to ||
      c.amount !== amount
    ) {
      throw new Error(WALLET.MISMATCH)
    }
    const computed = bytesToHex(sha256(hexToBytes(reply.raw_data_hex)))
    if (reply.txID !== undefined && reply.txID !== computed) throw new Error(WALLET.MISMATCH)
    return `signed ${json(decoded)} ${computed}`
  } catch (e) {
    return `refused ${e.message}`
  }
}
function pageVerdict(reply, owner, to, amount) {
  try {
    const r = P.tron.checkTrxSend(reply, owner, to, amount, Date.now())
    return `signed ${json(r.decoded)} ${r.txID}`
  } catch (e) {
    return `refused ${e.message}`
  }
}
const verdictName = (v) =>
  v.startsWith('signed ') ? 'signed' : (Object.keys(WALLET).find((k) => v === `refused ${WALLET[k]}`) ?? v.slice(0, 80))

console.log('--- A. the page\'s copies against the wallet\'s modules ---')

for (let i = 0; i < 3000; i++) {
  const m = bytes(int(0, 400))
  agree('sha256', bytesToHex(sha256(m)), P.hex(P.sha256(m)), `${m.length} bytes`)
}

for (let i = 0; i < 500; i++) {
  const a = P.madeUp.tron()
  agree('tron address', tron.isValidTronAddress(a) && tron.tronAddressToHex(a).length === 42 ? 'valid' : 'invalid', 'valid', a)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const FORMATS = [
  ['sol', look.SOL_FORMAT, P.lookalike.SOL_FORMAT, B58, 0],
  ['tron', look.TRON_FORMAT, P.lookalike.TRON_FORMAT, B58, 1],
  ['evm', look.EVM_FORMAT, P.lookalike.EVM_FORMAT, '0123456789abcdef', 2],
]
// an address that keeps k characters of `of` at the start and m at the end
function partCopy(of, alphabet, skip, k, m) {
  const head = of.slice(0, skip + k)
  const tail = m > 0 ? of.slice(of.length - m) : ''
  let mid = ''
  while (head.length + mid.length + tail.length < of.length) mid += pick(alphabet)
  return head + mid + tail
}
for (const [net, walletFormat, pageFormat, alphabet, skip] of FORMATS) {
  for (let round = 0; round < 400; round++) {
    const pool = Array.from({ length: int(1, 12) }, () => addr[net]())
    const own = pool.filter(() => chance(0.2))
    const history = pool.filter(() => chance(0.6)).concat(chance(0.2) ? [null] : [])
    const sent = pool.filter(() => chance(0.3))
    const contacts = pool.filter(() => chance(0.3)).map((address, i) => ({ address, name: `Contact ${i}` }))
    const wk = look.knownAddresses(own, history, sent, contacts)
    const pk = P.lookalike.knownAddresses(own, history, sent, contacts)
    agree('knownAddresses', json(wk), json(pk), net)
    for (let c = 0; c < 25; c++) {
      const base = pick(pool)
      const kind = int(0, 6)
      let cand = kind === 0 ? base : kind === 1 ? addr[net]() : partCopy(base, alphabet, skip, int(0, 8), int(0, 8))
      if (net === 'evm' && chance(0.3)) cand = '0x' + cand.slice(2).toUpperCase()
      if (chance(0.1)) cand = `  ${cand} `
      const detail = `${net} ${cand.trim()}`
      agree('findLookalike', json(look.findLookalike(cand, wk, walletFormat)), json(P.lookalike.findLookalike(cand, pk, pageFormat)), detail)
      agree('findKnown', json(look.findKnown(cand, wk, walletFormat)), json(P.lookalike.findKnown(cand, pk, pageFormat)), detail)
    }
  }
}

const scene = () => ({
  owner: addr.tron(),
  to: addr.tron(),
  thief: addr.tron(),
  amount: BigInt(int(1, 2_000_000)) * 1_000_000n,
  refBytes: [...bytes(2)],
  refHash: [...bytes(8)],
  now: Date.now(),
  fakeId: P.hex(bytes(32)),
})
const STAGE_ROUNDS = 550
const ended = {}
for (let round = 0; round < STAGE_ROUNDS; round++) {
  const s = scene()
  for (const attack of P.tron.ATTACKS) {
    const { reply } = P.tron.stage(attack, s)
    const w = walletVerdict(reply, s.owner, s.to, s.amount)
    agree('tron staged', w, pageVerdict(reply, s.owner, s.to, s.amount), attack)
    const tallyOf = (ended[attack] ??= {})
    const v = verdictName(w)
    tallyOf[v] = (tallyOf[v] ?? 0) + 1
  }
}
for (let round = 0; round < 300; round++) {
  const s = scene()
  const raw = [...P.tron.stage(pick(P.tron.ATTACKS), s).raw]
  for (let m = 0; m < 30; m++) {
    const b = raw.slice()
    const op = int(0, 3)
    const at = int(0, b.length)
    if (op === 0) b[at] = int(0, 256)
    else if (op === 1) b.splice(at, 0, int(0, 256))
    else b.splice(at, 1)
    const reply = { raw_data_hex: P.hex(Uint8Array.from(b)) }
    agree('tron damaged', walletVerdict(reply, s.owner, s.to, s.amount), pageVerdict(reply, s.owner, s.to, s.amount), `${reply.raw_data_hex.slice(0, 48)}…`)
  }
}

for (let i = 0; i < 300; i++) {
  const raw = P.doge.legacyTx({
    prevTxid: P.hex(bytes(32)),
    prevVout: int(0, 4),
    scriptSig: [...bytes(int(0, 110))],
    outputs: [
      { value: BigInt(int(1, 1e9)) * 100n, script: P.doge.p2pkh([...bytes(20)]) },
      { value: BigInt(int(1, 1e9)) * 100n, script: P.doge.p2pkh([...bytes(20)]) },
    ],
  })
  const rawHex = P.hex(raw)
  const id = rawtx.txidOfRawHex(rawHex)
  agree('doge', id, P.doge.txidOfRawTx(rawHex), `${rawHex.slice(0, 48)}…`)
  const lied = Uint8Array.from(raw)
  lied[int(0, lied.length)] ^= 1 << int(0, 8)
  agree('doge', rawtx.rememberRawTx(id, P.hex(lied)) ? 'kept' : 'refused', 'refused', `${id} with one bit changed`)
  agree('doge', rawtx.rememberRawTx(id, rawHex) ? 'kept' : 'refused', 'kept', id)
}
rawtx.clearRawTxCache()

const GROUPS = [
  ['sha256', 'SHA-256 of random bytes, beside @noble/hashes (the wallet\'s)'],
  ['tron address', 'made-up TRON addresses, valid to tron.ts'],
  ['knownAddresses', 'trusted-address lists from random histories'],
  ['findLookalike', 'lookalike verdicts on exact, random and part-copied addresses'],
  ['findKnown', '"who is this" verdicts on the same addresses'],
  ['tron staged', 'TRON node replies staged by the page, all twelve attacks'],
  ['tron damaged', 'TRON transactions with a random byte changed, added or removed'],
  ['doge', 'Dogecoin coin IDs, and rawtxcache keeping true bytes and refusing a changed bit'],
]
for (const [group, what] of GROUPS) {
  check(`A ${what}: ${n(tally[group] ?? 0)} cases, the same verdict`, (tally[group] ?? 0) > 0 && !differ[group], differ[group] ? `${differ[group]} differ; the first: ${first[group]}` : '')
}
const total = Object.values(tally).reduce((s, x) => s + x, 0)
const listed = robHtml.slice(robHtml.indexOf('class="rb-counts"'))
const pageCounts = [...listed.slice(0, listed.indexOf('</ul>')).matchAll(/<li><b>([\d,]+)<\/b>/g)].map((m) => Number(m[1].replace(/,/g, '')))
const runCounts = [
  tally.findLookalike + tally.findKnown,
  tally['tron staged'],
  tally['tron damaged'],
  tally.sha256,
  tally['tron address'] + tally.knownAddresses + tally.doge,
]
const listOk = json(pageCounts) === json(runCounts) && norm(robHtml).includes(`${n(total)} cases`)
check(
  `A the page's list of cases (${pageCounts.map(n).join(', ')}) is this run's, and its lead says "${n(total)} cases"`,
  listOk,
  listOk ? '' : `this run: ${runCounts.map(n).join(', ')}, ${n(total)} in all`,
)

console.log('--- B. the wallet code the page follows by hand ---')
const tronN = norm(tronSrc)
const TRX_PATH = `
    if (!r.raw_data_hex) throw new Error(MISMATCH)
    const decoded = decodeTronRawTx(r.raw_data_hex)
    assertTronEnvelope(decoded, 0n)
    const c = decoded.contracts[0]
    if (
      decoded.contracts.length !== 1 ||
      c === undefined ||
      c.type !== 'TransferContract' ||
      c.owner !== key.address ||
      c.to !== to ||
      c.amount !== amount
    ) {
      throw new Error(MISMATCH)
    }`
const VERIFY_TXID = `
function verifyTxId(rawHex: string, claimed: string | undefined): string {
  const computed = bytesToHex(sha256(hexToBytes(rawHex)))
  if (claimed !== undefined && claimed !== computed) throw new Error(MISMATCH)
  return computed
}`
const prepareAt = tronN.indexOf('export async function prepareTronSend(')
const pathAt = tronN.indexOf(norm(TRX_PATH))
check(
  'B1 prepareTronSend\'s TRX check is still the one rob-checks.js checkTrxSend copies (decode, envelope at fee limit 0, one TransferContract from you to the recipient for the amount), and its txID still goes through verifyTxId; if it changes, change the copy and this pin with it',
  prepareAt >= 0 && pathAt > prepareAt && tronN.indexOf('txID: verifyTxId(r.raw_data_hex, r.txID),', pathAt) > pathAt,
)
check('B2 verifyTxId still refuses a claimed ID that isn\'t the SHA-256 of the bytes', tronN.includes(norm(VERIFY_TXID)))
const txbuildN = norm(read('src/lib/txbuild.ts'))
check(
  'B3 the signer still checks each legacy funding transaction against its coin\'s ID before it signs ("the signer checks the same hash again")',
  txbuildN.includes('if (txidOfRawTx(u.rawTxHex) !== u.txid) {') && txbuildN.includes('tx.addInput({ txid: u.txid, index: u.vout, sequence, nonWitnessUtxo: u.rawTxHex })'),
)
check(
  'B4 the signer still refuses a signed transaction whose fee isn\'t the planned one ("the fee the signed transaction really pays is the fee it planned")',
  txbuildN.includes('const actualFee = tx.fee') && txbuildN.includes('if (actualFee !== fee) {'),
)

console.log('--- C. the staged TRON attacks, by the wallet\'s check ---')
const EXPECT = {
  honest: 'signed',
  recipient: 'MISMATCH',
  amount: 'MISMATCH',
  duplicate: 'UNEXPECTED',
  approve: 'MISMATCH',
  relabel: 'UNEXPECTED',
  second: 'MISMATCH',
  permission: 'UNEXPECTED',
  expiry: 'CLOCK_OR_NODE',
  feelimit: 'UNEXPECTED',
  memo: 'UNEXPECTED',
  txid: 'MISMATCH',
}
const chips = [...robHtml.matchAll(/name="rb-tatk"[^>]*value="([^"]+)"/g)].map((m) => m[1])
const chipsOk = json(P.tron.ATTACKS) === json(Object.keys(EXPECT)) && json(chips) === json(P.tron.ATTACKS)
check('C1 the page stages twelve attacks, the chips name them in the same order, and this test expects each one', chipsOk, chipsOk ? '' : `${json(P.tron.ATTACKS)} vs chips ${json(chips)}`)
const offScript = P.tron.ATTACKS.filter((a) => (ended[a]?.[EXPECT[a]] ?? 0) !== STAGE_ROUNDS)
check(
  `C2 in all ${STAGE_ROUNDS} rounds the honest node's reply is signed, and the other eleven are refused: five as a mismatch with your request, five as unexpected fields, the day-long expiry as a clock or node problem`,
  offScript.length === 0,
  offScript.map((a) => `${a}: ${json(ended[a])}`).join('; '),
)

console.log('--- D. the poisoning buttons, by the wallet\'s lookalike check ---')
const dWrong = { history: [], contact: [], oneEnd: [], three: [], stranger: [] }
for (const net of ['sol', 'evm']) {
  const format = net === 'evm' ? look.EVM_FORMAT : look.SOL_FORMAT
  const one = net === 'evm' ? 6 : 4
  for (let i = 0; i < 100; i++) {
    // the page's scene (rob.js poisonSetup)
    const alex = P.madeUp[net]()
    const own = P.madeUp[net]()
    const other = P.madeUp[net]()
    const fake = P.lookalike.fakeOf(net, alex, 4, 4)
    const known = look.knownAddresses([own], [alex, fake, other], [alex], [{ address: alex, name: 'Alex' }])
    const alexOnly = look.knownAddresses([], [], [alex], [{ address: alex, name: 'Alex' }])
    const lookalike = (a, list = alexOnly) => look.findLookalike(a, list, format)
    const ends = (a) => lookalike(a)?.ends ?? 'quiet'
    const h = lookalike(fake, known)
    if (!(h && h.ends === 'both' && h.relation === 'contact' && h.name === 'Alex' && h.known === alex && h.seenIncoming === true)) dWrong.history.push(`${net} ${fake}: ${json(h)}`)
    const k = look.findKnown(alex, known, format)
    if (!(lookalike(alex, known) === null && k?.relation === 'contact' && k?.name === 'Alex')) dWrong.contact.push(`${net} ${alex}: ${json(k)}`)
    const oneEnd = [
      [P.lookalike.fakeOf(net, alex, one, 0), 'start'],
      [P.lookalike.fakeOf(net, alex, 0, one), 'end'],
      [P.lookalike.fakeOf(net, alex, one - 1, 0), 'quiet'],
      [P.lookalike.fakeOf(net, alex, 0, one - 1), 'quiet'],
    ]
    for (const [a, want] of oneEnd) if (ends(a) !== want) dWrong.oneEnd.push(`${net} ${a}: ${ends(a)}, not ${want}`)
    const three = [
      [P.lookalike.fakeOf(net, alex, 3, 3), 'both'],
      [P.lookalike.fakeOf(net, alex, 2, 3), 'quiet'],
      [P.lookalike.fakeOf(net, alex, 3, 2), 'quiet'],
    ]
    for (const [a, want] of three) if (ends(a) !== want) dWrong.three.push(`${net} ${a}: ${ends(a)}, not ${want}`)
    const stranger = P.madeUp[net]()
    if (look.findKnown(stranger, known, format) !== null) dWrong.stranger.push(`${net} ${stranger}`)
  }
}
const firstOf = (list) => (list.length ? `${list.length} wrong; ${list[0]}` : '')
check('D1 "Copy it from history" (Solana and 0x, 100 scenes each): the dust sender\'s address warns as a lookalike of your contact Alex, at both ends, as an address that sent you something', dWrong.history.length === 0, firstOf(dWrong.history))
check('D2 "Pick Alex from contacts": Alex\'s own address is no lookalike and reads as the saved contact', dWrong.contact.length === 0, firstOf(dWrong.contact))
check('D3 "A fake that copies the first 4 only" (6 on 0x) warns, and so do as many at the end alone; one character fewer at either end is quiet', dWrong.oneEnd.length === 0, firstOf(dWrong.oneEnd))
check('D4 "A fake with three at each end" warns at both ends; two at either end is quiet', dWrong.three.length === 0, firstOf(dWrong.three))
check('D5 "A stranger\'s address" is nobody the wallet knows', dWrong.stranger.length === 0, firstOf(dWrong.stranger))
check(
  'D6 the buttons and the math say these numbers: 4 at one end or 3 at each on Solana, 6 or 3 on 0x',
  robHtml.includes('>A fake that copies the first 4 only<') &&
    robJs.includes("'A fake that copies the first ' + (net === 'evm' ? 6 : 4) + ' only'") &&
    robJs.includes("L.fakeOf(P.net, P.alex, P.net === 'evm' ? 6 : 4, 0)") &&
    robJs.includes("L.fakeOf(P.net, P.alex, 3, 3)") &&
    robJs.includes("'So Kailah warns at 6 matching at one end, or 3 at each.'") &&
    robJs.includes("'So Kailah warns at 4 matching at one end, or 3 at each.'"),
)
{
  // the first challenge's case (rob.js, challenge 'poison'): Alex paid and saved as a contact, nothing else known
  const wrong = []
  for (let i = 0; i < 200; i++) {
    const alex = P.madeUp.sol()
    const known = look.knownAddresses([], [], [alex], [{ address: alex, name: 'Alex' }])
    const fake = P.lookalike.fakeOf('sol', alex, 4, 4)
    const w = look.findLookalike(fake, known, look.SOL_FORMAT)
    if (!(w && w.ends === 'both' && w.relation === 'contact' && w.name === 'Alex' && w.sameStart === 4 && w.sameEnd === 4)) wrong.push(`fake ${fake}: ${json(w)}`)
    const k = look.findKnown(alex, known, look.SOL_FORMAT)
    if (!(look.findLookalike(alex, known, look.SOL_FORMAT) === null && k?.relation === 'contact' && k?.name === 'Alex')) wrong.push(`alex ${alex}: ${json(k)}`)
  }
  check(
    'D7 the first challenge (200 cases): a fake copying 4 characters at each end warns as a lookalike of your contact Alex, matching exactly 4 at each end as the reveal says, and Alex\'s own address reads as the contact',
    wrong.length === 0,
    firstOf(wrong),
  )
}

console.log('--- E. the Dogecoin modes, by rawtxcache ---')
{
  // the page's scene (rob.js dogeTx)
  const KOINU = 100_000_000n
  const sig = [...bytes(106)]
  const you = [...bytes(20)]
  const other = [...bytes(20)]
  const prev = P.hex(bytes(32))
  const dogeTx = (value) =>
    P.doge.legacyTx({
      prevTxid: prev,
      prevVout: 1,
      scriptSig: sig,
      outputs: [
        { value, script: P.doge.p2pkh(you) },
        { value: 7_318n * KOINU + 40_000_000n, script: P.doge.p2pkh(other) },
      ],
    })
  const honest = dogeTx(2_500n * KOINU)
  const coinId = rawtx.txidOfRawHex(P.hex(honest))
  check('E1 "Tell the truth": the bytes that hash to the coin\'s ID are kept', rawtx.rememberRawTx(coinId, P.hex(honest)) === true)
  check('E2 "Say the coin holds 25 DOGE": the same transaction with the amount changed is refused', rawtx.rememberRawTx(coinId, P.hex(dogeTx(25n * KOINU))) === false)
  let kept = 0
  for (let bit = 0; bit < honest.length * 8; bit++) {
    const b = Uint8Array.from(honest)
    b[bit >> 3] ^= 1 << (bit & 7)
    if (rawtx.rememberRawTx(coinId, P.hex(b))) kept++
  }
  check(`E3 "Flip one bit anywhere": all ${n(honest.length * 8)} one-bit changes of the true bytes are refused`, kept === 0, kept === 0 ? '' : `${kept} kept`)
  check('E4 the loss the page works out: a 2,500 DOGE coin, 20 sent, 4 back as change, 2,476 DOGE to the miners', 2_500 - 20 - 4 === 2_476 && robJs.includes("b('2,476 DOGE', 'rb-loss')"))
  rawtx.clearRawTxCache()
}

console.log('--- F. the wallet\'s own words and numbers ---')
const ui = (path) =>
  norm(
    read(path)
      .replace(/&rsquo;/g, '’')
      .replace(/&lsquo;/g, '‘')
      .replace(/&ldquo;/g, '“')
      .replace(/&rdquo;/g, '”')
      .replace(/\{' '\}/g, ' '),
  )
const warningSrc = ui('src/components/LookalikeWarning.tsx')
const noteSrc = ui('src/components/RecipientNote.tsx')
const WARNING_WORDS = [
  'This looks like',
  ', but it’s a different address',
  'Scammers make addresses that',
  'start and end the same way',
  'start the same way',
  'end the same way',
  'as one you use',
  ', then send you a tiny amount so theirs shows up in your history. This address sent you something.',
  ', hoping you won’t check the middle.',
  ', hoping you won’t check the rest.',
  'your contact',
  'an address you’ve sent to before',
  'one of your own addresses',
  'another address in your history',
  'Your contact',
  'You sent to',
  'Your own address',
  'In your history',
  'You entered',
  'pick them from your contacts instead. Otherwise check the whole address with the person you’re paying.',
  'Check the whole address with the person you’re paying. Don’t copy it from your transaction history.',
  'I’ve checked the whole address and it’s the right one',
]
const NOTE_WORDS = ['· saved contact', 'One of your own addresses', 'You’ve paid this address before', 'New address: you haven’t paid it from this device before.']
const notWarning = WARNING_WORDS.filter((w) => !warningSrc.includes(w) || !robJs.includes(w))
const notNote = NOTE_WORDS.filter((w) => !noteSrc.includes(w) || !robJs.includes(w))
check(`F1 the page's lookalike warning uses LookalikeWarning.tsx's words (${WARNING_WORDS.length} phrases)`, notWarning.length === 0, notWarning.join(' | '))
check(`F2 its "who is this" lines are RecipientNote.tsx's (${NOTE_WORDS.length} phrases)`, notNote.length === 0, notNote.join(' | '))
const quoted = norm(robHtml).match(/in the wallet's own words: "([^"]+)"/)?.[1]
const waiting = new evm.EvmSendWaiting({}, 'Your last send').message
const quoteOk = quoted !== undefined && waiting.includes(quoted)
check('F3 the retry section quotes EvmSendWaiting\'s message exactly', quoteOk, quoteOk ? '' : `page: ${quoted ?? 'no quote found'}; wallet: ${waiting}`)
check(
  'F4 TRON refusals carry the wallet\'s own words: the page\'s three messages are tron.ts\'s',
  Object.values(WALLET).every((m) => typeof m === 'string' && m.length > 40) &&
    P.tron.UNEXPECTED === WALLET.UNEXPECTED &&
    P.tron.CLOCK_OR_NODE === WALLET.CLOCK_OR_NODE &&
    P.tron.MISMATCH === WALLET.MISMATCH,
)
check(
  'F5 "a 10% higher fee" and "fee +10%" are the wallet\'s replacement bump, and "up to 30 minutes" its UTXO hold',
  pending.EVM_REPLACE_BUMP_BPS === 1_000n &&
    pending.UTXO_TTL_MS === 30 * 60_000 &&
    robHtml.includes('at a 10% higher fee') &&
    robJs.includes('same payment, fee +10%') &&
    norm(robHtml).includes('hold new sends for up to 30 minutes'),
)

console.log('--- G. the page keeps the site\'s rules ---')
const cspOf = (html) => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
const indexHtml = read('site/index.html')
check('G1 the demo page carries index.html\'s Content-Security-Policy, word for word', cspOf(robHtml) !== undefined && cspOf(robHtml) === cspOf(indexHtml))
const inlineScript = [...robHtml.matchAll(/<script\b[^>]*>/gi)].filter((m) => !/\bsrc="/.test(m[0]))
check(
  'G2 no inline script, style element, style attribute, event-handler attribute or javascript: URL',
  inlineScript.length === 0 && !/<style\b/i.test(robHtml) && !/\sstyle\s*=/i.test(robHtml) && !/\son[a-z]+\s*=/i.test(robHtml) && !/javascript:/i.test(robHtml),
)
const sheets = [...robHtml.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1])
const scripts = [...robHtml.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[0])
const loads = [...robHtml.matchAll(/<(?:img|script|source|iframe|video|audio|embed|object)\b[^>]*\bsrc="([^"]+)"/g), ...robHtml.matchAll(/<link\b(?![^>]*rel="canonical")[^>]*href="([^"]+)"/g)].map((m) => m[1])
const loadsOk =
  json(sheets) === json(['../styles.css', '../rob.css']) &&
  json(scripts) === json(['<script src="../rob-checks.js" defer>', '<script src="../rob.js" defer>']) &&
  loads.every((u) => !/^(?:[a-z]+:)?\/\//i.test(u))
check('G3 it loads the site\'s styles.css and rob.css, then rob-checks.js and rob.js (deferred), and nothing from another host', loadsOk, loadsOk ? '' : json({ sheets, scripts, loads }))
check('G4 the page names no version number, so a release can\'t leave it behind', !/\bv?\d+\.\d+\.\d+\b/.test(robHtml.replace(/<svg[\s\S]*?<\/svg>/g, '')))
const ids = new Set([...robHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
const asked = [...robJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).concat(robJs.includes("$('rb-r-' + lane)") ? ['rb-r-naive', 'rb-r-kailah'] : [])
const symbols = new Set([...robHtml.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]))
const icons = [...robHtml.matchAll(/<use href="#([^"]+)"/g), ...robJs.matchAll(/icon\('([^']+)'\)/g)].map((m) => m[1])
const anchors = [...robHtml.matchAll(/<a\b[^>]*href="#([^"]+)"/g)].map((m) => m[1])
const groups = ['rb-pnet', 'rb-tatk', 'rb-dmode'].map((g) => [...robHtml.matchAll(new RegExp(`name="${g}"[^>]*?( checked)? />`, 'g'))].filter((m) => m[1]).length)
const tries = [...robHtml.matchAll(/data-try="([^"]+)"/g)].map((m) => m[1])
const wiredOk =
  asked.length > 20 &&
  asked.every((i) => ids.has(i)) &&
  icons.every((i) => symbols.has(i)) &&
  anchors.every((a) => ids.has(a)) &&
  json(groups) === '[1,1,1]' &&
  json(tries) === json(['history', 'contact', 'oneend', 'three', 'stranger'])
check(
  'G5 every id rob.js asks for is on the page, every icon and in-page link has its target, each choice group starts with one choice made, and the poisoning buttons are the five rob.js knows',
  wiredOk,
  wiredOk
    ? ''
    : json({ missingIds: asked.filter((i) => !ids.has(i)), missingIcons: icons.filter((i) => !symbols.has(i)), missingAnchors: anchors.filter((a) => !ids.has(a)), checkedPerGroup: groups, tries }),
)
const FORBIDDEN = [
  /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write/, /\bDOMParser\b/, /\bcreateContextualFragment\b/, /\bsrcdoc\b/,
  /\beval\s*\(/, /\bFunction\s*\(/, /\bset(?:Timeout|Interval)\s*\(\s*['"`]/,
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimport\s*\(/, /\bimportScripts\b/, /\bpostMessage\b/, /\bwindow\.open\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bcookie\b/, /\bcaches\b/, /\bserviceWorker\b/,
  /\.(?:src|href|action)\s*=/, /setAttribute\(\s*['"](?:src|on[a-z]+|action|formaction|style)['"]/,
]
const hits = []
for (const [name, text] of [['rob.js', robJs], ['rob-checks.js', robChecks]]) {
  for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${name}: ${re}`)
  const hrefs = [...text.matchAll(/setAttribute\(\s*['"]href['"]\s*,\s*([^)]*)\)/g)].map((m) => m[1])
  for (const v of hrefs) if (!v.startsWith("'#' +")) hits.push(`${name}: href set to ${v}`)
}
check('G6 rob.js and rob-checks.js use no HTML sink, eval, network or storage API (the one href they set is a sprite fragment)', hits.length === 0, hits.join('; '))
const sitemap = read('site/sitemap.xml')
check(
  'G7 the home page links the demo as rob/ (a folder: Netlify\'s Pretty URLs rewrites links to .html files in the HTML it serves) from its checks section and its footer, and sitemap.xml lists https://kailah.netlify.app/rob/, the page\'s canonical URL',
  (indexHtml.match(/href="rob\/"/g) ?? []).length >= 2 &&
    !/href="[^"]*\.html[#?"]/.test(indexHtml + robHtml) &&
    indexHtml.slice(indexHtml.indexOf('id="checks"'), indexHtml.indexOf('</section>', indexHtml.indexOf('id="checks"'))).includes('href="rob/"') &&
    sitemap.includes('<loc>https://kailah.netlify.app/rob/</loc>') &&
    robHtml.includes('<link rel="canonical" href="https://kailah.netlify.app/rob/" />') &&
    robHtml.includes('<meta property="og:url" content="https://kailah.netlify.app/rob/" />'),
)
const QUESTIONS = [
  ['poison', 'rb-q1', 'Can you spot a fake wallet address?', ['same', 'fake']],
  ['node', 'rb-q2', 'Can you detect a manipulated transaction?', ['sign', 'refuse']],
  ['doge', 'rb-q3', 'Can you identify a suspicious network response?', ['trust', 'doubt']],
  ['retry', 'rb-q4', 'Can you prevent a double payment?', ['again', 'wait', 'replace']],
]
const quizWrong = []
{
  const navAt = robHtml.indexOf('<nav class="rb-index"')
  const links = [...robHtml.slice(navAt, robHtml.indexOf('</nav>', navAt)).matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]])
  if (json(links) !== json(QUESTIONS.map(([section, , question]) => [section, question]))) quizWrong.push(`the index links ${json(links)}`)
  QUESTIONS.forEach(([section, quiz, question, answers], i) => {
    const at = robHtml.indexOf(`<section class="rb-attack" id="${section}"`)
    const body = at < 0 ? '' : robHtml.slice(at, robHtml.indexOf('</section>', at))
    if (!body.includes(`Challenge ${i + 1} of 4 · `) || !body.includes(`<h2 class="h2" id="${section}-title">${question}</h2>`)) quizWrong.push(`${section}: its eyebrow or heading`)
    const quizAt = body.indexOf(`<div class="rb-quiz" id="${quiz}" hidden>`)
    const howAt = body.indexOf('<p class="sub rb-how">')
    const benchAt = body.indexOf('<div class="rb-bench">')
    if (!(quizAt > 0 && quizAt < howAt && howAt < benchAt)) quizWrong.push(`${section}: the challenge, then how Kailah stops it, then the demo`)
    const choicesAt = body.indexOf(`id="${quiz}-choices"`)
    const got = [...body.slice(choicesAt, body.indexOf('</div>', choicesAt)).matchAll(/data-answer="([^"]+)"/g)].map((m) => m[1])
    if (choicesAt < 0 || json(got) !== json(answers)) quizWrong.push(`${section}: answers ${json(got)}`)
    for (const a of answers) if (!new RegExp(`'${a}'|\\b${a}: `).test(robJs)) quizWrong.push(`${section}: rob.js never reads '${a}'`)
    for (const part of ['', '-choices', '-reveal', '-again']) if (!robJs.includes(`$('${quiz}${part}')`)) quizWrong.push(`${section}: rob.js doesn't wire #${quiz}${part}`)
  })
  // the cases the challenges deal are the ones C, D7 and E test
  for (const dealt of ["L.fakeOf('sol', Q1.alex, 4, 4)", "rnd(3) === 0 ? 'honest' : T.ATTACKS[1 + rnd(T.ATTACKS.length - 1)]", "dogeServe(['truth', 'lie', 'flip'][rnd(3)])"]) {
    if (!robJs.includes(dealt)) quizWrong.push(`rob.js no longer deals ${dealt}`)
  }
  const scoreAt = robHtml.indexOf('<section class="rb-attack rb-final" id="score" aria-labelledby="score-title" hidden>')
  if (!(scoreAt > robHtml.indexOf('id="retry"') && scoreAt < robHtml.indexOf('<section class="rb-more"') && robJs.includes("$('score').hidden = false"))) quizWrong.push('the score section, after the retry and shown by rob.js')
}
check(
  'G8 the four challenges: the hero\'s index and the sections\' headings ask the four questions in order; each section puts its challenge (hidden until rob.js runs) before how Kailah stops it and the demo, with the answers rob.js reads; the cases dealt are the ones C, D7 and E test; and the score follows the last one',
  quizWrong.length === 0,
  quizWrong.join('; '),
)

check(
  'G9 an element with the hidden attribute stays hidden: rob.css says so for the whole page, since a button\'s or a challenge card\'s own display would otherwise win (until 2026-11-25 "Flip another bit" showed in every mode)',
  /\.rb \[hidden\] \{\s*display: none !important;\s*\}/.test(read('site/rob.css')),
)

console.log(failures === 0 ? '\nAll site demo checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
