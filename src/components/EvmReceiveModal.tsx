import { useEffect, useState } from 'react'
import * as QRCode from 'qrcode'
import type { EvmChainConfig } from '../lib/evm'
import Modal from './Modal'
import CopyButton from './CopyButton'
import { IconExternal } from './Icons'

interface EvmReceiveModalProps {
  chain: EvmChainConfig
  address: string
  onClose: () => void
}

export default function EvmReceiveModal({ chain, address, onClose }: EvmReceiveModalProps) {
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
    <Modal
      title={`Receive ${chain.gasPrimary === true ? `${chain.gas.symbol} or ${chain.token.symbol}` : chain.token.symbol}`}
      onClose={onClose}
    >
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
            ? `This one address receives both ${chain.token.symbol} and ${chain.gas.symbol} on the ${chain.networkName} network. ` +
              `Make sure the sender picks ${chain.networkName} — the same address exists on every ` +
              `Ethereum-style network, so coins sent on the wrong one land in the wrong account.`
            : 'Practice address on the Base Sepolia test network — same address for test USDC and test ETH.'}
        </p>
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
            <p className="text-tertiary">
              Grab test USDC from Circle&rsquo;s faucet and a little test ETH for fees.
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
