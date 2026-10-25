// Serve dist/ with the exact security headers from public/_headers, so the
// production CSP (incl. Trusted Types) can be exercised locally:
//   npm run build && node scripts/serve-dist.mjs   (or the dist-preview launch config)
// production CSP (incl. Trusted Types) can be exercised locally.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('../dist', import.meta.url))
const headers = {}
for (const line of readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8').split('\n')) {
  const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
  if (m) headers[m[1]] = m[2]
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }
createServer((req, res) => {
  let p = join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(ROOT, 'index.html')
  res.writeHead(200, { ...headers, 'Content-Type': types[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(p))
}).listen(4173, () => console.log('dist preview on http://localhost:4173'))
