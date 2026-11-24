# Kailah Wallet — marketing site

The public face of the wallet: two static pages in this folder, the home page
and a live demo, with no build step. It is separate from the wallet app (`npm run build` → `dist/` never
touches it) and has its own hosting: its own Netlify site, plus a second copy
on the nginx box (below).

## Files

| File | What |
| --- | --- |
| `index.html` | The page. Every claim on it comes from `README.md`, `PRIVACY.md`, `SECURITY.md`, `TRADEMARK.md`, `docs/` and `extension/store/description.txt`. |
| `styles.css` | Dark theme with the wallet's own tokens (`src/styles.css`), system fonts, responsive from 360 px up, honours `prefers-reduced-motion`. |
| `main.js` | Scroll reveal, the phone menu, the "checked before signing" illustration. No network, no storage, no HTML sinks. |
| `rob/index.html` | "Try to rob Kailah", served as `/rob/`: four attacks (address poisoning, a TRON node that rewrites the payment, a Dogecoin data service that lies about a coin, the retry that pays twice) staged in the visitor's browser against the wallet's own checks. Linked from the home page's checks section and footer as `rob/`. A folder, not `rob.html`, because Netlify's Pretty URLs rewrites links to `.html` files in the HTML it serves (`href="rob.html"` came out as `href='/rob'`), and a served page should match this folder byte for byte; its own files sit at the root, as `../`, so it works at `/rob` and `/rob/`. It names no version, so a release can't leave it behind. |
| `rob.css` | The demo's own styles, loaded after `styles.css`; only `rb-` classes. |
| `rob-checks.js` | The checks the demo runs: copies of `src/lib/lookalike.ts`, `tron.ts`'s TRX send check and `rawtxcache.ts`'s coin ID, plus the made-up addresses and staged attacks. |
| `rob.js` | The demo's widgets, built from DOM nodes and text only (Trusted Types). No network, no storage. |
| `_headers` | The site's own security headers (Netlify format), including a CSP of `default-src 'none'` plus `'self'` for scripts, styles and images. `scripts/serve-site.mjs` applies them locally; a non-Netlify host needs them configured the way `deploy/vps-redeploy.sh` does for the wallet. |
| `icon.svg`, `icon-192.png` | Copies of the wallet's logo (`public/`). |
| `img/*.webp` | Real screenshots of v2.7.8, taken from the live site with the public test phrase at 390×844 @2×, then erased. `img/og.jpg` is the link-preview image. |

All asset paths are relative, so the pages work at a domain root or under a
path.

## The demo is held to the wallet

`scripts/check-sitedemo.mjs`, part of `npm run check:offline` and so of CI,
runs `rob-checks.js` beside the wallet's own modules on 81,200 seeded cases
and fails on any different verdict or message. It also pins the wallet code
the copy follows by hand (prepareTronSend's TRX check, verifyTxId, the
Dogecoin signer's hash and fee checks), the words the page quotes
(LookalikeWarning, RecipientNote, EvmSendWaiting) and the numbers it states.
So a change to any of those fails CI until `rob-checks.js`, `rob.js` or
`rob/index.html` follow, and the site then needs both its deploys. If the number of
cases changes, the page's list and its lead change with it.

## Preview

Start the `site-preview` launch config (`node scripts/serve-site.mjs`, port
4174). It serves this folder with `_headers`, so a CSP violation shows up in
the console exactly as it would on a host.

## Mirror on nginx (beside the wallet's second origin)

`deploy/site-redeploy.sh` ships this folder to the nginx box as its own
server block and webroot, so the wallet's config is never touched. It
applies every header in `_headers` the way the wallet's deploy applies
`public/_headers` (`deploy/nginx-site.awk`, under the site's own cache
variable), makes browsers re-check the page on every visit, serves a 404 for
unknown paths, and checks all of that live afterwards. The mirror keeps no
access log, its http redirect included: the deploy turns it off in every
server block and checks with marked requests that nothing was logged. First
time: add an A record for the chosen name pointing at the box (DNS only, not
proxied), then run it with `--install`, which also obtains the certificate
through certbot. Later deploys are the same command without the flag:

```bash
SITE_HOST=<hostname> WALLET_VPS=<user@host> deploy/site-redeploy.sh --install
```

Netlify stays the canonical copy (`og:url`, the canonical link), so the
mirror is a second copy of the same page, not a second identity.

## Before publishing

- **Domain:** `og:url`, `og:image` and the canonical link point at
  https://kailah.netlify.app (the site's own Netlify site), on both pages, and
  `sitemap.xml` and `robots.txt` name it too. Change them all when a custom
  domain is added; link previews need the absolute image address.
- **Version:** the page names v2.8.2 in the hero and the footer. Update
  both on a release, or drop the number.
- **Store link:** the two "Chrome extension" buttons, the official-sources
  line and the FAQ link to the Chrome Web Store listing.
- **Search Console:** the `google-site-verification` tag proves this site is the
  owner's, for the store listing's Official URL. Google re-checks it, so it stays.
- **Screenshots:** retake after a UI change. The capture used the public
  test wallet in headless Chrome against the live site; the dashboard shot
  shows only Solana and TRON (Settings › Networks shown) because the test
  wallet's other mainnet accounts are empty. Erase the test wallet afterwards.
- **Privacy:** the page sets no cookies and loads nothing from third
  parties, which the footer promises. Keep it that way: no analytics, fonts
  or embeds.
- **Public snapshot:** `ops/make-public-snapshot.sh` exports this folder with
  the rest of the tree, so nothing private may enter it.
