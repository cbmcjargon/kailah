// The TRON engine as one chunk: the library (protobuf decode-verify, TronGrid)
// and the card. src/engines.ts loads it when the dashboard first renders;
// each modal (staking included) is a further chunk, fetched the first time
// it opens.
import { lazy } from 'react'

export * from '../lib/tron'
export { default as TronCard } from '../components/TronCard'

export const TronReceiveModal = lazy(() => import('../components/TronReceiveModal'))
export const TronSendModal = lazy(() => import('../components/TronSendModal'))
export const TronBuyModal = lazy(() => import('../components/TronBuyModal'))
export const TronStakeModal = lazy(() => import('../components/TronStakeModal'))
