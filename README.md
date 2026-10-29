# Kailah Wallet

**v2.7.8** — a self-custody wallet for Bitcoin, Dogecoin, Litecoin, USDC + ETH
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
  support, and a practice twin on devnet; Get coins links to Solana's and
  Circle's faucets for free test SOL and USDC.
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
  exactly that account, and that the simulation pays it exactly 0.5%. When a
  route runs through a third token, the wallet closes the token account
  Jupiter opens for it in the same transaction, so its rent comes back.
  If the test run fails inside one exchange on the route, the wallet names
  that exchange and asks Jupiter once for a fresh route around it, which
  passes every check again before anything is signed. A quote more than 3%
  under the wallet's own prices needs a confirmation, on the form and again
  on the review screen for the route actually prepared.
  check-swapgate tampers with every part of a recorded build offline;
  check-solswap runs the gate on live mainnet routes.
- **Stablecoins done honestly** — each network card shows your USDC and the
  ETH that pays fees, with per-network fee truth on the send form (Base and
  Arbitrum cost fractions of a cent; Ethereum mainnet can cost dollars when
  busy). One 0x address serves all EVM networks; the receive screen warns that
  the sender must pick the right one. Practice mode has a Base Sepolia twin
  with faucets.
- **Practice mode** — starts on Bitcoin's test network with faucet links, so you
  can learn with worthless coins before touching real money. Practice
  networks sign with their own keys (BIP44's testnet coin type, as Bitcoin's
  testnet does), so nothing signed in practice mode can ever spend real
  coins, whatever a test-network service returns.
- **HD address rotation** — a fresh receive address per payment (BIP84 for
  BTC/LTC, BIP44 for DOGE); change returns to fresh change addresses; gap-limit
  scanning with a warm cache.
- **Transaction history** — classified in/out/self with amounts, fees,
  confirmations, counterparties, explorer links, and CSV export.
- **Send** — live address validation (with wrong-chain and MWEB detection),
  camera QR scanning (BIP21 payment URIs, amount autofill), MAX sweep, fee
  selection, mandatory review screen.
- **Lookalike-address warning** — on every network's send form: an address
  that starts and ends like one you've paid (or one of your own) but isn't
  it stops the send until you confirm you've checked it. That's the
  "address poisoning" scam, where a lookalike sends you dust so it shows up in
  your history. Only sends you signed make an address trusted, so the
  attacker's dust, a TRON zero-value USDT "send" or a fake-token "send" can't.
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
  Networks shown). A new wallet shows every network; an existing or restored
  wallet checks every network once in real mode and keeps Bitcoin, Base and
  each one with funds or history. Hidden networks are not scanned or polled at all (no
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
- Dogecoin reads from two free services, BlockCypher (~100 requests/hour,
  shared with Litecoin's last backup) and BitPay's Bitcore; scans are
  throttled and deliberately frugal. A Dogecoin send still needs each coin's
  funding transaction from BlockCypher, which the wallet keeps for the
  session once it hashes to its txid.
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
  blockcypher.ts  DOGE provider + LTC's last backup (throttled)
  bitcore.ts      BitPay's Bitcore: DOGE's second provider, LTC's first backup
  rawtxcache.ts   legacy funding txs, kept once they hash to their txid
  api.ts          failover client over the provider list
  providerpref.ts last-good provider per chain (no provider imports)
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
| check-txbuild.mjs / check-txv2.mjs | build/sign/decode correctness, fees, dust, RBF rules; Speed up adds only confirmed coins no pending payment spends, selects coins against the replacement floor (not just the rate), compares fee rates with the original's own, and keeps the node's required fee from its refusal |
| check-qrparse.mjs | QR/BIP21 parsing incl. wrong-chain and MWEB cases; Solana Pay references, memos and exact amounts (more decimal places than the asset has, or a malformed amount, refuses the request); EIP-681 requests keep their token and amount (exponents allowed, whole units only) |
| check-evm.mjs | ETH derivation vs published vector + independent stack, ERC-20 calldata, sign/recover round-trip, live Base RPC/Blockscout, custom-token detection with hostile-name sanitization proven against real scam airdrops |
| check-sol.mjs | SLIP-0010 vs official spec vectors, ed25519 sign/verify round-trip, and a REAL end-to-end airdrop + send on Solana devnet |
| check-solstake.mjs | hand-built stake-program instruction bytes, a full simulated create+delegate on mainnet (the runtime itself verifies the seed-derived address), and a REAL devnet stake→unstake→withdraw lifecycle when the faucet allows |
| check-tron.mjs | Stake 2.0 contract decoding (live freeze bytes for both resources, hand-built vectors for vote/unfreeze/claim/withdraw, build-time refusal of an over-limit vote), independent address derivation (raw curve + keccak + hand-built base58check), protobuf decoder vs live node bytes on two networks, our-calldata verification for USDT, sign/recover round-trip, and a live negative broadcast the node rejects with SIGERROR — proving the signature wire format |
| check-hw.mjs | hardware signing against scripts/ledger-emulator.mjs (device side of both Ledger protocols): framing, merkle/client commands, wallet policy, xpub import (LTC assembled from legacy replies), sends and RBF bumps byte-identical to the software path on BTC/testnet/LTC, a btc-signer-parsed PSBTv2 mock, device display = review screen, and every refusal (tampered digest, wrong key/index, bad DER, lying provider, other Ledger, rejected, locked, wrong app); a Ledger that re-enumerates (an app opened or closed, a replug) is reopened on the next tap, even when the browser never reports the old device gone; a stray frame from another exchange is skipped; a Ledger on this wallet's own recovery phrase isn't added twice; Speed up opens the device before its network fetches; a decline says nothing was signed, and an error from outside the device isn't a "Ledger problem" |
| check-solswap.mjs | independent ATA re-derivation, a REAL devnet USDC send, live Jupiter Swap V2 builds in both directions, the full prepareSwap gate on mainnet (simulation only, including a first-time USDC holder), a route through a third token, the fee wallet swapping for itself, a route made to fail inside one exchange and re-routed around it by Jupiter, and adversarial tests on live routes: a quote promising more than its route, a route whose slippage was raised, and one whose fee was redirected are all refused; a live route capped at 32 accounts (the size retry) passes the whole gate |
| check-netprefs.mjs | networks-shown choice: encrypted and seed-bound, cleared by erase, practice mirroring, the funds/history classifier that never hides a funded or unreadable network, which engine chunks load for a choice (and that the static ids/labels match the engines), and source checks that every scan/poll loop filters hidden networks and every engine load is gated; a failed history, token or stake lookup is "unknown" (EVM history that couldn't be read is an error, not an empty list), a used UTXO address and an activated TRON account are history, staked TRX is funds, and the portfolio counts staked SOL/TRX and a gas coin without its token's price; a modal whose network was hidden closes for good; the Buy modal's address is fixed when it opens and a Ledger account is sent to verify it |
| check-trondecode.mjs | the TRON decoder on hand-built protobuf bytes, offline: the honest transfer decodes exactly; expiration is bounded to ten minutes either side of now; the Stake 2.0 resource enum is strict; unknown fields, a Permission_id and a data/memo field are refused |
| check-swapgate.mjs | the Jupiter Swap V2 gate, offline, on two recorded /build answers: honest builds compile to exactly the instructions Jupiter described and sign byte-exactly; any change to the decoded amount, quoted output, slippage, platform fee, positive-slippage share, variant or authority is refused, as are "other"/tip instructions, foreign signers, a second Jupiter instruction, Approve, a CloseAccount paying someone else, unlisted programs, stake accounts, lookup tables that disagree with the chain, and a simulation short of the decoded floor; the fee is exactly 0.5% (none for the fee wallet itself), and a token account opened for an intermediate token is closed in the same transaction; a route that fails its test run in one exchange is named from the innermost log line and re-routed once, through the whole gate again (a dishonest fresh route is still refused), while failures of the transaction's own plumbing are not re-routed; a simulation that runs out of SOL or tokens says so in plain words, and the swap form checks the SOL it needs, takes only the quote for what it shows, and names the swap by its own direction; the gate reads balances at the simulation's commitment and measures a mismatch once more (a shared fee account, an unrelated transfer); a first-time holder's USDC account deposit is on the review; the form and review show the rate and route from the quote itself, the form's quote refreshes every 20 s while it is open and visible, and a Jupiter swap reads as "Swapped" in Solana activity (never as "Received" the coin it bought); Solana activity reads version-1 transactions (a recorded one) and skips only what it can't read safely; a route too large for one transaction is caught before any simulation, rebuilt once with fewer accounts through the whole gate, and otherwise refused in plain words |
| check-lookalike.mjs | the send form's lookalike-address check, offline: the real poisoning seen on a Solana wallet is caught; addresses you've paid, your own, new ones and people who paid you don't warn; history an attacker can write (incoming dust, TRON zero-value USDT, EVM custom-token rows) never makes an address trusted; 0x/EVM case, bech32 prefix and case, TRON's T, and the 3-and-3 threshold; case is folded only for real bech32 (bc/tb/ltc) addresses, so a case-flipped twin of a Solana, TRON or legacy Litecoin address warns |
| check-scanner.mjs | the scan frontier against a provider that hides or invents usage, snapshot validation and the encrypted caches; a failed worker pool stops taking items; a scan from before a lock or erase writes nothing afterwards (not even into the next wallet's store); snapshots carry their own flag; the dashboard keeps the last complete balance over a partial scan, queues rescans as asked, and a send says when coins couldn't load; confirmations count from a tip no lower than the payment's block and advance on quick polls; a scan for a Ledger account removed meanwhile keeps no address map |
| check-failover.mjs | rate limit vs outage in the provider failover: a provider that pushes back (a 429, or the bare network error a browser shows for a CORS-less 429) is paused and retried, a healthy backup covers the pause, timeouts get one retry, a dead provider fails over at once with a 60 s cooldown, BlockCypher's hourly limit is never retried, and a request never waits or retries past its limits; Bitcore's visible 429 is ridden out without spending BlockCypher's budget, the start-up probe keeps the configured order, a chain on a backup reports it (its polls slow to 10 minutes), nothing is remembered after the wallet locked or was erased, and BlockCypher serves up to 500 inputs/outputs per transaction (a bigger one is marked partial) and gives a broadcast 20 s; practice Bitcoin has a backup that answers address lookups (blockstream.info, used only while mempool.space fails, its hourly limit never retried), background polls back off from 1 to 10 minutes after a failed scan, and a test network's failed check is a calm note, not an alert; mainnet Bitcoin's blockstream.info is a backup too, asked only while all three mempool instances fail |
| check-pending.mjs | the double-pay guard, offline: every broadcast is recorded before it goes out; a send is refused while an earlier attempt may still land (EVM per nonce, Solana until its blockhash expires by block height, TRON until its expiration by this device's clock, UTXO for 30 minutes); a refusal drops the record, a lost answer keeps it, and an attempt whose broadcast failed but later landed is reported before any new send; another window's records count; a Speed up waits for a payment the network doesn't show yet; a send still waiting can be replaced at its nonce (outbidding every attempt by 10 %); a Solana attempt stops holding once the chain passes its blockhash, at any age, and is called expired only then; SOL below the rent minimum to a new address is refused; a UTXO attempt holds back only the account that sent it (seed or Ledger); a Solana attempt that landed but failed is reported as failed; a stake deactivated in its activation epoch is withdrawable, and Withdraw re-reads the account; with Solana's two mainnet servers, a read fails over to the second, a hold ends on the lower of their block heights, "landed" or "never seen" counts only when both agree, and a refusal after the first went quiet keeps the record |
| check-amounts.mjs | fees and balances, offline: every EVM native send is estimated (Arbitrum's plain transfer needs more than 21 000 gas), Base's L1 data fee is reserved in the fee shown and in MAX, sends to 0x0 are refused; TRON's USDT balance is read from the token contract, USDT fees use the chain's own energy price minus the account's spare energy, the fee cap is sized from the estimate, and TRX fees for new and existing recipients; typed amounts: a decimal comma works on every form, a number that reads as a thousands grouping on this device ("1,234" in the US) is refused, and every amount the wallet fills in reads back exactly in every locale; TRON: the zero address and the USDT contract are refused, other contracts flagged, zero-value TRC-20 rows dropped, a rate-limited history half keeps its rows, a 429 reads plainly, and /v1 requests are paced a second apart; EVM errors in plain words, reverted sends marked failed, tiny fees to two significant digits, a hung RPC passed over, 7702 accounts treated as wallets, Arbitrum's gas room; TRON failed USDT sends listed, MAX for TRX and USDT, reviews rebuilt before they expire; an RPC's fee per gas is held to 1,000 gwei (100 priority), and UTXO fee rates from any service to 1–1,000 sat/vB |
| check-vault.mjs | the vault: Argon2id round trip, the v1 → v2 upgrade, wrong passwords, tampered parameters, a record that can't be read reported as damaged (not "Wrong password"), every BIP39 phrase length (12-24 words), a failed biometric setup giving its passkey back, an erase winning over an unlock in flight, keys zeroed whenever the wallet unmounts, and the password policy; Erase, run as Shell.tsx runs it, leaves none of the storage keys the code names |
| check-sw.mjs | the service worker, offline, in a sandbox: install caches exactly the offline screen and its two files; offline, a navigation gets that screen and its stylesheet and icon come from the cache; the app's scripts and styles, API calls and other origins pass straight to the network, and nothing is written to the cache after install |
| check-providers.mjs | live API shapes + failover (spends BlockCypher budget — run sparingly; `bitcore` runs only Bitcore's section, with no BlockCypher requests) |
| check-headers.mjs | the delivery headers, offline: both copies of the seven security headers agree; the CSP's connect-src lists exactly the hosts the code fetches from (read from the modules' own configs), nothing stale, and no other module calls fetch; PRIVACY.md names each host; the mirror's nginx rewrite, run on a sample site file, puts every header in every location, gives HTML "Cache-Control: no-cache" while keeping a location's own, changes nothing on a second run and stops on input it can't handle; verify:live fails a page a browser may reuse |
| check-bitcore.mjs | the Bitcore provider, offline, on answers recorded 2026-10-27: the provider lists and that every provider host is in both CSP copies and PRIVACY.md; transactions parse (outputs by index, BIP125 only on Litecoin, malformed answers refused); balances from unspent coins (a pending send isn't counted twice); Dogecoin's funding txs verified against their txid and fetched once per session; a rejected broadcast is final; Dogecoin rides out BlockCypher's limit on Bitcore and Litecoin reaches Bitcore before BlockCypher; requests 330 ms apart (bitcore-node allows 200 a minute); one transaction Bitcore can't describe is left out of the history, not the address's whole history |

## Deployment

```bash
npm run build
npx netlify-cli deploy --prod --dir=dist --site <site-id>
```

The nginx mirror is updated with `deploy/vps-redeploy.sh`, which also
regenerates the mirror's security headers and gzip settings from
`public/_headers`, and tells browsers to re-check every page
(`deploy/nginx-site.awk`), so a page kept from before a redeploy never asks
for chunks that are gone.

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
