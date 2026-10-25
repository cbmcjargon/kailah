# Hardware signing — design (Ledger, Bitcoin + Litecoin)

Status: implemented (BTC, BTC testnet4, LTC). Written before the code; the
implementation follows it, and every section names the module that realizes
it. §12 records what implementation and testing turned up.

## 1. Why, and what changes

The 2026-10-21 security review concluded that for serious balances the only
real upgrade is a hardware wallet: a browser cannot use a phone's secure
enclave for secp256k1, so the key has to live in a device that signs without
ever exporting it. This design adds **hardware accounts** next to the existing
seed ("software") accounts:

- A hardware account is watch-and-sign: the browser holds the account's
  **extended public key only**. Balances, history, fresh receive/change
  addresses and RBF all run through the existing UTXO stack unchanged.
- Every signature comes from the device, after the device itself displays the
  recipient(s), amount(s) and fee, and the user approves on the device.
- The seed wallet stays as it is. A hardware account is added from Settings or
  the dashboard ("Add a Ledger account") and appears as its own card
  ("Bitcoin · Ledger").

Scope: **Bitcoin mainnet, Bitcoin testnet4 (practice mode) and Litecoin**, all
BIP84 native segwit (p2wpkh), account 0, Ledger devices. Out of scope (paths in
§11): Dogecoin, EVM, Solana, TRON, Trezor, Bluetooth.

What a hardware account defends against, in the wallet's own threat model:

| Threat | Software account | Hardware account |
| --- | --- | --- |
| Device malware / malicious extension reads memory while unlocked | seed and keys stolen | xpub (privacy) only; no key to steal |
| Compromised wallet JS builds a payment to an attacker | signed if the user approves the browser screen | device shows the attacker's address and amount; the user must reject on the device |
| Lying provider inflates/deflates an input amount (segwit fee attack) | review screen trusts the scan | device verifies every input amount against the full previous transaction |
| Forged receive address on screen | address re-derived from keys | additionally verifiable on the device screen ("Verify on Ledger") |

The device screen — not the browser — is the final authority for a hardware
account. §8 explains how the wallet keeps its own review screen identical to it.

## 2. Device protocols (verified against Ledger's sources, 2026-10-22)

Ledger ships two different Bitcoin-family app protocols, so the two chains in
scope use two clients:

| Chain | Ledger app | Protocol | Module |
| --- | --- | --- | --- |
| BTC | "Bitcoin" ≥ 2.1.0 | new app (CLA `0xE1`): PSBTv2 as merkleized maps, `SIGN_PSBT`, default wallet policy `wpkh(@0/**)` | `src/lib/ledger/btcapp.ts` |
| BTC testnet4 | "Bitcoin Test" ≥ 2.1.0 | same | same |
| LTC | "Litecoin" (legacy codebase) | legacy btchip (CLA `0xE0`): trusted inputs + BIP143 streaming | `src/lib/ledger/legacyapp.ts` |

Sources read: `LedgerHQ/app-bitcoin-new` `doc/bitcoin.md`, `doc/merkle.md`,
`doc/wallet.md`; `LedgerHQ/app-bitcoin-legacy` `doc/btc.asc` and its Makefile
(the Litecoin variant is built only from the legacy repo; the new repo builds
`bitcoin`, `bitcoin_testnet`, `bitcoin_recovery`); and Ledger's reference client
`hw-app-btc` (`Btc.ts` routes every non-Bitcoin app, Litecoin included, to the
legacy implementation). Facts the docs leave open were taken from the
reference client: CONTINUE is `F8 01 00 01`; merkle proofs are sibling hashes
leaf-to-root; list leaves are `sha256(0x00 || element)` and `GET_PREIMAGE`
answers include that `0x00`; map keys are `keytype || keydata` sorted bytewise;
yields are `varint(input) || len || pubkey || DER-signature || sighash`; the
reference client attaches `NON_WITNESS_UTXO` to segwit inputs too; the legacy
signature's first byte carries a parity flag that must be masked to `0x30`.

### Dependency decision: no new packages

Ledger's official stack for this is `@ledgerhq/hw-transport-webhid` (+
`@ledgerhq/devices`, `rxjs`, `semver`, `events`, `@ledgerhq/errors`,
`@ledgerhq/logs`) plus either `@ledgerhq/hw-app-btc` (bitcoinjs-lib, bs58check,
ripemd160, sha.js, …) or `ledger-bitcoin` (bitcoinjs-lib,
`@bitcoinerlab/descriptors`, miniscript, ecpair, …): dozens of packages, several
of them unaudited crypto, and Ledger's own README now calls that ledgerjs tree
"deprecated and in transition". Against the repo's audited-minimal stance
(`@scure`/`@noble`, exact pins, install scripts off) that is the wrong trade.

The protocols themselves are small. The wallet implements them directly on
what it already ships:

| Piece | Size | Built on |
| --- | --- | --- |
| HID framing (64-byte reports, channel/tag/sequence) | ~80 lines | — |
| WebHID + WebUSB transports | ~200 lines | browser APIs |
| Merkle tree, merkleized maps, client-command interpreter, wallet policy, PSBTv2 maps | ~400 lines | `@noble/hashes` |
| Legacy trusted-input signing | ~200 lines | `@noble/hashes` |
| Signature verification | ~60 lines | `@scure/bip32` `HDKey.verify` (noble secp256k1 under the hood) |

`package.json` gains **zero** dependencies. The cost is that this protocol
code has never touched a real device; §10 says exactly how that is mitigated
and what remains the user's step.

## 3. Transport and browser support

- **WebHID** (preferred): Chrome / Edge / Opera on desktop (89+). Filter
  `{ vendorId: 0x2c97, usagePage: 0xffa0 }` (Ledger's generic HID
  collection, not its FIDO one). `sendReport(0, frame)`, replies via
  `inputreport` events.
- **WebUSB** (fallback, used only when `navigator.hid` is missing): Chrome on
  Android with a USB-OTG cable. Configuration 1, the interface whose class is
  `0xFF`, endpoint 3 in/out, same 64-byte framing.
- **Not supported**: Safari (macOS/iOS) and Firefox have neither API; the UI
  says so instead of offering a button. Bluetooth (Nano X / Stax / Flex over
  Web Bluetooth) is a future transport behind the same interface (§11).
- Framing: every APDU is prefixed with its 2-byte length and cut into 64-byte
  frames `channel(2) | 0x05 | seq(2) | data`; replies are reassembled and every
  frame's channel, tag and sequence is checked (`src/lib/ledger/framing.ts`).
- `requestDevice` needs a user gesture, so connecting is always the direct
  result of a tap ("Connect Ledger", "Sign on Ledger", "Verify on Ledger").
  Already-granted devices are reopened with `getDevices()` without a prompt.
  Ledgers re-enumerate on USB when an app is opened or closed; a stale handle
  is dropped and the next action reconnects.
- Headers: no CSP change (no network involved). `Permissions-Policy` gains
  `hid=(self), usb=(self)` in `public/_headers` and `.netlify/netlify.toml`
  (the VPS script copies the `_headers` block to nginx, so the mirror follows
  on its next redeploy).

## 4. Accounts in the type system

`src/lib/types.ts` splits the public half of an account from the signing half:

```ts
interface PublicAddressKey { chain; address; path; publicKey; branch; index }   // no secret
interface WatchAccountKeys { chain; accountPath; xpubs; address(b, i): PublicAddressKey; zero() }
interface AccountKeys extends WatchAccountKeys { address(b, i): AddressKey }      // software: unchanged
interface HardwareAccountKeys extends WatchAccountKeys {
  kind: 'hardware'; record: HardwareAccountRecord; accountNode: HDKey (public)
}
```

- `deriveAccount` (software) is untouched and still returns `AccountKeys`
  whose `address()` carries the private key.
- `hardwareAccount(record)` (`src/lib/hwaccount.ts`) parses the device xpub
  with `HDKey.fromExtendedKey` (xpub or tpub versions), requires depth 3, a
  hardened child index matching the stored account path, and **no** private
  key; `address(branch, index)` derives public children only. `zero()` just
  drops the memoized children — there is no secret to wipe.
- `xpubs.xpub` is the canonical `0488b21e` re-encoding (the addrcache key, as
  for software accounts); `slip132` is the zpub/vpub form; the device's own
  string is kept verbatim in the record because the wallet policy must quote
  it exactly.
- `scanAccount` and `snapshotMatchesAccount` take `WatchAccountKeys` — a
  type-only widening; scanner code is unchanged, so gap scanning, the warm
  cache, the frontier caps and quick polls apply to hardware accounts as-is.

## 5. What is stored, lock and erase

A hardware account is persisted as one record — public data only:

```ts
interface HardwareAccountRecord {
  v: 1
  id: string                   // 'ledger:<chain>:<first 16 hex of sha256(xpub)>'
  chain: 'btc' | 'btc-testnet' | 'ltc'
  device: 'ledger'
  app: 'bitcoin' | 'litecoin-legacy'
  accountPath: string          // "m/84'/0'/0'"
  xpub: string                 // exactly as the device returned / as assembled from it
  masterFingerprint: string | null  // 8 hex (Bitcoin app); null for Litecoin (legacy app has no command for it)
  verifiedAddress: string      // receive 0/0, confirmed on the device screen at import
  label: string
  addedAt: number
}
```

Never stored: private keys (they never leave the device), PINs, device serial
numbers or USB identifiers.

**Where.** Records live in the encrypted secure store
(`src/lib/securestore.ts`) under the new name `hwaccounts`, i.e.
`kailah.sec.hwaccounts`: AES-256-GCM under the HKDF key derived from the
software seed, decrypted into memory on unlock, ciphertext while locked —
the same protection the scan caches already have. The xpub is not a secret
but it maps every address and payment of the account, so it must not sit in
the clear.

**Decision on the cache key source.** A hardware account always lives *inside*
an unlocked software wallet, so the seed-derived cache key exists whenever a
hardware account is visible; its caches (`addrmap` entry keyed by its xpub,
`statecache` entry keyed `hw:<record id>`) use that same key. Rejected
alternatives: (a) a key from the vault password — would need the password on
every unlock path, including biometric unlock, for no gain over the seed key;
(b) memory-only caches — would force a cold gap scan on every unlock, which
costs requests and hides history until it finishes. A **hardware-only wallet**
(no seed at all) is out of scope; it would need option (a): an Argon2id key
from its own password, through the same `unlockSecureStore` entry point.

Losing the record is an inconvenience, not a loss: the coins are controlled by
the device's own seed, and re-adding the account from the device restores the
same addresses and history.

**Lock.** `zero()` on every hardware account (drops derived public keys), the
open device session is closed, `lockSecureStore()` drops the decrypted record
list. Nothing secret existed, so nothing else needs wiping.

**Erase.** `clearSecureStore()` removes `kailah.sec.hwaccounts` with every
other `kailah.sec.*` blob (the name joins `KNOWN_NAMES`), so "erase clears
every kailah.* key" still holds without a new plain key. Erase also calls
`forget()` on every Ledger the origin was granted (WebHID/WebUSB) so the site
loses device permission. The device and its funds are untouched; the wallet
says so in the erase copy for users with hardware accounts.

## 6. The signer abstraction and the transaction flow

```ts
interface UtxoSigner { sign(req: SignRequest): Promise<InputSignature[]> }
interface SignRequest {
  chain; version; lockTime
  account: { path: number[]; xpub: string; masterFingerprint: Uint8Array | null }
  inputs:  { txid; vout; sequence; value; script; publicKey; path: number[]; prevTx: Uint8Array }[]
  outputs: { address; amount; script; change: { publicKey; path: number[] } | null }[]
}
interface InputSignature { index: number; publicKey: Uint8Array; signature: Uint8Array } // DER || sighash
```

- **Software signer = today's code, byte for byte.** `buildTxV2` and
  `buildBump` keep their synchronous signatures and their inline
  `tx.signIdx(privateKey, i)`. The only change is that their coin-selection
  halves move into `selectCoinsV2` / `planBump` (pure functions, same code, same
  messages) so the hardware path reuses them instead of duplicating them.
  `check-txbuild` and `check-txv2` run unmodified.
- **Device signer.** The hardware path is
  1. fresh scan (as today — sends never use a cached UTXO set);
  2. `prepareTxV2` / `prepareBump` → `UnsignedTx`: the same selection, the
     same fresh change address, inputs carrying public keys and
     branch/index, outputs with the change marked; plus a size *estimate*
     (68 vB per p2wpkh input — an upper bound for low-S signatures);
  3. `fetchPrevTxs`: the raw funding transaction of every input, bound to its
     txid with `Transaction.fromRaw(...).id` (witness-stripped, so correct for
     segwit funding txs) and required to pay exactly the scanned value to the
     scanned address — a lying provider is refused here, before the device;
  4. review screen (§8);
  5. `buildSignRequest` → the vendor client: `LedgerBtcApp.signPsbt`
     serializes PSBTv2 maps (global: tx version, input/output counts, PSBT
     version 2; inputs: previous txid, output index, sequence, witness UTXO,
     non-witness UTXO, BIP32 derivation; outputs: amount, script, BIP32
     derivation on change only) and answers the device's merkle/preimage
     requests; `LedgerLegacyApp.signSegwit` streams trusted inputs, the
     outputs and the change path, then one pseudo-transaction per input;
  6. `assembleSigned`: for every input exactly one signature, from the
     planned public key, DER-parsed strictly, S normalized low, verified
     against the BIP143 sighash this wallet computes itself over the exact
     transaction it will broadcast; outputs and fee re-checked against the
     `UnsignedTx`; for bumps the BIP125 rule 3/4 and fee-ceiling checks run
     again on the real size. Any mismatch refuses the transaction.
  7. broadcast, success/failed screens exactly as today (Retry re-broadcasts
     the same bytes, so it can never double-pay).
- Only signatures cross back from the device. The wallet never accepts a
  serialized transaction from it.
- **RBF.** `BumpModal` already rebuilds the original from verified raw bytes;
  for a hardware account the preview builds an `UnsignedTx` per fee choice,
  and "Replace transaction" sends it to the device. The funding transactions
  fetched during verification are reused; extra confirmed inputs get theirs
  fetched at signing time.
- **Identity binding.** Before signing or verifying an address the client asks
  the device for the account's extended key at the stored path and requires
  the same public key and chain code as the record (Bitcoin app: plus the
  master fingerprint). A different Ledger, or the right Ledger with a
  different passphrase, fails with "This Ledger doesn't hold this account".
- The mock signer (§10) implements the same interface, which is what makes
  the PSBT construction and signature assembly testable offline.

## 7. UI states

One component (`LedgerPrompt`) renders the device state everywhere (import,
receive verification, send, bump):

| State | Shown when | Copy |
| --- | --- | --- |
| unsupported | no WebHID and no WebUSB | "Hardware wallets need Chrome or Edge on a computer, or Chrome on Android with a USB cable." |
| connect | no granted device / handle went stale | "Connect your Ledger and unlock it" + button |
| locked | SW `0x5515` / `0x6982` | "Unlock your Ledger with its PIN, then try again." |
| wrong app | app name ≠ expected, or SW `0x6E00`/`0x6D00`/`0x6511` | "Open the Bitcoin app on your Ledger." |
| app too old | Bitcoin app < 2.1.0 | "Update the Bitcoin app in Ledger Live (2.1 or newer)." |
| confirm | request sent, waiting for the user | "Check and approve on your Ledger" + the values to compare |
| rejected | SW `0x6985` | "You rejected it on your Ledger. Nothing was sent." |
| wrong device | identity check failed | "This Ledger doesn't hold this account." |
| disconnected | device unplugged / reconnecting | "Your Ledger disconnected. Reconnect it and try again." |
| refused | signature or outputs failed verification | "Your Ledger's signature didn't match this transaction — nothing was sent." |

## 8. Keeping the review screen authoritative

1. **One object.** The review screen renders the `UnsignedTx`; the device
   request is built from that same object; the broadcast transaction is
   assembled from it. There is no second construction to drift.
2. **The device shows the same numbers.** Every non-change output's address
   and amount, and the fee, are displayed by the device from data it
   verifies itself (non-witness UTXOs for every input, so the fee it shows
   cannot be spoofed by a provider). The hardware review screen lists outputs
   in the device's order and formats amounts in coins, as the device does,
   and says: "Your Ledger will show exactly this. Approve only if both
   screens match what you intended."
3. **Change can't hide a payment.** Change is marked by its BIP32 path only;
   the device derives the script for that path from its own key and hides the
   output only if it matches. A compromised wallet that labels an attacker's
   output as change gets it displayed as a payment.
4. **What was signed is what was reviewed.** Each signature is checked against
   the BIP143 digest of the exact transaction about to be broadcast. BIP143
   commits to every output, every input amount, the sequences and the
   locktime, so a device (or a tampered transport) that signed anything else
   yields a signature that fails verification, and the wallet refuses.
5. **Receiving.** The import flow makes the user confirm receive address 0 on
   the device; the Receive screen offers "Verify on Ledger" for the address it
   is showing, and the wallet also checks the device's returned string
   equals its own derivation.

## 9. Invariants this keeps

- Fresh scan before every send and bump; change to the next unused change
  address — unchanged code path.
- All amounts are bigint; the protocol code encodes them as 64-bit LE from
  bigint, never through numbers.
- Strict CSP unchanged (no hosts); Permissions-Policy in both header files.
- The service worker still caches nothing executable.
- Erase clears every `kailah.*` key (the new data lives under `kailah.sec.*`).
- Secrets: the browser never holds a hardware account's key; software-account
  handling is untouched.
- `npm run check:offline` gains `check-hw` and stays network-free.

## 10. Testing

### Offline (CI): `scripts/check-hw.mjs`

The test device is `scripts/ledger-emulator.mjs`, an in-memory Ledger built on
the public BIP39 test vector seed that implements, **device-side**:
the HID framing; `GET_APP_AND_VERSION`; the Bitcoin app's
`GET_MASTER_FINGERPRINT`, `GET_EXTENDED_PUBKEY`, `GET_WALLET_ADDRESS`,
`SIGN_PSBT` (it rebuilds the PSBT purely through client commands, verifying
every merkle proof and preimage, enforces the default-policy rules, detects
change from BIP32 paths, records what it would display, computes BIP143 and
yields signatures); and the legacy app's `GET_WALLET_PUBLIC_KEY`,
`GET_TRUSTED_INPUT` (HMAC-authenticated trusted inputs), `HASH_INPUT_START`,
`HASH_INPUT_FINALIZE_FULL` and `HASH_SIGN` (with the parity flag set). It can
be told to reject, to be locked, to run the wrong app, or to sign a tampered
digest.

The suite proves:
- framing round trips at every boundary size, and refuses wrong
  channel/tag/sequence;
- merkle roots against an independent recursive reference for 0–70 leaves,
  proofs for every leaf, multi-round `GET_MORE_ELEMENTS` for long preimages
  and deep proofs;
- the wallet-policy serialization and id;
- hardware-account addresses equal the software derivation for the same seed
  (BTC, testnet, LTC; both branches), and the imported xpubs equal the
  software xpubs — for LTC that checks the xpub assembly from legacy
  responses, parent fingerprint included;
- **byte identity**: a send and an RBF bump signed through the emulated device
  (BTC via `SIGN_PSBT`, testnet via "Bitcoin Test", LTC via the legacy flow)
  produce exactly the hex `buildTxV2` / `buildBump` produce with the software
  key — so PSBT construction, the device conversation and signature assembly
  are all exact;
- a mock signer that receives standard PSBTv2 bytes parsed by
  `@scure/btc-signer` — an independent PSBT implementation — and signs from
  them, again byte-identical;
- the emulated device's display log equals the review screen's recipients,
  amounts and fee, with change hidden;
- refusals: a tampered digest, a signature on the wrong input or from the
  wrong key, a missing signature, high-S normalization, a provider that
  returns the wrong funding transaction or a different value, a different
  Ledger (identity check), user rejection, a locked device, the wrong app, a
  too-old app;
- record validation (wrong network, depth, path or a private key in the xpub
  are refused) and that erase removes the stored records.

### What cannot be tested without a device

- That real firmware accepts these exact APDUs: the client-command
  conversation, the default-policy checks, the legacy streaming and trusted
  input format, and that the Litecoin app accepts transaction version 2
  (Ledger's own client always sends 1 for legacy apps; BIP143 hashes whatever
  version is streamed, so this is expected to work but is unverified).
- WebHID/WebUSB behavior on real hardware: permission prompts, re-enumeration
  when switching apps, the `0xffa0` collection on each model (Nano S Plus,
  Nano X, Stax, Flex), Android OTG.
- What each device model actually displays (change hiding, "unverified
  inputs" warnings, the Litecoin app's segwit change detection).

### Real-device walkthrough (the user's step)

Use practice mode first; testnet4 coins are worthless.

1. On the Ledger, install **Bitcoin Test** (and later **Bitcoin**,
   **Litecoin**) from Ledger Live; update to the latest versions (Bitcoin apps
   must be ≥ 2.1.0). Quit Ledger Live (it holds the USB device).
2. Serve the build with headers: `npm run build`, then start the
   `dist-preview` launch config (`node scripts/serve-dist.mjs`, port 4173), in
   Chrome or Edge on a computer.
3. Restore the test wallet (practice mode). Dashboard → **Add a Ledger
   account** → Bitcoin testnet. Plug in and unlock the Ledger, open Bitcoin
   Test, tap **Connect Ledger**, pick the device in the browser prompt.
4. The Ledger shows receive address `0/0`; check it matches the address in the
   wallet, approve. The account card appears and scans.
5. Receive → **Verify on Ledger**; compare and approve. Fund the address from
   a testnet4 faucet; wait for the balance.
6. Send a small amount back to the faucet or to the software testnet account:
   review → **Sign on Ledger** → on the device, check recipient, amount and
   fee match the review screen, approve → broadcast → confirm on the
   explorer link.
7. Send again at the lowest fee, then open the pending transaction → **Speed
   up** → pick a higher fee → approve on the device → check the explorer shows
   the replacement.
8. Negative checks: reject on the device (expect "Nothing was sent"); start a
   send with the device locked, then with the dashboard open instead of the
   app (expect the matching prompts); unplug mid-confirmation.
9. Real mode, small amounts only: repeat 3–7 with **Bitcoin** and with
   **Litecoin** (receive a small LTC amount, send part of it, bump once).
10. Lock, unlock (the card returns from the encrypted store); Settings →
    remove the Ledger account; finally erase the test wallet and check that
    `chrome://settings/content/hidDevices` no longer lists the site.

Report back any step that fails with the on-screen message; device-protocol
fixes land in `src/lib/ledger/*` with a new emulator case reproducing them.

## 11. Out of scope, and the path for each

- **Dogecoin**: the Dogecoin app is legacy like Litecoin but p2pkh, which the
  legacy flow signs as a non-BIP143 transaction with full previous
  transactions; `legacyapp.ts` would gain that branch and `prepareTxV2` its
  p2pkh inputs. BlockCypher's budget makes the extra raw-tx fetches the real
  cost.
- **EVM** (USDC/ETH/BNB): the Ledger Ethereum app signs RLP-encoded EIP-1559
  transactions (`GET_ADDRESS` 44'/60'/0'/0/0, `SIGN_TX` in 255-byte chunks)
  and returns `v,r,s`; ERC-20 clear-signing needs the app's token metadata
  (`PROVIDE_ERC20_TOKEN_INFORMATION`, signed by Ledger) or blind signing.
  `evm.ts` would take a signer callback in place of its viem account; the
  pinned-chainId and re-prepare-on-failure rules stay.
- **Solana**: the Solana app signs the serialized message (`SIGN_MESSAGE`,
  44'/501'/0'/0'); SPL transfers display natively, Jupiter swaps need blind
  signing enabled on the device — which defeats the point, so the swap gate
  would stay software-only.
- **TRON**: the Tron app signs the raw protobuf transaction the node builds;
  the wallet's decode-before-sign check would run before sending bytes to the
  device. TRC-20 transfers display natively.
- **Trezor**: Trezor Connect is an iframe/popup served from
  `connect.trezor.io`, which would need CSP `frame-src`/`connect-src`
  exceptions and trust in that host; a direct WebUSB client speaks Trezor's
  protobuf wire protocol (and the newer THP) — a larger client than Ledger's.
  The `UtxoSigner` interface is vendor-neutral: a Trezor backend maps
  `SignRequest` to `SignTx` messages. A vendor-neutral alternative is PSBT
  export/import (file or animated QR) for Coldcard, Keystone, Jade or Sparrow;
  `btcapp.ts` already serializes standard PSBTv2.
- **Bluetooth**: Nano X / Stax / Flex over Web Bluetooth (Chrome desktop and
  Android); the same framing with an MTU negotiation, behind
  `LedgerTransport`.
- **Multisig / other accounts**: the Bitcoin app supports registered wallet
  policies (`REGISTER_WALLET`, HMAC stored by the host); the record would gain
  the policy and its HMAC. Account indexes other than 0 are a field away.

## 12. Found while implementing

- **Speed up was broken on `main`.** `decodeVerifiedTx` reversed outpoint
  txids that btc-signer already keeps in display order, so every bump asked
  the provider for a non-existent transaction. The suites used byte-palindromic
  txids (`'d1'.repeat(32)`) and could not see it. Fixed in its own commit;
  `check-hw` covers it with real txids (the hardware bump path uses the same
  verification).
- **Several coins from one funding transaction** (change and a receive in the
  same tx is the common case) must be verified from the provider's original
  hex: the witness-stripped copy cannot be re-parsed as a final transaction.
  Found by the browser walkthrough below; regression case `E6`.
- **btc-signer 1.8.1 reads `PSBT_IN_PREVIOUS_TXID` byte-reversed** relative to
  BIP-370 (and rejects the BIP's own PSBTv2 test vector). The wallet follows
  BIP-370 and Ledger (raw sha256d order, check `G23` against the BIP vector);
  the mock signer flips that one field before handing bytes to btc-signer.

### Browser walkthrough without a device

The emulator runs in the page too, which lets the real UI, the real WebHID
transport and both protocol clients be driven end to end on the dev server:
import `/scripts/ledger-emulator.mjs` from the console, define
`navigator.hid` (via `Object.defineProperty`) as an object whose
`requestDevice`/`getDevices` return an `EventTarget` with `sendReport` that
reassembles frames, calls `emulator.handle(apdu)` and dispatches the reply
frames as `inputreport` events. For data, override `window.fetch` for
`/testnet4/api` URLs with a synthetic Esplora (one funding tx, captured
`POST /tx`), so nothing reaches a network. On 2026-10-22 this drove: import
with on-device address confirmation, encrypted persistence across reload,
on-device receive verification, a two-input send (rejected on the device,
then approved), a Speed up of that send, account removal and erase (all
`kailah.*` keys gone, `forget()` called on the device). Both signed
transactions were byte-identical to `buildTxV2` / `buildBump` for the same
coins. The production build under the real headers showed no CSP, Trusted
Types or Permissions-Policy violations.
