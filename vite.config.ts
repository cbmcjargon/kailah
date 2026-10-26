import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The web app's CSP lives in public/_headers (served by the hosts). A host
 * misconfiguration once dropped it on the mirror, and nothing in the page
 * noticed. This repeats the same policy as a <meta http-equiv> tag at build
 * time, so script-src, connect-src and Trusted Types hold even when a host
 * serves no header (audit 2026-10-26, M5). frame-ancestors cannot go in a
 * meta tag; the header still carries it. Build only: the dev server injects
 * an inline refresh preamble that a page-level policy would block.
 */
function kailahMetaCsp(): Plugin {
  let extension = false
  return {
    name: 'kailah-meta-csp',
    apply: 'build',
    configResolved(config) {
      // the extension page gets its policy from the manifest (extension/plugin.ts)
      extension = String(config.define?.__KAILAH_EXTENSION__) === 'true'
    },
    transformIndexHtml(html) {
      if (extension) return html
      const headers = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')
      const line = headers.split('\n').find((l) => /^\s+Content-Security-Policy:/.test(l))
      if (line === undefined) throw new Error('public/_headers has no Content-Security-Policy')
      const policy = line
        .replace(/^\s+Content-Security-Policy:\s*/, '')
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d !== '' && !d.startsWith('frame-ancestors'))
        .join('; ')
      if (!/connect-src 'self' https:\/\//.test(policy) || !policy.includes("script-src 'self'")) {
        throw new Error('public/_headers CSP does not look like the wallet\u2019s policy')
      }
      const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      const out = html.replace(/(<meta charset="UTF-8" \/>)/, `$1\n    ${tag}`)
      if (out === html) throw new Error('index.html: could not add the page-level CSP')
      return out
    },
  }
}

export default defineConfig({
  plugins: [react(), kailahMetaCsp()],
  // src/platform.ts: the web build is never the extension build
  // (vite.extension.config.ts inherits this file and flips it to true).
  define: { __KAILAH_EXTENSION__: 'false' },
  server: { port: 5173 },
})
