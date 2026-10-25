// QR payment-code parsing for Kailah Wallet.
//
// parseScannedPayment(text, chain) turns the decoded text of a scanned QR
// code into a validated { address, amount? } payment for the chain the user
// is sending from. Handles BIP21-style URIs (bitcoin:/dogecoin:/litecoin:),
// bare addresses, and the ALL-CAPS bech32 encoding QR generators commonly
// use for compactness. Throws Error with a user-readable message when the
// code is empty, belongs to a different chain, or contains no valid address.

import { CHAINS } from './networks'
import { parseCoinAmount } from './format'
import { isValidAddress } from './txbuild'
import type { ChainConfig, ChainId } from './types'

/** BIP21-style URI scheme → the chain ids that scheme may pay. */
const SCHEME_CHAINS: Record<string, readonly ChainId[]> = {
  bitcoin: ['btc', 'btc-testnet'],
  dogecoin: ['doge'],
  litecoin: ['ltc'],
}

/**
 * Human name for a chain in error messages. The Bitcoin test network gets a
 * friendlier "practice-network" phrasing to match the wallet's practice mode.
 */
function chainDisplayName(chain: ChainConfig): string {
  return chain.id === 'btc-testnet' ? `practice-network ${CHAINS.btc.name}` : chain.name
}

/**
 * Extract the BIP21 `amount` value (whole-coin decimal) from a query string,
 * accepting the key case-insensitively: the BIP21 spec uses lowercase
 * `amount=`, but all-uppercase QR payloads (common for bech32 compactness)
 * arrive as `AMOUNT=`. URLSearchParams keys are case-sensitive, so we scan
 * the entries ourselves and take the first key that lowercases to 'amount'.
 */
function findAmountParam(query: string): string | undefined {
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.toLowerCase() === 'amount') return value
  }
  return undefined
}

/**
 * Parse the decoded text of a scanned QR code into a payment for `chain`.
 *
 * Returns the validated address, plus `amount` (smallest units) only when the
 * code carried a valid positive whole-coin amount.
 *
 * Throws Error with a user-readable message when the text is empty, is a
 * payment code / address for a different chain, or contains no valid address.
 */
export function parseScannedPayment(
  text: string,
  chain: ChainConfig,
): { address: string; amount?: bigint } {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('The scanned code was empty.')

  let rest = trimmed
  const schemeMatch = /^([a-z]+):/i.exec(trimmed)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    const allowedIds = SCHEME_CHAINS[scheme]
    if (allowedIds) {
      if (!allowedIds.includes(chain.id)) {
        const schemeChain = CHAINS[allowedIds[0]!]
        throw new Error(
          `That code is a ${chainDisplayName(schemeChain)} payment code, ` +
            `but you're sending ${chainDisplayName(chain)}.`,
        )
      }
      // Strip "scheme:" and tolerate a non-standard "//" (some generators
      // emit bitcoin://<addr> even though BIP21 has no authority part).
      rest = trimmed.slice(schemeMatch[0].length).replace(/^\/\//, '')
    }
    // Unknown schemes fall through: the full text will fail address
    // validation below and produce the "no valid address" error.
  }

  // Split address from the BIP21 query.
  const queryStart = rest.indexOf('?')
  let address = queryStart >= 0 ? rest.slice(0, queryStart) : rest
  const query = queryStart >= 0 ? rest.slice(queryStart + 1) : ''

  // A malformed amount param must NOT fail the scan: the address is the
  // payment-critical part, and a sender can always type the amount by hand.
  // Failing here would reject an otherwise perfectly payable code over a
  // detail we can safely ignore. parseCoinAmount throws on non-numeric,
  // negative, and too-many-decimal inputs — all of those are dropped.
  let amount: bigint | undefined
  const amountRaw = findAmountParam(query)
  if (amountRaw !== undefined) {
    try {
      const parsed = parseCoinAmount(amountRaw, chain.decimals)
      if (parsed > 0n) amount = parsed // amount=0 carries no information; omit
    } catch {
      // ignore — see comment above
    }
  }

  // QR codes often encode bech32 addresses in ALL CAPS (alphanumeric QR mode
  // is more compact). Bech32 is case-insensitive, so lowercase those — but
  // ONLY those: base58 addresses (e.g. DOGE 'D...') are case-sensitive and
  // must never be touched.
  if (!/[a-z]/.test(address)) {
    const lowered = address.toLowerCase()
    if (lowered.startsWith('bc1') || lowered.startsWith('tb1') || lowered.startsWith('ltc1')) {
      address = lowered
    }
  }

  // MWEB (MimbleWimble) stealth addresses get a real explanation instead of
  // a generic rejection: paying one requires confidential-transaction
  // cryptography this wallet does not implement.
  if (address.toLowerCase().startsWith('ltcmweb1')) {
    throw new Error(
      "That's a private (MWEB) Litecoin address. Kailah Wallet can't send to " +
        'MWEB yet — ask the recipient for a regular ltc1 address instead.',
    )
  }

  if (!isValidAddress(address, chain)) {
    for (const other of Object.values(CHAINS)) {
      if (other.id === chain.id) continue
      if (isValidAddress(address, other)) {
        throw new Error(
          `That's a ${chainDisplayName(other)} address, ` +
            `but you're sending ${chainDisplayName(chain)}.`,
        )
      }
    }
    throw new Error(`That code doesn't contain a valid ${chain.name} address.`)
  }

  return amount !== undefined ? { address, amount } : { address }
}
