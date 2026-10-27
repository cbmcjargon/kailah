// Raw transactions for legacy (p2pkh) signing, cached for the session.
//
// Dogecoin's legacy inputs are signed with each funding transaction's full
// bytes, so the signer can check the amount it spends (txbuild.ts refuses a
// funding tx that doesn't hash to its txid). Those bytes never change, and
// they are named by their own hash: a copy that hashes to the txid it was
// asked for is THE transaction, whoever served it. Caching them means each
// costs at most one request per session. That matters because only
// BlockCypher serves them for Dogecoin, on a ~100-requests-an-hour budget
// shared with Litecoin's backup, and every full Dogecoin scan asks for the
// funding txs of every coin (2026-10-27: that budget ran out and took
// Dogecoin offline).
//
// Only legacy serializations hash to their txid; a segwit tx's bytes include
// the witness and never match, so they are never cached (and never needed
// here: segwit signing takes the prevout amount instead).

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/** Plenty for a personal wallet's coins; the oldest entry goes first. */
const MAX_ENTRIES = 500

const cache = new Map<string, string>()

/** The txid a legacy raw transaction hashes to (double SHA-256, byte-reversed). */
export function txidOfRawHex(hex: string): string {
  return bytesToHex(sha256(sha256(hexToBytes(hex))).reverse())
}

/** The cached bytes for this txid, if any. */
export function cachedRawTx(txid: string): string | undefined {
  return cache.get(txid.toLowerCase())
}

/**
 * Cache `hex` as the transaction `txid` if, and only if, it hashes to that
 * txid. Returns whether it did: false for a segwit serialization or for
 * bytes that are simply not that transaction.
 */
export function rememberRawTx(txid: string, hex: string): boolean {
  const id = txid.toLowerCase()
  let matches: boolean
  try {
    matches = /^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0 && txidOfRawHex(hex) === id
  } catch {
    matches = false
  }
  if (!matches) return false
  if (!cache.has(id) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(id, hex.toLowerCase())
  return true
}

/** Tests only. */
export function clearRawTxCache(): void {
  cache.clear()
}
