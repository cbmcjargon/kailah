// The last-good data provider per chain (api.ts), kept in its own module so
// the welcome/lock screen can clear it on erase without importing api.ts:
// that import pulled every UTXO provider (esplora, BlockCypher, Bitcore) into
// the first-load chunk, where the UTXO stack doesn't belong (it loads with
// App.tsx on unlock).
//
// Persisted so a fresh page load starts on the backend that actually answered
// last time. During the live mempool.space outage (2026-08-01), every reload
// re-burned a full timeout burst against the dead primary before failing over
// — this makes the failover stick. Public data only (a provider name); cleared
// with every other kailah.* key.

const PROVIDER_PREF_KEY = 'kailah.provider.v1'

export function readProviderPref(persistKey: string): string | null {
  try {
    const raw = localStorage.getItem(PROVIDER_PREF_KEY)
    if (!raw) return null
    const map: unknown = JSON.parse(raw)
    const v = map && typeof map === 'object' ? (map as Record<string, unknown>)[persistKey] : null
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

export function writeProviderPref(persistKey: string, providerName: string): void {
  try {
    const raw = localStorage.getItem(PROVIDER_PREF_KEY)
    const map = raw ? ((JSON.parse(raw) as Record<string, string>) ?? {}) : {}
    map[persistKey] = providerName
    localStorage.setItem(PROVIDER_PREF_KEY, JSON.stringify(map))
  } catch {
    // best-effort
  }
}

export function clearProviderPref(): void {
  try {
    localStorage.removeItem(PROVIDER_PREF_KEY)
  } catch {
    // ignore
  }
}
