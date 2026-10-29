# Kailah Wallet — deep security review, 2026-10-21

Six parallel adversarial reviews (keys/vault, UTXO, EVM, Solana, TRON, UI/infra)
over the full source at v2.3.0, plus an npm dependency audit and a live probe of
the deployed site. Every CRITICAL/HIGH finding below was re-verified by direct
code reading before inclusion; findings resting on unverified external behavior
are marked UNCONFIRMED. Threat model: the wallet's own — malicious/compromised
API providers, hostile QR/pasted input, hostile airdrops, tampered swap/raw-tx
responses. Accepted risks (web delivery, device malware, weak passwords) are out
of scope.

**How it was done.** The reviews were AI-assisted: Claude agents read the
source adversarially, and each finding was then confirmed by reading the code
and, where possible, by a test. This is not a third-party audit.

**Verdict.** The ordinary send paths are genuinely strong — most of the claimed
invariants survived adversarial reading (see "What held" at the end). The
failures cluster in the *secondary* flows (RBF bump, swap gate, QR parsing,
retry-after-failure), where the wallet's own promises ("never signs blind",
"recipient and amount stay the same", "secrets never stored") are not met.
Findings 1–3 are fund-loss paths inside the stated threat model and should be
fixed before the wallet is used beyond small personal amounts.

**Current state (2026-10-22).** Every CRITICAL, HIGH and MEDIUM finding is
fixed and deployed; the LOW tier is fixed or documented as accepted. Work
after the review (stronger vault, encrypted caches, Trusted Types, a browser
extension, Ledger signing, account lockdown) and **one regression this review
introduced and later fixed** are recorded under "Later work, 2026-10-22" near
the end, with the risks that remain open.

---

## CRITICAL

### 1. RBF "Speed up" rebuilds the transaction from unverified provider JSON; the review screen shows only fees
`src/lib/txbuild.ts:427-433,525` takes the recipient set (addresses **and
values**) from `original.outputs`, which `toRawTxInfo` (`src/lib/esplora.ts:350-372`)
fills verbatim from provider JSON. Nothing fetches the original tx's raw bytes
and checks them against the txid. The bump confirm screen
(`src/components/BumpModal.tsx:422-444`) displays only Old fee / New fee /
Extra cost while asserting in prose "The recipient and amount stay the same."

- **Attack A (redirect):** a malicious esplora provider rewrites the pending
  tx's `vout` to a single attacker output worth nearly the whole balance. The
  bump logic pulls in extra confirmed UTXOs largest-first to cover it
  (`txbuild.ts:447-468`), the user confirms a fee-only screen, and a valid
  replacement paying the attacker confirms on-chain. Loss: up to the entire
  spendable balance. LTC is worst (single provider: litecoinspace.org).
- **Attack B (double-pay):** the provider reports different (real) wallet UTXOs
  as the pending tx's inputs; the "replacement" then doesn't conflict with the
  original, both confirm, the recipient is paid twice.

**Fix:** before preparing a bump, fetch the raw hex of the original tx, parse
it, and require the library-computed txid (witness-stripped — the local
`txidOfRawTx` is only correct for witness-free txs) to equal `original.txid`;
take inputs/outputs from those verified bytes. Show recipient and amount on the
bump review screen. Status: **confirmed**.

### 2. Solana swap gate never inspects instructions; a hostile Jupiter response can smuggle authority changes through one signature
The structural check (`src/lib/solswap.ts:207-219`) is exactly: one signature,
`requiredSignatures === 1`, `keys[0] === owner`. `decoded.msg.data.instructions`
is never examined — no program whitelist, no account-meta scan. The only
backstop is the simulation (`solswap.ts:234-253`), which diffs the **balances of
two accounts** (owner, USDC ATA).

A single Solana signature authorizes *every* instruction in the message. A
malicious `lite-api.jup.ag` (or its CDN) can return the honest route **plus**:
- `Token.Approve(ata, delegate=attacker, amount=MAX)` — no balance change at
  sim time → gate passes → ATA drained later;
- `Token.SetAuthority` on the ATA, or `System.Assign` on the main account;
- `Stake.Withdraw/Authorize` against the stake accounts, whose addresses are
  publicly derivable (fixed seeds `kailah:stake:0..7`, `solstake.ts:42-54`) and
  are not in the simulated-accounts list.

Related gaps that compound it: the quote's slippage floor is only ever proven
*in simulation* — nothing verifies an on-chain `otherAmountThreshold` exists in
the instruction data (sim→land TOCTOU through an attacker-priced pool); the
`prioritizationFeeLamports` figure comes from the Jupiter response unverified
and widens the allowed SOL spend (`solswap.ts:204,257`); and the before-balances
and simulation all come from the single mainnet RPC, so a compromised RPC plus
malicious bytes voids the gate entirely.

**Fix:** enumerate decoded instructions, resolve or reject address-lookup-table
metas, whitelist programs (ComputeBudget, System transfer for wSOL temp, Token
transfer/sync/closeToSelf, ATA create, Jupiter program), and refuse any
instruction where an account we control appears as writable outside the
whitelist; compute the priority fee from the decoded ComputeBudget instructions
instead of the response field; consider a second RPC for simulation. Status:
**confirmed** (the tamper test in check-solswap.mjs proves the delta check only,
not instruction-smuggling resistance).

---

## HIGH

### 3. Standard EIP-681 token-payment QRs parse the TOKEN CONTRACT as the recipient → USDC burned
`src/lib/evm.ts:682-686`: the regex `^ethereum:(?:pay-)?([^@?/]+)` stops at `/`,
so for the standard ERC-20 request form
`ethereum:<TOKEN_CONTRACT>@1/transfer?address=<RECIPIENT>&uint256=N`
(what MetaMask/Trust-style request QRs emit) the captured "address" is the token
contract. It validates, fills the To field, `transfer(USDC_contract, amount)`
builds and broadcasts fine, and the USDC is permanently stuck at the contract.
Found independently by two reviewers. The `@chainId` is also parsed and
discarded. The test suite covers only the bare `ethereum:0xADDR?value=` form.
**Fix:** parse the `/transfer?address=` form properly (use the `address` param)
or reject function-form URIs with an explanatory error; compare `@chainId` to
the open modal's chain. Status: **confirmed**.

### 4. Ambiguous broadcast failure + user retry = double payment (EVM and Solana)
- EVM: the failed screen (`src/components/EvmSendModal.tsx:418-440`) returns to
  the still-filled form; retry re-prepares with a **fresh pending nonce**
  (`evm.ts:561`), so if the first attempt actually landed (timeout after
  mempool acceptance, or an RPC that accepts then errors), both transfers
  confirm. No local hash (`keccak(signedBytes)`) check before re-enabling the
  form.
- Solana: same shape, worse copy — two sends with different blockhashes are
  both valid until the first expires (~60-90s), and the failure text
  ("Nothing further was sent — go back to rebuild with a fresh blockhash")
  invites an immediate retry. The first signature is known before broadcast
  (sig = txid); nothing polls `getSignatureStatuses` before allowing retry.

**Fix:** on ambiguous failure, check whether the first attempt landed (EVM:
`eth_getTransactionByHash` with the locally computed hash; Solana: poll the
known signature until blockhash expiry) before re-enabling the form, and say
"your first attempt may have gone through" meanwhile. Status: **confirmed**.

### 5. Recovery phrase copy button puts the seed in the OS clipboard, never cleared
`src/components/CreateFlow.tsx:87` offers "Copy recovery phrase" (framed as
"convenient but less safe than paper"). Windows clipboard history (Win+V,
cloud-synced), Apple Universal Clipboard, and Android keyboard history can all
persist/broadcast it; any app may read it later; nothing expires it. Directly
contradicts "secrets exist only in memory, never logged/stored". The
SettingsModal reveal flow correctly has no copy button — CreateFlow is the
inconsistency. **Fix:** remove the button (preferred) or clear the clipboard
after ~60s with a sync warning. Status: **confirmed**.

### 6. Unvalidated state snapshot can put a forged receive address on the Receive screen/QR
`src/lib/statecache.ts:97-130` returns `nextReceive`/`addresses` straight from
`JSON.parse(localStorage['kailah.statecache.v1'])` — never re-derived against
the account keys (the addrcache *is* hardened against exactly this; the
statecache is not). Dashboard (`Dashboard.tsx:173-174`) and ReceiveModal display
and QR-encode it on unlock before a full scan; `quickUnchanged` compares only
balances/frontier so the forged object survives quick polls (indefinitely on
DOGE's budget path). Prerequisite: localStorage write access *without* the
password (extension, devtools access while locked, residual XSS) — a real but
narrower attacker than a malicious provider. Snapshots are also keyed by
chainId, not xpub, so they're never bound to the current wallet. **Fix:** store
indices, re-derive addresses on hydration (or validate against
`account.address(branch, index)`), key snapshots by xpub. Status: **confirmed**.

### 7. UTXO change frontier can be pushed beyond any recoverable gap by one lying scan
`src/lib/scanner.ts:99-101,341`: `nextChangeIndex` comes purely from the current
scan's provider answers. A provider claiming `tx_count: 1` for change indices
4..60 makes the next send pay change to index 61 — above a ~57-address gap of
genuinely unused addresses. A seed restore in Electrum/Sparrow/Cake (gap 20), or
in this wallet after erase, finds nothing: the change is invisible everywhere.
Claiming indices up to 1000 pushes past MAX_INDEX so even this wallet's cache
never rescans it. Same mechanism poisons `nextReceive`. Also (MEDIUM, same
area): `lowestUnused` consults only the current scan, not the cache union, so a
provider *hiding* usage causes silent address reuse (`scanner.ts:318-341` —
the knownUsed protection fires only on fetch error, not on a lying 200).
**Fix:** cap how far one scan may advance the frontier past the cached state;
warn when the change index exceeds (highest cached used index + gap limit);
union cache into `lowestUnused`. Status: **confirmed by review** (code quoted
and consistent; not independently re-read line-by-line).

### 8. TRON decode-verify gate is allow-by-omission: `call_value` (and friends) ride through unseen
The decoder (`src/lib/tron.ts:316-375`) models only the fields the wallet
expects; the USDT verify (`tron.ts:537-547`) checks type/owner/contract/
calldata/feeLimit. `TriggerSmartContract` field 3 (`call_value`), 5
(`call_token_value`) and 6 (`token_id`) are never decoded, so a malicious node
can attach TRX/TRC10 value to a "USDT send" and the wallet signs it. Impact is
probably bounded — USDT's `transfer()` is non-payable, so a faithful TVM
reverts and the loss is the burned fee — but the wallet's safety must not
depend on the target contract reverting (UNCONFIRMED: TVM refund semantics).
Related, UNCONFIRMED but structural: `readFields` accepts duplicate field
numbers and inner lookups use first-wins (`tron.ts:339`) while protobuf
convention is last-wins — if TRON nodes verify signatures over bytes as
received and execute last-wins, a duplicated `to`/`amount` pair defeats every
check (testable on Nile by hand-crafting a duplicate-field tx). TRX sends and
stake ops also never pin `feeLimit`/`expiration`. **Fix:** reject unknown AND
duplicate fields in `readFields` (deny-by-default), decode and require
`call_value`/`call_token_value`/`token_id` to be 0/absent, pin feeLimit for all
contract types — or better, rebuild the expected `raw_data` locally and
byte-compare. Status: **confirmed** (decoder gap verified; on-chain
exploitability of each path unconfirmed).

---

## MEDIUM

9. **Production is a stale build.** The live site's CSP still whitelists
   `https://solana.lava.build`, which the repo removed everywhere; the deployed
   bundle differs from a current build. Whatever motivated dropping that RPC is
   not live. Rebuild + deploy + re-check
   (`curl -sSI https://kailah-wallet.netlify.app | grep -i connect-src`).
   Status: **confirmed live**.
10. **Bump fee floor is provider-controlled and unclamped.**
    `txbuild.ts:477-485`: `original.fee` (provider JSON), `conflictExtraFees`
    (provider), and `absoluteFeeFloor` parsed out of broadcast **rejection
    text** (`BumpModal.tsx:61-70,514-523`) all feed the floor with no
    MAX_FEE_RATE clamp, and the review's "Extra cost" is computed against the
    provider-claimed old fee — a lied-up old fee launders a 0.2 BTC burn as a
    tiny delta. BumpModal lacks SendModal's "Unusually large fee" warning.
    Status: **confirmed**.
11. **EVM address checksum validation is off.** `evm.ts:534-536` uses
    `isAddress(addr, { strict: false })`; a mixed-case address with a wrong
    EIP-55 checksum (one mistyped character) is accepted and silently
    re-checksummed. Fix: strict when input is mixed-case. Status: **confirmed**.
12. **No EVM gas-price clamp.** `evm.ts:563-565` uses RPC-supplied fees
    unbounded (priority fee verbatim); a malicious RPC can make a MAX send give
    ~98% of the balance to the block producer. The fee IS displayed from the
    same values (sound), but the README's "fee rates clamped against tampered
    fee APIs" is true only of the UTXO stack. The ERC-20 gas *limit* is also
    RPC-controlled. Add a per-chain max-gwei ceiling and a fee>¼-of-send
    warning like UTXO's. Status: **confirmed**.
13. **USDC (Solana) destination guard only rejects token accounts.**
    `sol.ts:500-504`: stake accounts, PDAs, program accounts pass; the ATA is
    created for an owner nobody has a key for → USDC burned. A lying RPC
    (`value: null`) also disables the guard. Allow only system-owned or
    nonexistent destinations. Status: **confirmed by review**.
14. **Solana Pay `spl-token` ignored.** `sol.ts:598-626` reads only `amount`; a
    100-USDC request QR autofills "100" into the SOL tab (~200x overpayment if
    confirmed). Found independently by two reviewers. Parse `spl-token`: reject
    non-USDC mints, switch asset for the USDC mint. Status: **confirmed by
    review**.
15. **Auto-lock can be cancelled by the first tap after resume.**
    `App.tsx:799-816`: `bump()` resets the idle clock unconditionally and
    nothing checks elapsed time on `visibilitychange`; a backgrounded PWA's
    interval doesn't run, so a phone reopened hours later can stay unlocked if
    touched within the first ~10s. Fix: in `bump`, lock first when overdue;
    also check on visibilitychange. Status: **confirmed by review**
    (platform timer ordering unconfirmed; logic gap real).
16. **keys.ts never zeroes the BIP39 seed or master/intermediate HD nodes.**
    `keys.ts:95-97`: the 64-byte seed and the root/path intermediates are left
    for GC (the other three engines all `seed.fill(0)`). Same class:
    `sol.ts:101-115` SLIP-0010 intermediates, `tron.ts:123-126` node not wiped.
    Violates the zeroing claim; fix by filling buffers after use and wiping
    nodes step-by-step. Status: **confirmed by review**.

## LOW / INFORMATIONAL

17. Provider broadcast error bodies are thrown unbounded into the UI and
    pattern-parsed (`esplora.ts:341`) — slice and prefix like `getText` does.
18. A scam token named exactly `USDC` passes the sanitizer charset; the only
    tell is the "(token)" marker / separate section. Consider suffixing
    ("USDC · unverified"). A hostile Blockscout can also fabricate
    pinned-looking history rows (balance stays honest; feed is display-only).
19. Token-transfer activity rows and received-toasts trust single sources;
    the EVM side has no analogue of DOGE's hex-vs-txid cross-check (fake "Sent"
    hash / fabricated "Received" rows are display-only deception).
20. Stake-slot dust griefing: ~0.008 SOL sent to the 8 publicly-derivable
    stake addresses bricks the staking UI ("all slots in use", bogus
    withdrawable rows). Treat non-stake-program accounts as free slots.
21. BTC dust limit is per-chain (294) not per-script: 294–545 sats to a legacy
    address builds an unrelayable tx (fail-closed DoS).
22. MAX sweep doesn't consult the *fresh* scan's `incomplete.utxos` flag —
    a mid-scan fetch failure silently sweeps a short set (underpayment, funds
    remain).
23. TRON vote dropdown labels SRs by their self-published hostname
    (vote-steering; React-escaped, no XSS).
24. viem CCIP-read on hostile detected-token contracts could beacon the user's
    address in dev (prod blocked by CSP); set `ccipRead: false` in
    `getEvmClient`.
25. `unlockVault` honors a tampered `iter` up to minutes of hang (DoS only —
    confidentiality fails closed; clamp to a sane range).
26. Locked-device privacy: xpub + full address/balance/history caches are
    plaintext while locked; an xpub copy survives erase and derives all future
    addresses. README's "localStorage holds ciphertext only" overstates.
27. EVM private key lives as an unzeroable hex string inside viem's account
    closures for the session (known JS limitation, admitted in-code; README
    overstates). The mnemonic is likewise session-long React state.
28. Hardcoded 21000 gas makes native sends to contract wallets (Safes) fail,
    losing the fee each attempt.
29. EIP-681 `@chainId` parsed and discarded (pairs with finding 3's fix).
30. Bumping a self-send shows "recipient and amount stay the same" while
    paying everything to change (display wrongness only).
31. Airdrop spam can evict a real custom token from the 12-slot "Other tokens"
    list (visibility DoS).
32. Real-mode acknowledgment is once per device forever (by design; compensating
    controls verified — noted so it stays a conscious choice).
33. npm audit: production dependencies 0 vulnerabilities; 7 (2 moderate, 5
    high) in dev-only vite/launch-editor (Windows dev-server vectors). Fix at
    leisure with `npm audit fix`.
34. Esplora history paging may pass an unconfirmed txid as `last_seen_txid`
    (possible truncated history; display only; UNCONFIRMED).
35. BNB sends assume BSC serves EIP-1559 fee fields; prepare is never
    exercised on BSC in the test suite (functional risk only; UNCONFIRMED).

---

## What held (verified adversarially, worth preserving)

- **UTXO send path:** fresh full scan enforced before every send; UTXO value
  lies fail closed on both chain families (legacy: txid-verified
  nonWitnessUtxo + fee assert; segwit: BIP143 commits the amount → consensus-
  invalid); change scripts always self-derived with a hard mismatch check;
  review screen shows the same BuiltTx that is broadcast; retry rebroadcasts
  identical hex (idempotent); BIP125 rules enforced; fee APIs
  floored/ceiled/NaN-safe/clamped; wrong-chain and MWEB QR detection sound
  across all chains and casings.
- **Vault/biometric:** PBKDF2-600k fixed at save (no downgrade propagation),
  fresh salt+IV per save, non-extractable keys, uniform error; PRF path
  never weaker than password (UV required, HKDF, secret zeroed after use);
  reveal requires password; erase clears all nine kailah.* keys and zeroes all
  four engines; no sessionStorage/IndexedDB/window.name anywhere.
- **EVM:** chainId hardcoded per network and never read from RPC in the signing
  path (cross-chain replay impossible); exactly one signing call site; ABI has
  no approve — approvals are structurally impossible; no stale-nonce re-sign or
  byte re-broadcast in code paths (the gap is the human retry loop, finding 4);
  decimals lies can't desync display from calldata; sanitizer collapses
  unicode/RTL/homoglyph token names; real-USDC card not spoofable by contract
  address.
- **Solana/TRON:** ATA derivation purely local; SLIP-0010 matches spec vectors;
  swap gate fails closed on structure (strict decoder, trailing bytes
  rejected); stake instruction bytes match bincode layouts, withdraw recipient
  hardcoded to self; TRON txID always recomputed locally (sha256 of verified
  bytes), signature over the same digest, no verify→sign TOCTOU; multi-contract
  smuggling rejected; address base58check enforced canonically.
- **UI/infra:** no HTML-injection sinks anywhere; no `javascript:` hrefs; CSV
  formula injection neutralized before quoting; onramp URLs carry only the
  receive address, https, noopener, no-referrer; system notifications
  amount-free; QR decoder output never rendered; prices display-only and
  finite-checked; CSP in repo byte-identical across both files and exactly
  matches the 27 hosts the code calls; sw.js caches only the offline screen
  (deployed copy byte-identical); no console logging anywhere; dependencies all
  justified.

## Status update — fixes applied later the same day

Findings **1, 2, 3, 4, 5, 10, 14** were fixed and deployed to production the
same day, verified by typecheck, the extended check suites (new cases in
check-txv2/check-evm/check-sol), a live Jupiter honest-swap pass +
tampered-quote refusal, a browser smoke test, and a live CSP re-check after
deploy. Also fixed in passing: mainnet Solana USDC balance reads (publicnode
now gates `getTokenAccountBalance` behind personal tokens; the wallet now
parses `getAccountInfo` bytes instead — this had also silently weakened the
swap gate's before-balance, now fail-closed), and the discovery that
`solana.lava.build` (in the previously deployed build's CSP) is discontinued.

**Second pass, same day:** findings **6, 7, 8, 11, 12, 13, 15, 16** fixed:
snapshots re-derive every address from the account's keys before hydrating
(6); the fresh receive/change index is computed over scan ∪ cache, capped at
GAP_LIMIT−1 past the pre-scan cache frontier (never past MAX_INDEX), with an
uncapped first-contact scan so deep restores still find their true frontier —
this neutralizes a provider lying during any single scan (the pre-send scan
above all); a provider lying consistently across MANY full scans can still
ratchet the cached frontier ~20 per scan, a residual only multi-provider
corroboration could close (7); the TRON decoder is now
deny-by-default — unknown or duplicate fields throw, type_url must match the
type enum, Permission_id/provider/memo are refused, `call_value`/
`call_token_value`/`token_id` are decoded and pinned to 0 for USDT, and every
signing path pins fee_limit and a ≤24h expiration (8, with 12 new adversarial
vectors in check-tron); EIP-55 checksums are enforced on mixed-case addresses
(11); EVM fees are clamped (1000/100 gwei) and ERC-20 gas limits capped at
400k (12); USDC destinations must be system-owned or nonexistent accounts
(13); auto-lock locks on the first post-resume event and on visibilitychange
when overdue (15); the BIP39 seed, HD root and all path intermediates are
wiped step-by-step in every engine, including SLIP-0010 loop copies (16).
**Third pass (LOW/informational), same day:** 17 provider broadcast errors
bounded to 200 chars and attributed; 18 a detected token wearing a built-in
ticker (USDC/USDT/ETH/BNB/WETH/USDbC) now sanitizes to "Unnamed token"; 20
system-owned (dusted) stake slots are neither rendered as stakes nor chosen
for creation — only slots with no account at all are; 21 dust is enforced per
destination script (546 p2pkh / 540 p2sh / 330 p2wsh,p2tr / 294 p2wpkh) on
both send and sweep paths; 22 a MAX sweep refuses when the fresh scan's utxo
set is incomplete; 23 SR vote labels always carry the short address beside
the self-published hostname; 24 `ccipRead: false` on every EVM client; 25
`unlockVault` bounds the stored iteration count (100k–10M) and reports
damaged data instead of hanging; 28 native sends to contract recipients
estimate gas (capped at 400k) instead of hardcoding 21k; 33 `npm audit fix`
applied — 0 vulnerabilities including dev dependencies; 34 esplora paging
now cursors on the last *confirmed* txid; 35 confirmed by live probe — BSC
serves EIP-1559 fields (estimateFeesPerGas returns 0.05 gwei), no change
needed. Items 29 and 30 were already fixed in the first pass. Accepted and
documented in the README's limitations instead of changed: 19 single-source
activity feeds/alerts, 26 plaintext public-data caches while locked, 27 the
EVM signer's string-held key, 31 the 12-token detection cap, 32 the
once-per-device real-mode acknowledgment.

## Later work, 2026-10-22

Everything below is on `main` and live on both origins,
`kailah-wallet.netlify.app` and `wallet.photoprompting.org`, unless marked
otherwise. Commit hashes and PR numbers refer to the maintainers' development
repository. The passes above and the hardening in "Fourth and fifth passes"
predate its history, so those two are not split into their own commits.

### Regression introduced by this review — Speed up broken, now fixed

The fix for **finding 1** added `decodeVerifiedTx`, which reads each input's
previous transaction id out of the raw bytes. It reversed those bytes, but
`@scure/btc-signer` already returns input txids in display order, so the
result was reversed a second time. Every Speed up then asked the provider for
a transaction id that does not exist and stopped with "Can't speed this up."

- **Impact:** it failed closed. Nothing wrong was signed or broadcast and no
  funds were at risk, but RBF did not work on either origin from the
  first-pass deploy (2026-10-21) until the fix deployed on 2026-10-22.
- **Why the tests missed it:** Case G used `'d1'.repeat(32)` as the funding
  txid. That is a byte palindrome, so a reversal changes nothing and the
  check passed.
- **Found by** the hardware-signing work: its bump path runs the same code.
- **Fix:** one line, `e49362d` on the hardware branch. It was cherry-picked
  to `main` as `61ac602` ahead of that PR, because a live feature was
  broken.
- **Regression test:** Case I in `check-txv2` (`596222a`). It builds a real
  funding transaction (id = sha256d of its bytes, not symmetric) and a
  payment spending it, then requires the decoded outpoint to equal the
  funding txid, the funding transaction to verify against it, and the fee
  to reconstruct exactly. It failed on the pre-fix code and passes after the
  fix. (In production the failure surfaced one step earlier, as the provider's
  "not found" for the reversed id; in the test it is the id-binding check.
  Both mean Speed up refused.)
- **Live check:** three transactions from the Bitcoin mainnet tip were
  decoded with the fixed code, and each input's previous transaction was
  fetched from blockstream.info by its decoded id and txid-verified.
- **Not exercised:** a full Speed up of a real stuck transaction (none was
  available).
- **Lesson:** a test fixture must not be unchanged by the transformation the
  code applies. Byte-order code needs non-palindromic ids.

### Fourth and fifth passes — vault, passwords, supply chain, headers

- **Vault v2: Argon2id.** 32 MiB, 3 passes, 1 lane (`src/lib/vault.ts`),
  replacing PBKDF2-SHA256 600k. Offline guessing of a copied vault now costs
  memory per attempt, not just GPU time. Legacy PBKDF2 vaults are
  re-encrypted as v2 on the first successful unlock with the same password,
  transparently. Stored parameters outside m 8 MiB–1 GiB, t 1–10, p 1–4 are
  refused as damaged data instead of hanging unlock. 64 MiB took 1.9 s in
  pure JS on a laptop (too slow per unlock on a phone), and 32 MiB took
  0.9 s. Hashing runs in a Web Worker (`argon.worker.ts`), because the
  main-thread async variant stalled under background-tab timer throttling.
  The lock screen shows its progress. Covered by `check-vault`: round trip,
  v1→v2 upgrade, wrong password, tampered parameters.
- **Password policy.** Minimum 10 characters, a common-password list,
  obvious words ("password", "wallet", "bitcoin"…) refused under 20
  characters, short single-class passwords refused, and a live strength
  label.
- **Storage durability.** `navigator.storage.persist()` is requested on
  unlock. When the browser declines, a dismissable banner reminds the user
  to keep the 12 words safe. Its key is cleared on erase.
- **Fee clamp.** Bitcoin/Litecoin fee estimates are capped at 1000 sat/vB
  (was 5000) and bump fees at 2000. Fee buttons show the rate.
- **Supply chain.** Every dependency is pinned to the exact installed
  version. `.npmrc` sets `ignore-scripts=true` and `save-exact=true`. A
  clean `npm ci` with scripts disabled builds, because esbuild's binary
  arrives through its optional platform package. `npm audit`: 0, dev
  dependencies included.
- **Headers.** `Strict-Transport-Security: max-age=31536000;
  includeSubDomains; preload` and `Cross-Origin-Opener-Policy: same-origin`
  are now on both origins. A two-year max-age was tried first, but Netlify's
  platform header overrides `_headers`, so both origins use the one-year
  value to stay identical. `deploy/vps-redeploy.sh` regenerates every
  security header in the nginx block from `public/_headers` on each deploy.
  (Until 2026-10-23 that reached only the server level, so some VPS paths
  had none; see "VPS mirror: no security headers on assets or the service
  worker" below.)

### Process

- Git with a private GitHub repo. CI runs typecheck, both builds, the
  offline suites and a production `npm audit` on every push and PR. It has
  passed on every push to `main` since the repo was created.
- The suites are split into `check:offline` (CI) and `check:live`. Live
  suites report an unreachable or rate-limited provider as SKIP rather than
  FAIL (`scripts/_live.mjs`).
- `check-vault` and `check-scanner` were added. `scripts/serve-dist.mjs`
  serves the production build with the real headers, which is the only way
  to test the CSP locally.

### Sixth pass — encrypted caches, double-pay ledger, Trusted Types

- **Encrypted caches at rest** (`src/lib/securestore.ts`). The address map,
  state snapshots, pending-send ledger and hardware-account records are
  AES-256-GCM ciphertext under a key derived (HKDF-SHA256) from the BIP39
  seed. The store is decrypted into memory on unlock and dropped on lock,
  and erase deletes the `kailah.sec.*` blobs. A forged or other-wallet blob
  fails authentication and the wallet falls back to a cold scan. Covered by
  `check-scanner`: opaque blob, lock/unlock restore, foreign seed, tampering.
  **Finding 26, previously accepted, is fixed by this.** What stays
  plaintext is not wallet-specific: tip heights, the preferred provider, and
  UI flags (mode, real-mode acknowledgment, notifications, backup nudge).
  The vault and biometric vault were already encrypted.
- **Persisted double-pay guard** (`src/lib/pending.ts`), extending finding
  4 beyond the open modal. Every send attempt is recorded before broadcast.
  On EVM, the hash is computed from the signed bytes, and a new send is
  refused while a recorded attempt is still unconfirmed in the mempool,
  unless it is the same-nonce retry that replaces it. On Solana, a new send
  is refused while a signature from the last 90 s is unseen by the network.
  Now covered by `check-pending`, whose first run found two fail-open bugs
  in it (below).
- **Trusted Types.** The CSP sets `require-trusted-types-for 'script';
  trusted-types default`. A single default policy in `src/main.tsx` vouches
  only for same-origin script URLs and has no `createHTML`, so every
  HTML-injection sink is blocked at runtime. The first attempt
  (`trusted-types 'none'`) broke the service-worker registration and the
  Argon2 worker. It was caught on the production bundle served with real
  headers, before deploy. Verified live on both origins: policy present,
  service worker registered, same-origin worker allowed, cross-origin worker
  refused, `innerHTML` blocked.
- **Origin indicator.** The current hostname is shown under the brand name,
  as a phishing check.

### Seventh pass — ledger tests found two fail-open bugs

Writing tests for the pending-send ledger's refusal paths exposed two bugs.
Both let a second payment through exactly when the guard mattered:

- **EVM:** any error from the "is it still pending?" lookup (a timeout, an
  HTTP error, an RPC error) was read as "the network never saw it". The
  record was deleted and the new send allowed.
- **Solana:** a failed lookup was read as "seen", with the same result. The
  code's own comment justified this as avoiding a permanent block, but
  Solana records already expire after 90 s.

Both were demonstrated on the pre-fix code: with the lookup failing, a
second send was allowed and the record deleted, on both engines.

**Fix.** The decisions moved into `evmInFlightBlock` and `solInFlightBlock`
in `pending.ts`, with the network lookup passed in as a parameter. On EVM,
only viem's explicit `TransactionNotFoundError` and
`TransactionReceiptNotFoundError` count as not-found, and every other
failure is `'unreachable'`. That state blocks with its own message ("Couldn't
check whether your send…"). On Solana it blocks for at most the 90 s record
lifetime.

`scripts/check-pending.mjs` (offline, 35 checks) covers three things. First,
the decision rules: block, allow, prune, TTL, and same-nonce retry. Second,
how the real EVM lookup classifies each RPC outcome, against a mock
JSON-RPC network. Third, the wiring end to end: a broadcast that dies
mid-flight is still recorded under the exact signed hash or signature, and
`prepareEvmSend` / `assertNoSolInFlight` really consult the ledger.

### Account and infrastructure lockdown

Hardening of the hosting accounts, DNS and the mirror server (two-factor
sign-in, DNSSEC, a default-deny firewall) is tracked in the maintainers'
private notes, with its open items, rather than here.

### Structural changes

- **Browser extension, Manifest V3** (PR #1, `0bf1928`). Built from the same
  source.
  - Permissions are pinned to `notifications` and `unlimitedStorage`. There
    are no host permissions, no content scripts, and
    `externally_connectable` is empty.
  - The extension CSP is read from `public/_headers` and validated at build
    time.
  - The background worker only opens or focuses the wallet tab.
  - The web build is byte-identical to the pre-merge build (14 files).
  - **Not yet submitted to the Chrome Web Store.** Store-signed delivery is
    what closes the web-delivery trust gap, and only for users who install
    that copy.
  - Untested: a real passkey, the camera prompt, a notification click, and
    the store install.
- **Ledger hardware signing, BTC and LTC** (PR #2, `b4de74d`).
  - Zero new dependencies: the device protocols are implemented on the
    existing `@noble`/`@scure` stack.
  - Every device signature is checked locally against the wallet's own
    BIP143 digest before broadcast, and outputs and fee are re-checked.
  - Import requires the receive-0 address on the device screen to match the
    wallet's derivation.
  - Full previous transactions are sent for every input.
  - Change is marked only by BIP32 path.
  - Records hold public data only, in the encrypted store.
  - Software signing is byte-identical to the pre-merge code (send, sweep
    and bump on BTC and LTC).
  - **Never run on a physical Ledger.** The offline suite runs against an
    emulator written alongside the implementation, which proves
    self-consistency, not device compatibility. A protocol mismatch fails
    closed.

### VPS mirror: no security headers on assets or the service worker

Found and fixed 2026-10-23. On `wallet.photoprompting.org`, `/assets/*` and
`/sw.js` were served with **none** of the seven security headers, while
Netlify sent all seven on every path.

- **Cause:** in nginx, a `location` block with any `add_header` of its own
  inherits none of the server-level ones. Both of those locations set
  `Cache-Control`. Earlier checks only looked at `/`, which had all seven.
- **Impact:** a worker's CSP comes from its own script's response, not from
  the page. So on the VPS, the service worker and the Argon2 worker ran with
  no CSP: `connect-src` didn't limit where they could connect, and JS was
  served without `nosniff`. Exploiting this needed attacker code inside
  those scripts, so this was a lost layer of defence, not a hole on its own.
  The page itself always had the full CSP.
- **Fix** (`deploy/vps-redeploy.sh`): the managed headers are now also
  written at the top of every location block. A `location` line without
  `{` on it stops the run before anything is written. The script's verify
  step fails the deploy unless `/`, `/sw.js` and the entry chunk each carry
  every managed header.
- **Verified:** 55 VPS paths match Netlify's header values exactly: every
  build file, an SPA route and a missing-asset 404. The service worker
  re-installed under the new headers. The Argon2 worker, started on the VPS
  through the Trusted Types policy, produced the same key as a Node
  reference for a throwaway input.
- **Same day:** the script now also manages gzip on the VPS (stock nginx
  compressed only HTML). The entry chunk dropped from 286 KB to 92 KB on the
  wire, and every file still decodes byte-for-byte to the build.

### Verifiable builds (2026-10-24)

The answer to residual risk 1 for web users, short of the extension, is that
anyone can now check what a live site serves:

- **`npm run verify:live`** fetches every file of the build from both
  origins. It compares each byte for byte with a local build of the same
  commit and checks all seven security headers on every response. Its only
  normalization is Netlify's fixed hosting comment in HTML, and it reports
  each one.
- **Checked against tampering.** Against a local server, an untouched copy
  and a copy with only the Netlify comment passed. Each of these failed: an
  injected script tag, one flipped bit in a same-size chunk, a CSP removed
  from `sw.js`, and a script hidden after the Netlify comment.
- **Reproducible across platforms.** CI prints build digests for every push
  (`npm run digest`). For `7d355f4` a clean `npm ci` build on Linux matched
  the macOS build exactly: `dist/` `7e9739e3…` (53 files) and
  `dist-extension/` `fda9101e…` (52 files).
- **Both origins matched** the build of that commit when it was added.

This detects tampering; it does not prevent it. It shows what one machine
was served at one moment, and a host could serve different bytes to someone
else.

### Swaps on Jupiter Swap V2 (2026-10-25)

Jupiter deprecated the keyless `lite-api.jup.ag/swap/v1` the wallet used
("no longer actively maintained", the host "phased out"). Swaps now use
`api.jup.ag/swap/v2/build`, which returns the route as **instructions**
instead of a finished transaction.

- **The wallet assembles the transaction.** Lookup tables come from the
  chain, and Jupiter's list of each table must agree with it. The blockhash is
  the wallet's own. The compute-unit limit is measured by a first simulation
  (1.2×, capped). Program ids, signers and the fee payer stay static keys.
- **The build's shape is checked:** version 0, no "other" or tip
  instructions, only a unit-price compute-budget instruction, and no signer
  but the user anywhere.
- **The Jupiter instruction is decoded** (layouts from the program's
  on-chain IDL). Exactly one is allowed, and it must be one of the four
  exact-in swap variants. Its fields must say what the user asked: the input
  amount, the quoted output, 50 bps slippage, a platform fee of 0, a
  positive-slippage share of 0, and the user as transfer authority. The
  guaranteed minimum shown and enforced is computed from the decoded route,
  which closes finding 2's slippage-floor residual.
- **All earlier checks still run on the exact bytes:** the program and
  instruction allow-lists, CloseAccount paying the user, no stake accounts,
  the priority-fee cap, and simulated balance changes that must honor the
  decoded minimum.
- **Tests.** `check-swapgate` (60 offline checks, on two recorded /build
  answers) covers honest builds compiling to exactly what Jupiter described,
  byte-exact signing, and the refusal of every tamper above. `check-solswap`
  runs the gate on live mainnet routes by simulation, including a first-time
  USDC holder and two tampered live routes.
- **Found along the way:**
  - The price-impact warning compared Jupiter's fraction (0.01 = 1%) with a
    percentage, so it could only fire at 100% impact. It now converts.
  - The public test wallet's mainnet Solana account has been reassigned to
    another program (`9G4pPipv…`), so it can't pay fees. Any transaction from
    it fails in simulation, and the wallet refuses to sign it.

### Swap fee (2026-10-25)

Swaps carry a 0.5% fee for the developer, shown on the form and as its own
line on the review screen. It is paid in USDC into one published token
account: `SWAP_FEE_ACCOUNT`, owned by `SWAP_FEE_WALLET`, both constants in
`solswap.ts`, checked on-chain before release. Jupiter takes the fee inside
the swap: from the USDC output when selling SOL, from the USDC input when
buying. Its quoted output is already net of the fee, and Jupiter charges
none of its own on `/build`.

The gate makes the fee impossible to raise or redirect:

- **The decoded instruction** must carry `platform_fee_bps` = 50 and
  Kailah's account in its fee slot: slot 10 for `route_v2`, measured live;
  the IDL's `platform_fee_account` slot for the older forms. A build without
  the fee, with a higher fee, or with another fee account is refused. These
  checks run on Jupiter's instruction before anything is simulated, and
  again on the compiled bytes.
- **The final simulation** reads the fee account's balance, which must rise
  by exactly 0.5% (±1 unit) of the gross USDC output, or of the USDC input.
  Less, more, or nothing is refused, so the user can't be overcharged.
- **Tests:** `check-swapgate` (82 checks) adds the fee cases and requires
  every tampered field to be refused before any simulation. `check-solswap`
  measured the fee on live mainnet routes at exactly 0.5%, and a live route
  with its fee redirected is refused.

### Second audit, 2026-10-26 — seven adversarial reviews, fixed in v2.7.0

Six parallel AI-assisted reviews (UTXO, Ledger, EVM, Solana/swaps, TRON,
delivery/UI/extension) plus a direct review of the vault and key handling,
over v2.6.1; every finding below was re-verified by reading the code and
re-running each reviewer's probe before it was accepted. Still not a
third-party audit. Totals: 2 critical, 5 high, 8 medium, 14 low. All of the
critical, high and medium findings and most of the low ones are fixed in the
commits following `abc903f`; what held, and what remains, is listed after.

**Theme 1 — the wallet kept no record of what it had signed.** It asked the
data service "which transactions are mine / did my send go out?" and
trusted the answer.

- **CRITICAL — Speed up signed a provider-forged original.** `decodeVerifiedTx`
  bound the pending transaction's bytes to its txid, but the txid itself
  came from the provider's history, and nothing checked that the inputs
  carried our signatures: a fabricated "pending" payment (our real coins, a
  garbage witness, any outputs) became a real, signed replacement — on seed
  accounts and, with the Ledger showing the forged recipient, on hardware
  accounts. Fix: `hwsign.assertSignedByUs` verifies every input's witness
  signature against the wallet's own BIP143 digest before a bump is planned.
  A provider cannot forge our signatures. (check-txv2 J, check-hw J)
- **HIGH — EVM same-nonce retry forgot the first attempt.** The in-flight
  ledger overwrote the entry at that nonce, and the retry did not outbid the
  first attempt, so a node holding the first refused the "replacement"; once
  the modal closed, a new send at the next nonce was allowed and both could
  mine. Fix: every attempt per nonce stays recorded, a retry outbids by 10 %,
  a mined attempt settles its whole nonce, an attempt the node claims never
  to have seen blocks for ten minutes, and a node's explicit rejection drops
  the record. (check-pending A10, C2)
- **HIGH — TRON had no in-flight record at all**; an ambiguous broadcast was
  reported as "nothing was sent" and the retry rebuilt a different
  transaction (TRON has no nonce). Fix: recorded before broadcast, refused
  while unseen and unexpired, DUP_TRANSACTION counts as success; the
  expiration bound is now ten minutes, not the chain's 24 h. (check-pending F,
  check-trondecode B)
- **MEDIUM — UTXO sends had no in-flight record** (a lost answer, then a
  rebuilt second payment). Fix: recorded before broadcast; a new send is
  refused for up to 30 minutes while the provider doesn't report the txid.
- **MEDIUM — Solana: the guard's expiry was a wall-clock guess** and a retry
  built a fresh transaction. Fix: entries expire by the blockhash's last
  valid block height; after a failed broadcast the modals re-send the SAME
  bytes. Stake actions are recorded too. (check-pending A14b-f, G)
- **LOW — the lookalike warning trusted "sent" rows from the data service.**
  Fix: trust comes only from the wallet's own send log (`sentlog.ts`).

**Theme 2 — the swap gate's allow-list was one opcode too wide, and it
didn't pin which accounts move.**

- **CRITICAL — a hostile `/build` could add an SPL `Transfer` /
  `TransferChecked` out of ANY token account the owner holds** (USDT, JUP,
  …) to any destination: the owner's one signature authorized it and the
  balance diff watched only SOL and USDC. Fix: those opcodes are gone (Jupiter
  moves tokens by CPI); helper instructions may move value only between the
  owner's accounts. (check-swapgate J)
- **HIGH — the older `route` / `shared_accounts_route` forms were decoded
  from their last 19 bytes**, while the program reads from the front and
  ignores trailing bytes. Fix: v2 forms only.
- **HIGH — the swap's source/destination accounts and mints were never
  pinned**, and the spend bounds were one-sided. Fix: pinned to the owner's
  ATAs for the requested mints; the input side must move by exactly the
  input.
- **MEDIUM — no sanity check of the quote against the wallet's own price
  feed.** Fix: the output is shown in USD and a quote more than 3 % under
  market needs an explicit acknowledgement.

**Theme 3 — practice and real mode shared one key on Solana and TRON**, and
the chain binding (Solana's blockhash, TRON's ref_block) came from the node
unverified, so a hostile practice node could obtain a mainnet-valid
signature. **HIGH.** Fix: practice networks derive at BIP44's testnet coin
type, as Bitcoin's testnet already did. (check-keys)

**Also fixed:** EVM token sends to the token's own contract or the zero
address are refused and a contract recipient is flagged (MEDIUM); a
page-level CSP is generated into the web build so a host that drops the
header can't drop the policy (MEDIUM); PRIVACY.md no longer overstates the
CSP and lists every onramp that receives the address or a referral
(MEDIUM/LOW); CI runs with read-only permissions and SHA-pinned actions;
explorer links only ever carry a well-formed id; the gate compiles against
the lookup-table entries Jupiter listed, not beyond; SOL sends refuse token
and program accounts; Solana Pay `reference` and `memo` are carried; the
TRON resource enum is strict; Speed up's fee pills are locked while a Ledger
signs; "Verify on Ledger" compares the exact string on screen; Argon2
parameters are bounded to 256 MiB.

**What held:** the vault and key lifecycle; ordinary sends on every network;
the TRON decoder against 44 hostile mutations; the EVM signing path (pinned
chainId, one signing call, no approvals reachable); the Ledger protocol
(only signatures come back, each verified against our own digest); the
service worker, CSP hosts, Trusted Types, extension permissions and the
dependency set.

**Remaining:** the mirror serves `index.html` without `Cache-Control` (a
stale page after a redeploy self-heals on reload; chunks are content-hashed);
a fully lying single RPC can still make Solana's guard believe a send was
seen; the on-chain behaviour behind the two swap findings (Anchor ignoring
trailing bytes; the program accepting an arbitrary mint pair) was reasoned,
not exercised live.

### Residual risks, as of 2026-10-22

1. **Web delivery trust.** Whoever controls Netlify, DNS or the VPS can still
   ship code to web users. Hardening those accounts, DNS and the server
   reduces this. It is closed only for users of the store-signed extension,
   once that is published.
2. **Solana swaps.** Simulation runs on a single RPC. (The route's on-chain
   slippage floor, finding 2's other residual, is decoded since 2026-10-25;
   see "Swaps on Jupiter Swap V2".) *2026-10-29:* mainnet now has a second
   RPC (Pocket Network's public gateway). Reads fail over to it, and the
   double-pay guard asks both and needs them to agree (the lower block
   height; "landed" or "never seen" only when both say so), which closes
   the 2026-10-26 residual of a single lying RPC ending a hold. Simulation
   still uses the first RPC that answers. The same day, the mirror's pages
   got "Cache-Control: no-cache" (the 2026-10-26 residual about
   `index.html`), effective at its next redeploy.
3. **UTXO frontier.** A provider that lies consistently across many full
   scans can ratchet the cached frontier about 20 indices per scan (finding
   7's residual). Closing this needs multi-provider corroboration.
4. **Testnet4 has one usable provider.** `mempool.emzy.de/testnet4` serves
   tip heights but returns 404 for address lookups, so it can't run the
   wallet's scans. Practice-mode Bitcoin depends on mempool.space alone.
   This is safe: a failed scan surfaces as an error, never as an empty
   wallet. But it is a single point of failure. *Resolved 2026-10-28:*
   blockstream.info now serves testnet4 (every lookup a scan makes) and
   replaced mempool.emzy.de, as a backup (it caps each IP at 700 requests
   an hour); after a failed scan,
   background polls back off from one minute to ten (check-failover K).
5. **Unexercised end to end:** a Speed up of a real stuck transaction. This
   was attempted on testnet4 on 2026-10-22 and blocked: mempool.space timed
   out from the development machine over both IPv4 and IPv6, and the backup
   can't serve address lookups. A physical Ledger, and the extension's
   manual checks and store install, are also still untested.
6. **Still accepted:** findings 19 (single-source activity feeds), 27 (EVM
   key held as a JS string), 31 (12-token detection cap) and 32
   (once-per-device real-mode acknowledgment).

## Suggested fix order

*Historical: the order the fixes above were applied in. All of it shipped
2026-10-21/22.*

1. Finding 1 (bump verification + honest bump review) and finding 10 with it.
2. Finding 2 (swap instruction whitelist) — or, if that's too large for now,
   disable mainnet swaps until it lands.
3. Finding 3 (EIP-681) — small parser fix, large harm.
4. Finding 4 (retry double-pay, both engines) and finding 5 (clipboard) — small.
5. Redeploy production (finding 9), then 6, 7, 8, 11–16.
