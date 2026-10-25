// Vite plugin for the extension build (vite.extension.config.ts). It
//   - rewrites index.html for an extension page (drops the PWA-only tags and
//     adds the referrer policy the web app sends as a header),
//   - emits manifest.json with the CSP derived from public/_headers,
//   - copies the icons the extension uses, and
//   - checks the finished package and fails the build if any invariant in
//     docs/extension.md is broken (no PWA service worker, no caching, no
//     inline or remote script, the CSP hosts identical to the web app's).

import { readFileSync } from 'node:fs'
import type { OutputBundle } from 'rollup'
import type { Plugin } from 'vite'
import {
  buildManifest,
  connectHosts,
  extensionPagesCsp,
  parseCsp,
  webCspFromHeaders,
  type Manifest,
} from './manifest'

const ROOT = new URL('..', import.meta.url)
const read = (path: string): Buffer => readFileSync(new URL(path, ROOT))

const ICON_SIZES = [16, 32, 48, 128] as const

/** Files copied verbatim from public/ (the rest of public/ is the PWA shell). */
const FROM_PUBLIC = [
  'icon.svg', // favicon link in index.html
  'icon-192.png', // notification icon (src/lib/notify.ts)
]

/** Web-only files that must never appear in the extension package. */
const FORBIDDEN = ['sw.js', '_headers', 'manifest.webmanifest', 'offline.html', 'offline.css', 'apple-touch-icon.png']

export function extensionHtml(html: string): string {
  let out = html
    .replace(/\n\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\n\s*<link rel="apple-touch-icon"[^>]*>/, '')
    .replace(/\n\s*<meta name="(apple-mobile-web-app-[a-z-]+|mobile-web-app-capable)"[^>]*>/g, '')
  // The web app sends Referrer-Policy: no-referrer as a header; an extension
  // page cannot set headers, so the same policy goes in a meta tag.
  out = out.replace(/(<meta charset="UTF-8" \/>)/, '$1\n    <meta name="referrer" content="no-referrer" />')
  if (out.includes('webmanifest') || out.includes('apple-')) {
    throw new Error('extension index.html still references a PWA-only file')
  }
  if (!out.includes('name="referrer" content="no-referrer"')) {
    throw new Error('extension index.html: could not add the referrer policy')
  }
  return out
}

function source(bundle: OutputBundle, name: string): string {
  const item = bundle[name]
  if (item === undefined) throw new Error(`extension package is missing ${name}`)
  return item.type === 'chunk' ? item.code : String(item.source)
}

/** Post-build invariants. Throws with the first violation. */
function checkPackage(bundle: OutputBundle, webCsp: string): void {
  const names = Object.keys(bundle)
  for (const f of FORBIDDEN) {
    if (names.includes(f)) throw new Error(`extension package must not contain ${f}`)
  }
  if (!names.some((n) => /^assets\/argon\.worker-[\w-]+\.js$/.test(n))) {
    throw new Error('extension package is missing the Argon2 worker chunk')
  }
  for (const size of ICON_SIZES) source(bundle, `icons/icon-${size}.png`)

  // Only packaged module scripts: no inline code, nothing remote.
  const html = source(bundle, 'index.html')
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\bsrc="\/assets\/[\w.-]+\.js"/.test(tag)) throw new Error(`index.html has a non-packaged script: ${tag}`)
  }
  if (/<script\b[^>]*>[^<\s]/.test(html)) throw new Error('index.html has an inline script')

  // The background worker caches nothing, intercepts nothing, fetches nothing.
  const bg = source(bundle, 'background.js')
  for (const banned of ['caches', 'fetch', 'importScripts', 'http://', 'https://', 'localStorage', 'indexedDB']) {
    if (bg.includes(banned)) throw new Error(`background.js must not use ${banned}`)
  }
  // Background must be self-contained: no shared chunk with the wallet page.
  if (/\bimport\b/.test(bg)) throw new Error('background.js must not import other chunks')

  for (const [name, item] of Object.entries(bundle)) {
    if (item.type !== 'chunk') continue
    if (/importScripts\(|import\(\s*["'`]https?:/.test(item.code)) {
      throw new Error(`${name} loads remote code`)
    }
  }

  // The emitted CSP must carry exactly the web app's provider hosts.
  const manifest = JSON.parse(source(bundle, 'manifest.json')) as Manifest
  const extCsp = (manifest.content_security_policy as { extension_pages: string }).extension_pages
  const want = connectHosts(parseCsp(webCsp)).join(' ')
  const got = connectHosts(parseCsp(extCsp)).join(' ')
  if (want !== got || want === '') throw new Error('extension connect-src differs from public/_headers')
}

export function kailahExtension(): Plugin {
  const webCsp = webCspFromHeaders(read('public/_headers').toString('utf8'))
  return {
    name: 'kailah-extension',
    apply: 'build',
    transformIndexHtml: { order: 'pre', handler: extensionHtml },
    generateBundle() {
      const pkg = JSON.parse(read('package.json').toString('utf8')) as { version: string }
      const manifest = buildManifest(pkg.version, extensionPagesCsp(webCsp))
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` })
      for (const f of FROM_PUBLIC) this.emitFile({ type: 'asset', fileName: f, source: read(`public/${f}`) })
      for (const size of ICON_SIZES) {
        const f = `icons/icon-${size}.png`
        this.emitFile({ type: 'asset', fileName: f, source: read(`extension/${f}`) })
      }
    },
    writeBundle(_options, bundle) {
      try {
        checkPackage(bundle, webCsp)
      } catch (e) {
        this.error(e instanceof Error ? e.message : String(e))
      }
    },
  }
}
