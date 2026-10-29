// Is a live site serving exactly this build? Fetches every file of dist/ from
// each origin, compares it byte for byte with the local build, and checks that
// every response carries the security headers of public/_headers, value for
// value, and that every page tells browsers to re-check it (no-cache or
// max-age=0). Run from the repo root, on the commit the site should be serving:
//   npm ci && npm run build && npm run verify:live [origin ...]
// With no origin it checks both official ones. Exits 0 only if all match.
//
// One normalization, always reported: Netlify inserts a fixed "This site is
// hosted on Netlify" HTML comment into HTML pages. Only a comment with that
// exact opening is removed before comparing, and a comment cannot run.
// Anything else that differs, including an added script, fails.
//
// What this proves is what this machine was served, just now. A host could
// serve other bytes to other people or at other times. The store-signed
// extension is what closes that gap.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDigest } from './build-digest.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const ORIGINS = process.argv.length > 2 ? process.argv.slice(2) : ['https://kailah-wallet.netlify.app', 'https://wallet.photoprompting.org']
const NETLIFY_NOTE = /<!-- This site is hosted on Netlify\.[\s\S]*?-->\r?\n?/

/** The `/*` block of public/_headers: the headers every response must carry. */
function managedHeaders() {
  const out = {}
  let inBlock = false
  for (const line of readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n')) {
    if (/^\/\*\s*$/.test(line)) inBlock = true
    else if (inBlock && /^\s+[A-Za-z-]+:/.test(line)) {
      const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
      out[m[1].toLowerCase()] = m[2].trim()
    } else if (inBlock && line.trim() && !/^\s/.test(line)) inBlock = false
  }
  return out
}

async function fetchOne(origin, path) {
  const res = await fetch(`${origin}/${path}`, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
}

/** Run fn over items, at most n at a time. */
async function pool(items, n, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

const expected = managedHeaders()
const build = buildDigest(DIST)
// _headers is configuration Netlify consumes rather than serves; `/` must be index.html.
const paths = [...build.files.map((f) => f.path).filter((p) => p !== '_headers'), '']
const local = (path) => readFileSync(join(DIST, path || 'index.html'))

console.log(`local build: dist/ digest ${build.digest} (${build.files.length} files)`)
let failed = false
for (const origin of ORIGINS) {
  const problems = []
  let normalized = 0
  await pool(paths, 6, async (path) => {
    const shown = '/' + path
    let r
    try {
      r = await fetchOne(origin, path)
    } catch (e) {
      problems.push(`${shown}: fetch failed (${e.cause?.code ?? e.message})`)
      return
    }
    if (r.status !== 200) return problems.push(`${shown}: HTTP ${r.status}`)
    for (const [name, value] of Object.entries(expected)) {
      const got = r.headers.get(name)
      if (got === null) problems.push(`${shown}: missing header ${name}`)
      else if (got !== value) problems.push(`${shown}: header ${name} differs: ${got.slice(0, 80)}`)
    }
    // A page must be re-checked on every visit: one a browser kept could
    // point at chunks a redeploy removed (review 2026-10-29).
    if (path === '' || path.endsWith('.html')) {
      const cache = r.headers.get('cache-control') ?? ''
      if (!/no-cache|max-age=0\b/i.test(cache)) problems.push(`${shown}: a browser may reuse this page (Cache-Control: ${cache || 'none'})`)
    }
    let body = r.body
    const want = local(path)
    if (!body.equals(want) && (path === '' || path.endsWith('.html'))) {
      const stripped = body.toString('utf8').replace(NETLIFY_NOTE, '')
      if (Buffer.from(stripped).equals(want)) {
        body = want
        normalized++
      }
    }
    if (!body.equals(want)) problems.push(`${shown}: content differs from the local build (${r.body.length} bytes served, ${want.length} built)`)
  })
  console.log(`\n${origin}`)
  if (problems.length) {
    failed = true
    for (const p of problems.sort()) console.log(`  FAIL ${p}`)
  } else {
    console.log(`  ✓ ${paths.length} responses byte-identical to the local build` + (normalized ? ` (${normalized} HTML after removing Netlify's hosting comment)` : ''))
    console.log(`  ✓ all ${Object.keys(expected).length} security headers on every response, equal to public/_headers`)
    console.log('  ✓ every page tells browsers to re-check it (no-cache or max-age=0)')
  }
}
console.log(failed ? '\nMISMATCH: the site is not serving this build.' : '\nMATCH: every origin serves exactly this build.')
process.exit(failed ? 1 : 0)
