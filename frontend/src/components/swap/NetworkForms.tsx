import { lazy, Suspense, type ReactNode } from 'react';
import { venueChain, type VenueChain } from '../../lib/sectionChains';
import { CHAIN_ID } from '../../lib/constants';
import { ChainSwapAvailability } from './ChainSwapAvailability';
import { WrongChainBanner } from '../ui/WrongChainGuard';

// Each network's form is its page's own, in its own chunk: a module pays for the one it shows.
const EvmSwapPanel = lazy(() => import('./EvmSwapPanel').then((m) => ({ default: m.EvmSwapPanel })));
const LiquidityTab = lazy(() => import('./LiquidityTab').then((m) => ({ default: m.LiquidityTab })));
const CardanoSwapCard = lazy(() => import('../../pages/CardanoSwapPage').then((m) => ({ default: m.CardanoSwapCard })));
const HyperEvmSwapCard = lazy(() => import('../hyperevm/HyperEvmSwapCard').then((m) => ({ default: m.HyperEvmSwapCard })));
const HyperEvmPoolsSection = lazy(() => import('../hyperevm/HyperEvmPoolsSection'));

const wait = (
  <p role="status" className="text-white/70 text-[13px] py-3 min-h-[204px]">
    One moment…
  </p>
);

/**
 * The swap form of a network that is not Solana, for a module that switches network in place (the
 * sheet, the home's swap card): /swap's own form on Ethereum, Base and Robinhood Chain, /cardano's
 * on Cardano, /hyperevm's on HyperEVM. Every quote, check and signature is that form's, unchanged. Solana's form needs a
 * Solana connection and is mounted by the module itself.
 */
export function OffSolanaSwap({ chain, buy, lead }: { chain: Exclude<VenueChain, 'solana'>; buy?: string; lead?: ReactNode }) {
  if (chain === 'cardano') {
    return (
      <Suspense fallback={wait}>
        <div data-testid="module-swap" data-network="cardano">
          {lead && <div className="flex justify-end mb-3">{lead}</div>}
          <CardanoSwapCard />
        </div>
      </Suspense>
    );
  }
  if (chain === 'hyperevm') {
    // Our own V3 pools: its own form, which says when the wallet is on another network.
    return (
      <Suspense fallback={wait}>
        <div data-testid="module-swap" data-network="hyperevm">
          <HyperEvmSwapCard lead={lead} />
        </div>
      </Suspense>
    );
  }
  const chainId = venueChain(chain).evmChainId ?? CHAIN_ID;
  return (
    <div data-testid="module-swap" data-network={chain}>
      <ChainSwapAvailability chainId={chainId} swapTab />
      <WrongChainBanner requiredChainId={chainId} message="Your wallet is on another network. Switch it to trade here." className="mb-3" />
      <Suspense fallback={wait}>
        <EvmSwapPanel key={chainId} chainId={chainId} buy={buy} lead={lead} />
      </Suspense>
    </div>
  );
}

/** The add / remove form of an EVM network, /liquidity's own, for a module that switches network in place. */
export function OffSolanaPools({ chain }: { chain: Exclude<VenueChain, 'solana' | 'cardano'> }) {
  if (chain === 'hyperevm') {
    return (
      <div data-testid="module-pools" data-network="hyperevm">
        <Suspense fallback={wait}>
          <HyperEvmPoolsSection />
        </Suspense>
      </div>
    );
  }
  const chainId = venueChain(chain).evmChainId ?? CHAIN_ID;
  return (
    <div data-testid="module-pools" data-network={chain}>
      <WrongChainBanner requiredChainId={chainId} message="Your wallet is on another network. Switch it to add or remove here." className="mb-3" />
      <Suspense fallback={wait}>
        <LiquidityTab key={chainId} chainId={chainId} />
      </Suspense>
    </div>
  );
}
