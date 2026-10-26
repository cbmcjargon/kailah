import type { SolChainConfig } from '../lib/sol'
import { coinbaseOption, geminiOption, krakenOption } from '../lib/onramp'
import Modal from './Modal'
import CopyButton from './CopyButton'
import ExchangeList from './BuyOptions'
import { IconExternal } from './Icons'

interface SolBuyModalProps {
  chain: SolChainConfig
  address: string
  onClose: () => void
}

// Practice coins come from the public faucets. Solana's devnet RPC airdrop,
// which this screen used to call in one tap, was closed by Solana in 2026
// ("the RPC faucet is closed on this cluster"); its web faucet still works.
const PRACTICE_FAUCETS = [
  { name: 'Solana faucet (test SOL)', url: 'https://faucet.solana.com/', note: 'pick Devnet' },
  { name: 'Circle faucet (test USDC)', url: 'https://faucet.circle.com/', note: 'pick Solana Devnet' },
]

export default function SolBuyModal({ chain, address, onClose }: SolBuyModalProps) {
  if (!chain.mainnet) {
    return (
      <Modal title="Get practice SOL" onClose={onClose}>
        <div className="stack">
          <p className="text-secondary">
            Practice coins are free. Copy your practice address, open a faucet, choose Devnet and
            paste it. Test SOL pays the network fees; test {chain.usdc.symbol} goes to the same
            address.
          </p>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy address" withText />
          </div>
          <div className="faucet-box">
            <span className="field-label">Faucets</span>
            <ul className="faucet-list">
              {PRACTICE_FAUCETS.map((f) => (
                <li key={f.url}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="faucet-link">
                    {f.name}
                    <IconExternal size={14} />
                  </a>
                  <span className="text-tertiary"> — {f.note}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-tertiary">
            Your balance updates on its own a minute or so after the faucet sends.
          </p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Buy SOL" onClose={onClose}>
      <div className="stack">
        <p className="text-secondary">
          Buying happens on a licensed exchange — it handles payment and identity checks, then
          withdraws straight to your wallet. Solana withdrawals arrive in seconds and cost
          almost nothing.
        </p>
        <div className="field">
          <span className="field-label">Your delivery address (Solana network)</span>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy delivery address" withText />
          </div>
        </div>
        <ExchangeList
          label="Exchanges"
          options={[
            krakenOption('SOL', 'Solana', address),
            geminiOption('SOL', 'Solana', address),
            coinbaseOption('SOL', 'solana', address),
          ]}
        />
      </div>
    </Modal>
  )
}
