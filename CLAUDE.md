# Kailah Wallet — maintenance notes

Self-custody browser wallet, v2.7.0: four engines — UTXO (BTC/DOGE/LTC),
EVM (USDC+ETH on Base/Ethereum/Arbitrum + BNB on BSC, no explorer API there),
Solana (SOL + SPL USDC + Jupiter swaps + native staking via hand-built
stake-program instructions in solstake.ts), TRON (TRX + USDT-TRC20 + Stake 2.0 via tron.ts/tronstake.ts — the node builds raw txs and the wallet DECODES the protobuf bytes
and refuses to sign on any mismatch; TronGrid keyless, Nile practice twin).
Ledger hardware accounts for BTC/LTC (docs/hardware-signing.md): xpub-only
accounts beside the seed ones, signed on the device — Bitcoin app via PSBT
(src/lib/ledger/btcapp.ts), Litecoin via the legacy protocol (legacyapp.ts);
no Ledger npm packages. Live: https://kailah-wallet.netlify.app
Read README.md first; contracts live in src/lib/types.ts (header comments are
the module API docs). The project is COMPLETE — sessions here are maintenance,
not feature building, unless the user asks for something new.

## Commands
- `npm run dev` (port 5173; use the wallet-dev launch config, never Bash)
- `node scripts/serve-dist.mjs` (port 4173; the dist-preview launch config) serves
  the production build WITH public/_headers — the only way to exercise the CSP
  (Trusted Types, connect-src) locally; the Vite dev server sends no headers.
- `npm run typecheck` — strict, must stay at zero errors
- `npm run build` → dist/
- `npm run build:extension` → dist-extension/ (MV3 Chrome extension of the same
  source; docs/extension.md). Its CSP is read from public/_headers at build
  time and the build checks its own output, so a provider host change needs
  no extension edit. Extension-only code paths sit behind IS_EXTENSION
  (src/platform.ts), a build constant: the web dist/ must stay byte-identical
  whether or not that code exists.
- Deploy: Netlify (`npx netlify-cli deploy --prod --dir=dist --site …`) and the
  nginx mirror (`deploy/vps-redeploy.sh`, which also regenerates the mirror's
  security headers from public/_headers, so redeploy it whenever the CSP hosts
  change). Site ID, host and access live in ops/infrastructure.md, which is
  private (see "Public repository" below): @ops/infrastructure.md
  The Netlify CLI rewrites .netlify/netlify.toml's `publish` to this Mac's
  absolute path on every deploy. Restore `publish = "dist"` before
  committing, and never `git add -A` right after a deploy without checking.
  The public snapshot's leak scan refuses that path (it caught it once,
  2026-10-25).
- Tests: `npm run check:offline` (keys, txbuild, txv2, qrparse, vault, scanner, hw, pending, netprefs, failover, swapgate, lookalike, trondecode —
  no network; this is what CI runs on every push) and `npm run check:live`
  (account, evm, sol, solswap, solstake, tron — real networks; a provider being
  down or rate-limited prints SKIP, never FAIL). check-providers.mjs is run by
  hand only when provider code changes (it burns BlockCypher's ~100/hr DOGE
  budget); check-sol/check-solswap do REAL devnet broadcasts, which is fine —
  devnet coins are worthless.
- `npm run verify:live [origin …]` — after `npm run build`, fetches every dist/
  file from both origins (or the ones given) and byte-compares it with the
  local build, plus all seven public/_headers headers on every response. Its
  one normalization is Netlify's fixed hosting comment in HTML.
  `npm run digest` prints the build digests CI prints for every push.
- Git: `main`; CI = .github/workflows/ci.yml. Commit every change.

## Public repository
- ops/ is private: infrastructure, accounts, release steps. Never copy host
  names, account state, keys or local paths into tracked files outside ops/.
  The public copy is cut by `ops/make-public-snapshot.sh`, which exports the
  committed tree without ops/ and fails on any leak it knows to look for
  (ops/public-release.md).

## Hard rules
- The service worker (public/sw.js) must NEVER cache application code — only
  the static offline screen. A cached wallet is a security hole.
- First load is code-split: Shell.tsx (welcome/lock) is the main chunk, App.tsx
  (unlocked wallet + UTXO stack) loads on unlock, and src/engines/ loads EVM,
  Solana and TRON when the dashboard renders, with modals lazy. A static value
  import of lib/evm|sol|tron (or their components) from Shell, App or Dashboard
  pulls that engine into an earlier chunk (type imports are fine); check the
  chunk sizes `npm run build` prints.
- Hardware path: only signatures come back from a device; hwsign.assembleSigned
  verifies each against our own BIP143 digest and the reviewed outputs/fee
  before anything is broadcast. Never accept a device-serialized transaction.
  Any Ledger protocol fix lands with an emulator case in scripts/check-hw.mjs.
- CSP `connect-src` (public/_headers AND .netlify/netlify.toml — keep in sync)
  must list exactly the hosts called by networks.ts providers + prices.ts +
  evm.ts (Base RPCs + blockscout) + the sol.ts/tron.ts RPCs + solswap.ts
  (Jupiter Swap V2, api.jup.ag). PRIVACY.md lists the same hosts.
- The EVM engine (evm.ts, USDC on Base) is intentionally separate from the
  UTXO stack: account model, viem signing with pinned chainId, no address
  rotation. Never blind-retry a failed EVM broadcast — re-prepare (fresh
  pending nonce) so an actually-landed first attempt can't be double-sent.
- Swaps carry a 0.5% fee (SWAP_FEE_BPS) into SWAP_FEE_ACCOUNT (solswap.ts),
  disclosed on the form, the review screen, README, PRIVACY.md and the store
  description. Changing the rate or the account is a deliberate edit to all
  of those plus the check-swapgate expectations, never a side effect. The
  fee wallet itself pays none (swapFeeBpsFor): its USDC account IS the fee
  account. Routes through a third token get a CloseAccount appended for the
  intermediate token account Jupiter opens (intermediateCloses); without it
  the stranded rent trips the SOL-cost bound and the swap is refused.
- Lookalike-address warning (lib/lookalike.ts, LookalikeWarning.tsx) on all
  four send forms. An address is trusted ("sent") only when the wallet's own
  send log says it paid it; history rows never make one trusted (a lying
  data service could plant a "sent" row). It reads only the history the
  form already has (no extra requests).
- Practice-mode keys are separate: Solana devnet and TRON Nile derive at
  coin type 1 (SOL_PRACTICE_PATH / TRON_PRACTICE_PATH), the UTXO testnet
  already did. A chain's binding comes from the node (Solana's blockhash,
  TRON's ref_block), so a practice signature from the REAL key would be
  mainnet-valid if the practice node lied (audit 2026-10-26). App.tsx holds
  both keys and picks by mode; wipe() zeroes both.
- All amounts are bigint smallest-units everywhere. No floats in money math.
- Secrets (mnemonic, private keys) exist only in memory; never log/store them.
  Private keys are zeroed on lock/erase; erase must clear every kailah.* key.
- DOGE scans are sequential and cache-seeded on purpose (BlockCypher budget).
  Background polls MUST stay quick-mode (scanAccount quickCheckAgainst) at the
  600s cadence; tip heights come from the kailah.tipcache.v1 fallback. Full
  gap scans on every poll previously burned the ~100/hr budget and produced
  CORS-less 429s that browsers report as "Load failed".
- Rate limits are handled in ONE place, the FailoverClient (api.ts). An
  esplora provider (burstLimited) that pushes back (a 429, or a network error
  right after a success) is paused for every request and retried after
  1.5/4/8 s; a provider that never answered is down for 60 s.
  check-failover proves both. Don't add retries inside a provider: a second
  layer multiplies requests, and mempool.space and mempool.emzy.de block a
  whole IP for a while after heavy bursts (2026-10-25). Keep live testnet
  scans and burst tests rare.
- Litecoin's BlockCypher provider is backupOnly (ProviderApi.backupOnly):
  used only while litecoinspace.org has failed or is cooling down, never
  raced at startup, never remembered, never used for a mere rate limit.
  BlockCypher requests from every chain share one 500 ms queue (one per-IP
  budget, ~100/hr). A full LTC scan through it costs ~70 requests for the
  test wallet, so browser-test a failover with Dogecoin's BlockCypher blocked.
  `check-providers.mjs ltc` runs only the Litecoin section.
- Networks shown (src/lib/netprefs.ts, kailah.sec.netprefs): hidden networks
  are never scanned or polled — every scan/poll/refresh loop in App.tsx goes
  through shownIn() (check-netprefs E1 enforces it) — and an engine chunk
  whose every network is hidden in the current mode is never fetched
  (useEngine's `wanted` = engineShown; no chunk, no key derived). netprefs
  names chain ids itself so the chooser never value-imports an engine;
  check-netprefs G keeps those ids/labels equal to the engine configs.
  Ledger accounts always show. An undecided wallet must never hide a network
  whose scan found funds or history, or couldn't tell.
- Sends always build from a fresh scan (no stale-utxo fallback) and change goes
  to the next unused change address.
- The in-flight ledger (lib/pending.ts) covers all four engines: every
  broadcast is recorded BEFORE it goes out, and a new send is refused while
  an attempt may still land (EVM: every attempt per nonce stays recorded,
  a same-nonce retry outbids by 10 %, "unknown" blocks for 10 min; Solana:
  held until the RPC's block height passes the blockhash's last valid
  height, and a failed broadcast is retried with the SAME bytes; TRON: until
  the tx's own expiration, bounded to 10 min; UTXO: 30 min, provider txSeen).
  Speed up first proves the pending tx carries OUR signatures
  (hwsign.assertSignedByUs): the provider picks what it shows as pending.
- The swap gate pins the Jupiter instruction's source/destination accounts
  and mints to the owner's ATAs, accepts v2 routes only, allows no top-level
  token transfer, and lets helper instructions move value only between the
  owner's own accounts; the input side must move by exactly the input.
- The lookalike check trusts only the wallet's own send log (lib/sentlog.ts),
  never history rows.
- Test wallet for dev flows: the public BIP39 vector phrase (abandon ×11 +
  about), password irrelevant — NEVER for real funds; erase after testing. Its
  testnet4/mainnet accounts have real history useful for exercising the UI.
  Its mainnet Solana account was reassigned to another program by someone, so
  it can't pay fees: live swap tests simulate from a funded public wallet
  (check-solswap's BINANCE_HOT) instead.

## Verification habits
After changes: typecheck + relevant check scripts + drive the affected flow in
the browser (restore test wallet → exercise → erase). After every deploy, run
`npm run verify:live` on the deployed commit: both origins must MATCH.
