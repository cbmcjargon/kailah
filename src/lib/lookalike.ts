// Lookalike-address warning (address poisoning) for Kailah Wallet.
//
// Contract:
//   findLookalike(candidate, known, format): Lookalike | null
//   knownAddresses(own, counterparties, sentTo): KnownAddress[]
//
// The scam: right after you pay someone, an attacker sends you a tiny amount
// from an address that starts and ends like the one you paid (observed on the
// owner's own Solana wallet, 2026-10-25: paid AbaEGdJq…GTZoT6M, dusted a
// minute later by AbaEvnMF…a4e1T6M). The lookalike now sits in your history,
// waiting to be copied the next time you pay that person.
//
// So the send form warns when the address typed or pasted shares its start
// and end with an address from this account's history (or one of its own
// addresses) but isn't it. What makes an address TRUSTED (never warned about)
// is only the wallet's own send log (sentlog.ts): a history row, whatever its
// direction, never does, because the data service that serves the history
// could plant a "sent" row to silence the warning (audit 2026-10-26). A
// match against an untrusted address still warns, and says when the typed
// address is one that appears in the history.
//
// Pure: no engine imports, so any send modal can use it without pulling an
// engine chunk forward.

/** How an address is known: ours, paid by this wallet, or merely seen in history. */
export type Relation = 'own' | 'sent' | 'other'

export interface KnownAddress {
  address: string
  relation: Relation
}

/** Per-network normalization: case and the fixed prefix every address shares. */
export interface AddressFormat {
  caseInsensitive: boolean
  /** case-insensitive for some of the network's addresses only (UTXO bech32) */
  foldCase?: (address: string) => boolean
  /** characters at the start that carry no identity (0x, bc1q, T), or none */
  fixedPrefix: (address: string) => number
}

export const EVM_FORMAT: AddressFormat = {
  caseInsensitive: true,
  fixedPrefix: (a) => (/^0x/i.test(a) ? 2 : 0),
}
export const TRON_FORMAT: AddressFormat = {
  caseInsensitive: false,
  fixedPrefix: (a) => (a.startsWith('T') ? 1 : 0),
}
export const SOL_FORMAT: AddressFormat = {
  caseInsensitive: false,
  fixedPrefix: () => 0,
}
// bech32 (bc1q…, tb1p…, ltc1q…): human-readable part, separator and witness
// version are shared by every address of that kind, and bech32 is
// case-insensitive. Base58 addresses (1…, 3…, D…, L…) keep their first
// character: it is only a version byte, but it is also what people see.
// Only this wallet's real bech32 prefixes, in one case throughout (bech32
// forbids mixed case), and only on the UTXO networks: any address that
// merely started like one (a Solana or TRON address, a legacy "Ltc1q…")
// was lowercased, which silenced the warning (bug audit 2026-10-27, BM12).
const BECH32 = /^(?:(?:bc|tb|ltc)1[qp][02-9ac-hj-np-z]+|(?:BC|TB|LTC)1[QP][02-9AC-HJ-NP-Z]+)$/
const BECH32_HEAD = /^(?:bc|tb|ltc)1[qp]/i
export const UTXO_FORMAT: AddressFormat = {
  caseInsensitive: false,
  foldCase: (a) => BECH32.test(a),
  fixedPrefix: (a) => (BECH32.test(a) ? (BECH32_HEAD.exec(a)?.[0].length ?? 0) : 0),
}

/** Matching start and end both at least this long (after the fixed prefix). */
export const LOOKALIKE_MIN = 3

export interface Lookalike {
  /** the known address the candidate resembles */
  known: string
  relation: Relation
  /** the candidate itself appears in this account's history (never paid by it) */
  seenIncoming: boolean
  /** raw characters at the candidate's start and end that match `known` */
  sameStart: number
  sameEnd: number
}

function normalize(address: string, format: AddressFormat): string {
  const a = address.trim()
  return format.caseInsensitive || format.foldCase?.(a) === true ? a.toLowerCase() : a
}

function body(address: string, format: AddressFormat): { text: string; skip: number } {
  const n = normalize(address, format)
  const skip = format.fixedPrefix(n)
  return { text: n.slice(skip), skip }
}

/** Common start and end lengths of two different bodies (non-overlapping). */
function overlap(a: string, b: string): { start: number; end: number } {
  const max = Math.min(a.length, b.length)
  let start = 0
  while (start < max && a[start] === b[start]) start++
  let end = 0
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return { start, end }
}

const PRIORITY: Record<Relation, number> = { sent: 0, own: 1, other: 2 }

/**
 * The known address `candidate` imitates, or null. An address this wallet
 * has paid before (its own send log), or one of its own, is trusted and never
 * warns.
 */
export function findLookalike(
  candidate: string,
  known: KnownAddress[],
  format: AddressFormat,
): Lookalike | null {
  const cand = body(candidate, format)
  if (cand.text.length < LOOKALIKE_MIN * 2) return null
  const same = (k: KnownAddress) => body(k.address, format).text === cand.text
  if (known.some((k) => k.relation !== 'other' && same(k))) return null
  const seenIncoming = known.some((k) => k.relation === 'other' && same(k))

  let best: Lookalike | null = null
  for (const k of known) {
    const kb = body(k.address, format)
    if (kb.text === cand.text) continue
    const { start, end } = overlap(cand.text, kb.text)
    if (start < LOOKALIKE_MIN || end < LOOKALIKE_MIN) continue
    const match: Lookalike = {
      known: k.address,
      relation: k.relation,
      seenIncoming,
      sameStart: cand.skip + start,
      sameEnd: end,
    }
    if (
      best === null ||
      PRIORITY[match.relation] < PRIORITY[best.relation] ||
      (PRIORITY[match.relation] === PRIORITY[best.relation] &&
        match.sameStart + match.sameEnd > best.sameStart + best.sameEnd)
    ) {
      best = match
    }
  }
  return best
}

/**
 * The address set a send form checks against: the account's own addresses
 * ('own'), the addresses the wallet itself has sent to ('sent', from
 * sentlog.ts), and every counterparty its history shows, in either direction
 * ('other'). Trust never comes from the history.
 */
export function knownAddresses(
  own: string[],
  counterparties: (string | null)[],
  sentTo: string[],
): KnownAddress[] {
  const out: KnownAddress[] = own.map((address) => ({ address, relation: 'own' as const }))
  const taken = new Set(own)
  for (const address of sentTo) {
    if (taken.has(address)) continue
    taken.add(address)
    out.push({ address, relation: 'sent' })
  }
  for (const address of counterparties) {
    if (!address || taken.has(address)) continue
    taken.add(address)
    out.push({ address, relation: 'other' })
  }
  return out
}
