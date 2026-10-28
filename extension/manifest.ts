// Manifest V3 description of the Kailah Wallet extension, plus the extension
// page CSP derived from the web app's own policy. Used only by
// vite.extension.config.ts at build time; see docs/extension.md.
//
// Two rules this file enforces so they cannot drift silently:
//   1. The extension page CSP is the web CSP from public/_headers, read at
//      build time. Same connect-src hosts, same Trusted Types directives. If
//      the web CSP ever stops being valid for an extension (a remote script
//      host, say), the build fails here with a reason, not later in Chrome.
//   2. The privilege surface is pinned: the build refuses to emit a manifest
//      that grants anything beyond the list below. Adding a permission means
//      editing ALLOWED_PERMISSIONS on purpose, with a justification in
//      docs/extension.md.

/** Pull the Content-Security-Policy value out of a Netlify-style _headers file. */
export function webCspFromHeaders(headersText: string): string {
  const m = /^[ \t]+Content-Security-Policy:[ \t]*(.+)$/m.exec(headersText)
  if (m === null) throw new Error('public/_headers has no Content-Security-Policy line')
  return m[1].trim()
}

export type Directives = Map<string, string[]>

export function parseCsp(csp: string): Directives {
  const out: Directives = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t !== '')
    if (tokens.length === 0) continue
    const [name, ...values] = tokens
    const key = name.toLowerCase()
    if (out.has(key)) throw new Error(`CSP directive ${key} appears twice`)
    out.set(key, values)
  }
  return out
}

export function serializeCsp(d: Directives): string {
  return [...d].map(([k, v]) => (v.length > 0 ? `${k} ${v.join(' ')}` : k)).join('; ')
}

/** The provider hosts the app may contact (connect-src minus 'self'). */
export function connectHosts(d: Directives): string[] {
  return (d.get('connect-src') ?? []).filter((v) => v.startsWith('https://'))
}

function requireExactly(d: Directives, name: string, expected: string[]): void {
  const got = d.get(name)
  if (got === undefined || got.join(' ') !== expected.join(' ')) {
    throw new Error(
      `extension CSP: ${name} must be "${expected.join(' ')}" but the web CSP has "${got?.join(' ') ?? '(missing)'}"`,
    )
  }
}

/**
 * The CSP for extension pages, derived from the web CSP. Chrome serves the
 * manifest's extension_pages policy as the page's CSP header, so the web
 * policy carries over unchanged. What is validated here is that it is still
 * acceptable to MV3 (no remote code) and still as strict as the
 * extension relies on.
 */
export function extensionPagesCsp(webCsp: string): string {
  const d = parseCsp(webCsp)
  // MV3 forbids remote code: only packaged scripts and workers may run.
  requireExactly(d, 'default-src', ["'self'"])
  requireExactly(d, 'script-src', ["'self'"])
  if (d.has('worker-src')) requireExactly(d, 'worker-src', ["'self'"])
  requireExactly(d, 'object-src', ["'none'"])
  // Trusted Types: the default policy in src/main.tsx must still be the only one.
  requireExactly(d, 'require-trusted-types-for', ["'script'"])
  requireExactly(d, 'trusted-types', ['default'])
  const connect = d.get('connect-src') ?? []
  if (connect[0] !== "'self'" || connect.slice(1).some((v) => !/^https:\/\/[a-z0-9.-]+$/.test(v))) {
    throw new Error(`extension CSP: connect-src must be 'self' plus bare https hosts, got "${connect.join(' ')}"`)
  }
  return serializeCsp(d)
}

/** Every key the manifest may contain; anything else fails the build. */
const ALLOWED_KEYS = new Set([
  'manifest_version',
  'name',
  'short_name',
  'version',
  'description',
  'minimum_chrome_version',
  'icons',
  'action',
  'background',
  'permissions',
  'content_security_policy',
  'cross_origin_opener_policy',
  'externally_connectable',
])

/**
 * - "notifications": lets the wallet tab show the generic, amount-free
 *   payment alert through the background worker's registration
 *   (src/lib/notify.ts). Without it Chrome denies notifications to extension
 *   pages outright. Install warning: "Display notifications".
 * - "unlimitedStorage": Chrome's documented way to exempt an extension's web
 *   storage (the localStorage that holds the encrypted vault) from quota
 *   eviction. No install warning.
 * Nothing else is requested: no host_permissions (providers are reached
 * through CORS exactly as on the web, see docs/extension.md), no tabs, no
 * scripting, no content scripts, no web_accessible_resources.
 */
const ALLOWED_PERMISSIONS = ['notifications', 'unlimitedStorage']

export interface Manifest {
  manifest_version: 3
  [key: string]: unknown
}

export function buildManifest(version: string, extensionCsp: string): Manifest {
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }
  const manifest: Manifest = {
    manifest_version: 3,
    name: 'Kailah Wallet',
    short_name: 'Kailah',
    version,
    // The store's summary line. No ticker list: "BTC, DOGE, LTC, USDC, ETH,
    // BNB, SOL and TRX" here got the listing rejected as keyword spam
    // (Yellow Argon, 2026-10-28); the build refuses one now.
    description:
      'A self-custody crypto wallet. Your keys are created and encrypted on this device and never leave it.',
    // 116: chrome.runtime.getContexts (background.ts). Trusted Types (83) and
    // the manifest COOP key (93) are older.
    minimum_chrome_version: '116',
    icons,
    // No default_popup: the click goes to background.ts, which opens the
    // wallet as a full tab.
    action: { default_title: 'Open Kailah Wallet', default_icon: { 16: icons[16], 32: icons[32] } },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ALLOWED_PERMISSIONS,
    content_security_policy: { extension_pages: extensionCsp },
    // The web app sends Cross-Origin-Opener-Policy: same-origin as a header;
    // extensions cannot set headers, but MV3 has this key for it.
    cross_origin_opener_policy: { value: 'same-origin' },
    // No other extension may message this one (and no web page: there is no
    // "matches" entry). The background registers no external listeners
    // anyway; this keeps it that way if one is ever added by mistake.
    externally_connectable: { ids: [] },
  }
  assertPrivilegeSurface(manifest)
  return manifest
}

export function assertPrivilegeSurface(manifest: Manifest): void {
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`manifest: "${key}" is not on the allowed list in extension/manifest.ts`)
    }
  }
  const perms = (manifest.permissions as string[] | undefined) ?? []
  for (const p of perms) {
    if (!ALLOWED_PERMISSIONS.includes(p)) throw new Error(`manifest: permission "${p}" is not allowed`)
  }
  const desc = manifest.description
  if (typeof desc !== 'string' || desc.length > 132) {
    throw new Error('manifest: description must be a string of at most 132 characters (Chrome Web Store limit)')
  }
  if (/\b[A-Z]{2,5}\b(?:,\s*(?:and\s+)?[A-Z]{2,5}\b|\s+and\s+[A-Z]{2,5}\b){2,}/.test(desc)) {
    throw new Error('manifest: description lists tickers; the Chrome Web Store rejects that as keyword spam (Yellow Argon)')
  }
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
    throw new Error(`manifest: version "${String(manifest.version)}" is not 1-4 dot-separated integers`)
  }
}
