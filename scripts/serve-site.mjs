// Serve the marketing site (site/) with the exact security headers from
// site/_headers, so its CSP can be exercised locally:
//   node scripts/serve-site.mjs   (or the site-preview launch config, port 4174)
// Plain static files, no SPA fallback: an unknown path is a 404, as on a host.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../site', import.meta.url))
const PORT = Number(process.env.PORT) || 4174

const headers = {}
for (const line of readFileSync(join(ROOT, '_headers'), 'utf8').split('\n')) {
  const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
  if (m) headers[m[1]] = m[2]
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

createServer((req, res) => {
  let rel
  try {
    rel = decodeURIComponent((req.url ?? '/').split('?')[0])
  } catch {
    rel = '/'
  }
  let p = resolve(ROOT, '.' + rel)
  if (p !== ROOT && !p.startsWith(ROOT + sep)) p = ROOT
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
  if (!existsSync(p) || statSync(p).isDirectory() || p.endsWith(sep + '_headers')) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Not found\n')
    return
  }
  res.writeHead(200, { ...headers, 'Content-Type': types[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(p))
}).listen(PORT, () => console.log(`site preview on http://localhost:${PORT}`))
