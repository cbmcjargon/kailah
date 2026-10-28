import type { ChainConfig } from '../lib/types'
import { getBuyOptions, STRIKE_INVITE_URL } from '../lib/onramp'
import Modal from './Modal'
import CopyButton from './CopyButton'
import ExchangeList from './BuyOptions'
import { IconExternal } from './Icons'

interface BuyModalProps {
  chain: ChainConfig
  address: string
  onClose: () => void
  /** a Ledger account: the address must be checked on the device first (opens Receive, which does that) */
  onVerifyOnDevice?: () => void
}

export default function BuyModal({ chain, address, onClose, onVerifyOnDevice }: BuyModalProps) {
  // A Ledger account's address is only as good as the device's word for it:
  // send people to Receive's "Verify on Ledger" before they pay to it (it was
  // never checked here; bug audit 2026-10-27, BL43).
  const deviceCheck = onVerifyOnDevice !== undefined && (
    <div className="warning-box">
      <div>
        <strong>Check this address on your Ledger first</strong>
        <p>Before you pay anyone to deliver coins here, confirm the address on the device.</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={onVerifyOnDevice}>
          Verify on Ledger
        </button>
      </div>
    </div>
  )
  // Practice chains: the "onramp" is a faucet — coins are free.
  if (!chain.mainnet) {
    return (
      <Modal title={`Get ${chain.ticker}`} onClose={onClose}>
        <div className="stack">
          <p className="text-secondary">
            Practice coins are free — no card needed. Copy your address, open a faucet, and
            paste it there. Coins usually arrive within a minute or two.
          </p>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy address" withText />
          </div>
          {deviceCheck}
          {chain.faucets && chain.faucets.length > 0 && (
            <div className="faucet-box">
              <span className="field-label">Faucets</span>
              <ul className="faucet-list">
                {chain.faucets.map((f) => (
                  <li key={f.url}>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="faucet-link"
                    >
                      {f.name}
                      <IconExternal size={14} />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {chain.id === 'btc-testnet' && (
            // Practice is where newcomers start; when they're ready for real
            // bitcoin, hand them the simplest on-ramp (disclosed invite link).
            <p className="text-secondary">
              Ready for real bitcoin?{' '}
              <a href={STRIKE_INVITE_URL} target="_blank" rel="noopener noreferrer">
                Strike
              </a>
              <span className="buy-option-tag">Invite link</span> is the simplest place to begin,
              with fee-free trades to start through this invite (the wallet&rsquo;s creator gets a
              referral reward) — switch to Real mode and tap Buy when you are.
            </p>
          )}
        </div>
      </Modal>
    )
  }

  const options = getBuyOptions(chain, address)
  const onramps = options.filter((o) => o.kind === 'onramp')
  const exchanges = options.filter((o) => o.kind === 'exchange')

  return (
    <Modal title={`Buy ${chain.ticker}`} onClose={onClose}>
      <div className="stack">
        <p className="text-secondary">
          Buying happens on a licensed partner site — they handle the payment and any identity
          checks, then deliver the coins straight to your wallet. Kailah Wallet never sees your
          card details.
        </p>

        <div className="field">
          <span className="field-label">Coins will be delivered to</span>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy delivery address" withText />
          </div>
        </div>
        {deviceCheck}

        {onramps.length > 0 && (
          <div className="field">
            <span className="field-label">Pay by card</span>
            <ul className="buy-list">
              {onramps.map((o) => (
                <li key={o.name} className="buy-option">
                  <div className="buy-option-info">
                    <span className="buy-option-name">{o.name}</span>
                    <span className="buy-option-blurb">{o.blurb}</span>
                    {!o.prefillsAddress && (
                      <span className="buy-option-note">
                        Copy your address above — you&rsquo;ll paste it at checkout.
                      </span>
                    )}
                  </div>
                  <a
                    className="btn btn-secondary btn-small"
                    href={o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                    <IconExternal size={14} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ExchangeList label="Or use an app you may already have" options={exchanges} />

        <p className="text-tertiary buy-disclaimer">
          These are independent third-party services — fees and availability vary (including by
          US state), and most require a quick identity check the first time. Double-check the
          delivery address matches the one above before paying.
        </p>
      </div>
    </Modal>
  )
}
