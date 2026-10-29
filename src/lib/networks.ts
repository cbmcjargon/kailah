import type { ChainConfig, ChainId, NetMode } from './types'

// HD wallet: fresh receive/change addresses under one account per chain
// (m/purpose'/coin'/0'). Paths follow BIP84 (native segwit: BTC, LTC, testnet)
// and BIP44 (DOGE) so the seed restores in any standard wallet. `derivationPath`
// is retained as the index-0 receive address for display/back-compat.
//
// Providers are ordered; api.ts fails over down the list. CORS for every base
// was verified live from the wallet origin (2026-07-20). BTC mainnet (three
// mempool instances) and Dogecoin have a genuine second provider; BTC
// mainnet and testnet4 (blockstream.info) and Litecoin (Bitcore, BlockCypher)
// have backup-only ones too. Scanning is
// per-address gap-limit (see scanner.ts), which works uniformly on every one
// of these esplora/blockcypher/bitcore backends.

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
      // blockstream.info hard-caps 700 requests/hour per IP, which normal
      // polling exhausts — good spare tire, bad daily driver. So it is a
      // backup (2026-10-29), as on testnet4: asked only while all three
      // mempool instances fail, never for a mere rate limit, polled every
      // 10 minutes meanwhile, and its 429 is never retried.
      { name: 'mempool.space', kind: 'esplora', base: 'https://mempool.space/api', pageSize: 50 },
      { name: 'mempool.emzy.de', kind: 'esplora', base: 'https://mempool.emzy.de/api', pageSize: 50 },
      { name: 'mempool.bitaroo.net', kind: 'esplora', base: 'https://mempool.bitaroo.net/api', pageSize: 50 },
      {
        name: 'blockstream.info',
        kind: 'esplora',
        base: 'https://blockstream.info/api',
        pageSize: 25,
        backupOnly: true,
        budgetLimited: true,
      },
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
      // Every lookup a scan makes, verified live 2026-10-28 (testnet4's
      // genesis, CORS *, 25 txs a page). It replaced mempool.emzy.de, whose
      // testnet4 answers tips but 404s every address lookup: practice
      // Bitcoin had depended on mempool.space alone. A backup, like
      // Litecoin's: it caps each IP at 700 requests an hour (one restore of
      // the test wallet took 203), so it serves only while mempool.space
      // fails, the card polls every 10 minutes meanwhile, and its 429 is
      // never retried.
      {
        name: 'blockstream.info',
        kind: 'esplora',
        base: 'https://blockstream.info/testnet4/api',
        pageSize: 25,
        backupOnly: true,
        budgetLimited: true,
      },
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
      // A second, independent service (2026-10-27): BlockCypher's hourly
      // budget is shared with Litecoin's backup, and when it ran out Dogecoin
      // went dark. Bitcore has no raw-tx endpoint; the funding txs Dogecoin
      // signs with still come from BlockCypher, cached (rawtxcache.ts).
      { name: 'bitcore', kind: 'bitcore', base: 'https://api.bitcore.io/api/DOGE/mainnet' },
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
      // Backups only, in this order, while litecoinspace is failing (it timed
      // out for the owner, 2026-10-26, and lagged ~14 blocks, 2026-10-27).
      // Bitcore first: BlockCypher's ~100 requests an hour are shared with
      // Dogecoin, and a full Litecoin scan there costs ~70 of them.
      { name: 'bitcore', kind: 'bitcore', base: 'https://api.bitcore.io/api/LTC/mainnet', backupOnly: true },
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
