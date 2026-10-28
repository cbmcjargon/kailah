// Fiat onramp options for Kailah Wallet.
//
// A self-custody wallet cannot legally take card payments itself — buying
// always happens on a licensed partner's site, which handles payment + KYC
// and delivers coins straight to the user's address. This module only builds
// links; no money or personal data ever flows through the wallet.
//
// Every entry below was verified against the live service on 2026-07-19
// (page loads keylessly for US users; where prefillsAddress is true, the
// destination address demonstrably lands in the provider's checkout field
// via the documented URL params). Provider URL schemes change often — if a
// link degrades, the user can always fall back to copy-address + paste.
//
// Not included, verified unusable keyless as of 2026-07: Ramp, Transak and
// Coinbase Onramp now require partner API keys or backend-signed session
// URLs for their checkout widgets.

import type { ChainConfig } from './types'

export interface BuyOption {
  name: string
  /** 'onramp' = card checkout site; 'exchange' = buy there, then withdraw */
  kind: 'onramp' | 'exchange'
  /** small pill next to the name — used to DISCLOSE the Kraken invite link */
  tag?: string
  /** one-line description shown under the name */
  blurb: string
  url: string
  /** true when the URL already carries the user's receive address */
  prefillsAddress: boolean
  /** short numbered steps, shown for exchange withdrawals */
  steps?: string[]
}

function banxa(coin: 'BTC' | 'DOGE' | 'LTC', address: string): BuyOption {
  const params = new URLSearchParams({
    coinType: coin,
    blockchain: coin,
    fiatType: 'USD',
    fiatAmount: '100',
    walletAddress: address,
  })
  return {
    name: 'Banxa',
    kind: 'onramp',
    blurb: 'Card or Google Pay — your wallet address is filled in for you.',
    url: `https://checkout.banxa.com/?${params.toString()}`,
    prefillsAddress: true,
  }
}

function moonpay(coin: 'btc' | 'doge' | 'ltc'): BuyOption {
  return {
    name: 'MoonPay',
    kind: 'onramp',
    blurb: 'Card, Apple Pay, PayPal or Venmo.',
    url: `https://www.moonpay.com/buy/${coin}`,
    prefillsAddress: false,
  }
}

// The wallet creator's Strike invite link — Bitcoin only. Shown with the
// same explicit "Invite link" tag as every referral below, and first on the
// Bitcoin card: Strike is the simplest on-ramp for a newcomer (bank or card,
// then a plain on-chain send), which is exactly who the BTC onboarding is for.
export const STRIKE_INVITE_URL = 'https://invite.strike.me/QRPRGZ'

export function strikeOption(addr: string): BuyOption {
  return {
    name: 'Strike',
    kind: 'exchange',
    tag: 'Invite link',
    blurb:
      "The simplest app for buying bitcoin in the US — bank or card, then send it here. New accounts made through this invite get fee-free trading up to a set amount, under Strike's current referral terms (not in the UK); the wallet's creator gets a referral reward too.",
    url: STRIKE_INVITE_URL,
    prefillsAddress: false,
    steps: [
      'Create your Strike account through the link (or log in) and buy Bitcoin.',
      `Tap Send, choose a Bitcoin address (not Lightning), paste yours (${addr.slice(0, 10)}…), and confirm.`,
      'On-chain sends carry a small network fee and usually land within the hour.',
    ],
  }
}

// The wallet creator's Kraken invite link — shown with an explicit
// "Invite link" tag wherever it appears. Disclosure is non-negotiable: users
// must be able to tell a referral from a neutral recommendation. Each
// referral's blurb also says what a new account gets from it: the Chrome Web
// Store allows affiliate links only with a direct user benefit, disclosed in
// the listing and the UI (review 2026-10-28).
const KRAKEN_INVITE_URL = 'https://proinvite.kraken.com/9f1e/rf9gcbrs'

/**
 * Kraken exchange option — first choice on every mainnet card. Live-verified
 * 2026-07-28 (api.kraken.com asset list): supports every coin this wallet
 * holds, including BNB. Low trading fees; withdrawal steps below.
 */
export function krakenOption(coin: string, networkName: string, addr: string): BuyOption {
  return {
    name: 'Kraken',
    kind: 'exchange',
    tag: 'Invite link',
    blurb: `Low fees and every coin in this wallet. New to Kraken? An account made through this invite can earn a sign-up bonus under Kraken's current referral offer (it varies by country); the wallet's creator gets one too.`,
    url: KRAKEN_INVITE_URL,
    prefillsAddress: false,
    steps: [
      `Create your Kraken account through the link (or log in) and buy ${coin}.`,
      `Choose Withdraw, pick the ${networkName} network, and paste your address (${addr.slice(0, 10)}…).`,
      'Confirm — first-time withdrawals may ask you to verify the new address.',
    ],
  }
}

// The wallet creator's Gemini invite link — same disclosure rule as Kraken.
const GEMINI_INVITE_URL = 'https://exchange.gemini.com/register?referral=ben8re2e&type=referral'

/**
 * Gemini exchange option — second choice. Live-verified 2026-08-01
 * (api.gemini.com symbols): trades every coin this wallet holds, incl. BNB.
 */
export function geminiOption(coin: string, networkName: string, addr: string): BuyOption {
  return {
    name: 'Gemini',
    kind: 'exchange',
    tag: 'Invite link',
    blurb: `US-regulated exchange. New accounts made through this invite get a crypto bonus after their first trades, under Gemini's current referral terms; the wallet's creator gets one too.`,
    url: GEMINI_INVITE_URL,
    prefillsAddress: false,
    steps: [
      `Create your Gemini account through the link (or log in) and buy ${coin}.`,
      `Choose Withdraw, pick the ${networkName} network, and paste your address (${addr.slice(0, 10)}…).`,
      'Confirm — new withdrawal addresses may need an extra verification step.',
    ],
  }
}

export function coinbaseOption(coin: string, slug: string, addr: string): BuyOption {
  return {
    name: 'Coinbase',
    kind: 'exchange',
    blurb: 'Buy in your Coinbase account, then send it to this wallet.',
    url: `https://www.coinbase.com/price/${slug}`,
    prefillsAddress: false,
    steps: COINBASE_STEPS(coin, addr),
  }
}

const COINBASE_STEPS = (coin: string, addr: string) => [
  `Buy ${coin} on Coinbase (bank, debit card or PayPal).`,
  `Choose Send, paste your address (${addr.slice(0, 10)}…), and confirm.`,
]

export function getBuyOptions(chain: ChainConfig, address: string): BuyOption[] {
  switch (chain.id) {
    case 'btc':
      return [
        banxa('BTC', address),
        {
          name: 'Guardarian',
          kind: 'onramp',
          blurb: 'Card or Apple Pay — often the best rate; address filled in for you.',
          url:
            'https://guardarian.com/calculator/v1?default_side=buy&default_fiat_currency=USD' +
            '&default_fiat_amount=100&default_crypto_currency=BTC&default_crypto_network=BTC' +
            `&payout_address=${encodeURIComponent(address)}&skip_choose_payout_address=true`,
          prefillsAddress: true,
        },
        moonpay('btc'),
        strikeOption(address),
        krakenOption('Bitcoin', 'Bitcoin', address),
        geminiOption('Bitcoin', 'Bitcoin', address),
        {
          name: 'Cash App',
          kind: 'exchange',
          blurb: 'Already have Cash App? It sells Bitcoin and can send it here.',
          url: 'https://cash.app/bitcoin',
          prefillsAddress: false,
          steps: [
            'In Cash App, open the Bitcoin tab and buy the amount you want.',
            'Tap Send or Withdraw Bitcoin, paste your address, and confirm.',
            'Free standard withdrawals start at 0.001 BTC and can take up to a day.',
          ],
        },
        {
          name: 'Coinbase',
          kind: 'exchange',
          blurb: 'Buy in your Coinbase account, then send it to this wallet.',
          url: 'https://www.coinbase.com/price/bitcoin',
          prefillsAddress: false,
          steps: COINBASE_STEPS('Bitcoin', address),
        },
      ]
    case 'doge':
      return [
        banxa('DOGE', address),
        {
          name: 'Onramper',
          kind: 'onramp',
          blurb: 'Compares several card providers for the best Dogecoin deal.',
          url: 'https://buy.onramper.com/?defaultCrypto=doge_dogecoin',
          prefillsAddress: false,
        },
        moonpay('doge'),
        krakenOption('Dogecoin', 'Dogecoin', address),
        geminiOption('Dogecoin', 'Dogecoin', address),
        {
          name: 'Robinhood',
          kind: 'exchange',
          blurb: 'Commission-free DOGE; supports sending to outside wallets.',
          url: 'https://robinhood.com/crypto/DOGE',
          prefillsAddress: false,
          steps: [
            'Buy DOGE on Robinhood, then choose Send in the crypto transfer menu.',
            `Paste your D… address and confirm (first-time transfers may need extra verification).`,
          ],
        },
        {
          name: 'Coinbase',
          kind: 'exchange',
          blurb: 'Buy in your Coinbase account, then send it to this wallet.',
          url: 'https://www.coinbase.com/price/dogecoin',
          prefillsAddress: false,
          steps: COINBASE_STEPS('Dogecoin', address),
        },
      ]
    case 'ltc':
      return [
        banxa('LTC', address),
        moonpay('ltc'),
        krakenOption('Litecoin', 'Litecoin', address),
        geminiOption('Litecoin', 'Litecoin', address),
        {
          name: 'Robinhood',
          kind: 'exchange',
          blurb: 'Commission-free LTC; supports sending to outside wallets.',
          url: 'https://robinhood.com/crypto/LTC',
          prefillsAddress: false,
          steps: [
            'Buy LTC on Robinhood, then choose Send in the crypto transfer menu.',
            'Paste your ltc1… address and confirm (first-time transfers may need extra verification).',
          ],
        },
        {
          name: 'Coinbase',
          kind: 'exchange',
          blurb: 'Buy in your Coinbase account, then send it to this wallet.',
          url: 'https://www.coinbase.com/price/litecoin',
          prefillsAddress: false,
          steps: COINBASE_STEPS('Litecoin', address),
        },
      ]
    default:
      // Test networks use faucets (handled by the Buy modal directly).
      return []
  }
}
