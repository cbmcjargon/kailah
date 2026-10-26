// Lookalike-address warning (address poisoning) for Kailah Wallet.
//
// Contract:
//   findLookalike(candidate, known, format): Lookalike | null
//   knownFromUtxo / knownFromEvm / knownFromSol / knownFromTron → KnownAddress[]
//
// The scam: right after you pay someone, an attacker sends you a tiny amount
// from an address that starts and ends like the one you paid (observed on the
// owner's own Solana wallet, 2026-10-25: paid AbaEGdJq…GTZoT6M, dusted a
// minute later by AbaEvnMF…a4e1T6M). The lookalike now sits in your history,
// waiting to be copied the next time you pay that person.
//
// So the send form warns when the address typed or pasted shares its start
// and end with an address from this account's history (or one of its own
// addresses) but isn't it. Two rules keep the attacker from slipping through:
//   - only sends this wallet actually signed make an address trusted
//     ("sent"). An address that merely SENT you something is not: the
//     poisoner did exactly that. Neither is a zero-value transfer that shows
//     up as "out" (TRON USDT transferFrom with 0) or any custom-token row on
//     EVM: anyone can emit those in your name;
//   - a match against an untrusted address still warns, and says when the
//     typed address is one that sent you something.
// It reads only the history each send screen already holds (no extra
// requests), so it sees as far back as that history goes.
//
// Pure: no engine imports, so any send modal can use it without pulling an
// engine chunk forward.

/** How an address appears in this account's history. */
export type Relation = 'own' | 'sent' | 'other'

export interface KnownAddress {
  address: string
  relation: Relation
}

/** Per-network normalization: case and the fixed prefix every address shares. */
export interface AddressFormat {
  caseInsensitive: boolean
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
const BECH32 = /^([a-z]{2,5})1[qp]/i
export const UTXO_FORMAT: AddressFormat = {
  caseInsensitive: false,
  fixedPrefix: (a) => BECH32.exec(a)?.[0].length ?? 0,
}

/** Matching start and end both at least this long (after the fixed prefix). */
export const LOOKALIKE_MIN = 3

export interface Lookalike {
  /** the known address the candidate resembles */
  known: string
  relation: Relation
  /** the candidate itself sent this account something (never paid by it) */
  seenIncoming: boolean
  /** raw characters at the candidate's start and end that match `known` */
  sameStart: number
  sameEnd: number
}

function normalize(address: string, format: AddressFormat): string {
  const a = address.trim()
  return format.caseInsensitive || BECH32.test(a) ? a.toLowerCase() : a
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
 * The known address `candidate` imitates, or null. An address this account
 * has paid before, or one of its own, is trusted and never warns.
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

// ---------------------------------------------------------------------------
// What each engine's history says. Structural types, so this module needs no
// engine import; each matches the engine's own tx row.

interface Row {
  direction: 'in' | 'out' | 'self'
  counterparty: string | null
}

function collect(own: string[], rows: { address: string | null; relation: Relation }[]): KnownAddress[] {
  const out: KnownAddress[] = own.map((address) => ({ address, relation: 'own' as const }))
  const ownSet = new Set(own)
  for (const r of rows) {
    if (r.address && !ownSet.has(r.address)) out.push({ address: r.address, relation: r.relation })
  }
  return out
}

/** UTXO: every derived address is ours; an "out" row was signed by us. */
export function knownFromUtxo(ownAddresses: string[], txs: Row[]): KnownAddress[] {
  return collect(
    ownAddresses,
    txs.map((t) => ({ address: t.counterparty, relation: t.direction === 'out' ? 'sent' : 'other' })),
  )
}

/**
 * EVM: native sends and pinned-token (USDC) sends are ours. A custom-token
 * row can be emitted by any contract in anyone's name, so it never trusts.
 */
export function knownFromEvm(
  own: string,
  txs: (Row & { asset: 'token' | 'gas'; tokenSymbol?: string })[],
): KnownAddress[] {
  return collect(
    [own],
    txs.map((t) => ({
      address: t.counterparty,
      relation: t.direction === 'out' && (t.asset === 'gas' || t.tokenSymbol === undefined) ? 'sent' : 'other',
    })),
  )
}

/** Solana: an "out" row means our balance went down, which needs our signature. */
export function knownFromSol(own: string, txs: Row[]): KnownAddress[] {
  return collect(
    [own],
    txs.map((t) => ({ address: t.counterparty, relation: t.direction === 'out' ? 'sent' : 'other' })),
  )
}

/**
 * TRON: a zero-value USDT "out" row is the classic poisoning trick
 * (transferFrom of 0 needs no allowance), so only non-zero sends trust.
 */
export function knownFromTron(own: string, txs: (Row & { amount: bigint })[]): KnownAddress[] {
  return collect(
    [own],
    txs.map((t) => ({
      address: t.counterparty,
      relation: t.direction === 'out' && t.amount !== 0n ? 'sent' : 'other',
    })),
  )
}
