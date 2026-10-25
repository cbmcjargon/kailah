// Kailah Wallet service worker.
//
// Security stance: the wallet application itself is NEVER cached — every
// page load fetches fresh code over the network with the site's
// Content-Security-Policy enforced, so a stale or tampered cached copy can
// never run. The only cached files are the static offline screen below.
//
// Responsibilities:
//   1. PWA installability + native notifications (registration.showNotification)
//   2. A friendly offline screen when a navigation fails with no network

const OFFLINE_CACHE = 'kailah-offline-v1'
const OFFLINE_ASSETS = ['/offline.html', '/offline.css', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.addAll(OFFLINE_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Only page navigations get the offline fallback. Everything else —
  // scripts, styles, API calls — passes straight through to the network
  // untouched (no caching, no rewriting).
  if (request.mode !== 'navigate') return
  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match('/offline.html')
      return cached ?? Response.error()
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.length > 0) return windows[0].focus()
      return self.clients.openWindow('/')
    }),
  )
})
