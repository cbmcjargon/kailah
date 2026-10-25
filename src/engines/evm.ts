// The EVM engine as one chunk: the library (with viem) and the card that
// shows a network. src/engines.ts loads it when the dashboard first renders;
// each modal is a further chunk, fetched the first time it opens.
import { lazy } from 'react'

export * from '../lib/evm'
export { default as EvmCard } from '../components/EvmCard'

export const EvmReceiveModal = lazy(() => import('../components/EvmReceiveModal'))
export const EvmSendModal = lazy(() => import('../components/EvmSendModal'))
export const EvmBuyModal = lazy(() => import('../components/EvmBuyModal'))
