// Kailah Wallet — Manifest V3 background service worker (extension build only;
// the web app uses public/sw.js instead, and this file never ships there).
//
// It takes over the two jobs of the PWA service worker that still make sense
// inside an extension, and nothing else:
//   1. The toolbar button opens the wallet as a full browser tab, or focuses
//      the one already open. There is deliberately no popup: popups close the
//      moment focus moves (a password manager, the camera prompt, a passkey
//      sheet), which would drop an unlock or a send mid-way.
//   2. Clicking a payment notification brings the wallet tab forward. The page
//      shows notifications through this worker's registration
//      (src/lib/notify.ts), so their clicks are delivered here.
//
// Security stance: no fetch handler, no Cache Storage, no storage of any kind,
// no message listeners, no network access. The packaged code is the store-
// signed copy and nothing here can serve anything else. This worker never sees
// keys, the vault or balances — all of that stays in the wallet page.

interface ExtensionContext {
  contextType: string
  tabId: number
  windowId: number
  documentUrl?: string
}

// Minimal typing for the few extension APIs used (no @types/chrome dependency).
declare const chrome: {
  runtime: {
    getURL(path: string): string
    getContexts(filter: { contextTypes: string[] }): Promise<ExtensionContext[]>
    onInstalled: { addListener(cb: (details: { reason: string }) => void): void }
  }
  action: { onClicked: { addListener(cb: () => void): void } }
  tabs: {
    create(props: { url: string; active?: boolean }): Promise<unknown>
    update(tabId: number, props: { active: boolean }): Promise<unknown>
  }
  windows: { update(windowId: number, props: { focused: boolean }): Promise<unknown> }
}

interface NotificationClickEvent {
  notification: { close(): void }
  waitUntil(work: Promise<unknown>): void
}

const worker = self as unknown as {
  addEventListener(type: 'notificationclick', fn: (e: NotificationClickEvent) => void): void
}

const WALLET_URL = chrome.runtime.getURL('index.html')

/** Focus an open wallet tab if there is one, otherwise open a new tab. */
async function openWallet(): Promise<void> {
  // getContexts only ever returns this extension's own pages, and needs no
  // "tabs" permission (tabs.query would, to filter by URL).
  const tabs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] })
  const open = tabs.find((c) => c.tabId >= 0 && (c.documentUrl ?? '').startsWith(WALLET_URL))
  if (open !== undefined) {
    await chrome.tabs.update(open.tabId, { active: true })
    await chrome.windows.update(open.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url: WALLET_URL, active: true })
}

// Listeners are registered synchronously at top level, as MV3 requires, so a
// click wakes the worker and is delivered.
chrome.action.onClicked.addListener(() => {
  void openWallet()
})

chrome.runtime.onInstalled.addListener((details) => {
  // First install only: show the wallet so the user is not left hunting for
  // the toolbar button. Updates and browser restarts open nothing.
  if (details.reason === 'install') void openWallet()
})

worker.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(openWallet())
})

export {}
