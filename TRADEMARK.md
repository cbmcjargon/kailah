# Kailah Wallet name and logo policy

The Kailah Wallet **code** is open source under the MIT license (see
[LICENSE](LICENSE)): you may use, copy, change and share it. This policy
covers something the license does not: the **name** "Kailah Wallet" (and
"Kailah" for a wallet), and the **logo** (the "K" in a ring: `public/icon.svg`,
the app icons and the extension icons). Together these are the "Kailah
marks".

The marks tell people that a copy is the wallet as its maintainer ships it.
That matters for a wallet, because people trust it with their money.

## The rule

**A build distributed as "Kailah Wallet", or with the Kailah logo, must keep
the referral links and the swap fee unchanged.** These are:

| Setting | Value | Defined in |
| --- | --- | --- |
| Strike invite link | `https://invite.strike.me/QRPRGZ` | `src/lib/onramp.ts` (`STRIKE_INVITE_URL`) |
| Kraken invite link | `https://proinvite.kraken.com/9f1e/rf9gcbrs` | `src/lib/onramp.ts` (`KRAKEN_INVITE_URL`) |
| Gemini invite link | `https://exchange.gemini.com/register?referral=ben8re2e&type=referral` | `src/lib/onramp.ts` (`GEMINI_INVITE_URL`) |
| Swap fee rate | 0.5% (`50` basis points) | `src/lib/solswap.ts` (`SWAP_FEE_BPS`) |
| Swap fee account | `F5VXwGCmbct91xohG4CTqiXg25d23zYNQav1pB5eH2oF` (USDC, owned by `BpmzmuZieAHqCm8s183T9c397K46YqsEQKbyyNo4Wo8b`) | `src/lib/solswap.ts` (`SWAP_FEE_ACCOUNT`, `SWAP_FEE_WALLET`) |

**A build that changes, removes or replaces any of them must use a
different name and logo.**

## What you may do without asking

- **Build and run it yourself,** changed or unchanged, for your own use.
- **Share unchanged copies under the Kailah name.** These are builds of an
  official release with the settings above intact. Say where the copy came
  from, and don't suggest that the maintainer made, checked or supports your
  particular copy.
- **Fork it under another name,** with any changes you like, including your
  own referral links and fee account. Change the name everywhere it appears:
  - the app title and the welcome screen;
  - `index.html`, `public/manifest.webmanifest` and the extension manifest
    (`extension/manifest.ts`: `name` and `short_name`);
  - any store listing.

  Replace the logo and icons too.
- **Describe your fork truthfully,** for example "based on Kailah Wallet" or
  "a fork of Kailah Wallet", in your README or release notes, as long as the
  new name is the one people see.
- **Talk about Kailah Wallet** in articles, reviews, tutorials and
  comparisons.

## What needs a different name

- **Changed settings:** a build distributed with any of the settings above
  changed, removed or replaced.
- **Listings and accounts:** an app-store listing, extension listing, website,
  domain name or social media account that uses the Kailah marks, or
  something confusingly similar, for a build that doesn't follow the rule.
- **Implied endorsement:** anything that makes a changed build look official,
  or as though the maintainer endorses it.

## Why

Users can check an official build against the public source (`npm run
verify:live`, the build digests CI publishes, the store package). They can't
easily tell whether a copy that merely looks like Kailah Wallet sends its
referral rewards and fees to someone else. Keeping the name for builds with
the original settings keeps that clear, and renamed forks stay free to do
whatever the license allows.

## Contact

To ask about a use not covered here, or to report a copy that breaks this
policy, open an issue at https://github.com/cbmcjargon/kailah/issues.

This policy may change; changes are published in this repository.
