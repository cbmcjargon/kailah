// Payment alerts for the account-model engines (EVM, Solana, TRON): which
// part of a balance that grew is a payment to announce. Kept out of App.tsx
// so the rules can be tested (check-amounts D5).
//
//   - Each asset that grew alerts once, measured from the last balance
//     alerted or shown, so two refreshes in flight can't both announce one
//     payment (bug audit 2026-10-27, BL18).
//   - The wallet's own swap, stake withdrawal or reward claim says before it
//     goes out what it may credit (expectCredit). Up to that much growth on
//     that asset, within OWN_CREDIT_MS, is silent; the rest is a payment. A
//     blanket two-minute quiet window per chain swallowed, for good, a real
//     payment that arrived beside a swap; and said only after a success, a
//     swap whose broadcast answer was lost and that landed anyway alerted as
//     "Received" (review 2026-10-28).

/** How long an own action's credit is expected: past a Solana blockhash's life, and a few polls. */
export const OWN_CREDIT_MS = 2 * 60_000
/** Headroom on an expected credit: a swap can fill a little above its quote. */
const OWN_CREDIT_SLACK_BPS = 500n

export interface AlertBook {
  /** the balance last alerted or seen, per `${chain}:${asset}` */
  alerted: Partial<Record<string, bigint>>
  /** what the wallet's own actions may still credit, per `${chain}:${asset}` */
  credits: Partial<Record<string, { upTo: bigint; until: number }>>
}

export function newAlertBook(): AlertBook {
  return { alerted: {}, credits: {} }
}

/** The wallet's own action may credit about `amount` of `key`'s asset within OWN_CREDIT_MS. */
export function expectCredit(book: AlertBook, key: string, amount: bigint, now: number): void {
  if (amount <= 0n) return
  const cur = book.credits[key]
  const left = cur !== undefined && now < cur.until ? cur.upTo : 0n
  book.credits[key] = { upTo: left + amount + (amount * OWN_CREDIT_SLACK_BPS) / 10_000n, until: now + OWN_CREDIT_MS }
}

/** How much of a new balance to announce as received; null for nothing. */
export function receivedAmount(
  book: AlertBook,
  key: string,
  shown: bigint | null,
  balance: bigint | null,
  now: number,
): bigint | null {
  if (balance === null) return null
  const from = book.alerted[key] ?? shown
  book.alerted[key] = balance
  if (from === null || balance <= from) return null
  let growth = balance - from
  const credit = book.credits[key]
  if (credit !== undefined && now < credit.until) {
    const own = credit.upTo < growth ? credit.upTo : growth
    credit.upTo -= own
    growth -= own
  }
  return growth > 0n ? growth : null
}
