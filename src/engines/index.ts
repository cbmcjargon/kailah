// The chain engines the wallet loads on demand. Each import() below is a
// split point: Vite/Rollup emits the target and everything only it needs as
// separate same-origin chunks, so the welcome and lock screens (and the UTXO
// accounts) never wait for viem, micro-sol-signer or the TRON decoder. The
// chunks are files of this build like the main one: script-src 'self' admits
// them and module imports are not a Trusted Types sink.
//
// The dashboard asks for every engine with a network shown in the current
// mode when it first renders (its cards are all on screen at once). An engine
// whose every network is hidden (lib/netprefs.ts engineShown) is not fetched
// until one of them is shown. Each engine module then splits off its modals,
// which load the first time one opens.

import { useEffect, useMemo, useRef, useState } from 'react'

export type EvmEngine = typeof import('./evm')
export type SolEngine = typeof import('./sol')
export type TronEngine = typeof import('./tron')

export const loadEvm = (): Promise<EvmEngine> => import('./evm')
export const loadSol = (): Promise<SolEngine> => import('./sol')
export const loadTron = (): Promise<TronEngine> => import('./tron')

/**
 * An engine chunk: `lib` once it has loaded, `failed` if it could not
 * (offline, or a deploy replaced it). `wanted` is false while every network
 * it serves is hidden — then nothing is fetched and no card placeholder shows.
 */
export interface Engine<T> {
  lib: T | null
  failed: boolean
  wanted: boolean
}

/**
 * Loads an engine chunk once, the first time it is wanted (on mount, or when
 * one of its networks is shown). Once loaded it stays: hiding its networks
 * again only stops their scans. `onLoad` runs in the same batch as `lib`
 * landing, so state keyed by the engine's chains is in place before anything
 * renders with it.
 */
export function useEngine<T>(
  load: () => Promise<T>,
  onLoad: (lib: T) => void,
  wanted = true,
): Engine<T> {
  const [engine, setEngine] = useState<{ lib: T | null; failed: boolean }>({ lib: null, failed: false })
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  // latches: wanted once means requested for the rest of the session
  const requestedRef = useRef(false)
  if (wanted) requestedRef.current = true
  const requested = requestedRef.current
  useEffect(() => {
    if (!requested) return
    let alive = true
    load().then(
      (lib) => {
        if (!alive) return
        onLoadRef.current(lib)
        setEngine({ lib, failed: false })
      },
      () => {
        if (alive) setEngine({ lib: null, failed: true })
      },
    )
    return () => {
      alive = false
    }
  }, [load, requested])
  return useMemo(() => ({ ...engine, wanted }), [engine, wanted])
}
