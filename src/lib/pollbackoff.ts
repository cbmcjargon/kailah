// How long background polls leave a UTXO account alone after its scan
// failed. Kept out of App.tsx so the rule can be tested (check-failover K).
//
// A scan with no earlier result to compare against is a full gap walk, about
// 41 lookups for a new account. When one failed, every 60 s poll sent the
// whole walk again, quietly, at a service that was already refusing: the
// practice Bitcoin card of a new wallet kept testnet4's free services busy
// (review 2026-10-28). Now each failure in a row doubles the wait, from one
// minute to ten. A success clears it, and a refresh the user asks for (or a
// mode change, an unlock) never waits: only background polls do.

/** The wait after the 1st, 2nd, 3rd … failure in a row; the last one repeats. */
export const POLL_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 600_000]

export interface PollBackoff {
  /** failed scans in a row */
  failures: number
  /** no background poll before this time (ms) */
  retryAt: number
}

/** The backoff after one more failed scan at `now`. */
export function afterScanFailure(prev: PollBackoff | undefined, now: number): PollBackoff {
  const failures = (prev?.failures ?? 0) + 1
  const wait = POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1]!
  return { failures, retryAt: now + wait }
}

/** Whether a background poll may scan the account now. */
export function pollDue(backoff: PollBackoff | undefined, now: number): boolean {
  return backoff === undefined || now >= backoff.retryAt
}

/**
 * How long a background poll leaves an EVM, Solana or TRON refresh alone once
 * it has started. A poll that replaced a refresh under way threw its work
 * away, so behind a service slower than the 60 s cadence no refresh ever
 * finished, and each one added requests to a struggling service (review
 * 2026-10-30). Every lookup has its own deadline, so a refresh ends well
 * before this; the limit only stops one that never settles from ending the
 * polls for good. A refresh the user asks for replaces it at any time.
 */
export const REFRESH_MAX_MS = 180_000

/** Whether a background poll may start a refresh, given when the last one started (undefined: it finished). */
export function pollMayStart(startedAt: number | undefined, now: number): boolean {
  return startedAt === undefined || now - startedAt >= REFRESH_MAX_MS
}
