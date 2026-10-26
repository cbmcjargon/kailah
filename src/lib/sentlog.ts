// The wallet's own record of where it has sent coins — the only source of
// "you've paid this address before" the lookalike-address check trusts.
//
// Contract:
//   recordSentTo(chainKey, address): void      — before a broadcast
//   sentToAddresses(chainKey): string[]         — newest last
//
// A transaction history fetched from a data service can be edited by that
// service: a lying one could list a send to the attacker's lookalike so the
// warning falls silent (audit 2026-10-26, L3/L13). This log is written only
// by the wallet's own broadcast paths, lives in the encrypted secure store,
// and is cleared with every other kailah.* key on erase. It is per chain id
// (utxo, EVM, Solana and TRON ids never collide) and capped; it does not
// survive a restore on another device, which only means the warning may ask
// once more about an address the user has paid before.

import { secureGet, secureSet } from './securestore'

const NAME = 'sentto'
/** per chain; a personal wallet never nears this, and the list is scanned linearly */
const MAX_PER_CHAIN = 500

type Log = Record<string, string[]>

function readLog(): Log {
  const v = secureGet(NAME)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Log = {}
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[k] = list.filter((a): a is string => typeof a === 'string')
  }
  return out
}

export function recordSentTo(chainKey: string, address: string): void {
  const log = readLog()
  const list = (log[chainKey] ?? []).filter((a) => a !== address)
  list.push(address)
  log[chainKey] = list.slice(-MAX_PER_CHAIN)
  secureSet(NAME, log)
}

export function sentToAddresses(chainKey: string): string[] {
  return readLog()[chainKey] ?? []
}
