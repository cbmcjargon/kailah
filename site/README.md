# Kailah Wallet — marketing site

The public face of the wallet: one static page in this folder, with no build
step. It is separate from the wallet app (`npm run build` → `dist/` never
touches it) and has its own hosting: its own Netlify site, plus a second copy
on the nginx box (below).

## Files

| File | What |
| --- | --- |
| `index.html` | The page. Every claim on it comes from `README.md`, `PRIVACY.md`, `SECURITY.md`, `TRADEMARK.md`, `docs/` and `extension/store/description.txt`. |
| `styles.css` | Dark theme with the wallet's own tokens (`src/styles.css`), system fonts, responsive from 360 px up, honours `prefers-reduced-motion`. |
| `main.js` | Scroll reveal, the phone menu, the "checked before signing" illustration. No network, no storage, no HTML sinks. |
| `_headers` | The site's own security headers (Netlify format), including a CSP of `default-src 'none'` plus `'self'` for scripts, styles and images. `scripts/serve-site.mjs` applies them locally; a non-Netlify host needs them configured the way `deploy/vps-redeploy.sh` does for the wallet. |
| `icon.svg`, `icon-192.png` | Copies of the wallet's logo (`public/`). |
| `img/*.webp` | Real screenshots of v2.7.8, taken from the live site with the public test phrase at 390×844 @2×, then erased. `img/og.jpg` is the link-preview image. |

All asset paths are relative, so the page works at a domain root or under a
path.

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
  https://kailah.netlify.app (the site's own Netlify site). Change all
  three when a custom domain is added; link previews need the absolute
  image address.
- **Version:** the page names v2.7.9 in the hero and the footer. Update
  both on a release, or drop the number.
- **Store link:** the two "Chrome extension" buttons, the official-sources
  line and the FAQ link to the Chrome Web Store listing.
- **Screenshots:** retake after a UI change. The capture used the public
  test wallet in headless Chrome against the live site; the dashboard shot
  shows only Solana and TRON (Settings › Networks shown) because the test
  wallet's other mainnet accounts are empty. Erase the test wallet afterwards.
- **Privacy:** the page sets no cookies and loads nothing from third
  parties, which the footer promises. Keep it that way: no analytics, fonts
  or embeds.
- **Public snapshot:** `ops/make-public-snapshot.sh` exports this folder with
  the rest of the tree, so nothing private may enter it.
