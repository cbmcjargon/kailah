# Privacy policy

Effective 2026-10-25. Applies to Kailah Wallet: the web app at
https://kailah-wallet.netlify.app and https://wallet.photoprompting.org, and
the Kailah Wallet Chrome extension.

**In short:** the developer collects no data. There are no accounts, analytics,
cookies, ads or trackers, and no server of ours sees your wallet. Your recovery
phrase, keys and password never leave your device. To show balances and send
coins, the wallet talks directly from your browser to public blockchain
services, and those services see your public addresses and the transactions
you choose to send.

## What stays on your device

Stored in your browser's local storage for this site or extension:

- **The vault:** your recovery phrase, encrypted with AES-256-GCM under a key
  derived from your password with Argon2id. It is never stored or sent
  unencrypted.
- **Encrypted caches:** addresses, balances, history, in-flight sends, the
  networks you chose to show, and the public keys of any Ledger accounts.
  They are encrypted with a key derived from your recovery phrase.
- **A few non-sensitive settings, unencrypted:** practice or real mode,
  whether payment alerts are on, the latest block heights, and which data
  provider answered last.

Erasing the wallet removes all of it. Uninstalling the extension deletes its
storage too.

## What leaves your device, and to whom

The browser enforces the list of services the wallet may contact (its
Content Security Policy), so nothing else can be reached.

- **Blockchain data services and network nodes.** They receive the public
  addresses the wallet looks up, the signed transactions you choose to send,
  and what every website request carries: your IP address and browser type.
  They never receive your recovery phrase, private keys or password.
  - **Bitcoin, Litecoin, Dogecoin:** mempool.space, mempool.emzy.de,
    mempool.bitaroo.net, blockstream.info, litecoinspace.org,
    api.blockcypher.com.
  - **Base, Ethereum, Arbitrum, BNB Chain:** mainnet.base.org,
    sepolia.base.org, base-rpc.publicnode.com, ethereum-rpc.publicnode.com,
    arbitrum-one-rpc.publicnode.com, bsc-rpc.publicnode.com,
    cloudflare-eth.com, arb1.arbitrum.io, bsc-dataseed.bnbchain.org,
    base.blockscout.com, base-sepolia.blockscout.com, eth.blockscout.com,
    arbitrum.blockscout.com.
  - **Solana:** solana-rpc.publicnode.com, api.devnet.solana.com.
  - **TRON:** api.trongrid.io, nile.trongrid.io.
- **Prices:** api.coinbase.com, api.exchange.coinbase.com, api.coingecko.com.
  These receive price requests only, with no addresses.
- **Swaps:** api.jup.ag (Jupiter) receives the amounts and your Solana
  address, to build the swap you asked for. Each swap includes a 0.5% fee,
  paid in USDC to the developer's fee account and shown before you confirm.
  That transfer is part of the public transaction, like the swap itself.
- **Sites you choose to open.** Buy and exchange pages, block explorers and
  test-coin faucets are third-party sites with their own privacy policies.
  - The Banxa buy link includes your receive address, so it is filled in for
    you; Banxa receives it when you open the link.
  - The Strike and Kraken links are referral links, and the developer may
    receive a referral reward. The wallet tags each one "Invite link".
- **Hosting (web app only):**
  - **kailah-wallet.netlify.app** is served by Netlify, which processes
    standard request logs under its own privacy policy.
  - **wallet.photoprompting.org** keeps standard web-server access logs (IP
    address, time, requested file, browser) for 14 days. They are used only
    to operate the site.
  - **The Chrome extension** loads no code from these sites. Chrome Web Store
    installs and updates are handled by Google under its policy.

Each service can see your IP address and the addresses you look up, and so
could link those addresses to each other. If that matters to you, use a VPN.
On Bitcoin, Litecoin and Dogecoin the wallet uses a fresh receive address for
each payment.

## Device features, used only when you ask

- **Camera:** for scanning QR codes. Frames are decoded on your device and
  never sent anywhere.
- **Notifications:** generic "payment received" alerts with no amounts. They
  are created on your device while the wallet is open.
- **Face ID / fingerprint unlock:** uses a passkey (WebAuthn). Your device or
  password manager stores the passkey under its own policy. The passkey only
  unlocks a second encrypted copy of your vault, which is kept on your device.
- **Ledger:** connects over USB in your browser. Only public keys and
  signatures pass between the device and the wallet.

## What we never do

We don't sell or share data, use it for advertising, or use it to judge
creditworthiness or lending. We have no wallet data to begin with. Your
information is used only to provide the wallet's features on your device.

## Children

Kailah Wallet is not directed at children under 13.

## Changes

Changes to this policy are published in the wallet's public source
repository, https://github.com/cbmcjargon/kailah, with a new effective date.

## Contact

security@photoprompting.org
