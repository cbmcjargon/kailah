// Payment notifications. There is deliberately no push server — the wallet
// has no backend watching addresses — so notifications fire while the wallet
// is open (App.tsx polls balances). Installed-PWA notifications go through
// the service worker registration so they render natively on Android.

const PREF_KEY = 'kailah.notify'

export function notifyPrefEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function setNotifyPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, '1')
    else localStorage.removeItem(PREF_KEY)
  } catch {
    // storage blocked — preference just won't persist
  }
}

export function notificationPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export async function showSystemNotification(title: string, body: string): Promise<void> {
  if (notificationPermission() !== 'granted') return
  try {
    const reg =
      'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (reg !== undefined) {
      await reg.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      })
    } else if (typeof Notification !== 'undefined') {
      new Notification(title, { body, icon: '/icon-192.png' })
    }
  } catch {
    // best effort — the in-app toast is the guaranteed path
  }
}
