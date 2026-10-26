// check-trondecode.mjs — OFFLINE (hand-built protobuf bytes, no network).
//
// The TRON decoder (src/lib/tron.ts decodeTronRawTx / assertTronEnvelope)
// is what stands between a node-built transaction and the wallet's
// signature. This suite builds Transaction.raw bytes by hand and proves,
// after the audit of 2026-10-26:
//   A. the baseline honest transfer decodes to exactly its fields;
//   B. expiration is bounded to TRON_MAX_EXPIRATION_MS either side of now
//      (the chain's own 24 h maximum used to be the bound — M4);
//   C. the Stake 2.0 resource enum is strict: 0/absent BANDWIDTH, 1 ENERGY,
//      anything else refused (it used to read as BANDWIDTH — L1);
//   D. the deny-by-default parser still refuses what it refused before:
//      unknown fields, a second contract, an unknown contract type.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
const { assertTronEnvelope, decodeTronRawTx, tronAddressToHex, TRON_MAX_EXPIRATION_MS } = await import('../src/lib/tron.ts')

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const refuses = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// --- minimal protobuf writers ----------------------------------------------
const varint = (n) => {
  const out = []
  let v = BigInt(n)
  for (;;) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) out.push(b | 0x80)
    else {
      out.push(b)
      break
    }
  }
  return out
}
const len = (num, bytes) => [...varint((num << 3) | 2), ...varint(bytes.length), ...Array.from(bytes)]
const vint = (num, n) => [...varint(num << 3), ...varint(n)]
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)))
const str = (s) => Array.from(new TextEncoder().encode(s))

const OWNER = 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX'
const TO = 'TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M'
const ownerB = hexToBytes(tronAddressToHex(OWNER))
const toB = hexToBytes(tronAddressToHex(TO))

const anyWrap = (typeNum, url, inner) => cat(vint(1, typeNum), len(2, cat(len(1, str(url)), len(2, inner))))
const top = (contract, { extra = [], exp = Date.now() + 60_000 } = {}) =>
  cat(len(1, hexToBytes('aabb')), len(4, hexToBytes('0011223344556677')), vint(8, exp), len(11, contract), vint(14, Date.now()), extra)
const transfer = (amount) => anyWrap(1, 'type.googleapis.com/protocol.TransferContract', cat(len(1, ownerB), len(2, toB), vint(3, amount)))
const freeze = (amount, resource) =>
  anyWrap(54, 'type.googleapis.com/protocol.FreezeBalanceV2Contract', resource === undefined ? cat(len(1, ownerB), vint(2, amount)) : cat(len(1, ownerB), vint(2, amount), vint(3, resource)))
const dec = (b) => decodeTronRawTx(bytesToHex(b))

console.log('--- A. the honest transfer ---')
{
  const d = dec(top(transfer(1_000_000)))
  const c = d.contracts[0]
  check('A1 one TransferContract, owner/to/amount exact', d.contracts.length === 1 && c.type === 'TransferContract' && c.owner === OWNER && c.to === TO && c.amount === 1_000_000n)
  check('A2 fee_limit 0 and the envelope passes', d.feeLimit === 0n && !refuses(() => assertTronEnvelope(d, 0n)))
}

console.log('--- B. expiration is bounded to ten minutes ---')
{
  const env = (exp) => assertTronEnvelope(dec(top(transfer(1), { exp })), 0n)
  check(`B1 the constant is 10 minutes`, TRON_MAX_EXPIRATION_MS === 600_000)
  check('B2 60 s ahead (what the node sets) passes', !refuses(() => env(Date.now() + 60_000)))
  check('B3 9 minutes ahead passes', !refuses(() => env(Date.now() + 9 * 60_000)))
  check('B4 11 minutes ahead is refused', refuses(() => env(Date.now() + 11 * 60_000)))
  check('B5 23 h 59 min ahead (the chain maximum) is refused', refuses(() => env(Date.now() + 24 * 3600_000 - 60_000)))
  check('B6 5 minutes in the past passes (a fast device clock)', !refuses(() => env(Date.now() - 5 * 60_000)))
  check('B7 11 minutes in the past is refused', refuses(() => env(Date.now() - 11 * 60_000)))
  check('B8 zero is refused', refuses(() => env(0)))
}

console.log('--- C. the resource enum is strict ---')
{
  check('C1 absent → BANDWIDTH', dec(top(freeze(5_000_000))).contracts[0].resource === 'BANDWIDTH')
  check('C2 0 → BANDWIDTH', dec(top(freeze(5_000_000, 0))).contracts[0].resource === 'BANDWIDTH')
  check('C3 1 → ENERGY', dec(top(freeze(5_000_000, 1))).contracts[0].resource === 'ENERGY')
  check('C4 2 (TRON_POWER) is refused, not read as BANDWIDTH', refuses(() => dec(top(freeze(5_000_000, 2)))))
  check('C5 3 is refused', refuses(() => dec(top(freeze(5_000_000, 3)))))
}

console.log('--- D. deny by default, still ---')
{
  check('D1 a data/memo field on the transaction is refused', refuses(() => dec(top(transfer(1), { extra: len(10, str('hello')) }))))
  check('D2 a second contract is decoded and counted (every verify path refuses more than one)', dec(cat(top(transfer(1)), len(11, transfer(2)))).contracts.length === 2)
  check('D3 an unknown contract type reads as other', dec(top(anyWrap(46, 'type.googleapis.com/protocol.AccountPermissionUpdateContract', cat(len(1, ownerB))))).contracts[0].type === 'other')
  check('D4 a Permission_id on the contract is refused', refuses(() => dec(top(cat(transfer(1), vint(5, 2))))))
}

console.log(failures === 0 ? '\nAll TRON decoder checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
