import { useEffect, useState } from 'react'
import * as QRCode from 'qrcode'
import type { SolChainConfig } from '../lib/sol'
import Modal from './Modal'
import CopyButton from './CopyButton'

interface SolReceiveModalProps {
  chain: SolChainConfig
  address: string
  onClose: () => void
}

export default function SolReceiveModal({ chain, address, onClose }: SolReceiveModalProps) {
  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)

  useEffect(() => {
    let alive = true
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
    <Modal title="Receive SOL" onClose={onClose}>
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
        <p className="text-tertiary path-caption">
          {chain.mainnet
            ? 'Your Solana address — restorable in Phantom or Solflare with the same 12 words.'
            : 'Practice address on Solana devnet. Use "Get coins" for free test SOL.'}
        </p>
      </div>
    </Modal>
  )
}
