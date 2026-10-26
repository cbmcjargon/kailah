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
//      on erase.
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
  check('D bech32: "bc1q" alone is not a matching start', findLookalike('bc1qx9zsrrr7xfkvy5l643lydnw9re59gtzzwf5mdq', utxo, UTXO_FORMAT) === null)
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
  check('D thresholds: 2 at the end is not enough', findLookalike('AbaE' + 'z'.repeat(38) + '6M', k, SOL_FORMAT) === null)
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

console.log(failures === 0 ? '\nAll lookalike checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
