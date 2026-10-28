import { useEffect, useState } from 'react'
import * as QRCode from 'qrcode'
import type { AccountAddressInfo, AccountKeys, AccountState, ChainConfig, HardwareAccountKeys } from '../lib/types'
import { shortAddress } from '../lib/format'
import { isHardwareAccount } from '../lib/hwaccount'
import { browserTransport, verifyAddressOnLedger } from '../lib/ledger'
import Modal from './Modal'
import CopyButton from './CopyButton'
import LedgerPrompt, { useDevice } from './LedgerPrompt'
import { IconCheck, IconChevronDown, IconExternal, IconShield } from './Icons'

interface ReceiveModalProps {
  chain: ChainConfig
  account: AccountKeys | HardwareAccountKeys
  accountState: AccountState | null
  /** show (and check on the device) this address rather than the next fresh one: Buy's delivery address */
  pinned?: AccountAddressInfo
  onClose: () => void
}

export default function ReceiveModal({ chain, account, accountState, pinned, onClose }: ReceiveModalProps) {
  // Freeze the fresh receive address once the first scan provides it. Later
  // background scans (or a payment landing on this very address) would advance
  // nextReceive; swapping the displayed address/QR mid-share is jarring and can
  // send a payer to a different address than the one they were reading.
  const [frozen, setFrozen] = useState(pinned ?? accountState?.nextReceive ?? null)
  useEffect(() => {
    if (frozen === null && accountState?.nextReceive) setFrozen(accountState.nextReceive)
  }, [accountState, frozen])

  const address = frozen?.address ?? account.address(0, 0).address
  const index = frozen?.index ?? 0
  const path = `${chain.accountPath}/0/${index}`

  // Previously handed-out receive addresses, so older QR codes still resolve.
  const previous = (accountState?.addresses ?? [])
    .filter((a) => a.branch === 0 && a.used)
    .sort((a, b) => a.index - b.index)

  // Hardware account: the device screen is the one malware can't repaint.
  const hw = isHardwareAccount(account) ? account : null
  const device = useDevice()
  const [verified, setVerified] = useState<string | null>(null)
  const verify = async () => {
    if (hw === null) return
    const ok = await device.run((onStatus) => verifyAddressOnLedger(hw, 0, index, browserTransport(true), onStatus, address))
    if (ok !== null) setVerified(address)
  }

  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [showPrevious, setShowPrevious] = useState(false)

  useEffect(() => {
    let alive = true
    setQr(null)
    setQrFailed(false)
    QRCode.toDataURL(address, {
      width: 480,
      margin: 2,
      errorCorrectionLevel: 'medium',
      color: { dark: '#0b0e14', light: '#ffffff' },
    })
      .then((url) => {
        if (alive) setQr(url)
      })
      .catch(() => {
        if (alive) setQrFailed(true)
      })
    return () => {
      alive = false
    }
  }, [address])

  return (
    // not while the Ledger shows the address: closing then left the check
    // running, and the next device action timed out behind it (bug audit
    // 2026-10-27, BM28)
    <Modal title={`Receive ${chain.ticker}${hw !== null ? ' · Ledger' : ''}`} onClose={onClose} canDismiss={!device.busy}>
      <div className="stack receive-body">
        <div className="qr-frame">
          {qr ? (
            <img src={qr} width={240} height={240} alt={`QR code for your ${chain.name} address`} />
          ) : qrFailed ? (
            <span className="text-secondary">Could not render QR</span>
          ) : (
            <div className="skeleton skeleton-qr" />
          )}
        </div>
        <div className="address-block">
          <div className="mono address-full">{address}</div>
          <CopyButton text={address} label="Copy address" withText />
        </div>
        {hw !== null && (
          <div className="stack">
            {verified === address ? (
              <span className="device-ok" role="status">
                <IconCheck size={16} />
                Your Ledger shows this same address.
              </span>
            ) : (
              <>
                <p className="text-secondary">
                  Before sharing it — especially for a large payment — check this address on your
                  Ledger. The device screen is the one malware on this computer can&rsquo;t fake.
                </p>
                <LedgerPrompt
                  chainId={hw.record.chain}
                  ui={device.ui}
                  confirmText={`It must show ${address}. Approve only if every character matches.`}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={device.busy}
                  onClick={() => void verify()}
                >
                  <IconShield size={16} />
                  {device.ui.phase === 'error' ? 'Try again' : 'Verify on Ledger'}
                </button>
              </>
            )}
          </div>
        )}
        <p className="text-tertiary path-caption">
          A fresh address every time keeps your balance and history more private. Old addresses keep
          working — coins sent to any of them still land here.
        </p>
        <p className="text-tertiary path-caption">
          Derivation path <span className="mono">{path}</span>
        </p>

        {previous.length > 0 && (
          <div className="prev-addr-box">
            <button
              type="button"
              className="prev-addr-toggle"
              onClick={() => setShowPrevious((v) => !v)}
              aria-expanded={showPrevious}
            >
              <span>
                {showPrevious ? 'Hide' : 'Show'} previous addresses ({previous.length})
              </span>
              <IconChevronDown size={15} className={showPrevious ? 'chevron-up' : undefined} />
            </button>
            {showPrevious && (
              <ul className="prev-addr-list">
                {previous.map((a) => (
                  <li key={a.address} className="prev-addr-row">
                    <span className="mono text-secondary" title={a.address}>
                      {shortAddress(a.address)}
                    </span>
                    <CopyButton text={a.address} label={`Copy ${chain.name} address`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {chain.faucets && chain.faucets.length > 0 && (
          <div className="faucet-box">
            <span className="field-label">Get free test coins</span>
            <ul className="faucet-list">
              {chain.faucets.map((f) => (
                <li key={f.url}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="faucet-link">
                    {f.name}
                    <IconExternal size={14} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
