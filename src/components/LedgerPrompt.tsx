// One rendering of the Ledger's state everywhere a device is involved
// (import, receive verification, send, speed-up). docs/hardware-signing.md §7.
import { useCallback, useEffect, useRef, useState } from 'react'
import { HARDWARE_CHAINS } from '../lib/hwaccount'
import { LedgerError, ledgerSupport, toLedgerError, type LedgerStatus } from '../lib/ledger'
import type { HardwareChainId } from '../lib/types'
import { IconShield, IconWarning, Spinner } from './Icons'

export type DeviceUi =
  | { phase: 'idle' }
  | { phase: 'working'; status: LedgerStatus }
  | { phase: 'error'; error: LedgerError }

export const DEVICE_IDLE: DeviceUi = { phase: 'idle' }

export const UNSUPPORTED_COPY =
  'Hardware wallets need Chrome or Edge on a computer, or Chrome on Android with a USB cable. This browser has no USB device access.'

/**
 * Run one device operation with its status mirrored into state. Returns the
 * result, or null when it failed (the error is then in `ui`).
 */
export function useDevice(): {
  ui: DeviceUi
  busy: boolean
  run: <T>(op: (onStatus: (s: LedgerStatus) => void) => Promise<T>) => Promise<T | null>
  reset: () => void
} {
  const [ui, setUi] = useState<DeviceUi>(DEVICE_IDLE)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(async <T,>(op: (onStatus: (s: LedgerStatus) => void) => Promise<T>) => {
    setUi({ phase: 'working', status: 'connecting' })
    try {
      const out = await op((status) => {
        if (alive.current) setUi({ phase: 'working', status })
      })
      if (alive.current) setUi(DEVICE_IDLE)
      return out
    } catch (e) {
      if (alive.current) setUi({ phase: 'error', error: toLedgerError(e) })
      return null
    }
  }, [])
  return { ui, busy: ui.phase === 'working', run, reset: () => setUi(DEVICE_IDLE) }
}

interface LedgerPromptProps {
  chainId: HardwareChainId
  ui: DeviceUi
  /** what to tell the user to compare while the device waits for approval */
  confirmText: string
}

export default function LedgerPrompt({ chainId, ui, confirmText }: LedgerPromptProps) {
  const appName = HARDWARE_CHAINS[chainId].appName
  if (ui.phase === 'idle') {
    if (ledgerSupport() === null) {
      return (
        <div className="warning-box" role="alert">
          <IconWarning size={20} />
          <div>
            <strong>This browser can&rsquo;t reach a Ledger</strong>
            <p>{UNSUPPORTED_COPY}</p>
          </div>
        </div>
      )
    }
    return null
  }
  if (ui.phase === 'working') {
    if (ui.status === 'confirm') {
      return (
        <div className="device-box device-box-live" role="status" aria-live="polite">
          <IconShield size={20} />
          <div>
            <strong>Check and approve on your Ledger</strong>
            <p>{confirmText}</p>
          </div>
        </div>
      )
    }
    return (
      <div className="device-box" role="status" aria-live="polite">
        <Spinner size={18} />
        <div>
          <strong>{ui.status === 'connecting' ? 'Connecting to your Ledger…' : `Talking to the ${appName} app…`}</strong>
          <p>
            Plug it in, unlock it and open the {appName} app. Close Ledger Live if it&rsquo;s running.
          </p>
        </div>
      </div>
    )
  }
  const { error } = ui
  const title =
    error.kind === 'rejected'
      ? 'Rejected on your Ledger'
      : error.kind === 'locked'
        ? 'Your Ledger is locked'
        : error.kind === 'wrong-app' || error.kind === 'app-too-old'
          ? `Open the ${appName} app`
          : error.kind === 'wrong-device'
            ? 'Wrong Ledger'
            : error.kind === 'cancelled'
              ? 'No device selected'
              : error.kind === 'unsupported'
                ? 'This browser can’t reach a Ledger'
                : 'Ledger problem'
  return (
    <div className={error.kind === 'rejected' || error.kind === 'cancelled' ? 'device-box' : 'warning-box'} role="alert">
      <IconWarning size={20} />
      <div>
        <strong>{title}</strong>
        <p>{error.message}</p>
      </div>
    </div>
  )
}
