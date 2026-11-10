// check-lookalike.mjs — OFFLINE. The send form's lookalike-address warning
// (src/lib/lookalike.ts) and the send log that feeds it (src/lib/sentlog.ts).
// It proves:
//   A. the real poisoning seen on the owner's Solana wallet (2026-10-25) is
//      caught: the address that dusted the wallet resembles the one it paid,
//      and the warning says it appears in the history;
//   B. an address this wallet has paid (its own send log), or one of its own,
//      never warns, and neither does a new address or someone who paid you;
//   C. history never makes an address trusted: a "sent" row from the data
//      service (a lying one could plant it), an incoming transfer, a TRON
//      zero-value USDT row, an EVM custom-token row — only the send log does;
//   D. per-network normalization: 0x and EVM checksum case, bech32 prefix and
//      case, TRON's leading T; and the match thresholds;
//   E. the send log: per chain, deduplicated, capped, encrypted at rest, gone
//      on erase;
//   F. case is folded only for this wallet's real bech32 prefixes in one
//      case: a Solana, TRON or legacy Litecoin address that merely starts
//      like one stays case-sensitive, so its case-flipped twin warns;
//   G. one end alone is enough when it matches for long enough (review
//      2026-11-10: the fakes that dusted a real wallet matched four
//      characters at one end and from none to four at the other): the shapes seen,
//      the figure for each kind of address with one character fewer staying
//      quiet, and how rarely 400 unrelated addresses per network warn by chance.
//      Every address in G is made up (a hash of a label): a real wallet's
//      counterparties don't belong in a public test.
import { sha256 } from '@noble/hashes/sha2'
import { base58, bech32, createBase58check } from '@scure/base'
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { findLookalike, knownAddresses, EVM_FORMAT, LOOKALIKE_MIN, SOL_FORMAT, TRON_FORMAT, UTXO_FORMAT } =
  await import('../src/lib/lookalike.ts')
const { recordSentTo, sentToAddresses } = await import('../src/lib/sentlog.ts')
const { unlockSecureStore, lockSecureStore, clearSecureStore } = await import('../src/lib/securestore.ts')

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const show = (m) => (m ? `${m.relation} ${m.known.slice(0, 8)}… start ${m.sameStart} end ${m.sameEnd}${m.seenIncoming ? ' incoming' : ''}` : 'no warning')

console.log('--- A. the poisoning seen on the owner\'s wallet ---')
const OWNER = 'BpmzmuZieAHqCm8s183T9c397K46YqsEQKbyyNo4Wo8b'
const PAID = 'AbaEGdJqWwCAavfwy4GVdTVeZUwaAn2Zjq6KxGTZoT6M'
const POISON = 'AbaEvnMFucpE85kTcQha3gJP8LWQFMxawx63oa4e1T6M'
// the history as fetchSolHistory shows it (two dusts, one send), and the
// wallet's own record that it paid PAID
const solKnown = knownAddresses([OWNER], [POISON, POISON, PAID], [PAID])
{
  const m = findLookalike(POISON, solKnown, SOL_FORMAT)
  check('A the dusting address warns: it resembles the address we paid', m?.known === PAID && m.relation === 'sent', show(m))
  check('A the warning knows it appears in the history', m?.seenIncoming === true)
  check('A it matches 4 characters at the start and 3 at the end', m?.sameStart === 4 && m?.sameEnd === 3, show(m))
  check('A the address we actually paid does not warn', findLookalike(PAID, solKnown, SOL_FORMAT) === null)
}

console.log('--- B. what never warns ---')
{
  const NEW = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  check('B a brand-new address that resembles nothing', findLookalike(NEW, solKnown, SOL_FORMAT) === null)
  check('B our own address', findLookalike(OWNER, solKnown, SOL_FORMAT) === null)
  const payer = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
  const k = knownAddresses([OWNER], [payer], [])
  check('B paying back someone who paid us, with no lookalike around', findLookalike(payer, k, SOL_FORMAT) === null)
  check('B leading or trailing spaces change nothing', findLookalike(`  ${PAID} `, solKnown, SOL_FORMAT) === null && findLookalike(` ${POISON}`, solKnown, SOL_FORMAT)?.known === PAID)
  check('B an empty or too-short address is not judged', findLookalike('', solKnown, SOL_FORMAT) === null && findLookalike('AbaEM', solKnown, SOL_FORMAT) === null)
}

console.log('--- C. history never makes an address trusted ---')
{
  // the data service lists a "send" to the lookalike: still a warning, and
  // the real address (in OUR log) is the one named
  const planted = knownAddresses([OWNER], [POISON, PAID], [PAID])
  const m = findLookalike(POISON, planted, SOL_FORMAT)
  check('C a "sent to the lookalike" row planted in the history does not silence the warning', m?.known === PAID && m.relation === 'sent', show(m))
  // without our own log, two lookalikes in the history warn about each other
  const k = knownAddresses([OWNER], [PAID, POISON], [])
  const w = findLookalike(POISON, k, SOL_FORMAT)
  check('C two lookalikes that are only in the history: either one warns', w?.known === PAID && w.relation === 'other' && findLookalike(PAID, k, SOL_FORMAT)?.known === POISON, show(w))
  // the log wins over the history for the same address
  const both = knownAddresses([OWNER], [PAID], [PAID])
  check('C an address in both the log and the history counts as paid', both.find((x) => x.address === PAID)?.relation === 'sent' && both.length === 2)
  // priority: resembling an address we paid outranks resembling one in the history
  const prio = knownAddresses([OWNER], ['AbaE1111111111111111111111111111111111e1T6M', PAID], [PAID])
  check('C the warning names the address we paid over one that is only in the history', findLookalike(POISON, prio, SOL_FORMAT)?.known === PAID)
  // TRON: a zero-value USDT "send" and an EVM custom-token "send" are history rows like any other
  const TOWN = 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH'
  const TPAID = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
  const TFAKE = 'TXYZqk2BxNv8sHmcPLJq1GfJr7wWRtAeBf'
  const tron = knownAddresses([TOWN], [TPAID, TFAKE], [TPAID])
  const t = findLookalike(TFAKE, tron, TRON_FORMAT)
  check('C TRON: a zero-value USDT "send" row to a lookalike does not trust it', t?.known === TPAID && t.relation === 'sent', show(t))
  check('C TRON: the address we really paid is still trusted', findLookalike(TPAID, tron, TRON_FORMAT) === null)
  const EOWN = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const EPAID = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const EFAKE = '0x5aAe1111111111111111111111111111Ef1BeAed'
  const evm = knownAddresses([EOWN], [EPAID, EFAKE], [EPAID])
  const e = findLookalike(EFAKE, evm, EVM_FORMAT)
  check('C EVM: a custom-token "send" row to a lookalike does not trust it', e?.known === EPAID && e.relation === 'sent', show(e))
  check('C EVM: a native send this wallet made trusts its recipient', findLookalike(EPAID, evm, EVM_FORMAT) === null)
}

console.log('--- D. normalization and thresholds ---')
{
  const EOWN = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const EPAID = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const evm = knownAddresses([EOWN], [], [EPAID])
  check('D EVM: the same address in lowercase is the same address', findLookalike(EPAID.toLowerCase(), evm, EVM_FORMAT) === null)
  const near = '0x5AAE000000000000000000000000000000000AED'
  check('D EVM: a lookalike in different case still warns', findLookalike(near, evm, EVM_FORMAT)?.known === EPAID)
  check('D EVM: "0x" alone is not a matching start', findLookalike('0x5aa0000000000000000000000000000000000aed', evm, EVM_FORMAT)?.sameStart === 5 && findLookalike('0x5000000000000000000000000000000000000aed', evm, EVM_FORMAT) === null)

  const BOWN = ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g']
  const BPAID = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  const utxo = knownAddresses(BOWN, [], [BPAID])
  check('D bech32: "bc1q" alone is not a matching start', findLookalike('bc1qx9z' + 'z'.repeat(32) + 'mdq', utxo, UTXO_FORMAT) === null)
  check('D bech32: an address that differs only just after "bc1q" warns (three at both ends never saw it)', findLookalike('bc1qx9zsrrr7xfkvy5l643lydnw9re59gtzzwf5mdq', utxo, UTXO_FORMAT)?.known === BPAID)
  check('D bech32: a lookalike after "bc1q" warns', findLookalike('bc1qar0zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz5mdq', utxo, UTXO_FORMAT)?.known === BPAID)
  check('D bech32: uppercase is the same address', findLookalike(BPAID.toUpperCase(), utxo, UTXO_FORMAT) === null)
  check('D bech32: a lookalike of one of our own addresses warns as ours', findLookalike('bc1qcr8zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz6fyu', utxo, UTXO_FORMAT)?.relation === 'own')
  check('D UTXO: a history row naming our own address adds nothing', knownAddresses(BOWN, [BOWN[0]], []).length === BOWN.length)

  const TOWN = 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH'
  const TPAID = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
  const tron = knownAddresses([TOWN], [], [TPAID])
  check('D TRON: the leading "T" is not a matching start', findLookalike('TXY0000000000000000000000000000eBf', tron, TRON_FORMAT) === null && findLookalike('TXYZ000000000000000000000000000eBf', tron, TRON_FORMAT)?.known === TPAID)

  const k = knownAddresses([OWNER], [], [PAID])
  check(`D thresholds: ${LOOKALIKE_MIN} at each end warns`, findLookalike('Aba' + 'z'.repeat(38) + 'T6M', k, SOL_FORMAT) !== null)
  check('D thresholds: 2 at the start is not enough', findLookalike('Ab' + 'z'.repeat(39) + 'T6M', k, SOL_FORMAT) === null)
  check('D thresholds: 2 at the end is not enough', findLookalike('Aba' + 'z'.repeat(39) + '6M', k, SOL_FORMAT) === null)
  check('D thresholds: 4 at the start with 2 at the end warns, on the start alone (section G)', findLookalike('AbaE' + 'z'.repeat(38) + '6M', k, SOL_FORMAT)?.ends === 'start')
}

console.log('--- E. the send log ---')
{
  recordSentTo('sol', PAID)
  await new Promise((r) => setTimeout(r, 60))
  check('E locked: nothing is persisted', !store.has('kailah.sec.sentto'))
  await unlockSecureStore('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
  check('E unlock starts from what is on disk (nothing yet)', sentToAddresses('sol').length === 0)
  recordSentTo('sol', PAID)
  recordSentTo('sol', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
  recordSentTo('sol', PAID)
  recordSentTo('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
  check('E per chain, deduplicated, most recent last', sentToAddresses('sol').join() === ['HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', PAID].join() && sentToAddresses('btc').length === 1 && sentToAddresses('tron').length === 0)
  for (let i = 0; i < 600; i++) recordSentTo('cap', `addr${i}`)
  check('E capped at 500 per chain, keeping the newest', sentToAddresses('cap').length === 500 && sentToAddresses('cap').at(-1) === 'addr599' && !sentToAddresses('cap').includes('addr50'))
  await new Promise((r) => setTimeout(r, 60))
  const blob = store.get('kailah.sec.sentto')
  check('E on disk only as ciphertext', typeof blob === 'string' && !blob.includes(PAID.slice(0, 12)))
  lockSecureStore()
  check('E locked again: empty', sentToAddresses('sol').length === 0)
  await unlockSecureStore('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
  check('E unlocked: the log is back', sentToAddresses('sol').includes(PAID))
  clearSecureStore()
  check('E erase removes it', !store.has('kailah.sec.sentto') && sentToAddresses('sol').length === 0)
}

console.log('--- F. case folding only for real bech32 (bug audit 2026-10-27, BM12) ---')
{
  // a case-sensitive address that merely STARTS like bech32 ("..1q") was
  // lowercased, so a lookalike differing from it only in letter case read as
  // the same address and never warned
  const flip = (a, from) => a.slice(0, from) + [...a.slice(from, -4)].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('') + a.slice(-4)
  const SOL_PAID = 'Ab1qEGdJqWwCAavfwy4GVdTVeZUwaAn2Zjq6KxGTZoT6M'
  const solTwin = flip(SOL_PAID, 4)
  const m1 = findLookalike(solTwin, knownAddresses([], [], [SOL_PAID]), SOL_FORMAT)
  check('F1 Solana: a case-flipped twin of a paid address starting "Ab1q" warns', solTwin !== SOL_PAID && m1?.known === SOL_PAID, show(m1))
  const TRON_PAID = 'TAb1pHXWJ7v2sMkPBxNnpfgDqkhJ6ZMRSWy'
  const tronTwin = flip(TRON_PAID, 5)
  const m2 = findLookalike(tronTwin, knownAddresses([], [], [TRON_PAID]), TRON_FORMAT)
  check('F2 TRON: likewise for "TAb1p…"', tronTwin !== TRON_PAID && m2?.known === TRON_PAID, show(m2))
  const LTC_LEGACY = 'Ltc1qQ8Fz7b3N9xWJbN5yVt2KcLdRzXyAbC'
  const ltcTwin = flip(LTC_LEGACY, 5)
  const m3 = findLookalike(ltcTwin, knownAddresses([], [], [LTC_LEGACY]), UTXO_FORMAT)
  check('F3 a legacy (base58) Litecoin address that starts "Ltc1q" is case-sensitive too', m3?.known === LTC_LEGACY, show(m3))
  const BECH = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  check('F4 a real bech32 address in capitals is still the same address (no warning)', findLookalike(BECH.toUpperCase(), knownAddresses([], [], [BECH]), UTXO_FORMAT) === null)
  const bechTwin = 'bc1qar0sXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXf5mdq'.toLowerCase().replace(/x/g, 'q')
  const m5 = findLookalike(bechTwin, knownAddresses([], [], [BECH]), UTXO_FORMAT)
  check('F5 ...and a real bech32 lookalike still warns, past the shared "bc1q"', m5?.known === BECH && m5.sameStart >= 4, show(m5))
}

console.log('--- G. one end alone (review 2026-11-10) ---')
{
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const HEX = '0123456789abcdef'
  // made-up addresses of each kind, from the hash of a label
  const bytes = (label) => sha256(new TextEncoder().encode(`kailah check-lookalike ${label}`))
  const b58check = createBase58check(sha256)
  const solAddr = (label) => base58.encode(bytes(label))
  const tronAddr = (label) => b58check.encode(Uint8Array.from([0x41, ...bytes(label).slice(0, 20)]))
  const dogeAddr = (label) => b58check.encode(Uint8Array.from([0x1e, ...bytes(label).slice(0, 20)]))
  const evmAddr = (label) => '0x' + [...bytes(label).slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const btcAddr = (label) => bech32.encode('bc', [0, ...bech32.toWords(bytes(label).slice(0, 20))])
  // `address` with only its first `s` and last `e` characters (after `skip`)
  // kept: every other one becomes the next in its alphabet, so the two share
  // exactly that much
  const like = (address, s, e, alphabet, skip = 0) => {
    const body = [...address.slice(skip)]
    return address.slice(0, skip) + body.map((c, i) => (i < s || i >= body.length - e ? c : alphabet[(alphabet.indexOf(c) + 1) % alphabet.length])).join('')
  }

  const OWN = solAddr('own')
  const P = solAddr('paid')
  const k = knownAddresses([OWN], [], [P])
  const at = (s, e) => findLookalike(like(P, s, e, B58), k, SOL_FORMAT)
  const m14 = at(1, 4)
  check('G1 Solana: the last four with one at the start warns (the fake seen most often)', m14?.known === P && m14.ends === 'end' && m14.sameStart === 1 && m14.sameEnd === 4, show(m14))
  check('G1b the last four with two at the start, and the first four with two at the end, warn', at(2, 4)?.ends === 'end' && at(4, 2)?.ends === 'start', `${show(at(2, 4))} / ${show(at(4, 2))}`)
  check('G1c one end alone is enough: the last four and nothing else, or the first four and nothing else', at(0, 4)?.ends === 'end' && at(4, 0)?.ends === 'start')
  check('G1d three at one end is not: (3,0), (0,3), (3,2) and (2,3) stay quiet', [at(3, 0), at(0, 3), at(3, 2), at(2, 3)].every((m) => m === null))
  check('G1e three at both ends is still a match on both ends, and so is a longer one', at(3, 3)?.ends === 'both' && at(5, 5)?.ends === 'both')
  check('G1f the address really paid, and our own, still never warn', findLookalike(P, k, SOL_FORMAT) === null && findLookalike(OWN, k, SOL_FORMAT) === null)
  check('G1g a one-ended lookalike of our own address warns as ours', findLookalike(like(OWN, 0, 4, B58), k, SOL_FORMAT)?.relation === 'own')
  const fake = like(P, 1, 4, B58)
  const dusted = findLookalike(fake, knownAddresses([OWN], [fake], [P]), SOL_FORMAT)
  check('G1h ...and one that dusted the wallet is named as in the history, against the address we paid', dusted?.seenIncoming === true && dusted.known === P && dusted.relation === 'sent', show(dusted))
  // the ten fakes that imitated an address a real wallet deals with, as
  // (same first, same last), over two weeks of its SOL and USDC transfers
  const seen = [[4, 3], [4, 3], [4, 3], [4, 3], [4, 3], [4, 4], [1, 4], [2, 4], [4, 2], [4, 0]]
  check('G1i all ten shapes seen on a real wallet warn; three at both ends alone caught six of them',
    seen.every(([s, e]) => at(s, e) !== null) && seen.filter(([s, e]) => s >= LOOKALIKE_MIN && e >= LOOKALIKE_MIN).length === 6)

  const tP = tronAddr('paid')
  const tk = knownAddresses([tronAddr('own')], [], [tP])
  const tat = (s, e) => findLookalike(like(tP, s, e, B58, 1), tk, TRON_FORMAT)
  check('G2 TRON: four after the "T", or the last four, warn; three do not', tat(4, 0)?.ends === 'start' && tat(0, 4)?.ends === 'end' && tat(3, 0) === null && tat(0, 3) === null && tat(3, 2) === null, `${show(tat(4, 0))} / ${show(tat(0, 4))}`)

  const eP = evmAddr('paid')
  const ek = knownAddresses([evmAddr('own')], [], [eP])
  const eat = (s, e) => findLookalike(like(eP, s, e, HEX, 2), ek, EVM_FORMAT)
  check('G3 0x addresses: six at one end warn, five do not (a hex character says less)', eat(6, 0)?.ends === 'start' && eat(0, 6)?.ends === 'end' && [eat(5, 0), eat(0, 5), eat(5, 2), eat(2, 5)].every((m) => m === null), `${show(eat(6, 0))} / ${show(eat(0, 6))}`)
  check('G3b ...and three at both ends still warns there', eat(3, 3)?.ends === 'both')

  const bP = btcAddr('paid')
  const bk = knownAddresses([btcAddr('own')], [], [bP])
  const bat = (s, e) => findLookalike(like(bP, s, e, BECH, 4), bk, UTXO_FORMAT)
  check('G4 bech32: five after "bc1q", or the last five, warn; four do not', bP.startsWith('bc1q') && bat(5, 0)?.ends === 'start' && bat(0, 5)?.ends === 'end' && [bat(4, 0), bat(0, 4), bat(4, 2)].every((m) => m === null), `${show(bat(5, 0))} / ${show(bat(0, 5))}`)

  const dP = dogeAddr('paid')
  const dk = knownAddresses([dogeAddr('own')], [], [dP])
  const dat = (s, e) => findLookalike(like(dP, s, e, B58), dk, UTXO_FORMAT)
  check('G5 legacy base58 (Dogecoin): every address starts with the same "D", so the start needs five; the last four warn', dP.startsWith('D') && dat(5, 0)?.ends === 'start' && dat(4, 0) === null && dat(0, 4)?.ends === 'end' && dat(0, 3) === null, `${show(dat(5, 0))} / ${show(dat(0, 4))}`)

  // Quiet on unrelated addresses: 400 of each kind, each checked against the
  // other 399 (79,800 pairs). A chance match is real but rare: this sample holds
  // one, two Solana addresses that end in the same four characters, which is
  // what one pair in three to thirty million (by kind and end) comes to.
  const warned = (make, format) => {
    const all = Array.from({ length: 400 }, (_, i) => make(`unrelated ${i}`))
    const known = knownAddresses([], all, [])
    return all.filter((a) => findLookalike(a, known, format) !== null).length
  }
  const noise = { Solana: warned(solAddr, SOL_FORMAT), TRON: warned(tronAddr, TRON_FORMAT), '0x': warned(evmAddr, EVM_FORMAT), bech32: warned(btcAddr, UTXO_FORMAT), Dogecoin: warned(dogeAddr, UTXO_FORMAT) }
  check('G6 among 400 unrelated addresses of each kind, at most one chance pair warns (two addresses), and none on four of the five kinds',
    Object.values(noise).every((n) => n <= 2) && Object.values(noise).filter((n) => n === 0).length >= 4, JSON.stringify(noise))
}

console.log(failures === 0 ? '\nAll lookalike checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
