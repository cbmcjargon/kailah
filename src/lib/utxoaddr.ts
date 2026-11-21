// Destination-address validation for the UTXO chains (BTC, testnet, DOGE, LTC).
//
// Contract:
//   isValidAddress(addr: string, chain: ChainConfig): boolean
//
// It lives apart from txbuild.ts (which re-exports it) so that code with no
// business building transactions, the contact book for one, can ask "is this
// an address on that chain?" without loading the transaction builder. There
// is one implementation: what the send form accepts and what a contact may
// hold can't drift apart.

import { Address } from '@scure/btc-signer'
import type { ChainConfig } from './types'

/** script types acceptable as a destination, per chain family */
const BTC_DEST_TYPES = ['pkh', 'sh', 'wpkh', 'wsh', 'tr']
const DOGE_DEST_TYPES = ['pkh', 'sh']

export function isValidAddress(addr: string, chain: ChainConfig): boolean {
  let type: string
  try {
    type = Address(chain.network).decode(addr).type
  } catch {
    return false
  }
  const allowed = chain.id === 'doge' ? DOGE_DEST_TYPES : BTC_DEST_TYPES
  return allowed.includes(type)
}
