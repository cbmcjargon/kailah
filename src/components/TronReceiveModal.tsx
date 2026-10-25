import { useEffect, useState } from 'react'
import * as QRCode from 'qrcode'
import type { TronChainConfig } from '../lib/tron'
import Modal from './Modal'
import CopyButton from './CopyButton'

interface TronReceiveModalProps {
  chain: TronChainConfig
  address: string
  onClose: () => void
}

export default function TronReceiveModal({ chain, address, onClose }: TronReceiveModalProps) {
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
    <Modal title="Receive on TRON" onClose={onClose}>
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
            ? 'One address receives both TRX and USDT (TRC-20). Senders must pick the TRON network — USDT sent on another network lands in a different account.'
            : 'Practice address on TRON Nile. Faucet coins via "Get coins".'}
        </p>
      </div>
    </Modal>
  )
}
