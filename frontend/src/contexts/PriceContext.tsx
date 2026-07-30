import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useToweliPrice } from '../hooks/useToweliPrice';

/**
 * Audit #53: Shared price context so multiple components share a single
 * useToweliPrice fetch instead of each calling the hook independently.
 */

type PriceData = ReturnType<typeof useToweliPrice>;

const PriceContext = createContext<PriceData | null>(null);

export function PriceProvider({ children }: { children: ReactNode }) {
  const price = useToweliPrice();
  const value = useMemo(
    () => price,
    [
      price.priceInEth,
      price.priceInUsd,
      price.ethUsd,
      // Tracks a DIFFERENT freshness window than `ethUsd` (heartbeat vs 300s), so it
      // flips independently — omitting it would hand /launch a stale memoized 0.
      price.ethUsdForLaunch,
      price.isLoaded,
      price.oracleStale,
      price.priceChange,
      price.priceUnavailable,
      price.displayPriceStale,
      price.apiPriceDiscrepant,
      price.priceDiscrepancy,
      // F144: include the TWAP/swap-safety flags so consumers (swap surfaces)
      // don't read a stale memoized object when only these flip.
      price.twapPriceInEth,
      price.twapOverrideActive,
      price.priceSafeForSwaps,
    ],
  );
  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
}

/**
 * Consume the shared TOWELI price from the nearest PriceProvider.
 * Throws if used outside PriceProvider — wrap your component tree.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTOWELIPrice(): PriceData {
  const ctx = useContext(PriceContext);
  if (!ctx) {
    throw new Error('useTOWELIPrice must be used within a <PriceProvider>');
  }
  return ctx;
}

/**
 * Non-throwing variant for surfaces that may mount outside AppLayout's
 * PriceProvider (the Tradermigos sub-app has two mount points: embedded
 * under /nakamigos and the standalone nakamigos.gallery build — neither
 * is wrapped). Returns null there; callers keep their own fallbacks.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTOWELIPriceOptional(): PriceData | null {
  return useContext(PriceContext);
}
