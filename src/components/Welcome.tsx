import { LogoMark, IconShield } from './Icons'

interface WelcomeProps {
  onCreate: () => void
  onRestore: () => void
}

export default function Welcome({ onCreate, onRestore }: WelcomeProps) {
  return (
    <div className="onboard-screen">
      <div className="onboard-hero">
        <LogoMark size={64} />
        <h1 className="onboard-title">Kailah Wallet</h1>
        <p className="onboard-tagline">
          <IconShield size={16} className="inline-icon" />
          Self-custody Bitcoin, Dogecoin &amp; Litecoin — your keys never leave this device.
        </p>
      </div>
      <div className="stack">
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          Create a new wallet
        </button>
        <button type="button" className="btn btn-secondary" onClick={onRestore}>
          I have a recovery phrase
        </button>
      </div>
    </div>
  )
}
