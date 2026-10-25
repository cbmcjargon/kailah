import type { EvmChainConfig } from '../lib/evm'
import { coinbaseOption, geminiOption, krakenOption, type BuyOption } from '../lib/onramp'
import Modal from './Modal'
import CopyButton from './CopyButton'
import ExchangeList from './BuyOptions'
import { IconExternal } from './Icons'

interface EvmBuyModalProps {
  chain: EvmChainConfig
  address: string
  onClose: () => void
}

export default function EvmBuyModal({ chain, address, onClose }: EvmBuyModalProps) {
  if (!chain.mainnet) {
    return (
      <Modal title="Get practice USDC" onClose={onClose}>
        <div className="stack">
          <p className="text-secondary">
            Practice USDC is free from Circle&rsquo;s faucet (pick the Base Sepolia network), and a
            faucet dab of test ETH covers the fees. Copy your address first:
          </p>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy address" withText />
          </div>
          {chain.faucets && (
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
          )}
        </div>
      </Modal>
    )
  }

  const headline = chain.gasPrimary === true ? chain.gas.symbol : chain.token.symbol
  const options: BuyOption[] = [
    krakenOption(headline, chain.networkName, address),
    geminiOption(headline, chain.networkName, address),
  ]
  if (chain.id === 'bnb') {
    // Coinbase neither sells BNB nor withdraws to BNB Smart Chain — the
    // honest second option is Binance itself.
    options.push({
      name: 'Binance',
      kind: 'exchange',
      blurb: 'BNB is Binance’s own coin — its home exchange always supports it.',
      url: 'https://www.binance.com/en/how-to-buy/bnb',
      prefillsAddress: false,
      steps: [
        'Buy BNB on Binance, then choose Withdraw.',
        `Pick the BNB Smart Chain (BEP-20) network and paste your address (${address.slice(0, 10)}…).`,
        'Confirm — it typically lands within a couple of minutes.',
      ],
    })
  } else {
    options.push(coinbaseOption(chain.token.symbol, 'usdc', address))
  }

  return (
    <Modal title={`Buy ${headline}`} onClose={onClose}>
      <div className="stack">
        <p className="text-secondary">
          Buying happens on a licensed exchange — it handles payment and identity checks, then
          withdraws straight to your wallet. Kailah never sees your card details.
        </p>
        <div className="field">
          <span className="field-label">Your delivery address ({chain.networkName} network)</span>
          <div className="address-block">
            <div className="mono address-full">{address}</div>
            <CopyButton text={address} label="Copy delivery address" withText />
          </div>
        </div>
        <ExchangeList label="Exchanges" options={options} />
        <p className="text-tertiary buy-disclaimer">
          Double-check the network says {chain.networkName} before confirming — coins sent on the
          wrong network land in the wrong account. A little {chain.gas.symbol} on{' '}
          {chain.networkName} (withdrawable the same way) covers your sends&rsquo; fees.
        </p>
      </div>
    </Modal>
  )
}
