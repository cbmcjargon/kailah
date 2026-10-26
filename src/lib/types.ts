// Core contracts for Kailah Wallet. Every module implements against these
// types; UI code consumes modules only through the function signatures
// documented here.
//
// Module contracts (implemented in sibling files):
//
// keys.ts
//   generateMnemonic(): string                  — new 12-word BIP39 phrase (english)
//   isValidMnemonic(m: string): boolean
//   deriveKey(mnemonic: string, chain: ChainConfig): DerivedKey
//
// vault.ts
//   hasVault(): boolean
//   saveVault(mnemonic: string, password: string): Promise<void>
//   unlockVault(password: string, onProgress?): Promise<string> — resolves mnemonic, throws on wrong password; legacy PBKDF2 vaults are re-saved as Argon2id
//   clearVault(): void
//
// api.ts
//   getClient(chain: ChainConfig): ChainClient
//
// prices.ts
//   fetchPrices(symbols: string[]): Promise<Record<string, number>>  — USD spot; missing on failure
//
// format.ts
//   formatCoin(v: bigint, decimals?: number): string
//   parseCoinAmount(s: string, decimals?: number): bigint   — throws on invalid input
//   formatUsd(n: number): string
//   shortAddress(a: string): string
//
// txbuild.ts
//   isValidAddress(addr: string, chain: ChainConfig): boolean
//   buildTx(args: BuildTxArgs): BuiltTx   — throws Error with user-readable message on failure

export type ChainId = 'btc' | 'btc-testnet' | 'doge' | 'ltc'

/** Practice mode shows test networks only; real mode shows mainnet chains only. */
export type NetMode = 'practice' | 'real'

/** Base58/bech32 version bytes, format used by @scure/btc-signer network params. */
export interface Base58Network {
  bech32: string
  pubKeyHash: number
  scriptHash: number
  wif: number
}

export interface ChainConfig {
  id: ChainId
  name: string
  ticker: string
  /** false → test network: no fiat price, practice badge, faucet links */
  mainnet: boolean
  explorerTx: (txid: string) => string
  explorerAddr: (addr: string) => string
  addressType: 'p2wpkh' | 'p2pkh'
  /** full path of the wallet's single receive address, e.g. m/84'/0'/0'/0/0 */
  derivationPath: string
  /** account path for HD rotation, e.g. m/84'/0'/0' (receive = .../0/i) */
  accountPath: string
  /** BIP44 purpose/coin/coin-type for building child paths under accountPath */
  purpose: 44 | 84
  coinType: number
  /** SLIP-0132 xpub version bytes (zpub/vpub for BIP84); undefined → standard xpub */
  slip132?: { public: number; private: number }
  /** ordered providers; failover walks the list. First is primary. */
  providers: ProviderSpec[]
  network: Base58Network
  /** name of the smallest unit (sats, koinu) */
  unitName: string
  /** smallest units per coin = 10^decimals; 8 for both BTC and DOGE */
  decimals: number
  /** outputs below this (in smallest units) are rejected by the network */
  dustLimit: bigint
  txVersion: number
  /** flat fee rate in smallest units per vbyte; when set, skip the fee API */
  fixedFeeRate?: bigint
  /** Coinbase spot symbol ('BTC', 'DOGE'); undefined → no USD display */
  priceSymbol?: string
  /** accent color for the chain card */
  color: string
  faucets?: { name: string; url: string }[]
}

/** One backend for a chain. `kind` selects the ProviderApi implementation. */
export interface ProviderSpec {
  name: string
  kind: 'esplora' | 'blockcypher'
  base: string
  /** esplora only: first /txs page size (mempool.space=50, blockstream=25) */
  pageSize?: number
  /** esplora only: prefer a different base for broadcast (testnet4 CORS quirk) */
  broadcastBase?: string
  /** a backup only (ProviderApi.backupOnly) */
  backupOnly?: boolean
}

export interface DerivedKey {
  chain: ChainId
  address: string
  path: string
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface Balance {
  confirmed: bigint
  unconfirmed: bigint
}

export interface Utxo {
  txid: string
  vout: number
  value: bigint
  /** raw hex of the funding tx; populated by clients for p2pkh chains (legacy signing needs it) */
  rawTxHex?: string
  /** false when the utxo is still in the mempool; used to keep RBF-bump extras confirmed (BIP125 rule 2) */
  confirmed?: boolean
}

export interface FeeOption {
  label: string
  /** human estimate, e.g. "~10 min" */
  eta: string
  /** smallest units per vbyte */
  rate: bigint
}

export interface BuildTxArgs {
  chain: ChainConfig
  key: DerivedKey
  utxos: Utxo[]
  toAddress: string
  /** ignored when sendMax is true */
  amount: bigint
  /** smallest units per vbyte */
  feeRate: bigint
  /** sweep everything to toAddress */
  sendMax?: boolean
}

export interface BuiltTx {
  hex: string
  txid: string
  /** amount actually delivered to toAddress */
  amount: bigint
  fee: bigint
  change: bigint
  toAddress: string
  vbytes: number
}

export interface ChainClient {
  getBalance(address: string): Promise<Balance>
  getUtxos(address: string): Promise<Utxo[]>
  getFeeOptions(): Promise<FeeOption[]>
  /** resolves broadcast txid; throws Error with a readable message on rejection */
  broadcast(txHex: string): Promise<string>
}

// ===========================================================================
// v2 — HD accounts, history, provider failover, fee bumping
// ===========================================================================
//
// Module contracts (v2):
//
// keys.ts (additions)
//   deriveAccount(mnemonic: string, chain: ChainConfig): AccountKeys
//
// providers: blockbook.ts / esplora.ts / blockcypher.ts implement ProviderApi
//   (xpub?: XpubApi present only where the backend supports account queries)
// api.ts
//   getClient(chain: ChainConfig): FailoverClient — ordered providers with
//   automatic failover; exposes the ProviderApi union plus `capabilities()`
//
// scanner.ts
//   scanAccount(account: AccountKeys, client: FailoverClient): Promise<AccountState>
//     — uses XpubApi when available, else per-address gap scan (gap 20)
//
// history.ts
//   classifyTxs(raw: RawTxInfo[], ours: Set<string>, tipHeight: number): TxSummary[]
//
// csvexport.ts
//   txsToCsv(chain: ChainConfig, txs: TxSummary[]): string
//
// txbuild.ts (additions)
//   buildTxV2(args: BuildTxArgsV2): BuiltTx
//   buildBump(args: BumpArgs): BuiltTx — RBF replacement at a higher rate
//
// prices.ts (additions)
//   fetchPriceHistory(symbol: string): Promise<PricePoint[]> — ~7d daily USD

/** Derived key for one concrete address in an account. */
export interface AddressKey extends DerivedKey {
  branch: 0 | 1 // 0 = receive, 1 = change
  index: number
}

/** The public half of an AddressKey — everything except the secret. */
export type PublicAddressKey = Omit<AddressKey, 'privateKey'>

/**
 * What the scanner, the snapshot validator and every display path need from
 * an HD account: public keys only. Both software accounts (AccountKeys) and
 * hardware accounts (HardwareAccountKeys) satisfy it.
 */
export interface WatchAccountKeys {
  chain: ChainId
  accountPath: string
  /**
   * Account public keys for provider queries, by encoding:
   *  'xpub'    — standard BIP32 version bytes (0488b21e)
   *  'slip132' — zpub/vpub for BIP84 chains; equals 'xpub' where n/a
   *  'native'  — chain's own scheme (e.g. DOGE dgub); equals 'xpub' where n/a
   */
  xpubs: Record<'xpub' | 'slip132' | 'native', string>
  /** derive (and cache) the public key + address for branch/index */
  address(branch: 0 | 1, index: number): PublicAddressKey
  /** drop cached keys (wipes private material where there is any) */
  zero(): void
}

/**
 * In-memory handle for one chain's seed-derived HD account
 * (m/purpose'/coin'/0'). Never serialized; zero() wipes private material on
 * lock/erase.
 */
export interface AccountKeys extends WatchAccountKeys {
  /** derive (and cache) the key for branch/index, private key included */
  address(branch: 0 | 1, index: number): AddressKey
  /** wipe cached private keys */
  zero(): void
}

export interface AccountAddressInfo {
  address: string
  branch: 0 | 1
  index: number
  used: boolean
}

export interface AccountUtxo extends Utxo {
  address: string
  branch: 0 | 1
  index: number
}

/** Provider-normalized transaction (minimal, cross-provider). */
export interface RawTxInfo {
  txid: string
  height: number | null
  time: number | null
  fee: bigint | null
  /**
   * Inputs with their prevout reference (needed to rebuild the tx for an RBF
   * bump). address/value may be null when the provider can't resolve them.
   */
  inputs: {
    address: string | null
    value: bigint
    prevTxid: string | null
    prevVout: number | null
  }[]
  outputs: { address: string | null; value: bigint }[]
  /** true when any input signals BIP125 replaceability (sequence < 0xfffffffe) */
  rbfSignaled: boolean
}

export interface TxSummary {
  txid: string
  direction: 'in' | 'out' | 'self'
  /** signed net effect on the wallet, smallest units (out includes the fee) */
  amount: bigint
  fee: bigint | null
  time: number | null
  height: number | null
  confirmations: number
  pending: boolean
  /** display counterparty: first non-wallet output for out, first wallet address for in */
  counterparty: string | null
  /** pending + rbfSignaled + every input ours → the Speed up button shows */
  bumpable: boolean
}

export interface AccountState {
  balance: Balance
  addresses: AccountAddressInfo[]
  nextReceive: AccountAddressInfo
  nextChange: AccountAddressInfo
  utxos: AccountUtxo[]
  /** newest first, deduped across addresses */
  txs: TxSummary[]
  /** raw form of the same txs (by txid), retained so a bump can rebuild them */
  rawTxs: RawTxInfo[]
  tipHeight: number
  /**
   * Set when a per-address fetch failed mid-scan, so consumers can avoid acting
   * on undercounted data: `balance` true → the total may be too low (suppress
   * received-coin alerts); `utxos` true → the spendable set may be short (warn
   * before a MAX sweep). Absent/both-false on a fully successful scan.
   */
  incomplete?: { balance: boolean; utxos: boolean }
}

/** Per-address provider surface (every provider implements this). */
export interface AddressApi {
  getAddressStats(address: string): Promise<{ balance: Balance; txCount: number }>
  getAddressUtxos(address: string): Promise<Utxo[]>
  getAddressTxs(address: string): Promise<RawTxInfo[]>
  getRawTxHex(txid: string): Promise<string>
  getTipHeight(): Promise<number>
  getFeeOptions(): Promise<FeeOption[]>
  broadcast(txHex: string): Promise<string>
  /**
   * Whether the backend knows this txid at all (mempool or confirmed): true,
   * false on an explicit not-found, a throw on anything else. The in-flight
   * ledger (pending.ts) asks this before a new send.
   */
  txSeen(txid: string): Promise<boolean>
  /**
   * Who spent each output of a tx (esplora /outspends). Optional: providers
   * without it return undefined and RBF falls back to the broadcast-error
   * retry path. Needed so a bump can outbid CONFLICTING descendants it can't
   * see in the wallet's own history (e.g. the recipient re-spent an
   * unconfirmed output — BIP125 rule 3 counts their fee too).
   */
  getTxOutspends?(txid: string): Promise<{ spent: boolean; txid: string | null; confirmed: boolean }[]>
  /** fee of an arbitrary tx (esplora /tx json); optional like outspends */
  getTxFee?(txid: string): Promise<bigint | null>
}

/** Account-level surface (Blockbook-style backends only). */
export interface XpubApi {
  /** balance, per-address usage and normalized txs for a whole account */
  scanXpub(xpub: string): Promise<{
    balance: Balance
    /** every address the backend saw as used, with branch/index parsed from its path */
    used: { address: string; branch: 0 | 1; index: number }[]
    txs: RawTxInfo[]
  }>
  getXpubUtxos(xpub: string): Promise<AccountUtxo[]>
}

export interface ProviderApi extends AddressApi {
  /** short id for logs/errors, e.g. 'mempool.space' */
  providerName: string
  xpub?: XpubApi
  /**
   * The backend sheds load in short bursts (esplora: 429s for a second or two
   * under scan load). A browser can't see those 429s when they carry no CORS
   * headers, only a network error, so for such a provider the FailoverClient
   * reads a network-level failure right after a success as a rate limit and
   * backs off and retries it. Leave unset where the limit is long (BlockCypher
   * is hourly) and a retry seconds later can't help.
   */
  burstLimited?: boolean
  /**
   * Used only while every regular provider for the chain has failed or is
   * cooling down: never raced at startup, never remembered as the last-good
   * provider, and a regular provider that is merely rate-limited is waited
   * for instead. For a host whose budget is small and shared (BlockCypher,
   * ~100 requests an hour across every chain it serves).
   */
  backupOnly?: boolean
}

/** getClient(chain) v2: failover over an ordered ProviderApi list. */
export interface FailoverClient extends AddressApi {
  /** true when the CURRENT healthy provider supports account queries */
  hasXpubApi(): boolean
  scanXpub: XpubApi['scanXpub']
  getXpubUtxos: XpubApi['getXpubUtxos']
  /** name of the provider that served the last successful call */
  activeProvider(): string
}

export interface BuildTxArgsV2 {
  chain: ChainConfig
  utxos: AccountUtxo[]
  /** resolve the signing key for a selected utxo */
  keyFor: (u: AccountUtxo) => DerivedKey
  toAddress: string
  amount: bigint
  feeRate: bigint
  sendMax?: boolean
  /** fresh change address (next unused change index) */
  changeAddress: string
}

export interface BumpArgs {
  chain: ChainConfig
  /** the pending tx to replace; must be rbfSignaled with all inputs ours */
  original: RawTxInfo
  /** wallet addresses, to distinguish our change from recipient outputs */
  ourAddresses: Set<string>
  /** resolve the signing key for an input address; null → cannot bump */
  keyFor: (address: string) => DerivedKey | null
  /** original inputs as spendable utxos (same outpoints, with rawTxHex where legacy) */
  originalUtxos: AccountUtxo[]
  /** extra confirmed utxos to add if the higher fee needs more funds */
  extraUtxos: AccountUtxo[]
  extraKeyFor: (u: AccountUtxo) => DerivedKey
  newFeeRate: bigint
  /**
   * Sum of fees of UNCONFIRMED transactions that conflict with the
   * replacement beyond the original itself (its unconfirmed spenders).
   * BIP125 rule 3: the replacement's absolute fee must exceed the whole
   * conflicting set, not just the original.
   */
  conflictExtraFees?: bigint
  /** hard floor for the absolute fee (from a node's rejection message) */
  absoluteFeeFloor?: bigint
  /** where change goes (may reuse the original change address) */
  changeAddress: string
}

export interface PricePoint {
  /** unix seconds */
  t: number
  /** USD */
  p: number
}

// ===========================================================================
// v3 — hardware accounts (Ledger) for the BTC/LTC engine
// ===========================================================================
//
// Design: docs/hardware-signing.md. A hardware account is watch-and-sign: the
// browser holds the account xpub only; every signature comes from the device.
//
// Module contracts (v3):
//
// txbuild.ts (additions)
//   prepareTxV2(args: PrepareTxArgsV2): UnsignedTx — buildTxV2's selection,
//     unsigned (public keys only); p2wpkh chains only
//   prepareBump(args: PrepareBumpArgs): UnsignedTx — buildBump's selection and
//     BIP125 checks against the estimated size, unsigned
//
// hwsign.ts
//   fetchPrevTxs(chain, client, unsigned, known?): Promise<Map<txid, Uint8Array>>
//     — every input's funding tx, witness-stripped, txid-bound, and required to
//     pay exactly the planned value to the planned address
//   buildSignRequest(unsigned, account, prevTxs): SignRequest
//   assembleSigned(unsigned, sigs): BuiltTx — strict verification of every
//     signature against the locally computed BIP143 digest, then finalize
//
// hwaccount.ts
//   hardwareAccount(record): HardwareAccountKeys — throws on an invalid record
//   loadHardwareRecords() / saveHardwareRecords(records) — securestore 'hwaccounts'
//   isHardwareAccount(a): a is HardwareAccountKeys
//
// ledger/*.ts
//   framing.ts   HID framing (pure)
//   transport.ts WebHID (preferred) / WebUSB (fallback) LedgerTransport
//   btcapp.ts    Bitcoin app ≥ 2.1 (PSBTv2 merkleized maps, SIGN_PSBT)
//   legacyapp.ts Litecoin app (legacy trusted-input BIP143 signing)
//   index.ts     sessions, app checks, identity binding, import, address
//                verification, ledgerSigner(account) → UtxoSigner, errors

/** Chains a hardware account can be added for (native segwit only). */
export type HardwareChainId = 'btc' | 'btc-testnet' | 'ltc'

/**
 * Persisted description of one hardware account — public data only. Lives in
 * the encrypted secure store (kailah.sec.hwaccounts); never key material.
 */
export interface HardwareAccountRecord {
  v: 1
  /** 'ledger:<chain>:<first 16 hex of sha256(xpub)>' */
  id: string
  chain: HardwareChainId
  device: 'ledger'
  /** which device app/protocol signs for it */
  app: 'bitcoin' | 'litecoin-legacy'
  /** e.g. m/84'/0'/0' — must equal the chain's accountPath */
  accountPath: string
  /** account xpub exactly as the device returned it (xpub/tpub) or as assembled from it */
  xpub: string
  /** 8 lowercase hex chars (Bitcoin app); null where the app can't report it */
  masterFingerprint: string | null
  /** receive address 0/0 as confirmed on the device screen during import */
  verifiedAddress: string
  label: string
  addedAt: number
}

/** A watch-only HD account whose keys live in a hardware device. */
export interface HardwareAccountKeys extends WatchAccountKeys {
  kind: 'hardware'
  record: HardwareAccountRecord
  /** account path as BIP32 indices (hardened offsets applied) */
  accountPathIndices: number[]
}

/** One coin of an unsigned spend: the outpoint plus the public key that owns it. */
export interface PlannedInput {
  txid: string
  vout: number
  value: bigint
  address: string
  publicKey: Uint8Array
  branch: 0 | 1
  index: number
}

/** One output of an unsigned spend; `change` is set only on our own change. */
export interface PlannedOutput {
  address: string
  amount: bigint
  change: { publicKey: Uint8Array; branch: 0 | 1; index: number } | null
}

/**
 * A fully selected, not-yet-signed transaction. The hardware review screen
 * renders it, the device request is built from it, and the broadcast bytes
 * are assembled from it — one object, so the three cannot drift.
 */
export interface UnsignedTx {
  chain: ChainConfig
  version: number
  lockTime: number
  sequence: number
  inputs: PlannedInput[]
  /** in transaction order */
  outputs: PlannedOutput[]
  /** delivered to the recipient(s) (bump: sum of every recipient output) */
  amount: bigint
  fee: bigint
  change: bigint
  /** first recipient (bump: as BuiltTx.toAddress) */
  toAddress: string
  /** upper bound before signatures exist (68 vB per p2wpkh input) */
  vbytesEstimate: number
  /** bump only: what the BIP125 checks need to re-run on the final size */
  bump?: { original: RawTxInfo; conflictExtraFees: bigint }
}

export interface PrepareTxArgsV2 {
  chain: ChainConfig
  utxos: AccountUtxo[]
  /** resolve the public key for a selected utxo */
  keyFor: (u: AccountUtxo) => PublicAddressKey
  toAddress: string
  amount: bigint
  feeRate: bigint
  sendMax?: boolean
  /** fresh change key (next unused change index) */
  change: PublicAddressKey
}

export interface PrepareBumpArgs
  extends Omit<BumpArgs, 'keyFor' | 'extraKeyFor' | 'changeAddress'> {
  keyFor: (address: string) => PublicAddressKey | null
  extraKeyFor: (u: AccountUtxo) => PublicAddressKey
  /** where change goes (may reuse the original change address) */
  change: PublicAddressKey
}

/** One input as a device needs it. */
export interface SignInput {
  txid: string
  vout: number
  sequence: number
  value: bigint
  /** scriptPubKey of the spent output */
  script: Uint8Array
  publicKey: Uint8Array
  /** full BIP32 path from the master key */
  path: number[]
  /** the funding transaction, witness-stripped, txid-verified */
  prevTx: Uint8Array
}

export interface SignOutput {
  address: string
  amount: bigint
  script: Uint8Array
  /** set on our own change only: the device re-derives it to hide it */
  change: { publicKey: Uint8Array; path: number[] } | null
}

/** Vendor-neutral description of what a device must sign. */
export interface SignRequest {
  chain: ChainConfig
  version: number
  lockTime: number
  account: { path: number[]; xpub: string; masterFingerprint: Uint8Array | null }
  inputs: SignInput[]
  outputs: SignOutput[]
}

/** A device's answer for one input: DER signature with the sighash byte appended. */
export interface InputSignature {
  index: number
  publicKey: Uint8Array
  signature: Uint8Array
}

/** Anything that can sign a SignRequest (a Ledger, the test mock, …). */
export interface UtxoSigner {
  sign(req: SignRequest): Promise<InputSignature[]>
}

// ===========================================================================
// v4 — networks shown (dashboard chooser)
// ===========================================================================
//
// netprefs.ts
//   loadNetworkPrefs(): NetworkPrefs | null — securestore 'netprefs'; null =
//     undecided (every network shows, as before the chooser)
//   saveNetworkPrefs(shown): NetworkPrefs — throws on an empty list
//   isNetworkShown(prefs, chainId): boolean — any engine's id; practice
//     networks mirror their real twin
//   utxoActivity / evmActivity / solActivity / tronActivity(uiState):
//     NetworkActivity — funded | used | unused | unknown | pending
//   decideShown(activity): RealNetworkId[] | null — an undecided wallet's
//     pick: defaults + funded/used/unknown; null while any is pending
//   realNetworkActivity(states, failed?) — all nine; a failed engine chunk
//     reads as unknown
//   engineShown(prefs, 'evm' | 'sol' | 'tron', mode): boolean — load that
//     engine's chunk only when one of its networks shows in this mode
//   networksForMode(mode), ENGINE_NETWORKS, NETWORK_LABELS — static ids and
//     labels (no engine import), proven equal to the engine configs
// Hidden networks are never scanned or polled (App.tsx filters every scan
// loop through isNetworkShown) and an all-hidden engine is never loaded;
// hardware accounts always show.
