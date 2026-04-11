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
      price.isLoaded,
      price.oracleStale,
      price.priceChange,
      price.priceUnavailable,
      price.displayPriceStale,
      price.apiPriceDiscrepant,
      price.priceDiscrepancy,
    ],
  );
  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
}

/**
 * Consume the shared TOWELI price from the nearest PriceProvider.
 * Throws if used outside PriceProvider — wrap your component tree.
 */
export function useTOWELIPrice(): PriceData {
  const ctx = useContext(PriceContext);
  if (!ctx) {
    throw new Error('useTOWELIPrice must be used within a <PriceProvider>');
  }
  return ctx;
}
