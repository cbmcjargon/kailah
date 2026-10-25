import type { TronChainConfig } from '../lib/tron'
import { krakenOption, type BuyOption } from '../lib/onramp'
import Modal from './Modal'
import CopyButton from './CopyButton'
import ExchangeList from './BuyOptions'
import { IconExternal } from './Icons'

interface TronBuyModalProps {
  chain: TronChainConfig
  address: string
  onClose: () => void
}

export default function TronBuyModal({ chain, address, onClose }: TronBuyModalProps) {
  if (!chain.mainnet) {
    return (
      <Modal title="Get practice TRX" onClose={onClose}>
        <div className="stack">
          <p className="text-secondary">
            Free test TRX comes from the Nile faucet — copy your address, open the faucet, and
            paste it there (it asks you to log in with a social account to stop bots).
          </p>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy address" withText />
          </div>
          <a
            className="btn btn-secondary"
            href="https://nileex.io/join/getJoinPage"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the Nile faucet
            <IconExternal size={15} />
          </a>
        </div>
      </Modal>
    )
  }

  // Kraken carries TRX (live-verified via its asset list); Coinbase does not
  // support TRON, so Binance is the honest second option.
  const options: BuyOption[] = [
    krakenOption('TRX', 'TRON', address),
    {
      name: 'Binance',
      kind: 'exchange',
      blurb: 'Deep TRX/USDT liquidity; withdrawals on the TRON network are cheap.',
      url: 'https://www.binance.com/en/how-to-buy/tron',
      prefillsAddress: false,
      steps: [
        'Buy TRX (or USDT) on Binance, then choose Withdraw.',
        `Pick the TRON (TRC-20) network and paste your address (${address.slice(0, 8)}…).`,
        'Confirm — TRON withdrawals usually land within a minute.',
      ],
    },
  ]

  return (
    <Modal title="Buy TRX" onClose={onClose}>
      <div className="stack">
        <p className="text-secondary">
          Buying happens on a licensed exchange — it handles payment and identity checks, then
          withdraws straight to your wallet. Kailah never sees your card details.
        </p>
        <div className="field">
          <span className="field-label">Your delivery address (TRON network)</span>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy delivery address" withText />
          </div>
        </div>
        <ExchangeList label="Exchanges" options={options} />
        <p className="text-tertiary buy-disclaimer">
          Tip: if you mainly want USDT, buy it directly and withdraw it on the TRON (TRC-20)
          network — then keep a few TRX here for fees.
        </p>
      </div>
    </Modal>
  )
}
