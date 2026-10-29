// check-headers.mjs — OFFLINE. The delivery headers (review 2026-10-29):
//   A. both copies of the security headers (public/_headers and
//      .netlify/netlify.toml) carry the same seven headers, value for value;
//   B. the CSP's connect-src lists EXACTLY the hosts the code fetches from:
//      every provider, RPC, explorer API, price service and Jupiter, read
//      from the modules' own configs, and nothing else; every fetch call
//      site in src/ is one of the modules counted; PRIVACY.md names each host;
//   C. the mirror's nginx rewrite (deploy/nginx-site.awk, run here with this
//      machine's awk on a sample site file): every location carries every
//      header, HTML gets "Cache-Control: no-cache", a location's own
//      Cache-Control survives, old values are replaced, a second run changes
//      nothing, and a location whose `{` isn't on its line stops the run;
//   D. verify:live and the redeploy script check that pages aren't cached.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const read = (f) => readFileSync(f, 'utf8')

/** The `/*` block of public/_headers, as [name, value] pairs. */
function headersFile() {
  const out = []
  let inBlock = false
  for (const line of read('public/_headers').split('\n')) {
    if (/^\/\*\s*$/.test(line)) inBlock = true
    else if (inBlock && /^\s+[A-Za-z-]+:/.test(line)) {
      const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
      out.push([m[1], m[2].trim()])
    } else if (inBlock && line.trim() && !/^\s/.test(line)) inBlock = false
  }
  return out
}
/** The [headers.values] table of .netlify/netlify.toml. */
function netlifyHeaders() {
  const toml = read('.netlify/netlify.toml')
  const block = toml.slice(toml.indexOf('[headers.values]') + '[headers.values]'.length)
  const out = []
  for (const line of block.split('\n')) {
    if (/^\s*\[/.test(line)) break
    const m = /^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/.exec(line)
    if (m) out.push([m[1], m[2]])
  }
  return out
}

console.log('--- A. both copies of the security headers ---')
const headers = headersFile()
const netlify = netlifyHeaders()
{
  const fmt = (h) => h.map(([n, v]) => `${n}: ${v}`).sort().join('\n')
  check('A1 public/_headers lists the seven security headers', headers.length === 7, headers.map(([n]) => n).join(', '))
  check('A2 .netlify/netlify.toml carries the same seven, value for value', fmt(headers) === fmt(netlify), `${netlify.length} in netlify.toml`)
}

console.log('--- B. connect-src is exactly the hosts the code fetches from ---')
const csp = headers.find(([n]) => n === 'Content-Security-Policy')[1]
const connect = new Set(/connect-src([^;]*)/.exec(csp)[1].trim().split(/\s+/).filter((h) => h !== "'self'"))
{
  const { CHAINS } = await import('../src/lib/networks.ts')
  const { EVM_CHAINS } = await import('../src/lib/evm.ts')
  const { SOL_CHAINS } = await import('../src/lib/sol.ts')
  const { TRON_CHAINS } = await import('../src/lib/tron.ts')
  const origin = (u) => new URL(u).origin
  const used = new Map() // origin -> where
  const add = (u, where) => used.set(origin(u), where)
  for (const c of Object.values(CHAINS)) for (const p of c.providers) for (const b of [p.base, p.broadcastBase]) if (b) add(b, `${c.id} provider`)
  for (const c of Object.values(EVM_CHAINS)) {
    for (const r of c.rpcs) add(r, `${c.id} RPC`)
    if (c.blockscoutBase) add(c.blockscoutBase, `${c.id} Blockscout`)
  }
  for (const c of Object.values(SOL_CHAINS)) for (const r of c.rpcs) add(r, `${c.id} RPC`)
  for (const c of Object.values(TRON_CHAINS)) add(c.api, `${c.id} API`)
  // prices.ts and solswap.ts build their URLs inline: every https origin in them is fetched
  for (const f of ['prices.ts', 'solswap.ts']) {
    for (const m of read(`src/lib/${f}`).matchAll(/https:\/\/[a-z0-9.-]+/g)) add(m[0], f)
  }
  const missing = [...used.keys()].filter((o) => !connect.has(o))
  const extra = [...connect].filter((o) => !used.has(o))
  check('B1 every host the code fetches from is in connect-src', missing.length === 0, missing.map((o) => `${o} (${used.get(o)})`).join(', ') || `${used.size} hosts`)
  check('B2 ...and connect-src lists nothing the code doesn\'t fetch from (a stale host is an open door)', extra.length === 0, extra.join(', '))

  // Every fetch call site is in a module counted above, so a new one can't
  // reach a host this check doesn't know about.
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []))
  const counted = ['src/lib/esplora.ts', 'src/lib/blockcypher.ts', 'src/lib/bitcore.ts', 'src/lib/evm.ts', 'src/lib/sol.ts', 'src/lib/tron.ts', 'src/lib/prices.ts', 'src/lib/solswap.ts']
  const sites = walk('src').filter((f) => /\bfetch\(/.test(read(f)))
  const stray = sites.filter((f) => !counted.includes(f))
  check('B3 every fetch call in src/ is in a module whose hosts B1 counts', stray.length === 0, stray.join(', ') || sites.length + ' modules')
  const evmSrc = read('src/lib/evm.ts')
  check('B3b the EVM engine fetches only from its RPCs and Blockscout (viem transports over chain.rpcs)',
    /chain\.rpcs\.map\(\(url\) => pausableHttp\(url, chain\.rpcs\)\)/.test(evmSrc) && [...evmSrc.matchAll(/fetch\(([^,)]*)/g)].every((m) => /chain\.blockscoutBase|\$\{base\}|url/.test(m[1])))

  const privacy = read('PRIVACY.md')
  const unnamed = [...connect].map((o) => new URL(o).host).filter((h) => !privacy.includes(h))
  check('B4 PRIVACY.md names every host the wallet can reach', unnamed.length === 0, unnamed.join(', '))
  check('B5 the second Solana server is Pocket Network\'s gateway, in the CSP and the privacy policy',
    connect.has('https://solana.api.pocket.network') && /solana\.api\.pocket\.network/.test(privacy) && /Pocket Network/.test(privacy))
}

console.log('--- C. the mirror\'s nginx rewrite (deploy/nginx-site.awk) ---')
{
  const script = read('deploy/vps-redeploy.sh')
  // the deploy script's own _headers -> add_header converter, run here as it runs there
  const conv = /awk '\n([\s\S]*?)\n' public\/_headers > "\$HEADERS_FILE"/.exec(script)
  check('C0 the redeploy script builds its add_header lines from public/_headers', conv !== null)
  const hdrs = execFileSync('awk', [conv[1], 'public/_headers'], { encoding: 'utf8' }).replace(/\n$/, '')
  const managed = hdrs.split('\n').map((l) => /add_header ([A-Za-z-]+) /.exec(l)[1]).join(' ')
  const gz = '    # kailah-gzip: managed by deploy/vps-redeploy.sh\n    gzip on;'
  const dir = mkdtempSync(join(tmpdir(), 'kailah-nginx-'))
  writeFileSync(join(dir, 'headers.conf'), hdrs + '\n')
  writeFileSync(join(dir, 'gzip.conf'), gz + '\n')
  const rewrite = (conf, hdrsfile = join(dir, 'headers.conf')) => {
    const f = join(dir, 'site.conf')
    writeFileSync(f, conf)
    return spawnSync('awk', ['-v', `hdrsfile=${hdrsfile}`, '-v', `gzfile=${join(dir, 'gzip.conf')}`, '-v', `managed=${managed}`, '-f', 'deploy/nginx-site.awk', f], { encoding: 'utf8' })
  }
  const SITE = [
    'server {',
    '    server_name wallet.example;',
    '    root /var/www/wallet;',
    '    add_header X-Frame-Options "SAMEORIGIN" always;',
    '    add_header Content-Security-Policy "default-src *" always;',
    '    gzip on;',
    '    location / {',
    '        try_files $uri $uri/ /index.html;',
    '    }',
    '    location /assets/ {',
    '        add_header Cache-Control "public, max-age=31536000, immutable";',
    '    }',
    '    location = /sw.js {',
    '        add_header Cache-Control "no-cache";',
    '    }',
    '}',
    '',
  ].join('\n')
  const once = rewrite(SITE)
  const out = once.stdout
  const lines = out.split('\n')
  const count = (re) => lines.filter((l) => re.test(l)).length
  check('C1 the rewrite runs (exit 0)', once.status === 0, once.stderr.trim())
  check('C2 the HTML cache map comes first, once, in http context: text/html gets no-cache, everything else nothing',
    lines[0] === 'map $sent_http_content_type $kailah_html_cache { ~^text/html "no-cache"; default ""; } # kailah-html-cache' && count(/^map /) === 1)
  const blocks = 1 + count(/^\s*location\s/) // the server block and each location
  const everyHeader = headers.every(([n, v]) => count(new RegExp(`^\\s+add_header ${n} "${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" always;$`)) === blocks)
  check('C3 every security header, at its _headers value, is in the server block and at the top of every location', everyHeader, `${blocks} blocks`)
  check('C4 so is the HTML cache line, once per block', count(/add_header Cache-Control \$kailah_html_cache always; # kailah-html-cache$/) === blocks)
  check('C5 the old values are gone (X-Frame-Options SAMEORIGIN, a wildcard CSP), and gzip appears once, as the managed block',
    !/SAMEORIGIN|default-src \*/.test(out) && count(/^\s*gzip on;/) === 1)
  check('C6 a location\'s own Cache-Control survives (/assets/ immutable, /sw.js no-cache)',
    /add_header Cache-Control "public, max-age=31536000, immutable";/.test(out) && /add_header Cache-Control "no-cache";/.test(out))
  const twice = rewrite(out)
  check('C7 a second run changes nothing', twice.status === 0 && twice.stdout === out)
  const bad = rewrite(SITE.replace('    location / {', '    location /\n    {'))
  check('C8 a location whose { isn\'t on its own line stops the run (exit 3)', bad.status === 3, `exit ${bad.status}`)
  const empty = rewrite(SITE, join(dir, 'missing.conf'))
  check('C8b a headers file that can\'t be read stops the run (exit 4) instead of writing a site with no security headers', empty.status === 4, `exit ${empty.status}`)
  rmSync(dir, { recursive: true, force: true })
  check('C9 the redeploy script ships the rewrite file and checks the page for no-cache after reloading',
    /scp [^\n]*deploy\/nginx-site\.awk/.test(script) && /-v hdrsfile=\/tmp\/wallet-headers\.conf -v gzfile=\/tmp\/wallet-gzip\.conf/.test(script) &&
      /-f \/tmp\/wallet-site\.awk/.test(script) && /grep -qi 'no-cache'/.test(script))
}

console.log('--- D. the live check ---')
{
  const live = read('scripts/verify-live.mjs')
  check('D1 verify:live fails a page a browser may reuse (no no-cache or max-age=0)',
    /path === '' \|\| path\.endsWith\('\.html'\)/.test(live) && /no-cache\|max-age=0/.test(live))
}

console.log(failures === 0 ? '\nAll header checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
