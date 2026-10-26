// check-lookalike.mjs — OFFLINE. The send form's lookalike-address warning
// (src/lib/lookalike.ts). It proves:
//   A. the real poisoning seen on the owner's Solana wallet (2026-10-25) is
//      caught: the address that dusted the wallet resembles the one it paid,
//      and the warning says it sent the wallet something;
//   B. an address this account has paid, or one of its own, never warns, and
//      neither does a new address or someone who paid you;
//   C. history the attacker can write does not make an address trusted: an
//      incoming transfer, a TRON zero-value USDT "send", an EVM custom-token
//      "send";
//   D. per-network normalization: 0x and EVM checksum case, bech32 prefix and
//      case, TRON's leading T; and the match thresholds.
const {
  findLookalike,
  knownFromEvm,
  knownFromSol,
  knownFromTron,
  knownFromUtxo,
  EVM_FORMAT,
  LOOKALIKE_MIN,
  SOL_FORMAT,
  TRON_FORMAT,
  UTXO_FORMAT,
} = await import('../src/lib/lookalike.ts')

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
// the three rows as fetchSolHistory classifies them: our 0.1 SOL send, then
// 0.0001 USDC and 1000 lamports from the lookalike
const solTxs = [
  { direction: 'in', counterparty: POISON },
  { direction: 'in', counterparty: POISON },
  { direction: 'out', counterparty: PAID },
]
const solKnown = knownFromSol(OWNER, solTxs)
{
  const m = findLookalike(POISON, solKnown, SOL_FORMAT)
  check('A the dusting address warns: it resembles the address we paid', m?.known === PAID && m.relation === 'sent', show(m))
  check('A the warning knows it sent us something', m?.seenIncoming === true)
  check('A it matches 4 characters at the start and 3 at the end', m?.sameStart === 4 && m?.sameEnd === 3, show(m))
  check('A the address we actually paid does not warn', findLookalike(PAID, solKnown, SOL_FORMAT) === null)
}

console.log('--- B. what never warns ---')
{
  const NEW = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  check('B a brand-new address that resembles nothing', findLookalike(NEW, solKnown, SOL_FORMAT) === null)
  check('B our own address', findLookalike(OWNER, solKnown, SOL_FORMAT) === null)
  const payer = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
  const k = knownFromSol(OWNER, [{ direction: 'in', counterparty: payer }])
  check('B paying back someone who paid us, with no lookalike around', findLookalike(payer, k, SOL_FORMAT) === null)
  check('B leading or trailing spaces change nothing', findLookalike(`  ${PAID} `, solKnown, SOL_FORMAT) === null && findLookalike(` ${POISON}`, solKnown, SOL_FORMAT)?.known === PAID)
  check('B an empty or too-short address is not judged', findLookalike('', solKnown, SOL_FORMAT) === null && findLookalike('AbaEM', solKnown, SOL_FORMAT) === null)
}

console.log('--- C. history the attacker can write is not trusted ---')
{
  // TRON: USDT transferFrom(victim, lookalike, 0) needs no allowance and
  // shows up as an "out" row of 0
  const TOWN = 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH'
  const TPAID = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
  const TFAKE = 'TXYZqk2BxNv8sHmcPLJq1GfJr7wWRtAeBf'
  const tron = knownFromTron(TOWN, [
    { direction: 'out', counterparty: TPAID, amount: -5_000_000n },
    { direction: 'out', counterparty: TFAKE, amount: 0n },
  ])
  const m = findLookalike(TFAKE, tron, TRON_FORMAT)
  check('C TRON: a zero-value USDT "send" to a lookalike does not trust it', m?.known === TPAID && m.relation === 'sent', show(m))
  check('C TRON: the address we really paid is still trusted', findLookalike(TPAID, tron, TRON_FORMAT) === null)

  // EVM: a custom token can emit Transfer(from: us, to: lookalike)
  const EOWN = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const EPAID = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const EFAKE = '0x5aAe1111111111111111111111111111Ef1BeAed'
  const evm = knownFromEvm(EOWN, [
    { direction: 'out', counterparty: EPAID, asset: 'token' },
    { direction: 'out', counterparty: EFAKE, asset: 'token', tokenSymbol: 'USDC' },
  ])
  const e = findLookalike(EFAKE, evm, EVM_FORMAT)
  check('C EVM: a custom-token "send" to a lookalike does not trust it', e?.known === EPAID && e.relation === 'sent', show(e))
  const native = knownFromEvm(EOWN, [{ direction: 'out', counterparty: EPAID, asset: 'gas' }])
  check('C EVM: a native send trusts its recipient', findLookalike(EPAID, native, EVM_FORMAT) === null)

  // incoming only: two lookalikes that both sent us something still warn
  const k = knownFromSol(OWNER, [
    { direction: 'in', counterparty: PAID },
    { direction: 'in', counterparty: POISON },
  ])
  const w = findLookalike(POISON, k, SOL_FORMAT)
  check('C two lookalikes that only sent us coins: either one warns', w?.known === PAID && w.relation === 'other' && findLookalike(PAID, k, SOL_FORMAT)?.known === POISON, show(w))
  // priority: resembling an address we paid outranks resembling a sender
  const both = knownFromSol(OWNER, [
    { direction: 'in', counterparty: 'AbaE1111111111111111111111111111111111e1T6M' },
    { direction: 'out', counterparty: PAID },
  ])
  check('C the warning names the address we paid over one that paid us', findLookalike(POISON, both, SOL_FORMAT)?.known === PAID)
}

console.log('--- D. normalization and thresholds ---')
{
  const EOWN = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
  const EPAID = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const evm = knownFromEvm(EOWN, [{ direction: 'out', counterparty: EPAID, asset: 'gas' }])
  check('D EVM: the same address in lowercase is the same address', findLookalike(EPAID.toLowerCase(), evm, EVM_FORMAT) === null)
  const near = '0x5AAE000000000000000000000000000000000AED'
  check('D EVM: a lookalike in different case still warns', findLookalike(near, evm, EVM_FORMAT)?.known === EPAID)
  check('D EVM: "0x" alone is not a matching start', findLookalike('0x5aa0000000000000000000000000000000000aed', evm, EVM_FORMAT)?.sameStart === 5 && findLookalike('0x5000000000000000000000000000000000000aed', evm, EVM_FORMAT) === null)

  const BOWN = ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g']
  const BPAID = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  const utxo = knownFromUtxo(BOWN, [{ direction: 'out', counterparty: BPAID }])
  check('D bech32: "bc1q" alone is not a matching start', findLookalike('bc1qzzzsrrr7xfkvy5l643lydnw9re59gtzzwf5mdq'.replace('zzz', 'x9z'), utxo, UTXO_FORMAT) === null)
  check('D bech32: a lookalike after "bc1q" warns', findLookalike('bc1qar0zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz5mdq', utxo, UTXO_FORMAT)?.known === BPAID)
  check('D bech32: uppercase is the same address', findLookalike(BPAID.toUpperCase(), utxo, UTXO_FORMAT) === null)
  check('D bech32: a lookalike of one of our own addresses warns as ours', findLookalike('bc1qcr8zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz6fyu', utxo, UTXO_FORMAT)?.relation === 'own')
  const ownRow = knownFromUtxo(BOWN, [{ direction: 'in', counterparty: BOWN[0] }])
  check('D UTXO: an "in" row naming our own address adds nothing', ownRow.length === BOWN.length)

  const TOWN = 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH'
  const TPAID = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
  const tron = knownFromTron(TOWN, [{ direction: 'out', counterparty: TPAID, amount: -1n }])
  check('D TRON: the leading "T" is not a matching start', findLookalike('TXY0000000000000000000000000000eBf', tron, TRON_FORMAT) === null && findLookalike('TXYZ000000000000000000000000000eBf', tron, TRON_FORMAT)?.known === TPAID)

  const base = PAID
  const k = knownFromSol(OWNER, [{ direction: 'out', counterparty: base }])
  const mk = (s, e) => base.slice(0, s) + 'x'.repeat(base.length - s - e) + base.slice(base.length - e)
  check(`D thresholds: ${LOOKALIKE_MIN} at each end warns`, findLookalike(mk(3, 3).replace(/^(...)./, '$1z'), k, SOL_FORMAT) !== null)
  check('D thresholds: 2 at the start is not enough', findLookalike('Ab' + 'z'.repeat(39) + 'T6M', k, SOL_FORMAT) === null)
  check('D thresholds: 2 at the end is not enough', findLookalike('AbaE' + 'z'.repeat(38) + '6M', k, SOL_FORMAT) === null)
}

console.log(failures === 0 ? '\nAll lookalike checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
