# Security policy

Kailah Wallet holds people's keys, so a security report is the most valuable
feedback it can get. Thank you for taking the time.

## Reporting a vulnerability

Report privately. Please don't open a public issue, discussion or pull request
for a security problem.

- **Preferred:** GitHub private vulnerability reporting. Open this
  repository's **Security** tab and choose **Report a vulnerability**.
- **Email:** security@photoprompting.org

A useful report says:

- what an attacker can do, and what they need first;
- the affected version or commit;
- steps or a proof of concept, on a test network (see "Testing rules");
- whether anyone else knows about it.

## What to expect

- An acknowledgement within 14 days, then a first assessment.
- A fix for each confirmed issue, as quickly as its severity warrants. You
  will hear before details are made public, and you can be credited in the fix
  and in the security review if you want.
- There is no paid bug bounty.

## Scope

In scope:

- The wallet's code in this repository: key handling, the vault, transaction
  building and verification, signing, the Ledger path, QR parsing and the
  double-pay guard.
- The web build and browser extension made from it, including their CSP and
  headers.
- The official deployments: https://kailah-wallet.netlify.app,
  https://wallet.photoprompting.org and the Chrome Web Store listing
  (coming soon).

Out of scope:

- Bugs in the blockchain APIs, explorers, RPC providers or exchanges the wallet
  talks to. How the wallet handles what they return *is* in scope: a lying
  provider is part of its threat model.
- Attacks that need a compromised device, a malicious browser or the user's
  password. See the threat model in
  [SECURITY-REVIEW-2026-10-21.md](SECURITY-REVIEW-2026-10-21.md).
- Social engineering, phishing sites that imitate the wallet, denial of
  service and rate limits.
- Automated-scanner output with no demonstrated impact.

## Testing rules

- Use practice mode (test networks) or your own funds only. Never touch other
  people's funds or accounts.
- Don't load-test the deployments or the public APIs they use.
- The recovery phrase "abandon" ×11 + "about" is a public test vector. Anyone
  can take funds sent to its addresses, so that is not a vulnerability.
- Good-faith research that follows these rules will not be pursued legally.

## Supported versions

Only the latest release (currently v2.3.0) and `main` receive fixes.

## Known open risks

"Residual risks" in
[SECURITY-REVIEW-2026-10-21.md](SECURITY-REVIEW-2026-10-21.md) lists the
risks that remain open. Please check it before reporting one of them.
