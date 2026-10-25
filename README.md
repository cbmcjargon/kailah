# Kailah Wallet

**v2.5.0** — a self-custody wallet for Bitcoin, Dogecoin, Litecoin, USDC + ETH
(Base / Ethereum / Arbitrum), BNB, Solana (SOL + USDC, with in-wallet swaps
and native staking), and TRON (TRX + USDT) that runs entirely in the browser. No servers, no accounts, no custody: keys are
generated on your device, encrypted with your password, and never leave it.

**Live app:** https://kailah-wallet.netlify.app (mirrored at
https://wallet.photoprompting.org) — installable on Android
(Chrome ⋮ → *Add to Home screen*) and iPhone (Safari Share → *Add to Home
Screen*).

## Before you use it

**What it is.** A hobby-grade, self-custody wallet maintained by one person.
Nobody can restore your funds, reverse a send or recover a lost recovery
phrase. The code has had AI-assisted security reviews, not a third-party
audit (see [Security model](#security-model)). Keep amounts small.

**Try it risk-free.** Practice mode, the switch in the header, puts every
network family on its test network: Bitcoin testnet4, Base Sepolia, Solana
devnet and TRON Nile. Faucet links are built in, so you can send and receive
worthless coins before using real ones.

**Get it.**

- **Web:** the live app above, installable as an app.
- **Chrome extension:** coming to the Chrome Web Store.
  Until then, build it (below) and load `dist-extension/` unpacked, as
  [docs/extension.md](docs/extension.md) describes.

The extension is the safer way to run the wallet. Its code is fixed by the
signed store package, while a website can serve different code on any visit.

**Verify what you run.**

```bash
git clone https://github.com/cbmcjargon/kailah.git && cd kailah
npm ci            # exact versions from package-lock.json; install scripts are off (.npmrc)
npm run typecheck && npm run check:offline
npm run build && npm run build:extension
npm run digest        # must equal the "Build digests" CI printed for this commit
npm run verify:live   # is each official site serving exactly this build?
```

- **Tests.** `check:offline` runs the offline test suites that CI runs on
  every push.
- **Same build everywhere.** Builds are deterministic: the same commit built
  with the same toolchain (Node 20 and the lockfile's versions) gives
  byte-identical files. CI prints the digests of every push under "Build
  digests", and `npm run digest` prints yours. A clean Linux build in CI and
  a macOS build of the same commit have matched exactly, for both the website
  and the extension.
- **The live site.** `npm run verify:live` fetches every file from both
  official sites and compares each one byte for byte with your build, along
  with all seven security headers on every response. The one difference it
  allows is the fixed HTML comment Netlify adds to HTML pages, and it says
  when it removed one. It proves what you were served just now, not what
  anyone else gets; that guarantee needs the store-signed extension.
- **The extension.** Compare `dist-extension/` file by file with the
  extension Chrome installed from the store, which adds only a `_metadata/`
  folder.

**Privacy.** The developer collects no data. [PRIVACY.md](PRIVACY.md) lists
exactly what stays on your device and which services see what.

**Report a vulnerability** privately, as [SECURITY.md](SECURITY.md)
describes. Please don't open a public issue for a security problem.

**Contributing.** Issues are welcome: bugs, questions and ideas. Pull requests
are by arrangement. Open an issue first so we can agree on the approach,
because every change to wallet code gets a careful review.

**License and name.** The code is MIT-licensed; see [LICENSE](LICENSE). The
name "Kailah Wallet" and its logo are covered by [TRADEMARK.md](TRADEMARK.md):
a build distributed under that name must keep the referral links and the
swap fee account unchanged, and a build that changes them must use a
different name and logo.

## Features

- **Seven accounts, one seed** — Bitcoin (mainnet + testnet4), Dogecoin,
  Litecoin, USDC + ETH accounts on three Ethereum-style networks (Base,
  Ethereum mainnet, Arbitrum One), and Solana — all from a single 12-word
  BIP39 phrase.
- **Solana done natively** — ed25519 keys via SLIP-0010 at the Phantom-standard
  path (restorable in Phantom/Solflare), flat ~0.000005 SOL fees, Solana Pay QR
  support, and a practice twin on devnet with a one-tap in-app airdrop —
  Solana's faucet needs no captcha, so test coins are a single button.
- **USDC on Solana** — real SPL-token support: balances, history, and sends
  that handle the token-account layer honestly (sending to a first-time USDC
  holder creates their token account; the one-time deposit is itemized on the
  review screen). A guard refuses the classic paste-a-token-account-address
  mistake. Practice mode points at Circle's devnet faucet.
- **Custom ERC-20 tokens, quarantined** — any token that lands at your EVM
  address is detected (via Blockscout) and can be sent with a plain ERC-20
  transfer, but it's shown in a separate "Other tokens" section with a
  sanitized name, its contract address, no USD price, and a standing scam
  warning. Airdropped tokens with hostile names ("Telegram @…", fake domains)
  display as "Unnamed token" — the bait never reaches the screen. The wallet
  never signs token approvals, only transfers.
- **BNB Chain** — hold and send BNB (and Binance-Peg USDC) with the same
  one-address EVM account. Stated honestly: BNB has no keyless explorer API,
  so this card shows live balances and sends but no activity feed.
- **Solana staking, natively** — delegate SOL to a validator (curated list,
  ≤10% commission), watch it activate, unstake and withdraw — with epoch
  timing explained in plain words. Stake accounts are derived from your own
  key, so the 12 words recover them anywhere; the wallet never uses a
  staking pool or third-party contract.
- **TRON + USDT, decoded before signed** — TRX and USDT (TRC-20, the world's
  most-used stablecoin rail) on a fourth engine. TRON nodes build the raw
  transaction, and the wallet never signs those bytes blind: a built-in
  protobuf decoder reads them back and refuses to sign unless they say
  exactly what you asked (for USDT, down to byte-identical calldata the
  wallet constructed itself). Energy/bandwidth costs are estimated live and
  shown before you confirm — including the ~1.1 TRX charge for paying a
  brand-new address. Practice twin on the Nile testnet.
- **TRON staking** — stake TRX for network resources and voting power, vote
  for a Super Representative to earn (~3–5%/yr, set by the network), claim
  rewards, unstake and withdraw. Staking for Energy is the practical win: it
  makes USDT sends cheap or free. Every stake action is decode-verified before
  signing like the rest of the TRON engine, and the 14-day unstaking wait is
  stated up front, not discovered later.
- **Swap, verified before signed** — SOL ↔ USDC on mainnet through Jupiter
  Swap V2, Solana's standard DEX aggregator, keylessly. Jupiter returns the
  route as instructions, and the wallet assembles the transaction itself:
  lookup tables read from the chain, its own blockhash, a compute limit it
  measures. It decodes Jupiter's swap instruction and refuses unless the
  amount, slippage and fee fields say exactly what you asked, then simulates
  the exact bytes and signs only if the balance changes honor the minimum
  decoded from the route. Each swap carries a 0.5% Kailah fee, paid in USDC
  to the developer's published fee account and shown on the form and the
  review screen. The gate checks the route asks for exactly that fee into
  exactly that account, and that the simulation pays it exactly 0.5%.
  check-swapgate tampers with every part of a recorded build offline;
  check-solswap runs the gate on live mainnet routes.
- **Stablecoins done honestly** — each network card shows your USDC and the
  ETH that pays fees, with per-network fee truth on the send form (Base and
  Arbitrum cost fractions of a cent; Ethereum mainnet can cost dollars when
  busy). One 0x address serves all EVM networks; the receive screen warns that
  the sender must pick the right one. Practice mode has a Base Sepolia twin
  with faucets.
- **Practice mode** — starts on Bitcoin's test network with faucet links, so you
  can learn with worthless coins before touching real money.
- **HD address rotation** — a fresh receive address per payment (BIP84 for
  BTC/LTC, BIP44 for DOGE); change returns to fresh change addresses; gap-limit
  scanning with a warm cache.
- **Transaction history** — classified in/out/self with amounts, fees,
  confirmations, counterparties, explorer links, and CSV export.
- **Send** — live address validation (with wrong-chain and MWEB detection),
  camera QR scanning (BIP21 payment URIs, amount autofill), MAX sweep, fee
  selection, mandatory review screen.
- **Speed up (RBF)** — replace a stuck Bitcoin/Litecoin transaction with a
  higher-fee version, with the BIP125 rules enforced client-side.
- **Buy** — curated links to licensed onramps (Banxa pre-fills your address)
  plus exchange-withdrawal guides (Strike, Kraken, Gemini, Cash App, Coinbase,
  Robinhood). Referral links are always labeled "Invite link" — Strike is the
  recommended first stop for anyone new to bitcoin.
- **Ledger hardware accounts (Bitcoin, Litecoin)** — add a Ledger account next
  to the seed accounts: the wallet keeps only its public key (encrypted), scans
  balances and history as usual, and every send or Speed up is signed on the
  device after it shows the recipient, amount and fee. The wallet checks each
  signature against its own digest of the reviewed transaction before
  broadcasting, verifies receive addresses on the device screen, and refuses a
  different Ledger. Bitcoin uses the Bitcoin app's PSBT protocol (app 2.1+),
  Litecoin the Litecoin app's trusted-input protocol; Chrome/Edge on a
  computer (WebHID) or Chrome on Android over USB (WebUSB). No new
  dependencies. Design: [docs/hardware-signing.md](docs/hardware-signing.md).
- **Face ID / fingerprint unlock** — WebAuthn PRF: the biometric-released
  hardware secret encrypts a copy of the seed. Password always remains the
  fallback and is required to reveal the phrase.
- **Payment alerts** — balance polling with in-app toasts and (generic,
  amount-free) system notifications while the wallet is open. There is
  deliberately no push server.
- **Networks shown** — pick which networks the dashboard shows (Settings ›
  Networks shown). A new wallet starts with Bitcoin and Base; an existing or
  restored wallet checks every network once in real mode and keeps each one
  with funds or history. Hidden networks are not scanned or polled at all (no
  provider requests, no alerts, not in the total), and coins that arrive on
  one stay hidden until you show it again — the dashboard always says how
  many are hidden. An engine whose networks are all hidden isn't even
  downloaded (a Bitcoin + Base wallet never fetches the Solana or TRON code).
  Practice mode mirrors the choice. The choice is wallet-revealing, so it
  lives in the encrypted store, not plain storage.
- **Portfolio** — total USD balance, live prices, 7-day sparklines.
- **PWA** — installable, with an offline screen. The service worker never
  caches application code: every launch runs fresh, so a stale or tampered
  cached wallet can never execute.
- **Browser extension** — the same code also ships as a Manifest V3 Chrome
  extension, where the store's signature, not a web server, decides what runs
  (see [Browser extension](#browser-extension)).

## Security model

| Layer | Design |
| --- | --- |
| Seed storage | AES-256-GCM, key from Argon2id (32 MiB, 3 passes — memory-hard, so offline guessing costs RAM, not just GPU time; legacy PBKDF2-600k vaults upgrade transparently on unlock), fresh salt+IV per save; `localStorage` holds the seed only as ciphertext. Scan caches (addresses, balances, history) are AES-256-GCM ciphertext under a key derived from the seed — readable only while unlocked, cleared on erase; snapshots are additionally re-derived from the keys before use. Only tip heights and the preferred-provider name stay plain |
| Biometrics | WebAuthn PRF (user verification required); HKDF-SHA256 → AES-256-GCM second ciphertext; never weaker than the password path |
| In memory | Mnemonic and private keys live only in React state; the seed, HD root and intermediates are wiped during derivation and private-key buffers are zeroed on lock/erase (the EVM signer additionally keeps its key as an immutable JS string for the session — a language limitation, dropped on lock); auto-lock after 15 min idle, enforced on resume |
| Network | Strict CSP: the app may only contact the pinned API hosts; no third-party scripts, fonts, or frames; camera restricted to same origin; HSTS (preload) and Cross-Origin-Opener-Policy on both origins |
| Providers | Fee rates clamped against tampered fee APIs; DOGE funding hex verified against its txid; failover treats network errors and server rejections differently |
| Erase | Removes vault, biometric vault, address map, and preferences; typed-DELETE confirmation |

Reviewed, not audited. The code has had AI-assisted adversarial reviews
(Claude agents), and each finding was confirmed by reading the code or by a
test:

- Address derivation is cross-checked against a second implementation and
  published BIP84 vectors.
- Every transaction signature is re-verified with an independent stack.
- The biometric-unlock crypto review returned no high or critical findings.
- The 2026-10-21 review recorded 35 findings, three of them fund-loss paths. Every
  critical, high and medium finding is fixed; the low tier is fixed or
  documented as accepted.

The full record is in
[SECURITY-REVIEW-2026-10-21.md](SECURITY-REVIEW-2026-10-21.md), including a
regression the fixes introduced and how it was caught. No third-party firm
has audited this code.

## Honest limitations

This is a personal, hobby-grade wallet. Keep amounts small.

- One seed = the whole wallet. The 12 words on paper are the only backup.
- Notifications fire only while the app is open (no push server by design).
- Balances come from the pinned RPCs, but activity feeds and received-coin
  alerts each trust a single API source; a compromised explorer could show a
  payment that never happened. Confirm large receipts on a second explorer.
- "Other tokens" shows at most 12 detected ERC-20s; a flood of airdrops can
  crowd a real custom token out of the list.
- The real-mode confirmation is shown once per device; after that the
  practice/real toggle is one tap (the banner, header and card colors change).
- DOGE runs on BlockCypher's free tier (~100 requests/hour) — scans are
  throttled and deliberately frugal.
- No MWEB/Monero: confidential-transaction cryptography has no trustworthy
  browser implementation today. MWEB addresses are detected and explained
  rather than mis-rejected. For MWEB/XMR, restore the same seed in Cake Wallet.
- Hardware signing is implemented from Ledger's published protocols and proven
  against a device emulator (byte-identical to the software path), but has not
  yet been run against a physical Ledger — follow the walkthrough in
  docs/hardware-signing.md §10 with small amounts first.
- Buying happens on licensed third-party sites (a wallet cannot legally take
  card payments); tap-to-pay in stores requires a card issuer — pair the wallet
  with a crypto debit card in Google Wallet for that.

## Architecture

```
src/lib/          — all money logic, UI-free, contracts in types.ts
  keys.ts         BIP39/BIP32 derivation, per-chain accounts, xpub encodings
  vault.ts        password vault (Argon2id + AES-GCM; legacy PBKDF2 upgraded on unlock)
  biometric.ts    WebAuthn PRF vault
  networks.ts     chain configs + ordered provider lists
  esplora.ts      mempool.space-style provider (BTC, tBTC, LTC)
  blockcypher.ts  DOGE provider (throttled)
  api.ts          failover client over the provider list
  scanner.ts      gap-limit account scan → AccountState
  addrcache.ts    warm-scan cache of used indices (public data; cleared on erase)
  history.ts      raw tx → classified TxSummary
  txbuild.ts      coin selection, signing, RBF bump (buildTx/buildTxV2/buildBump);
                  prepareTxV2/prepareBump = the same selection, unsigned
  hwaccount.ts    watch-only hardware accounts from a device xpub; encrypted records
  hwsign.ts       funding-tx binding, device request, signature verify + assembly
  ledger/         HID framing, WebHID/WebUSB transports, Bitcoin app (PSBT) and
                  Litecoin legacy clients, sessions/import/verify/signer
  qrparse.ts      BIP21/address QR parsing with wrong-chain detection
  onramp.ts       buy-provider links
  prices.ts       spot prices + 7-day history
  csvexport.ts    formula-injection-safe CSV
  evm.ts          the whole EVM engine (keys, RPC failover, ERC-20 send with
                  pinned chainId, Blockscout history) — deliberately separate
                  from the UTXO stack
  tron.ts         the TRON engine (BIP44/195 keys, protobuf decode-verify
                  before signing, TronGrid keyless, energy fee estimation)
  sol.ts          the Solana engine (SLIP-0010 ed25519, micro-sol-signer,
                  JSON-RPC, SPL USDC with ATA handling, devnet airdrop) —
                  third self-contained stack
  solswap.ts      Jupiter SOL↔USDC swaps with the simulation gate: decode,
                  simulate, verify deltas against the quote, only then sign
  units.ts        display helpers for amounts, shared by EVM/Solana/TRON
src/Shell.tsx     — first screen: welcome, onboarding, lock; lock/erase/auto-lock
src/App.tsx       — the unlocked wallet's state machine (its own chunk)
src/engines/      — EVM, Solana and TRON as chunks: library + card, modals lazy
src/components/   — React UI
src/platform.ts   — build-time web/extension flag (the few places that differ)
src/extension/    — the extension's background service worker
extension/        — extension build: manifest + CSP derivation, Vite plugin, icons
scripts/          — executable verification suites (see below)
public/           — PWA manifest, icons, service worker, security headers
```

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # strict tsc
npm run build      # production build to dist/
npm run build:extension  # Manifest V3 extension to dist-extension/
```

Verification suites (run with `npx tsx scripts/<name>.mjs`):

| Script | Proves |
| --- | --- |
| check-keys.mjs | derivation matches published BIP84 vectors, all chains |
| check-account.mjs | account xpubs, gap scan, cache behavior (live testnet4) |
| check-txbuild.mjs / check-txv2.mjs | build/sign/decode correctness, fees, dust, RBF rules |
| check-qrparse.mjs | QR/BIP21 parsing incl. wrong-chain and MWEB cases |
| check-evm.mjs | ETH derivation vs published vector + independent stack, ERC-20 calldata, sign/recover round-trip, live Base RPC/Blockscout, custom-token detection with hostile-name sanitization proven against real scam airdrops |
| check-sol.mjs | SLIP-0010 vs official spec vectors, ed25519 sign/verify round-trip, and a REAL end-to-end airdrop + send on Solana devnet |
| check-solstake.mjs | hand-built stake-program instruction bytes, a full simulated create+delegate on mainnet (the runtime itself verifies the seed-derived address), and a REAL devnet stake→unstake→withdraw lifecycle when the faucet allows |
| check-tron.mjs | Stake 2.0 contract decoding (live freeze bytes for both resources, hand-built vectors for vote/unfreeze/claim/withdraw, build-time refusal of an over-limit vote), independent address derivation (raw curve + keccak + hand-built base58check), protobuf decoder vs live node bytes on two networks, our-calldata verification for USDT, sign/recover round-trip, and a live negative broadcast the node rejects with SIGERROR — proving the signature wire format |
| check-hw.mjs | hardware signing against scripts/ledger-emulator.mjs (device side of both Ledger protocols): framing, merkle/client commands, wallet policy, xpub import (LTC assembled from legacy replies), sends and RBF bumps byte-identical to the software path on BTC/testnet/LTC, a btc-signer-parsed PSBTv2 mock, device display = review screen, and every refusal (tampered digest, wrong key/index, bad DER, lying provider, other Ledger, rejected, locked, wrong app) |
| check-solswap.mjs | independent ATA re-derivation, a REAL devnet USDC send, live Jupiter Swap V2 builds in both directions, the full prepareSwap gate on mainnet (simulation only, including a first-time USDC holder), and adversarial tests on live routes: a quote promising more than its route, and a route whose slippage was raised, are both refused |
| check-netprefs.mjs | networks-shown choice: encrypted and seed-bound, cleared by erase, practice mirroring, the funds/history classifier that never hides a funded or unreadable network, which engine chunks load for a choice (and that the static ids/labels match the engines), and source checks that every scan/poll loop filters hidden networks and every engine load is gated |
| check-swapgate.mjs | the Jupiter Swap V2 gate, offline, on two recorded /build answers: honest builds compile to exactly the instructions Jupiter described and sign byte-exactly; any change to the decoded amount, quoted output, slippage, platform fee, positive-slippage share, variant or authority is refused, as are "other"/tip instructions, foreign signers, a second Jupiter instruction, Approve, a CloseAccount paying someone else, unlisted programs, stake accounts, lookup tables that disagree with the chain, and a simulation short of the decoded floor |
| check-failover.mjs | rate limit vs outage in the provider failover: a provider that pushes back (a 429, or the bare network error a browser shows for a CORS-less 429) is paused and retried, a healthy backup covers the pause, timeouts get one retry, a dead provider fails over at once with a 60 s cooldown, BlockCypher's hourly limit is never retried, and a request never waits or retries past its limits |
| check-providers.mjs | live API shapes + failover (spends BlockCypher budget — run sparingly) |

## Deployment

```bash
npm run build
npx netlify-cli deploy --prod --dir=dist --site <site-id>
```

The nginx mirror is updated with `deploy/vps-redeploy.sh`, which also
regenerates the mirror's security headers and gzip settings from
`public/_headers`.

Security headers live in `public/_headers` **and** `.netlify/netlify.toml` —
keep both in sync, and update the CSP `connect-src` whenever a provider host is
added in `networks.ts` or `prices.ts`.

## Browser extension

The web app's one structural gap is its hosting: whoever controls the Netlify
account, DNS or the mirror can ship new code to every visitor, and other
browser extensions can read the page. The extension build closes that gap by
packaging the same source:

- **Store-signed code.** All code is in the package, so the store's signature
  decides what runs.
- **Isolated pages.** Other extensions cannot inject into its pages.
- **Durable storage.** Its storage survives "Clear browsing data", and
  `unlimitedStorage` exempts it from eviction.

```bash
npm run build:extension   # → dist-extension/
# chrome://extensions → Developer mode → Load unpacked → pick dist-extension/
```

The wallet opens as a full tab from the toolbar button, not a popup. The page
CSP is the web CSP, read from `public/_headers` at build time, with Trusted
Types kept. The manifest asks only for `notifications` and `unlimitedStorage`,
with no host permissions. The build fails if the package breaks any of these
rules. The web build is unaffected: its output is byte-identical with or
without the extension code.

[docs/extension.md](docs/extension.md) covers what differs from the web app
and why, the verification record, the store-listing checklist, and Firefox
notes.

## Restoring elsewhere

The seed is standard. Paths: BTC `m/84'/0'/0'`, LTC `m/84'/2'/0'` (both native
segwit), DOGE `m/44'/3'/0'`, testnet `m/84'/1'/0'`. Any BIP39/BIP84-capable
wallet (Electrum, Sparrow, Cake Wallet, …) can restore it.
