// Add a Ledger account: read its account key from the device and have the user
// confirm receive address 0/0 on the device screen. docs/hardware-signing.md.
import { useState } from 'react'
import type { HardwareAccountRecord, HardwareChainId, NetMode } from '../lib/types'
import { CHAINS } from '../lib/networks'
import { HARDWARE_CHAINS } from '../lib/hwaccount'
import { browserTransport, importLedgerAccount, ledgerSupport } from '../lib/ledger'
import Modal from './Modal'
import LedgerPrompt, { UNSUPPORTED_COPY, useDevice } from './LedgerPrompt'
import { IconCheck, IconShield, IconWarning } from './Icons'

interface HardwareImportModalProps {
  mode: NetMode
  existing: HardwareAccountRecord[]
  /** this wallet's own first receive address per chain: a Ledger on the same recovery phrase holds the same coins */
  ownFirstAddress: (chain: HardwareChainId) => string | undefined
  onAdded: (record: HardwareAccountRecord) => void
  onClose: () => void
}

export default function HardwareImportModal({ mode, existing, ownFirstAddress, onAdded, onClose }: HardwareImportModalProps) {
  const choices: HardwareChainId[] = mode === 'practice' ? ['btc-testnet'] : ['btc', 'ltc']
  const [chainId, setChainId] = useState<HardwareChainId>(choices[0]!)
  const [expect, setExpect] = useState<string | null>(null)
  const [added, setAdded] = useState<HardwareAccountRecord | null>(null)
  const [duplicate, setDuplicate] = useState<'ledger' | 'own' | null>(null)
  const device = useDevice()
  const appName = HARDWARE_CHAINS[chainId].appName
  const chain = CHAINS[chainId]
  const supported = ledgerSupport() !== null

  const connect = async () => {
    setDuplicate(null)
    setExpect(null)
    const rec = await device.run((onStatus) => importLedgerAccount(chainId, browserTransport(true), onStatus, setExpect))
    if (rec === null) return
    if (existing.some((r) => r.id === rec.id)) {
      setDuplicate('ledger')
      return
    }
    // A Ledger set up with this wallet's own recovery phrase holds this
    // wallet's own account: adding it showed every coin twice (bug audit
    // 2026-10-27, BL44)
    if (ownFirstAddress(rec.chain) === rec.verifiedAddress) {
      setDuplicate('own')
      return
    }
    onAdded(rec)
    setAdded(rec)
  }

  return (
    <Modal title="Add a Ledger account" onClose={onClose} canDismiss={!device.busy}>
      {added !== null ? (
        <div className="stack success-body">
          <div className="success-badge">
            <IconCheck size={26} />
          </div>
          <h3 className="state-title">{CHAINS[added.chain].name} · Ledger added</h3>
          <p className="text-secondary">
            Its card is on your dashboard. Balances and history load from the account&rsquo;s public
            key; every payment from it is signed on the Ledger.
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="text-secondary">
            Your keys never leave the Ledger. This wallet keeps only the account&rsquo;s public key
            (encrypted, like the rest of its data) so it can show balances and prepare payments for
            the device to sign. The Ledger&rsquo;s own recovery phrase — not this wallet&rsquo;s 12
            words — backs these coins.
          </p>

          {!supported && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>This browser can&rsquo;t reach a Ledger</strong>
                <p>{UNSUPPORTED_COPY}</p>
              </div>
            </div>
          )}

          {choices.length > 1 && (
            <div className="field">
              <span className="field-label" id="hw-chain-label">
                Network
              </span>
              <div className="fee-pills" role="group" aria-labelledby="hw-chain-label">
                {choices.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={id === chainId}
                    className={`fee-pill ${id === chainId ? 'is-selected' : ''}`}
                    disabled={device.busy}
                    onClick={() => {
                      setChainId(id)
                      device.reset()
                    }}
                  >
                    <span className="fee-pill-label">{CHAINS[id].name}</span>
                    <span className="fee-pill-eta">{HARDWARE_CHAINS[id].appName} app</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <ol className="hw-steps">
            <li>Plug in your Ledger and unlock it with its PIN.</li>
            <li>
              Open the <strong>{appName}</strong> app
              {HARDWARE_CHAINS[chainId].app === 'bitcoin' ? ' (version 2.1 or newer)' : ''}.
            </li>
            <li>Close Ledger Live if it&rsquo;s running — it holds the USB connection.</li>
          </ol>
          {mode === 'practice' && (
            <p className="text-tertiary">
              Practice mode uses Bitcoin testnet4 — install &ldquo;Bitcoin Test&rdquo; from Ledger
              Live&rsquo;s app catalog (enable developer mode in its settings if it isn&rsquo;t
              listed).
            </p>
          )}

          <LedgerPrompt
            chainId={chainId}
            ui={device.ui}
            confirmText={
              expect !== null
                ? `Your Ledger shows your first ${chain.name} receive address. It must be ${expect} — approve only if every character matches.`
                : 'Approve the address shown on your Ledger.'
            }
          />
          {duplicate !== null && (
            <div className="device-box" role="status">
              <IconCheck size={20} />
              <div>
                <strong>Already on your dashboard</strong>
                <p>
                  {duplicate === 'own'
                    ? 'This Ledger uses the same recovery phrase as this wallet, so its coins are already shown on its card. Adding it would count them twice.'
                    : 'This Ledger account is already on your dashboard.'}
                </p>
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!supported || device.busy}
            onClick={() => void connect()}
          >
            <IconShield size={16} />
            {device.ui.phase === 'error' ? 'Try again' : 'Connect Ledger'}
          </button>
        </div>
      )}
    </Modal>
  )
}
