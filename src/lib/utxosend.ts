// Broadcasting a signed UTXO transaction (Bitcoin, Litecoin, Dogecoin) — the
// one path every send, Ledger send and Speed up goes through, so the
// double-pay ledger hears the same story from all three (bug audit
// 2026-10-27, BH1):
//   - the attempt is recorded BEFORE it goes out;
//   - a node's explicit refusal (it validated the bytes and said no) drops
//     the record: nothing was taken, and holding the user back 30 minutes
//     helped nobody. Not so for a Retry of an attempt whose answer was lost
//     (same bytes): "inputs missing or spent" is exactly what a node says
//     once the first try went through, so that record stays failed. Nor
//     for a refusal that followed another provider's network error, which
//     may have taken the bytes (review 2026-10-28);
//   - "already in the mempool / chain" is the network saying it HAS it:
//     that is a success;
//   - anything else (a timeout, a lost connection, a 5xx) leaves the record
//     marked failed: if the network shows it later, the next send says so;
//   - a Speed up that went out supersedes the transaction it replaces, whose
//     record would otherwise block sends for half an hour once the network
//     forgets the evicted original.

import type { ChainConfig, FailoverClient } from './types'
import { dropPending, markPendingFailed, markPendingSent, pendingUtxo, recordPending, type PendingUtxo } from './pending'
import { recordSentTo } from './sentlog'

export type UtxoBroadcastOutcome = 'known' | 'rejected' | 'ambiguous'

const NO_ANSWER = /could not reach any provider|timed? ?out|abort|load failed|failed to fetch|networkerror/i
const KNOWN =
  /already (in (the )?(block ?chain|mempool)|known|exists)|txn-already-(in-mempool|known)|outputs already in utxo set|"code"\s*:\s*-27\b/i
const REJECTED =
  /sendrawtransaction RPC error|bad-txns|mandatory-script|non-mandatory-script|min(imum)? relay fee|insufficient fee|dust|txn-mempool-conflict|missing ?inputs|missingorspent|non-final|absurdly-high-fee|max-fee-exceeded|tx-size|too-long-mempool-chain|TX decode failed|decode failed|Error validating transaction|rate limited|too many requests/i

/** What a failed broadcast means for the record. Unrecognised failures count as "may have gone out". */
export function utxoBroadcastOutcome(err: unknown): UtxoBroadcastOutcome {
  if (err instanceof TypeError) return 'ambiguous'
  const msg = err instanceof Error ? err.message : String(err)
  if (NO_ANSWER.test(msg)) return 'ambiguous'
  if (KNOWN.test(msg)) return 'known'
  // a refusal from a later provider says nothing of the one that went quiet
  if ((err as { afterNetworkError?: unknown } | null)?.afterNetworkError === true) return 'ambiguous'
  if (REJECTED.test(msg)) return 'rejected'
  return 'ambiguous'
}

/** A broadcast that did not go out cleanly. `definite`: the network refused it, so a new send is safe. */
export class UtxoBroadcastError extends Error {
  readonly definite: boolean
  constructor(message: string, definite: boolean) {
    super(message)
    this.name = 'UtxoBroadcastError'
    this.definite = definite
  }
}

/**
 * The total fee a node's BIP125 refusal says a replacement must beat ("…less
 * fees than conflicting txs; 0.00000564 < 0.00001046"), in smallest units;
 * null when the message isn't one. Exact decimal-string math. The number
 * may end a sentence: broadcastUtxo's own wording adds ". Nothing was
 * sent.", and refusing a trailing period hid the floor from Speed up
 * (review 2026-10-28); a longer number ("1.2.3", 13+ digits) still isn't one.
 */
export function replacementFloorFrom(message: string, decimals: number): bigint | null {
  const m = /less fees than conflicting txs;\s*[\d.]+\s*<\s*(\d{1,12})(?:\.(\d{1,12}))?(?!\d|\.\d)/i.exec(message)
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(decimals, '0').slice(0, decimals)
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac === '' ? '0' : frac)
}

export async function broadcastUtxo(
  client: Pick<FailoverClient, 'broadcast'>,
  chain: ChainConfig,
  built: { txid: string; hex: string; toAddress: string },
  opts?: { replaces?: string; account?: string },
): Promise<string> {
  // a Retry of an attempt whose answer was lost: it stays failed until a
  // try goes out cleanly (re-recording it used to clear the flag)
  const retry = pendingUtxo(chain.id).some((p) => p.txid === built.txid && p.failed === true)
  const entry: PendingUtxo = {
    kind: 'utxo',
    chainId: chain.id,
    txid: built.txid,
    to: built.toAddress,
    ts: Date.now(),
    ...(opts?.account !== undefined && { account: opts.account }),
    ...(retry && { failed: true as const }),
  }
  recordPending(entry)
  // the send log trusts an address paid, or maybe paid: never one the node
  // refused (bug audit 2026-10-27, BL19)
  const trust = () => recordSentTo(chain.id, built.toAddress)
  const supersede = () => {
    if (opts?.replaces === undefined) return
    for (const p of pendingUtxo(chain.id)) if (p.txid === opts.replaces) dropPending(p)
  }
  try {
    const txid = await client.broadcast(built.hex)
    trust()
    supersede()
    if (retry) markPendingSent(entry)
    return txid
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const outcome = utxoBroadcastOutcome(e)
    if (outcome === 'known') {
      trust()
      supersede()
      if (retry) markPendingSent(entry)
      return built.txid
    }
    if (outcome === 'rejected' && retry) {
      throw new UtxoBroadcastError(
        `The network refused this try: ${detail}. The first try may still have gone through, so new sends on ${chain.name} wait until the wallet can tell.`,
        false,
      )
    }
    if (outcome === 'rejected') {
      dropPending(entry)
      throw new UtxoBroadcastError(`The network refused this transaction: ${detail}. Nothing was sent.`, true)
    }
    trust()
    markPendingFailed(entry)
    throw new UtxoBroadcastError(detail, false)
  }
}
