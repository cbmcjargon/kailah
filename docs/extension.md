# Kailah Wallet as a browser extension

The web app has one gap a web page cannot close (see
`SECURITY-REVIEW-2026-10-21.md`): whoever controls the hosting (the Netlify
account, DNS, the VPS mirror) can ship new code to every user on their next
visit, and other browser extensions can read and script the page. The
extension build packages the **same source** as a Manifest V3 extension:

- **The store's signature decides what runs, not a server.** All code is in the
  package. Nothing is fetched at launch, and an update has to go through the
  store.
- **Other extensions cannot reach it.** Chrome does not let one extension inject
  content scripts into another extension's pages. The manifest also exposes
  nothing to web pages (no `web_accessible_resources`) and accepts no messages
  from other extensions.
- **Its storage is not swept with site data.** It survives "Clear browsing data"
  and, with `unlimitedStorage`, quota eviction too.

The web app stays the practice and try-it front door, and its build is
untouched. The `dist/` produced on this branch is byte-identical to the one
from `main` before the extension work.

## Build

```bash
npm run build:extension   # → dist-extension/
```

`vite.extension.config.ts` inherits everything from `vite.config.ts`, so a
setting added for the web build reaches the extension too. It adds four things:
a build-time flag (`__KAILAH_EXTENSION__`, read through `src/platform.ts`), the
background worker entry, `publicDir: false`, and the plugin in
`extension/plugin.ts`.

| File in `dist-extension/` | Comes from |
| --- | --- |
| `manifest.json` | `extension/manifest.ts`. The version comes from `package.json`, the CSP from `public/_headers` |
| `index.html`, `assets/index-*.js/.css` | the app shell (welcome and lock screens), same source as the web build |
| other `assets/*.js` | the code-split chunks of the same app (unlocked wallet, each engine, modals), loaded on demand |
| `assets/argon.worker-*.js` | the Argon2id worker (`src/lib/argon.worker.ts`) |
| `assets/ccip-*.js` | viem's lazily loaded chunk, same as the web build |
| `background.js` | `src/extension/background.ts` |
| `icons/icon-{16,32,48,128}.png` | `extension/icons/`, rendered from `public/icon.svg` by `scripts/make-extension-icons.mjs` |
| `icon.svg`, `icon-192.png` | `public/` (favicon and notification icon) |

Nothing else from `public/` is copied. `sw.js`, `_headers`,
`manifest.webmanifest` and the offline page are the PWA shell.

The build checks its own output and fails if any of these breaks:

- The extension CSP's `connect-src` hosts must equal the ones in
  `public/_headers`.
- The CSP must still be valid for MV3: `script-src 'self'`, `object-src 'none'`
  and the Trusted Types directives.
- The manifest may only use the keys and permissions listed in
  `extension/manifest.ts`. Adding one is a deliberate edit there.
- The package must not contain `sw.js`, `_headers`, the webmanifest or the
  offline page.
- `index.html` may only load packaged `/assets/*.js` scripts. No inline or
  remote scripts.
- `background.js` must not mention `caches`, `fetch`, `importScripts`,
  `localStorage`, `indexedDB` or any URL, and must not import other chunks.

The build is deterministic. Two consecutive builds produce byte-identical
files, and a clean Linux build in CI has matched a macOS build of the same
commit. CI prints the digests of every push (`npm run digest` prints yours).
Anyone can rebuild a tagged commit and compare it with the store package:

```bash
curl -L -o kailah.crx 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.0.0&acceptformat=crx3&x=id%3Dnlcefhomhhohcegbacldomjpamambmac%26uc'
unzip kailah.crx -d store-copy    # warns about the signature bytes at the start
diff -r store-copy dist-extension  # built from the tag of the version in store-copy
```

The store adds a `_metadata/` folder with its signature and an `update_url` line
in `manifest.json`; Chrome adds a `key` line when it installs. Every other file
should match, and on the store's 2.7.7 package (2026-10-31) every other file did.

CI (`.github/workflows/ci.yml`) runs `npm run build:extension` on every push, so
the checks above run there too.

## Load it unpacked in Chrome

1. Build it with `npm run build:extension`.
2. Open `chrome://extensions` and turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and choose the `dist-extension` folder.
4. The wallet opens in a new tab on first install. Afterwards, click the
   toolbar button. It lives in the puzzle-piece menu until you pin it. The
   button focuses the open wallet tab, or opens one if none is open.
5. After a rebuild, click the reload arrow on the extension's card in
   `chrome://extensions`, then reopen the tab.

Things to know while testing:

- An unpacked extension's ID is derived from its folder path. Loading from a
  different folder gives a different ID, a different origin, and empty storage.
  The store assigns one permanent ID.
- **Removing the extension deletes its storage, including the vault.** Test
  with the public test wallet (abandon ×11 + about) only, and erase afterwards.
- Branded Chrome 137+ ignores the `--load-extension` command-line flag. For
  automated runs, use Chrome for Testing or Chromium. The verification below
  did that.

## What differs from the web app, and why

The web CSP carries over verbatim. It is read from `public/_headers` at build
time and placed in `content_security_policy.extension_pages`. Chrome serves
that policy as the page's CSP. The other security headers cannot be set by an
extension, so each has an equivalent or does not apply:

| Web app (`public/_headers`) | Extension | Why |
| --- | --- | --- |
| `Content-Security-Policy` | same string, in the manifest | derived at build time, so they cannot drift |
| `X-Frame-Options: DENY` / `frame-ancestors 'none'` | `frame-ancestors 'none'` kept, and no `web_accessible_resources` | web pages cannot load or frame extension pages at all |
| `Referrer-Policy: no-referrer` | `<meta name="referrer" content="no-referrer">` injected into the extension's `index.html` | headers cannot be set, a meta tag can |
| `Cross-Origin-Opener-Policy: same-origin` | `cross_origin_opener_policy` manifest key | MV3's own mechanism |
| `Strict-Transport-Security` | not applicable | code is not fetched over the network |
| `X-Content-Type-Options: nosniff` | not applicable | Chrome serves packaged files with fixed types |
| `Permissions-Policy: camera=(self), geolocation=(), microphone=(), payment=()` | no equivalent | see below |

**Permissions-Policy.** An extension page cannot hard-disable features the way
the header does. Camera is still limited to the page itself, because the CSP
blocks frames, so no third-party document exists to ask. Microphone,
geolocation and payment are not disabled by policy, but nothing in the code
requests them, the CSP forbids any code that is not packaged, and Chrome would
show a prompt naming the extension.

Behavior that differs on purpose:

- **No PWA service worker.** `src/main.tsx` skips registering `sw.js`, and the
  string is not in the extension bundle. `background.js` takes over its
  remaining jobs. The toolbar button focuses or opens the wallet tab. A click
  on a payment notification does the same, because the page shows
  notifications through the background worker's registration. Neither worker
  caches anything. The extension needs no offline screen: its code is local, so
  the wallet opens offline and only balances need the network.
- **Full tab, not a popup.** Popups close as soon as focus moves to a password
  manager, the camera prompt, or a passkey sheet, which would drop an unlock or
  send mid-way.
- **Origin indicator.** The header line under the name shows
  `location.hostname`. On an extension page that is the extension ID, which
  should match the ID in the store listing's address. Only the tooltip wording
  changes.
- **No storage nudge.** `navigator.storage.persisted()` returns false for
  extension origins even with `unlimitedStorage`, so the nudge about
  installing to the home screen would always appear, with wrong advice. It is
  skipped in the extension build.
- **Separate vaults and passkeys.** The extension origin has its own storage,
  so a wallet on the website does not appear in the extension. Restore from the
  12 words to move it. A passkey's relying-party ID is the hostname, so
  biometric unlock must be set up again inside the extension.

Every one of these differences is compiled out of the web build
(`IS_EXTENSION` is the constant `false` there).

## Permissions

| Permission | Why | Install warning |
| --- | --- | --- |
| `notifications` | Generic, amount-free payment alerts while the wallet tab is open (`src/lib/notify.ts`). With it, notifications are granted without a prompt. Without it, `Notification.requestPermission()` returned `denied` in testing (headless Chrome, which may auto-deny prompts). | "Display notifications" |
| `unlimitedStorage` | Chrome's documented way to exempt an extension's web storage, here the localStorage holding the encrypted vault, from quota eviction. | none |

Deliberately absent:

- **`host_permissions`.** Every provider answers the extension origin exactly
  as it answers the website. Each `connect-src` host was checked from the
  extension page. Host permissions would only let the page bypass CORS. That
  would mean a compromised page could read cookie-authenticated responses from
  hosts such as `api.coinbase.com`. It would also add the install warning
  "Read and change your data on a number of websites". The CSP's `connect-src`
  is what limits where the page can connect, as on the web.
- **Others.** No `tabs`: `background.ts` uses `chrome.runtime.getContexts`,
  which needs no permission. No `scripting`, content scripts, or
  `web_accessible_resources`. `externally_connectable: { "ids": [] }` refuses
  messages from all other extensions and from web pages.
- **Camera.** There is no manifest permission for it. Chrome asks the first
  time the QR scanner opens, and the prompt names the extension.

## Storage and auth

- **Storage.** Vault, encrypted scan caches, the pending-send ledger and the
  keys are unchanged. They live in localStorage on
  `chrome-extension://<id>`. Chrome documents that extension storage is not
  cleared by "Clear browsing data", and that `unlimitedStorage` exempts it from
  eviction. It is deleted when the extension is uninstalled. The 12 words
  remain the backup, as on the web.
- **WebAuthn PRF works on an extension page in Chrome.** It was tested with a
  DevTools virtual platform authenticator that has PRF:
  - `isUserVerifyingPlatformAuthenticatorAvailable()` returned true.
  - Creating a passkey with `rp.id` set to the extension ID succeeded with PRF
    enabled. Two assertions returned the same 32-byte PRF secret.
  - A foreign RP ID such as `kailah-wallet.netlify.app` was refused with
    `SecurityError`.
  - The wallet's own flow worked end to end: enrol in Settings, lock, unlock
    with "Face ID / fingerprint".
- **Not verified: a real Touch ID or iCloud Keychain passkey.** Chrome for
  Testing lacks the macOS keychain entitlement, and branded Chrome cannot load
  an unpacked build by command line. If a real passkey provider refuses the
  extension ID, enrolment and unlock show: "Face ID / fingerprint unlock isn't
  available to the browser extension on this device — your password still
  unlocks the wallet." A device without a platform authenticator never shows
  the option at all. To check by hand: load unpacked in your own Chrome, open
  Settings, turn on Face ID / fingerprint unlock, lock, and unlock with it.

## Verification record (2026-10-22)

Run in an isolated, throwaway Chrome for Testing 151 profile, driven over the
DevTools protocol with no new dependencies. The camera was faked with
`--use-fake-device-for-media-stream`.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `build`, `build:extension`, `check:offline` | all green |
| Web `dist/` vs. `main` | byte-identical (SHA-256 of every file) |
| Extension loads | yes; no manifest warnings or errors on its `chrome://extensions` card |
| Trusted Types default policy installs | yes. Same-origin `chrome-extension://` script and worker URLs pass. Cross-origin and `data:` URLs are refused. `innerHTML` is blocked. |
| CSP enforced | yes. An unlisted host was blocked by `connect-src`. `eval` and `new Function` from page code were blocked. |
| Providers reachable without `host_permissions` | yes, over plain CORS, for every provider reachable from the test network |
| Create → lock → unlock | yes. Argon2id ran in the worker chunk. Password unlock worked after a reload. Biometric unlock worked with the virtual authenticator. |
| Toolbar button | focuses the open wallet tab without opening a duplicate, and opens a tab when none is open (via `Extensions.triggerAction`) |
| First install | opens the wallet tab |
| Notifications | `Notification.permission` is `granted`. `showNotification` goes through the background worker's registration. A real click on an OS notification could not be simulated; it runs the same code as the toolbar button. |
| QR scanner | the camera stream runs on the extension page |
| Practice send form (Solana devnet) | address validation, amount, Continue, and the prepare step (RPC from the extension) work. It stops at "insufficient SOL" because the devnet faucet refused an airdrop that day. |
| Practice send through broadcast (TRON Nile) | the test wallet went form → node-built tx → decode → review → sign → broadcast. Nile rejected the broadcast because someone reassigned that public account's permissions on-chain; its error confirmed the signature came from the wallet's own key. |
| Erase | removes every `kailah.*` key (storage empty) and returns to the welcome screen |
| Console errors during the walk | CORS-looking failures from mempool.emzy.de (it has no testnet4 and returns a 404 without CORS headers), mempool.space (unreachable from the test network) and CoinGecko (IP rate limit). The same requests failed identically from the web build served with its real headers. |

Not verified: a real platform passkey (see above), the real camera permission
prompt, a click on an OS notification, and the store's own install flow.

## Chrome Web Store listing: what it needs

Live since 2026-10-31:
https://chromewebstore.google.com/detail/kailah-wallet/nlcefhomhhohcegbacldomjpamambmac
(extension ID `nlcefhomhhohcegbacldomjpamambmac`).

- **Package.** Zip the contents of `dist-extension/` (not the folder itself):
  `cd dist-extension && zip -qrX ../kailah-wallet-extension.zip .`. The version
  must increase with every upload; it comes from `package.json`.
- **Images.** Ready to upload, in `extension/store/` (24-bit PNG, no alpha):
  - Five 1280×800 screenshots, in listing order: `screenshot-1-dashboard`,
    `-2-send-review` (USDT on TRON, stopped at review), `-3-receive-btc`,
    `-4-ledger` and `-5-settings`.
  - `promo-small-440x280.png`, the small promo tile, rendered from
    `promo-tile.html`.
  - The 128×128 icon is in the package (`icons/icon-128.png`).

  How they were made, to redo after a UI change:
  - **Screenshots.** Captured from `dist-extension/` in Chrome for Testing
    (headless, 1280×800, DPR 1, throwaway profile). The public test wallet
    was in practice mode and was erased afterwards. They are full-bleed
    captures of the real UI, as the store asks: no frames or captions.
  - **Edits.** The extension ID under the name is blurred, because the store
    assigns a different ID from the unpacked build's. Scrollbars are hidden,
    as macOS overlay scrollbars are. Focus rings are cleared.
  - **Networks.** Shots 1 and 2 hide Bitcoin and Base through Networks shown.
    Practice Bitcoin needs mempool.space, which the capture machine could not
    reach, and Base's spam-airdrop list crowded the frame. Shots 3–5 have
    Bitcoin shown, behind the modal.
  - **Tile.** Render `promo-tile.html` at exactly 440×280, DPR 1, and save
    it as RGB.
- **Single purpose.** "A self-custody cryptocurrency wallet: create or restore
  a wallet, view balances and history, and send and receive coins. Keys are
  created and encrypted on the user's device."
- **Permission justifications.**
  - notifications: "Shows a generic 'you received a payment' alert, with no
    amount, while the wallet tab is open."
  - unlimitedStorage: "Keeps the user's encrypted wallet from being evicted
    from local storage under disk pressure. Losing it would force a restore
    from the recovery phrase."
- **Remote code.** "No, I am not using remote code." All JavaScript is in the
  package. Network requests fetch only JSON data from the blockchain and price
  APIs listed in the CSP.
- **Data usage and privacy disclosure.** No data is sent to the developer (the 0.5% swap fee is an on-chain USDC payment, disclosed in the listing).
  There are no accounts, analytics, or servers. The recovery phrase, keys and
  password never leave the device. They are stored only as AES-256-GCM
  ciphertext under an Argon2id-derived key. To show balances and send coins, the
  extension sends the wallet's public addresses and signed transactions to
  public blockchain APIs and fetches prices from public price APIs. That
  traffic goes directly from the user's browser to those services, as in the
  web app.
  - The form's categories need a decision by whoever submits. The strict
    reading is to disclose "Financial and payment information", because public
    addresses go to those APIs, with "not sold, not used for unrelated
    purposes, not used for creditworthiness" certified.
  - A privacy policy URL is required once any category is disclosed. It is
    [PRIVACY.md](../PRIVACY.md), at
    https://github.com/cbmcjargon/kailah/blob/main/PRIVACY.md once the
    repository is public.
- **Referral links.** The Chrome Web Store's affiliate policy allows them
  only when the listing and the UI describe them and they give the user a
  direct benefit. The description's "Referral links" section says which
  exchanges are the developer's referrals, what a new account gets and that
  the developer is rewarded; each one is tagged "Invite link" in the wallet,
  with its sign-up offer in the blurb (`src/lib/onramp.ts`). Keep the two in
  step when an offer or link changes.
- **Description.** Paste-ready plain text in
  `extension/store/description.txt` (about 3,500 characters; the store allows
  16,000). The short summary is the manifest `description`.
  - **No keyword lists.** The store rejected 2.7.6 as keyword spam ("Yellow
    Argon") for the summary's ticker list, "BTC, DOGE, LTC, USDC, ETH, BNB,
    SOL and TRX". Its rule also counts long lists of brands and any keyword
    repeated more than five times. The build refuses a ticker list in the
    summary, and check-netprefs I6/I7 check both texts.

## Firefox (not packaged; what would differ)

- **Background.** Firefox MV3 runs the background as an event page
  (`background.scripts`), not a service worker. `chrome.runtime.getContexts`
  is not available there, so the focus-or-open logic would need another route,
  such as `clients.matchAll()` or `tabs.query`.
- **Manifest keys.** Firefox needs `browser_specific_settings.gecko.id` and
  `strict_min_version`. `minimum_chrome_version` and
  `cross_origin_opener_policy` are Chrome-only.
- **Origin.** The origin is `moz-extension://<random per-install UUID>`.
  `src/platform.ts` is a build flag, so detection would still work. Passkeys
  would be bound to that per-install UUID, and WebAuthn from Firefox extension
  pages is untested.
- **Trusted Types.** Check Firefox's support at the time of packaging. Without
  it, the CSP's `require-trusted-types-for` is ignored, not an error.
- **Review.** AMO review requires the source and build instructions for minified
  bundles. The deterministic build makes that straightforward.

## Maintenance

- **New provider host.** Edit `public/_headers` and
  `.netlify/netlify.toml`, as before. The next `build:extension` picks the host
  up. There is no manifest edit.
- **New permission or manifest key.** Add it to the allowed lists in
  `extension/manifest.ts` and justify it in this file. The build refuses
  otherwise.
- **New logo.** Rerun `node scripts/make-extension-icons.mjs` and commit the
  PNGs.
