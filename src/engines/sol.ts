// The Solana engine as one chunk: the library (with micro-sol-signer), stake
// account discovery and the card. src/engines.ts loads it when the dashboard
// first renders; each modal (swap and stake included) is a further chunk,
// fetched the first time it opens.
import { lazy } from 'react'

export * from '../lib/sol'
export { fetchStakeAccounts } from '../lib/solstake'
export { default as SolCard } from '../components/SolCard'

export const SolReceiveModal = lazy(() => import('../components/SolReceiveModal'))
export const SolSendModal = lazy(() => import('../components/SolSendModal'))
export const SolSwapModal = lazy(() => import('../components/SolSwapModal'))
export const SolStakeModal = lazy(() => import('../components/SolStakeModal'))
export const SolBuyModal = lazy(() => import('../components/SolBuyModal'))
