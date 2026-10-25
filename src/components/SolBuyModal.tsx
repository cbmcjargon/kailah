import { useState } from 'react'
import type { SolChainConfig } from '../lib/sol'
import { requestDevnetAirdrop } from '../lib/sol'
import { coinbaseOption, geminiOption, krakenOption } from '../lib/onramp'
import Modal from './Modal'
import CopyButton from './CopyButton'
import ExchangeList from './BuyOptions'
import { IconCheck, IconExternal, IconWarning, Spinner } from './Icons'
import { errMessage } from './ui'

interface SolBuyModalProps {
  chain: SolChainConfig
  address: string
  onClose: () => void
  /** called after a successful devnet airdrop so the card refreshes */
  onFunded: () => void
}

type AirdropState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string }

export default function SolBuyModal({ chain, address, onClose, onFunded }: SolBuyModalProps) {
  const [airdrop, setAirdrop] = useState<AirdropState>({ kind: 'idle' })

  if (!chain.mainnet) {
    const requesting = airdrop.kind === 'requesting'
    return (
      <Modal title="Get practice SOL" onClose={onClose}>
        <div className="stack">
          <p className="text-secondary">
            Solana&rsquo;s test network hands out free SOL directly — no sign-ups, no captchas.
            One tap drops 1 test SOL into your practice account.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={requesting}
            onClick={() => {
              setAirdrop({ kind: 'requesting' })
              requestDevnetAirdrop(address)
                .then(() => {
                  setAirdrop({ kind: 'done' })
                  window.setTimeout(onFunded, 3000)
                })
                .catch((e) => setAirdrop({ kind: 'failed', message: errMessage(e) }))
            }}
          >
            {requesting ? <Spinner size={18} /> : null}
            {requesting ? 'Requesting…' : 'Airdrop 1 test SOL'}
          </button>
          {airdrop.kind === 'done' && (
            <p className="field-hint" role="status">
              <IconCheck size={14} className="inline-icon" />
              Airdrop requested — your balance updates in a few seconds.
            </p>
          )}
          {airdrop.kind === 'failed' && (
            <div className="warning-box" role="alert">
              <IconWarning size={20} />
              <div>
                <strong>Airdrop unavailable right now</strong>
                <p>{airdrop.message} The devnet faucet rate-limits; try again in a minute.</p>
              </div>
            </div>
          )}
          <p className="text-tertiary">
            Want practice {chain.usdc.symbol} too? Circle&rsquo;s faucet sends test USDC to this
            same address — pick &ldquo;Solana Devnet&rdquo; there.
          </p>
          <a
            className="btn btn-secondary"
            href="https://faucet.circle.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the USDC faucet
            <IconExternal size={15} />
          </a>
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
