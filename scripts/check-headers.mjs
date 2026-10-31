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
//      the marketing site's mirror (deploy/site-redeploy.sh, its server block
//      deploy/nginx-site-marketing.conf) goes through the same rewrite from
//      site/_headers under its own map variable, with no fallback page;
//   D. verify:live and the redeploy script check that pages aren't cached;
//   E. the health check (npm run check:health) covers every host in the CSP,
//      and reads answers rightly: a server that can only say which network it
//      is fails it (cloudflare-eth.com's real answers, 2026-10-30), a backup
//      that 404s address lookups fails it (emzy's testnet4), and a rate limit
//      or a bot check doesn't.
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

/** The `/*` block of a Netlify _headers file (public/_headers by default), as [name, value] pairs. */
function headersFile(file = 'public/_headers') {
  const out = []
  let inBlock = false
  for (const line of read(file).split('\n')) {
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
    /chain\.rpcs\.map\(\(url\) => pausableHttp\(url, chain\.rpcs\)\)/.test(evmSrc) && [...evmSrc.matchAll(/fetch\(([^,)]*)/g)].every((m) => /^url$/.test(m[1])) &&
      [...evmSrc.matchAll(/explorerGet\(([^,)]*)/g)].every((m) => /chain\.blockscoutBase|\$\{base\}|url: string/.test(m[1])))

  const privacy = read('PRIVACY.md')
  const unnamed = [...connect].map((o) => new URL(o).host).filter((h) => !privacy.includes(h))
  check('B4 PRIVACY.md names every host the wallet can reach', unnamed.length === 0, unnamed.join(', '))
  check('B5 the second Solana server is Pocket Network\'s gateway, in the CSP and the privacy policy',
    connect.has('https://solana.api.pocket.network') && /solana\.api\.pocket\.network/.test(privacy) && /Pocket Network/.test(privacy))
  check('B5b so is Ethereum\'s (2026-10-30), and the dead cloudflare-eth.com is gone from the code, the CSP and the policy',
    EVM_CHAINS.ethereum.rpcs.join() === 'https://ethereum-rpc.publicnode.com,https://eth.api.pocket.network' &&
      connect.has('https://eth.api.pocket.network') && /eth\.api\.pocket\.network/.test(privacy) &&
      !connect.has('https://cloudflare-eth.com') && !privacy.includes('cloudflare-eth.com') && !/rpcs:.*cloudflare/.test(evmSrc))
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

  // The marketing site's mirror: its own server block, the same rewrite, from
  // site/_headers, under its own map variable (two site files in one nginx
  // must not both define $kailah_html_cache).
  const siteScript = read('deploy/site-redeploy.sh')
  const sconv = /awk '\n([\s\S]*?)\n' site\/_headers > "\$HEADERS_FILE"/.exec(siteScript)
  check('C10 the site deploy script builds its add_header lines from site/_headers, ships the same rewrite under the site\'s own cache variable, and checks the page for no-cache',
    sconv !== null && /scp [^\n]*deploy\/nginx-site\.awk/.test(siteScript) && /-v var=\$VAR/.test(siteScript) &&
      /^VAR=kailah_site_html_cache/m.test(siteScript) && /grep -qi 'no-cache'/.test(siteScript))
  const siteHeaders = headersFile('site/_headers')
  check('C11 site/_headers carries the same seven header names as the wallet\'s, with the site\'s own default-src \'none\' policy',
    siteHeaders.map(([n]) => n).sort().join() === headers.map(([n]) => n).sort().join() &&
      /^default-src 'none'; script-src 'self'/.test(siteHeaders.find(([n]) => n === 'Content-Security-Policy')?.[1] ?? ''),
    siteHeaders.map(([n]) => n).join(', '))
  const shdrs = execFileSync('awk', [sconv[1], 'site/_headers'], { encoding: 'utf8' }).replace(/\n$/, '')
  const smanaged = shdrs.split('\n').map((l) => /add_header ([A-Za-z-]+) /.exec(l)[1]).join(' ')
  const sdir = mkdtempSync(join(tmpdir(), 'kailah-nginx-site-'))
  writeFileSync(join(sdir, 'headers.conf'), shdrs + '\n')
  writeFileSync(join(sdir, 'gzip.conf'), '    # kailah-gzip: managed by deploy/site-redeploy.sh\n    gzip on;\n')
  const tpl = read('deploy/nginx-site-marketing.conf').replace(/@SITE_HOST@/g, 'site.example').replace(/@ROOT@/g, '/var/www/site')
  const srewrite = (conf, extra = ['-v', 'nolog=1']) => {
    const f = join(sdir, 'site.conf')
    writeFileSync(f, conf)
    return spawnSync('awk', ['-v', `hdrsfile=${join(sdir, 'headers.conf')}`, '-v', `gzfile=${join(sdir, 'gzip.conf')}`, '-v', `managed=${smanaged}`, '-v', 'var=kailah_site_html_cache', ...extra, '-f', 'deploy/nginx-site.awk', f], { encoding: 'utf8' })
  }
  const sonce = srewrite(tpl)
  const sout = sonce.stdout
  const slines = sout.split('\n')
  const scount = (re) => slines.filter((l) => re.test(l)).length
  const sblocks = 1 + scount(/^\s*location\s/)
  check('C12 the site\'s template rewrites cleanly: the map names the site\'s own variable (the wallet\'s appears nowhere), every site header at its _headers value is in the server block and in all three locations, HTML gets no-cache, and an unknown path is a 404, never index.html',
    sonce.status === 0 && slines[0] === 'map $sent_http_content_type $kailah_site_html_cache { ~^text/html "no-cache"; default ""; } # kailah-html-cache' &&
      !/\$kailah_html_cache\b/.test(sout) && sblocks === 4 &&
      siteHeaders.every(([n, v]) => scount(new RegExp(`^\\s+add_header ${n} "${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" always;$`)) === sblocks) &&
      scount(/add_header Cache-Control \$kailah_site_html_cache always; # kailah-html-cache$/) === sblocks &&
      /try_files \$uri \$uri\/ =404;/.test(sout) && !/\/index\.html;/.test(sout),
    sonce.stderr.trim() || `${sblocks} blocks`)
  const stwice = srewrite(sout)
  check('C13 a second run of the site file changes nothing, and without var the rewrite still names the wallet\'s variable',
    stwice.status === 0 && stwice.stdout === sout && out.includes('$kailah_html_cache ') && !out.includes('kailah_site_html_cache'))
  // The archive's raw entries, parsed here: macOS tar -t merges its ._* entries
  // back into the file they belong to, so a listing could never show them.
  const star = /^((?:COPYFILE_DISABLE=1 )?tar -C site [^|\n]*-cf - \.) \|/m.exec(siteScript)
  const sraw = star ? spawnSync('bash', ['-c', star[1]], { maxBuffer: 1 << 27 }).stdout : Buffer.alloc(0)
  const smembers = []
  for (let off = 0; off + 512 <= sraw.length; ) {
    const h = sraw.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const field = (from, to) => h.toString('latin1', from, to).replace(/\0[\s\S]*$/, '')
    if (!['x', 'g'].includes(String.fromCharCode(h[156]))) smembers.push(field(0, 100))
    off += 512 + Math.ceil(parseInt(field(124, 136).trim() || '0', 8) / 512) * 512
  }
  const sjunk = smembers.filter((m) => /(^|\/)(\._|\.DS_Store$)/.test(m))
  check('C14 the site deploy\'s archive holds the site\'s files only: no ._* entries from macOS tar (nginx would serve them), neither _headers nor README.md, and the script compares the whole webroot with site/ afterwards',
    /^COPYFILE_DISABLE=1 tar -C site /m.test(siteScript) && smembers.includes('./index.html') && smembers.includes('./img/og.jpg') &&
      sjunk.length === 0 && !smembers.includes('./_headers') && !smembers.includes('./README.md') &&
      /\[ "\$WANT_TREE" = "\$GOT_TREE" \]/.test(siteScript),
    `${smembers.length} entries, ${sjunk.length} of them metadata`)
  check('C15 the wallet deploy\'s archive leaves out macOS metadata too (COPYFILE_DISABLE on its tar): nginx would serve those ._* entries, and verify:live only fetches dist/\'s own files',
    /^COPYFILE_DISABLE=1 tar -C dist -cf - \. \|/m.test(read('deploy/vps-redeploy.sh')))
  // The live file's shape: certbot's TLS lines and redirect block, and the log
  // line the mirror had when it first went live.
  const certbotShape = tpl.replace('access_log off;', 'access_log /var/log/nginx/site.access.log;').replace(/\n\s*listen 80;\n\}\s*$/,
    '\n    listen 443 ssl; # managed by Certbot\n    ssl_certificate /etc/letsencrypt/live/site.example/fullchain.pem; # managed by Certbot\n}\n' +
    'server {\n    if ($host = site.example) {\n        return 301 https://$host$request_uri;\n    } # managed by Certbot\n\n    server_name site.example;\n    listen 80;\n    return 404; # managed by Certbot\n}\n')
  const nolog = srewrite(certbotShape)
  const noLogBlocks = nolog.stdout.split(/^server \{$/m).slice(1)
  const keptLog = srewrite(certbotShape, []).stdout
  check('C16 the site keeps no access log: after the rewrite every server block, certbot\'s redirect too, has "access_log off;" and no other log line, a second run changes nothing, and the deploy passes nolog and proves it live; without nolog, as the wallet\'s deploy runs it, the rewrite leaves log lines alone',
    nolog.status === 0 && noLogBlocks.length === 2 && /listen 80;/.test(noLogBlocks[1]) && /return 301/.test(noLogBlocks[1]) &&
      noLogBlocks.every((b) => /^\s*access_log off;$/m.test(b) && b.match(/^\s*access_log\s/gm).length === 1) &&
      srewrite(nolog.stdout).stdout === nolog.stdout &&
      /-v var=\$VAR -v nolog=1 /.test(siteScript) && /grep -ls -- '\$MARK' \/var\/log\/nginx\/\*\.log/.test(siteScript) &&
      !/nolog/.test(read('deploy/vps-redeploy.sh')) &&
      keptLog.includes('access_log /var/log/nginx/site.access.log;') && !keptLog.includes('access_log off;'),
    nolog.stderr.trim() || `${noLogBlocks.length} server blocks`)
  rmSync(sdir, { recursive: true, force: true })
}

console.log('--- D. the live check ---')
{
  const live = read('scripts/verify-live.mjs')
  check('D1 verify:live fails a page a browser may reuse (no no-cache or max-age=0)',
    /path === '' \|\| path\.endsWith\('\.html'\)/.test(live) && /no-cache\|max-age=0/.test(live))
}

console.log('--- E. the health check ---')
{
  const { CHAINS } = await import('../src/lib/networks.ts')
  const { EVM_CHAINS } = await import('../src/lib/evm.ts')
  const { SOL_CHAINS } = await import('../src/lib/sol.ts')
  const { TRON_CHAINS, tronAddressToHex } = await import('../src/lib/tron.ts')
  const { servicesFor, classifyAnswer, classifyNoAnswer, preflightProblem, markLagging, verdictOf, WALLET_ORIGINS } = await import('./health-probes.mjs')
  const services = servicesFor({ CHAINS, EVM_CHAINS, SOL_CHAINS, TRON_CHAINS, tronAddressToHex })
  const probed = new Set(services.map((s) => `https://${s.host}`))
  const unprobed = [...connect].filter((h) => !probed.has(h))
  const extra = [...probed].filter((h) => !connect.has(h))
  check('E1 it probes every host in connect-src and nothing else, so a new service can\'t go unwatched',
    unprobed.length === 0 && extra.length === 0, [...unprobed, ...extra].join(', ') || `${probed.size} hosts, ${services.length} services`)
  const rpcCount = Object.values(EVM_CHAINS).reduce((n, c) => n + c.rpcs.length, 0) + Object.values(SOL_CHAINS).reduce((n, c) => n + c.rpcs.length, 0)
  check('E1b every RPC of every chain gets its own probe, with a browser permission check', services.filter((s) => s.role === 'node' && s.preflight === true).length === rpcCount + Object.keys(TRON_CHAINS).length)
  check('E1c it runs from the three places the wallet runs', WALLET_ORIGINS.length === 3 && WALLET_ORIGINS[0].endsWith('netlify.app') && WALLET_ORIGINS[1].startsWith('https://wallet.') && WALLET_ORIGINS[2].startsWith('chrome-extension://'))

  const origin = WALLET_ORIGINS[0]
  const answer = (call, text, over = {}) =>
    classifyAnswer({ status: 200, text, acao: '*', cfMitigated: false, origin, verdict: over.status && over.status !== 200 ? true : call.check(text, {}), ...over })
  const rpc = (error, result) => JSON.stringify({ jsonrpc: '2.0', id: 1, ...(error ? { error: { code: -32000, message: error } } : { result }) })
  const eth = services.find((s) => s.host === 'ethereum-rpc.publicnode.com')
  const call = (label) => eth.calls.find((c) => c.label === label)
  // cloudflare-eth.com's real answers, 2026-10-30
  const cf = [answer(call('latest block'), rpc('Cannot fulfill request')), answer(call('balance'), rpc('Internal error')), answer(call('token balance'), rpc('Internal error')), answer(call('takes transactions'), rpc('Cannot fulfill request'))]
  check('E2 a server that can only say which network it is fails: "Cannot fulfill request", "Internal error"',
    cf.every((r) => r.state === 'broken') && /Cannot fulfill/.test(cf[0].detail) && /can't take transactions/.test(cf[3].detail), cf.map((r) => r.detail).join(' | '))
  const good = [answer(call('latest block'), rpc(null, '0x1916770')), answer(call('balance'), rpc(null, '0x2')), answer(call('fee data'), rpc(null, { number: '0x1' })), answer(call('takes transactions'), rpc('reading transaction object failed - rawTx: 0x00')), answer(call('takes transactions'), rpc('failed to decode signed transaction')), answer(call('takes transactions'), rpc('input too short'))]
  check('E2b a working server passes, and refusing an undecodable transaction, in any node\'s words, is what working looks like',
    good.every((r) => r.state === 'ok'), good.map((r) => r.state + r.detail).join())
  check('E2c a server that accepts an undecodable transaction fails', answer(call('takes transactions'), rpc(null, '0xabc')).state === 'broken')
  // mempool.emzy.de's real testnet4 behaviour: tips fine, address lookups 404
  const tn = services.find((s) => s.chainId === 'btc-testnet' && s.calls[0].url.includes('mempool.space'))
  const addr = tn.calls.find((c) => c.label === 'address')
  check('E3 a backup that answers tips but 404s address lookups fails', answer(addr, '<html>404 Not Found</html>', { status: 404 }).state === 'broken')
  check('E3b a rate limit is "busy", as a 429 or in JSON-RPC words: nothing to conclude',
    answer(addr, 'Too Many Requests', { status: 429 }).state === 'busy' && answer(call('balance'), rpc('rate limit exceeded')).state === 'busy')
  check('E3c a bot check says it can\'t tell, a server error is "down", and so is no answer',
    answer(addr, '<title>Just a moment...</title>', { status: 403 }).state === 'bot-check' && answer(addr, 'x', { status: 403, cfMitigated: true }).state === 'bot-check' &&
      answer(addr, 'Bad gateway', { status: 502 }).state === 'down' && classifyNoAnswer(Object.assign(new Error('x'), { name: 'TimeoutError' })).state === 'down' && classifyNoAnswer(new TypeError('fetch failed')).state === 'down')
  check('E3d a 403 that isn\'t a bot check fails: Solana\'s own server refuses browser origins that way', answer(addr, 'Access forbidden', { status: 403 }).state === 'broken')
  check('E3e an answer a browser may not read fails', answer(call('balance'), rpc(null, '0x2'), { acao: null }).state === 'broken' && answer(call('balance'), rpc(null, '0x2'), { acao: 'https://other.example' }).state === 'broken' && answer(call('balance'), rpc(null, '0x2'), { acao: origin }).state === 'ok')
  check('E4 browser permission: an echoed origin or * passes; another origin, a refusal or no JSON allowed fails; a rate limit says nothing',
    preflightProblem({ status: 204, acao: origin, acah: 'content-type', origin }) === null && preflightProblem({ status: 204, acao: '*', acah: '*', origin }) === null &&
      preflightProblem({ status: 204, acao: 'https://other.example', acah: 'content-type', origin }) !== null && preflightProblem({ status: 404, acao: null, acah: null, origin }) !== null &&
      preflightProblem({ status: 204, acao: '*', acah: 'authorization', origin }) !== null && preflightProblem({ status: 429, acao: null, acah: null, origin }) === null)

  const svc = (over) => ({ network: 'Litecoin', chainId: 'ltc', role: 'data', name: 'x', state: 'ok', detail: '', ms: 100, ...over })
  const lag = markLagging([svc({ name: 'litecoinspace.org', height: 100 }), svc({ name: 'bitcore', height: 114 })])
  check('E5 a service 14 blocks behind on Litecoin is flagged (litecoinspace, 2026-10-27), the leader isn\'t',
    lag[0].state === 'lagging' && /14 blocks behind bitcore/.test(lag[0].detail) && lag[1].state === 'ok')
  check('E5b a few blocks behind isn\'t', markLagging([svc({ height: 100 }), svc({ height: 103 })])[0].state === 'ok')
  const v = (...r) => verdictOf(r)
  check('E6 a broken service fails the check; a job with nothing answering fails it; one down beside one working passes with a note',
    v(svc({}), svc({ state: 'broken', detail: 'x' })).exitCode === 1 && v(svc({ state: 'down', detail: 'x' }), svc({ state: 'down', detail: 'x' })).exitCode === 1 &&
      v(svc({}), svc({ state: 'down', detail: 'x' })).exitCode === 0 && v(svc({}), svc({ state: 'down', detail: 'x' })).warns.length === 1)
  check('E6b busy, a bot check, lagging and slow are notes, never a failure',
    v(svc({ state: 'busy', detail: 'x' }), svc({ state: 'bot-check', detail: 'x' }), svc({ state: 'lagging', detail: 'x' }), svc({ state: 'slow' })).exitCode === 0)
  const pkg = JSON.parse(read('package.json'))
  check('E7 npm run check:health runs it, and it stays out of the offline suite CI runs (it needs the network)',
    /check-health\.mjs/.test(pkg.scripts['check:health']) && !/\bhealth\b/.test(pkg.scripts['check:offline']))
}

console.log(failures === 0 ? '\nAll header checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
