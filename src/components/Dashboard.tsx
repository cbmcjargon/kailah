import { lazy, Suspense, useEffect, useState } from 'react'
import type {
  AccountKeys,
  ChainConfig,
  ChainId,
  HardwareAccountKeys,
  NetMode,
  PricePoint,
  TxSummary,
} from '../lib/types'
import { CHAINS } from '../lib/networks'
import { hardwareSlotKey } from '../lib/hwaccount'
import { evmToUsd } from '../lib/units'
import type { DetectedToken, EvmChainConfig, EvmChainId, EvmKey, EvmTx, EvmUiState } from '../lib/evm'
import type { SolChainConfig, SolChainId, SolKey, SolUiState } from '../lib/sol'
import type { TronChainConfig, TronChainId, TronKey, TronUiState } from '../lib/tron'
import type { Engine, EvmEngine, SolEngine, TronEngine } from '../engines'
import { IconLock, IconRefresh, IconSettings, IconShield, LogoMark } from './Icons'
import ChainCard from './ChainCard'
import ModeToggle from './ModeToggle'
import PortfolioHeader, { type PortfolioSegment } from './PortfolioHeader'
import ChunkBoundary, { ModalFailed, ModalPending } from './ChunkBoundary'
import { coinsToUsd, type ChainStates } from './ui'
import { IS_EXTENSION } from '../platform'

// UTXO account modals: each its own chunk (send and Speed up carry the
// transaction builder and the Ledger protocols), fetched the first time it
// opens. The other engines' cards and modals come with their engine (src/engines).
const ReceiveModal = lazy(() => import('./ReceiveModal'))
const SendModal = lazy(() => import('./SendModal'))
const BuyModal = lazy(() => import('./BuyModal'))
const TxDetailModal = lazy(() => import('./TxDetailModal'))
const BumpModal = lazy(() => import('./BumpModal'))

/** stable empty history, so the EVM send form's lookalike check isn't recomputed every render */
const EMPTY_EVM_TXS: EvmTx[] = []

interface DashboardProps {
  mode: NetMode
  chains: ChainConfig[]
  accounts: Record<ChainId, AccountKeys>
  /** Ledger accounts for the chains of the current mode (always shown, whatever the chooser says) */
  hwAccounts: HardwareAccountKeys[]
  chainStates: ChainStates
  /** each engine's chunk: its cards and modals render once it has loaded */
  evm: Engine<EvmEngine>
  evmChains: EvmChainConfig[]
  evmKey: EvmKey | null
  evmStates: Record<EvmChainId, EvmUiState>
  sol: Engine<SolEngine>
  solChains: SolChainConfig[]
  solKey: SolKey | null
  solStates: Record<SolChainId, SolUiState>
  tron: Engine<TronEngine>
  tronChains: TronChainConfig[]
  tronKey: TronKey | null
  tronStates: Record<TronChainId, TronUiState>
  prices: Record<string, number>
  priceHistory: Record<string, PricePoint[]>
  onRequestModeChange: (mode: NetMode) => void
  onRefreshChain: (chain: ChainConfig) => void
  onRefreshHw: (account: HardwareAccountKeys) => void
  onAddHardware: () => void
  onRefreshEvm: (chain: EvmChainConfig) => void
  /** ownAction: the wallet's own swap, stake withdrawal or claim, whose credit is not a payment alert */
  onRefreshSol: (chain: SolChainConfig, opts?: { ownAction?: boolean }) => void
  onRefreshTron: (chain: TronChainConfig, opts?: { ownAction?: boolean }) => void
  onRefreshAll: () => void
  /** this mode's networks hidden by Settings › Networks shown */
  hiddenCount: number
  onShowHidden: () => void
  onLock: () => void
  /** browser declined (or lacks) persistent storage — remind about the backup */
  storageNudge: boolean
  onDismissStorageNudge: () => void
  onOpenSettings: () => void
}

/**
 * One UTXO account on screen: a seed account (key = chain id) or a hardware
 * account (key = 'hw:<record id>'). Modals address accounts by this key.
 */
interface Slot {
  key: string
  chain: ChainConfig
  account: AccountKeys | HardwareAccountKeys
  hw: HardwareAccountKeys | null
}

type ActiveModal =
  | { kind: 'receive' | 'send'; slot: string }
  // the delivery address is fixed when the modal opens: a scan finishing
  // meanwhile moved it under the user (bug audit 2026-10-27, BL43)
  | { kind: 'buy'; slot: string; address: string }
  | { kind: 'txdetail'; slot: string; txid: string }
  // Carries the tx snapshot: a successful bump makes the original txid vanish
  // from the next scan, and the modal must stay open on its success screen.
  | { kind: 'bump'; slot: string; tx: TxSummary }
  | { kind: 'evm-receive' | 'evm-send' | 'evm-buy'; evmId: EvmChainId }
  | { kind: 'evm-send-custom'; evmId: EvmChainId; token: DetectedToken }
  | { kind: 'sol-receive' | 'sol-send' | 'sol-buy' | 'sol-swap' | 'sol-stake'; solId: SolChainId }
  | { kind: 'tron-receive' | 'tron-send' | 'tron-buy' | 'tron-stake'; tronId: TronChainId }
  | null

export default function Dashboard({
  mode,
  chains,
  accounts,
  hwAccounts,
  chainStates,
  evm,
  evmChains,
  evmKey,
  evmStates,
  sol,
  solChains,
  solKey,
  solStates,
  tron,
  tronChains,
  tronKey,
  tronStates,
  prices,
  priceHistory,
  onRequestModeChange,
  onRefreshChain,
  onRefreshHw,
  onAddHardware,
  onRefreshEvm,
  onRefreshSol,
  onRefreshTron,
  onRefreshAll,
  hiddenCount,
  onShowHidden,
  onLock,
  storageNudge,
  onDismissStorageNudge,
  onOpenSettings,
}: DashboardProps) {
  const [active, setActive] = useState<ActiveModal>(null)
  const closeModal = () => setActive(null)
  // Each engine's components, once its chunk has loaded (null until then).
  const evmUi = evm.lib
  const solUi = sol.lib
  const tronUi = tron.lib

  const slots: Slot[] = [
    ...chains.map((chain) => ({ key: chain.id, chain, account: accounts[chain.id], hw: null })),
    ...hwAccounts.map((a) => ({ key: hardwareSlotKey(a.record), chain: CHAINS[a.chain], account: a, hw: a })),
  ]
  const refreshSlot = (s: Slot) => (s.hw !== null ? onRefreshHw(s.hw) : onRefreshChain(s.chain))

  const priceFor = (chain: ChainConfig): number | undefined =>
    chain.priceSymbol !== undefined ? prices[chain.priceSymbol] : undefined
  const historyFor = (chain: ChainConfig): PricePoint[] =>
    chain.priceSymbol !== undefined ? (priceHistory[chain.priceSymbol] ?? []) : []

  // Per-asset USD segments for the portfolio header (only assets whose price
  // and balance have both loaded; UTXO chains by confirmed balance, EVM
  // networks as USDC + gas ETH combined per network).
  const segments: PortfolioSegment[] = []
  for (const { key, chain, hw } of slots) {
    if (chain.priceSymbol === undefined) continue
    const price = prices[chain.priceSymbol]
    const balance = chainStates[key]?.account?.balance
    if (price === undefined || balance === undefined) continue
    segments.push({
      id: key,
      label: hw !== null ? `${chain.ticker} · Ledger` : chain.ticker,
      color: chain.color,
      usd: coinsToUsd(balance.confirmed, chain.decimals, price),
    })
  }
  for (const c of evmChains) {
    if (!c.mainnet) continue
    const s = evmStates[c.id]
    const tokenPrice = prices[c.token.priceSymbol]
    const gasPrice = prices[c.gas.priceSymbol]
    // either half counts on its own: a missing USDC price used to drop the
    // network's ETH/BNB too (bug audit 2026-10-27, BM9)
    const tokenUsd = s?.token != null && tokenPrice !== undefined ? evmToUsd(s.token, c.token.decimals, tokenPrice) : null
    const gasUsd = s?.gas != null && gasPrice !== undefined ? evmToUsd(s.gas, 18, gasPrice) : null
    if (tokenUsd === null && gasUsd === null) continue
    segments.push({ id: c.id, label: c.name, color: c.color, usd: (tokenUsd ?? 0) + (gasUsd ?? 0) })
  }
  for (const c of solChains) {
    if (!c.mainnet) continue
    const st = solStates[c.id]
    const price = prices[c.priceSymbol]
    if (st?.balance == null || price === undefined) continue
    // staked SOL is the holder's too (BM9)
    const staked = st.stakeAccounts.reduce((sum, a) => sum + a.lamports, 0n)
    let usd = evmToUsd(st.balance + staked, c.decimals, price)
    const usdcPrice = prices[c.usdc.priceSymbol]
    if (st.usdcBalance != null && usdcPrice !== undefined) {
      usd += evmToUsd(st.usdcBalance, c.usdc.decimals, usdcPrice)
    }
    segments.push({ id: c.id, label: 'SOL', color: c.color, usd })
  }
  for (const c of tronChains) {
    if (!c.mainnet) continue
    const st = tronStates[c.id]
    const price = prices[c.priceSymbol]
    if (st?.balance == null || price === undefined) continue
    // and so is staked or unstaking TRX (BM9)
    let usd = evmToUsd(st.balance + (st.staked ?? 0n), c.decimals, price)
    const usdtPrice = prices[c.usdt.priceSymbol]
    if (st.usdtBalance != null && usdtPrice !== undefined) {
      usd += evmToUsd(st.usdtBalance, c.usdt.decimals, usdtPrice)
    }
    segments.push({ id: c.id, label: 'TRX', color: c.color, usd })
  }

  const activeEvmChain =
    active !== null && 'evmId' in active ? evmChains.find((c) => c.id === active.evmId) : undefined
  const activeSolChain =
    active !== null && 'solId' in active ? solChains.find((c) => c.id === active.solId) : undefined
  const activeTronChain =
    active !== null && 'tronId' in active
      ? tronChains.find((c) => c.id === active.tronId)
      : undefined

  const activeSlot = active !== null && 'slot' in active ? slots.find((s) => s.key === active.slot) : undefined
  const activeChain = activeSlot?.chain
  const activeAccountState = activeSlot !== undefined ? (chainStates[activeSlot.key]?.account ?? null) : null
  // A modal whose network was hidden (the automatic first pick, say) is
  // closed for good: kept open in state, it came back by itself when the
  // network was shown again (bug audit 2026-10-27, BL42).
  const activeGone =
    active !== null &&
    (('slot' in active && activeSlot === undefined) ||
      ('evmId' in active && activeEvmChain === undefined) ||
      ('solId' in active && activeSolChain === undefined) ||
      ('tronId' in active && activeTronChain === undefined))
  useEffect(() => {
    if (activeGone) setActive(null)
  }, [activeGone])
  // txdetail re-derives from the live list (fine — it just closes if the tx
  // confirms away); bump carries its own snapshot so it never unmounts mid-flow.
  const activeTx =
    active?.kind === 'txdetail' && activeAccountState !== null
      ? (activeAccountState.txs.find((t) => t.txid === active.txid) ?? null)
      : null
  const receiveAddressFor = (s: Slot): string =>
    chainStates[s.key]?.account?.nextReceive.address ?? s.account.address(0, 0).address

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <LogoMark size={26} />
          <span className="brand-name">
            Kailah Wallet
            {/* phishing check: a lookalike site can copy everything but its own hostname
                (in the extension, the hostname is the extension ID) */}
            <span
              className="brand-origin"
              title={
                IS_EXTENSION
                  ? 'This extension’s ID — check it matches the ID in the Chrome Web Store listing’s address'
                  : 'The site you are on — check it matches the address you trust'
              }
            >
              {typeof location !== 'undefined' ? location.hostname : ''}
            </span>
          </span>
        </div>
        <div className="header-actions">
          <ModeToggle mode={mode} onChange={onRequestModeChange} />
          <button type="button" className="icon-btn" aria-label="Lock wallet" onClick={onLock}>
            <IconLock />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <IconSettings />
          </button>
        </div>
      </header>

      {mode === 'real' && <PortfolioHeader segments={segments} partial={hiddenCount > 0} />}

      {mode === 'practice' && (
        <div className="practice-banner">
          Practice mode — these are worthless test coins. Grab some from a faucet and try a real
          send, risk-free.
        </div>
      )}

      {storageNudge && (
        <div className="practice-banner storage-nudge" role="status">
          <div>
            <strong>Keep your 12 words somewhere safe.</strong> This browser hasn&rsquo;t promised to
            keep the wallet&rsquo;s saved data if you don&rsquo;t open it for a while. Installing the
            app to your home screen helps — and your recovery phrase restores everything either way.
          </div>
          <button type="button" className="btn btn-ghost btn-small" onClick={onDismissStorageNudge}>
            Got it
          </button>
        </div>
      )}

      <div className="row-between section-head">
        <h2 className="section-title">Balances</h2>
        <button
          type="button"
          className="icon-btn icon-btn-small"
          aria-label="Refresh all balances"
          onClick={onRefreshAll}
        >
          <IconRefresh size={17} />
        </button>
      </div>

      <main className="card-list">
        {slots.map((s) => (
          <ChainCard
            key={s.key}
            chain={s.chain}
            account={s.account}
            {...(s.hw !== null && { deviceLabel: 'Ledger' })}
            state={chainStates[s.key] ?? { account: null, loading: false, error: null }}
            price={priceFor(s.chain)}
            priceHistory={historyFor(s.chain)}
            onRefresh={() => refreshSlot(s)}
            onReceive={() => setActive({ kind: 'receive', slot: s.key })}
            onSend={() => setActive({ kind: 'send', slot: s.key })}
            onBuy={() => setActive({ kind: 'buy', slot: s.key, address: receiveAddressFor(s) })}
            onSelectTx={(tx) => setActive({ kind: 'txdetail', slot: s.key, txid: tx.txid })}
          />
        ))}
        {/* an engine with every network hidden isn't loaded, and shows no placeholder */}
        {evmUi === null && evm.wanted && <EnginePending name="Ethereum networks" failed={evm.failed} />}
        {evmUi !== null &&
          evmKey !== null &&
          evmChains.map((chain) => (
            <evmUi.EvmCard
              key={chain.id}
              chain={chain}
              address={evmKey.address}
              state={
                evmStates[chain.id] ?? {
                  token: null,
                  gas: null,
                  others: [],
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              tokenPrice={prices[chain.token.priceSymbol]}
              gasPrice={prices[chain.gas.priceSymbol]}
              history={priceHistory[chain.gasPrimary === true ? chain.gas.priceSymbol : chain.token.priceSymbol]}
              onRefresh={() => onRefreshEvm(chain)}
              onReceive={() => setActive({ kind: 'evm-receive', evmId: chain.id })}
              onSend={() => setActive({ kind: 'evm-send', evmId: chain.id })}
              onSendCustom={(token) =>
                setActive({ kind: 'evm-send-custom', evmId: chain.id, token })
              }
              onBuy={() => setActive({ kind: 'evm-buy', evmId: chain.id })}
              onTxClick={(t) => window.open(chain.explorerTx(t.hash), '_blank', 'noopener')}
            />
          ))}
        {solUi === null && sol.wanted && <EnginePending name="Solana" failed={sol.failed} />}
        {solUi !== null &&
          solKey !== null &&
          solChains.map((chain) => (
            <solUi.SolCard
              key={chain.id}
              chain={chain}
              address={solKey.address}
              state={
                solStates[chain.id] ?? {
                  balance: null,
                  usdcBalance: null,
                  stakeAccounts: [],
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[chain.priceSymbol]}
              usdcPrice={prices[chain.usdc.priceSymbol]}
              history={priceHistory[chain.priceSymbol]}
              onRefresh={() => onRefreshSol(chain)}
              onReceive={() => setActive({ kind: 'sol-receive', solId: chain.id })}
              onSend={() => setActive({ kind: 'sol-send', solId: chain.id })}
              onBuy={() => setActive({ kind: 'sol-buy', solId: chain.id })}
              onSwap={() => setActive({ kind: 'sol-swap', solId: chain.id })}
              onStake={() => setActive({ kind: 'sol-stake', solId: chain.id })}
              onTxClick={(t) => window.open(chain.explorerTx(t.signature), '_blank', 'noopener')}
            />
          ))}
        {tronUi === null && tron.wanted && <EnginePending name="TRON" failed={tron.failed} />}
        {tronUi !== null &&
          tronKey !== null &&
          tronChains.map((chain) => (
            <tronUi.TronCard
              key={chain.id}
              chain={chain}
              address={tronKey.address}
              state={
                tronStates[chain.id] ?? {
                  balance: null,
                  usdtBalance: null,
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[chain.priceSymbol]}
              usdtPrice={prices[chain.usdt.priceSymbol]}
              onRefresh={() => onRefreshTron(chain)}
              onReceive={() => setActive({ kind: 'tron-receive', tronId: chain.id })}
              onSend={() => setActive({ kind: 'tron-send', tronId: chain.id })}
              onBuy={() => setActive({ kind: 'tron-buy', tronId: chain.id })}
              onStake={() => setActive({ kind: 'tron-stake', tronId: chain.id })}
              onTxClick={(t) => window.open(chain.explorerTx(t.id), '_blank', 'noopener')}
            />
          ))}
        {hiddenCount > 0 && (
          // Hidden networks are never checked — say so, so nothing seems to vanish.
          <button
            type="button"
            className="btn btn-ghost hidden-nets-btn"
            onClick={onShowHidden}
            title="Hidden networks aren’t checked for balances or payments"
          >
            {hiddenCount} {hiddenCount === 1 ? 'network' : 'networks'} hidden — show
          </button>
        )}
        <button type="button" className="btn btn-ghost add-hw-btn" onClick={onAddHardware}>
          <IconShield size={16} />
          {hwAccounts.length > 0 ? 'Add another Ledger account' : 'Add a Ledger hardware wallet'}
        </button>
      </main>

      {/* keyed by modal, so closing one that failed to load resets the boundary */}
      <ChunkBoundary key={active?.kind ?? 'none'} fallback={<ModalFailed onClose={closeModal} />}>
        <Suspense fallback={<ModalPending onClose={closeModal} />}>
          {active?.kind === 'receive' && activeSlot !== undefined && (
            <ReceiveModal
              chain={activeSlot.chain}
              account={activeSlot.account}
              accountState={activeAccountState}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'buy' && activeSlot !== undefined && (
            <BuyModal
              chain={activeSlot.chain}
              address={active.address}
              onClose={() => setActive(null)}
              // a Ledger address is checked on the device before anyone pays to it
              {...(activeSlot.hw !== null && { onVerifyOnDevice: () => setActive({ kind: 'receive', slot: activeSlot.key }) })}
            />
          )}

          {active?.kind === 'send' && activeSlot !== undefined && (
            <SendModal
              chain={activeSlot.chain}
              account={activeSlot.account}
              accountState={activeAccountState}
              price={priceFor(activeSlot.chain)}
              onClose={() => setActive(null)}
              onSent={() => refreshSlot(activeSlot)}
            />
          )}

          {active?.kind === 'txdetail' && activeSlot !== undefined && activeChain !== undefined && activeTx !== null && (
            <TxDetailModal
              chain={activeChain}
              tx={activeTx}
              price={priceFor(activeChain)}
              onClose={() => setActive(null)}
              onBump={
                activeTx.bumpable
                  ? () => setActive({ kind: 'bump', slot: activeSlot.key, tx: activeTx })
                  : undefined
              }
            />
          )}

          {active?.kind === 'bump' &&
            activeSlot !== undefined &&
            activeAccountState !== null && (
              <BumpModal
                chain={activeSlot.chain}
                account={activeSlot.account}
                tx={active.tx}
                onClose={() => setActive(null)}
                onBumped={() => refreshSlot(activeSlot)}
              />
            )}

          {active?.kind === 'evm-receive' && activeEvmChain !== undefined && evmKey !== null && evmUi !== null && (
            <evmUi.EvmReceiveModal
              chain={activeEvmChain}
              address={evmKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'evm-buy' && activeEvmChain !== undefined && evmKey !== null && evmUi !== null && (
            <evmUi.EvmBuyModal
              chain={activeEvmChain}
              address={evmKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'sol-receive' && activeSolChain !== undefined && solKey !== null && solUi !== null && (
            <solUi.SolReceiveModal
              chain={activeSolChain}
              address={solKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'sol-buy' && activeSolChain !== undefined && solKey !== null && solUi !== null && (
            <solUi.SolBuyModal
              chain={activeSolChain}
              address={solKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'sol-send' && activeSolChain !== undefined && solKey !== null && solUi !== null && (
            <solUi.SolSendModal
              chain={activeSolChain}
              solKey={solKey}
              state={
                solStates[activeSolChain.id] ?? {
                  balance: null,
                  usdcBalance: null,
                  stakeAccounts: [],
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[activeSolChain.priceSymbol]}
              usdcPrice={prices[activeSolChain.usdc.priceSymbol]}
              onClose={() => setActive(null)}
              onSent={() => onRefreshSol(activeSolChain)}
            />
          )}

          {active?.kind === 'sol-swap' && activeSolChain !== undefined && solKey !== null && solUi !== null && (
            <solUi.SolSwapModal
              chain={activeSolChain}
              solKey={solKey}
              state={
                solStates[activeSolChain.id] ?? {
                  balance: null,
                  usdcBalance: null,
                  stakeAccounts: [],
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[activeSolChain.priceSymbol]}
              usdcPrice={prices[activeSolChain.usdc.priceSymbol]}
              onClose={() => setActive(null)}
              onSwapped={() => onRefreshSol(activeSolChain, { ownAction: true })}
            />
          )}

          {active?.kind === 'sol-stake' && activeSolChain !== undefined && solKey !== null && solUi !== null && (
            <solUi.SolStakeModal
              chain={activeSolChain}
              solKey={solKey}
              state={
                solStates[activeSolChain.id] ?? {
                  balance: null,
                  usdcBalance: null,
                  stakeAccounts: [],
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[activeSolChain.priceSymbol]}
              onClose={() => setActive(null)}
              onChanged={() => onRefreshSol(activeSolChain, { ownAction: true })}
            />
          )}

          {active?.kind === 'tron-receive' && activeTronChain !== undefined && tronKey !== null && tronUi !== null && (
            <tronUi.TronReceiveModal
              chain={activeTronChain}
              address={tronKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'tron-buy' && activeTronChain !== undefined && tronKey !== null && tronUi !== null && (
            <tronUi.TronBuyModal
              chain={activeTronChain}
              address={tronKey.address}
              onClose={() => setActive(null)}
            />
          )}

          {active?.kind === 'tron-send' && activeTronChain !== undefined && tronKey !== null && tronUi !== null && (
            <tronUi.TronSendModal
              chain={activeTronChain}
              tronKey={tronKey}
              state={
                tronStates[activeTronChain.id] ?? {
                  balance: null,
                  usdtBalance: null,
                  txs: [],
                  loading: false,
                  error: null,
                }
              }
              price={prices[activeTronChain.priceSymbol]}
              usdtPrice={prices[activeTronChain.usdt.priceSymbol]}
              onClose={() => setActive(null)}
              onSent={() => onRefreshTron(activeTronChain)}
            />
          )}

          {active?.kind === 'tron-stake' && activeTronChain !== undefined && tronKey !== null && tronUi !== null && (
            <tronUi.TronStakeModal
              chain={activeTronChain}
              tronKey={tronKey}
              price={prices[activeTronChain.priceSymbol]}
              onClose={() => setActive(null)}
              onChanged={() => onRefreshTron(activeTronChain, { ownAction: true })}
            />
          )}

          {(active?.kind === 'evm-send' || active?.kind === 'evm-send-custom') &&
            activeEvmChain !== undefined &&
            evmKey !== null &&
            evmUi !== null && (
              <evmUi.EvmSendModal
                chain={activeEvmChain}
                evmKey={evmKey}
                balances={
                  evmStates[activeEvmChain.id]
                    ? { token: evmStates[activeEvmChain.id]!.token, gas: evmStates[activeEvmChain.id]!.gas }
                    : null
                }
                txs={evmStates[activeEvmChain.id]?.txs ?? EMPTY_EVM_TXS}
                tokenPrice={prices[activeEvmChain.token.priceSymbol]}
                gasPrice={prices[activeEvmChain.gas.priceSymbol]}
                {...(active.kind === 'evm-send-custom' && { customToken: active.token })}
                onClose={() => setActive(null)}
                onSent={() => onRefreshEvm(activeEvmChain)}
              />
            )}
        </Suspense>
      </ChunkBoundary>
    </div>
  )
}

/** An engine's place on the dashboard while its chunk loads, or if it failed to. */
function EnginePending({ name, failed }: { name: string; failed: boolean }) {
  return (
    <section className="card chain-card" aria-label={name} aria-busy={!failed}>
      <div className="chain-card-head">
        <div className="chain-id">
          <span className="chain-name">{name}</span>
        </div>
      </div>
      <div className="chain-balance">
        {failed ? (
          <p className="form-error" role="alert">
            Couldn’t load. Check your connection, then reload the page.
          </p>
        ) : (
          <>
            <div className="skeleton skeleton-balance" />
            <div className="skeleton skeleton-caption" />
          </>
        )}
      </div>
    </section>
  )
}
