// The unified portfolio: every tracked source, one total, one freshness model.
//
// Deliberately thin. All availability logic is in `lib/portfolio/sources.ts` and all
// summing/disclosure logic is in `lib/portfolio/aggregate.ts`, both pure, so the rules
// that decide whether a number may be shown are provable without a chain or a render.

import { useMemo } from 'react';
import { usePortfolioSources } from './usePortfolioSources';
import { aggregatePortfolio, describeCompleteness } from '../lib/portfolio/aggregate';
import type { PortfolioSourceReport, PortfolioTotal } from '../lib/portfolio/types';

export interface UsePortfolioResult {
  sources: PortfolioSourceReport[];
  total: PortfolioTotal;
  /** The sentence that must travel with the total. See `describeCompleteness`. */
  summary: string;
  refetch: () => Promise<void>;
}

export function usePortfolio(): UsePortfolioResult {
  const { sources, refetch } = usePortfolioSources();
  const total = useMemo(() => aggregatePortfolio(sources), [sources]);
  const summary = useMemo(() => describeCompleteness(total), [total]);
  return { sources, total, summary, refetch };
}
