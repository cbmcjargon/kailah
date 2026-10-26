import type { ChainConfig, ChainId, NetMode } from './types'

// HD wallet: fresh receive/change addresses under one account per chain
// (m/purpose'/coin'/0'). Paths follow BIP84 (native segwit: BTC, LTC, testnet)
// and BIP44 (DOGE) so the seed restores in any standard wallet. `derivationPath`
// is retained as the index-0 receive address for display/back-compat.
//
// Providers are ordered; api.ts fails over down the list. CORS for every base
// was verified live from the wallet origin (2026-07-20). Only BTC mainnet has
// a genuine second provider (testnet4's backup can't serve address lookups);
// Litecoin has a backup-only one (BlockCypher, 2026-10-26); the others run
// single-provider through the same failover client. Scanning is per-address gap-limit (see scanner.ts), which
// works uniformly on every one of these esplora/blockcypher backends.

// SLIP-0132 version bytes (kept for interoperability/export display).
const ZPUB = { public: 0x04b24746, private: 0x04b2430c } // BTC/LTC mainnet BIP84
const VPUB = { public: 0x045f1cf6, private: 0x045f18bc } // testnet BIP84

export const CHAINS: Record<ChainId, ChainConfig> = {
  btc: {
    id: 'btc',
    name: 'Bitcoin',
    ticker: 'BTC',
    mainnet: true,
    providers: [
      // Ordered by preference; api.ts health-probes and starts on a live one.
      // Community mempool instances verified 2026-08-01 (CORS *, tips agree).
      // blockstream.info sits last: it hard-caps 700 requests/hour per IP,
      // which normal polling exhausts — good spare tire, bad daily driver.
      { name: 'mempool.space', kind: 'esplora', base: 'https://mempool.space/api', pageSize: 50 },
      { name: 'mempool.emzy.de', kind: 'esplora', base: 'https://mempool.emzy.de/api', pageSize: 50 },
      { name: 'mempool.bitaroo.net', kind: 'esplora', base: 'https://mempool.bitaroo.net/api', pageSize: 50 },
      { name: 'blockstream.info', kind: 'esplora', base: 'https://blockstream.info/api', pageSize: 25 },
    ],
    explorerTx: (t) => `https://mempool.space/tx/${t}`,
    explorerAddr: (a) => `https://mempool.space/address/${a}`,
    addressType: 'p2wpkh',
    derivationPath: "m/84'/0'/0'/0/0",
    accountPath: "m/84'/0'/0'",
    purpose: 84,
    coinType: 0,
    slip132: ZPUB,
    network: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
    unitName: 'sats',
    decimals: 8,
    dustLimit: 294n,
    txVersion: 2,
    priceSymbol: 'BTC',
    color: '#f7931a',
  },
  'btc-testnet': {
    id: 'btc-testnet',
    name: 'Bitcoin testnet',
    ticker: 'tBTC',
    mainnet: false,
    providers: [
      { name: 'mempool.space', kind: 'esplora', base: 'https://mempool.space/testnet4/api', pageSize: 50 },
      { name: 'mempool.emzy.de', kind: 'esplora', base: 'https://mempool.emzy.de/testnet4/api', pageSize: 50 },
    ],
    explorerTx: (t) => `https://mempool.space/testnet4/tx/${t}`,
    explorerAddr: (a) => `https://mempool.space/testnet4/address/${a}`,
    addressType: 'p2wpkh',
    derivationPath: "m/84'/1'/0'/0/0",
    accountPath: "m/84'/1'/0'",
    purpose: 84,
    coinType: 1,
    slip132: VPUB,
    network: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    unitName: 'sats',
    decimals: 8,
    dustLimit: 294n,
    txVersion: 2,
    color: '#26a17b',
    faucets: [
      { name: 'mempool.space faucet', url: 'https://mempool.space/testnet4/faucet' },
      { name: 'coinfaucet.eu', url: 'https://coinfaucet.eu/en/btc-testnet4/' },
    ],
  },
  doge: {
    id: 'doge',
    name: 'Dogecoin',
    ticker: 'DOGE',
    mainnet: true,
    providers: [
      { name: 'blockcypher', kind: 'blockcypher', base: 'https://api.blockcypher.com/v1/doge/main' },
    ],
    explorerTx: (t) => `https://dogechain.info/tx/${t}`,
    explorerAddr: (a) => `https://dogechain.info/address/${a}`,
    addressType: 'p2pkh',
    derivationPath: "m/44'/3'/0'/0/0",
    accountPath: "m/44'/3'/0'",
    purpose: 44,
    coinType: 3,
    network: { bech32: 'doge', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e },
    unitName: 'koinu',
    decimals: 8,
    // Dogecoin relay policy: dust 0.01 DOGE, recommended fee 0.01 DOGE/kB.
    dustLimit: 1_000_000n,
    txVersion: 1,
    // 2000 koinu/byte = 0.02 DOGE/kB — 2x recommended for reliable confirmation.
    fixedFeeRate: 2000n,
    priceSymbol: 'DOGE',
    color: '#cba135',
  },
  ltc: {
    id: 'ltc',
    name: 'Litecoin',
    ticker: 'LTC',
    mainnet: true,
    providers: [
      { name: 'litecoinspace.org', kind: 'esplora', base: 'https://litecoinspace.org/api', pageSize: 50 },
      // Backup only: its free budget (~100 requests an hour) is shared with
      // Dogecoin, so it serves Litecoin only while litecoinspace is failing
      // (it timed out for the owner, 2026-10-26).
      { name: 'blockcypher', kind: 'blockcypher', base: 'https://api.blockcypher.com/v1/ltc/main', backupOnly: true },
    ],
    explorerTx: (t) => `https://litecoinspace.org/tx/${t}`,
    explorerAddr: (a) => `https://litecoinspace.org/address/${a}`,
    addressType: 'p2wpkh',
    derivationPath: "m/84'/2'/0'/0/0",
    accountPath: "m/84'/2'/0'",
    purpose: 84,
    coinType: 2,
    slip132: ZPUB,
    network: { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
    unitName: 'litoshis',
    decimals: 8,
    // Conservative: above the p2wpkh dust floor under any common relay config.
    dustLimit: 546n,
    txVersion: 2,
    priceSymbol: 'LTC',
    color: '#345d9d',
  },
}

export function chainsForMode(mode: NetMode): ChainConfig[] {
  const all = Object.values(CHAINS)
  return mode === 'practice' ? all.filter((c) => !c.mainnet) : all.filter((c) => c.mainnet)
}
