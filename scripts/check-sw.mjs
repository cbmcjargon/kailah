// check-sw.mjs — OFFLINE. The service worker (public/sw.js), run in a
// sandbox with a fake cache and no network.
//
// Hard rule: it never caches application code — every page load fetches
// fresh code with the CSP enforced. It caches the static offline screen
// only. This suite proves:
//   A. install caches exactly the offline screen and its two files;
//   B. offline, a page navigation gets the offline screen, and the screen's
//      stylesheet and icon come from the cache (they were cached but never
//      served, so the screen showed unstyled; bug audit 2026-10-27, BL36);
//   C. everything else — the app's scripts and styles, API calls, another
//      origin's files of the same name — passes straight to the network,
//      and nothing is ever written to the cache after install.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const ORIGIN = 'https://wallet.example'
const listeners = {}
const stored = new Map()
let writesAfterInstall = 0
let installing = true
const cache = {
  addAll: async (paths) => {
    for (const p of paths) stored.set(p, new Response(`cached ${p}`))
  },
  put: async (req, res) => {
    if (!installing) writesAfterInstall++
    stored.set(typeof req === 'string' ? req : new URL(req.url).pathname, res)
  },
}
let online = false
const sandbox = {
  self: {
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    location: new URL(`${ORIGIN}/sw.js`),
  },
  caches: {
    open: async () => cache,
    keys: async () => ['kailah-offline-v1'],
    delete: async () => true,
    match: async (key) => stored.get(typeof key === 'string' ? key : new URL(key.url).pathname),
  },
  fetch: async (req) => {
    if (!online) throw new TypeError('Failed to fetch')
    return new Response(`network ${req.url}`)
  },
  Response,
  URL,
  Set,
  Promise,
}
vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox)

console.log('--- A. install ---')
{
  let done
  listeners.install({ waitUntil: (p) => (done = p) })
  await done
  installing = false
  check('A1 install caches exactly the offline screen and its two files', [...stored.keys()].sort().join() === '/icon.svg,/offline.css,/offline.html', [...stored.keys()].join())
}

const dispatch = (path, mode, origin = ORIGIN) => {
  let answer = null
  listeners.fetch({ request: { url: `${origin}${path}`, mode }, respondWith: (p) => (answer = p) })
  return answer
}
const text = async (p) => (p === null ? null : (await p).text())

console.log('--- B. offline: the offline screen, whole ---')
{
  check('B1 a page navigation gets the offline screen', (await text(dispatch('/', 'navigate'))) === 'cached /offline.html')
  check('B2 ...its stylesheet comes from the cache (BL36)', (await text(dispatch('/offline.css', 'no-cors'))) === 'cached /offline.css')
  check('B3 ...and so does its icon', (await text(dispatch('/icon.svg', 'no-cors'))) === 'cached /icon.svg')
}

console.log('--- C. nothing else is cached or served from the cache ---')
{
  check('C1 the app\'s scripts and styles pass straight to the network (never answered by the worker)',
    dispatch('/assets/App-abc123.js', 'cors') === null && dispatch('/assets/index-def456.css', 'no-cors') === null && dispatch('/index.html', 'same-origin') === null)
  check('C2 API calls pass straight through', dispatch('/api/anything', 'cors') === null)
  check('C3 another origin\'s file of the same name is not answered from the cache', dispatch('/offline.css', 'no-cors', 'https://evil.example') === null)
  online = true
  check('C4 online, the offline files come from the network (the cache is only a fallback)', (await text(dispatch('/offline.css', 'no-cors'))) === `network ${ORIGIN}/offline.css`)
  check('C5 nothing is written to the cache after install (no runtime caching)', writesAfterInstall === 0)
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  check('C6 the worker\'s source writes the cache only through install\'s addAll', !/\.put\(/.test(src) && (src.match(/addAll\(/g) ?? []).length === 1)
}

console.log(failures === 0 ? '\nAll service worker checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
