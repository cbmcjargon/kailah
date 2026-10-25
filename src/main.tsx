import React from 'react'
import { createRoot } from 'react-dom/client'
import Shell from './Shell'
import { IS_EXTENSION } from './platform'
import './styles.css'

// Trusted Types (enforced by the CSP in Chromium): every DOM sink that could
// inject script is blocked unless a policy vouches for the value. The ONLY
// policy is this default one, and it vouches solely for same-origin script
// URLs (the service worker, the Argon2 worker chunk). There is deliberately
// no createHTML/createScript: innerHTML and friends stay blocked for good —
// a defence against XSS that doesn't exist yet, not just the sinks we know.
interface TrustedTypesShim {
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): unknown
}
const tt = (window as unknown as { trustedTypes?: TrustedTypesShim }).trustedTypes
if (tt !== undefined) {
  try {
    tt.createPolicy('default', {
      createScriptURL: (input) => {
        if (new URL(input, location.href).origin !== location.origin) {
          throw new Error('cross-origin script URL refused')
        }
        return input
      },
    })
  } catch {
    // policy already exists (hot reload) — nothing to do
  }
}

// Service worker enables installability + native notifications. It performs
// no caching (see public/sw.js) — the wallet always runs fresh code.
// Web build only: the extension package has no sw.js; its background service
// worker (src/extension/background.ts) is declared in manifest.json instead.
if (!IS_EXTENSION && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* notifications degrade gracefully without it */
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
)
