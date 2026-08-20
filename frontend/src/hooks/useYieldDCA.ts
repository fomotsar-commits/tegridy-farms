import { useMemo } from 'react';
import { dcaYieldPlan, type DcaBudgetInput, type DcaYieldPlanResult } from '../lib/yield/dcaYield';

// The DCA panel's view of its own unspent budget.
//
// Thin on purpose: every decision lives in lib/yield/dcaYield.ts, which is pure
// and tested without a render. What this adds is memoisation keyed on the three
// inputs that can change it — a plan recomputed on every keystroke of an
// unrelated field would re-run the parse and, worse, invite a caller to treat the
// result object's identity as meaningful.
//
// Returns the REFUSAL as a value rather than throwing or defaulting. A malformed
// amount must reach the panel as "this could not be read", never as a plan whose
// idle figure happens to be zero — that reading would tell a user their budget is
// fully deployed when nothing was parsed at all.

export function useYieldDCA(input: DcaBudgetInput): DcaYieldPlanResult {
  const { amountPerSwap, totalSwaps, completedSwaps, asset } = input;
  // Depended on field by field rather than on `asset` itself: a caller that
  // builds the descriptor inline hands over a fresh object every render, and
  // keying on its identity would defeat the memo for every consumer that does.
  const { symbol, decimals } = asset;
  return useMemo(
    () => dcaYieldPlan({ amountPerSwap, totalSwaps, completedSwaps, asset: { symbol, decimals } }),
    [amountPerSwap, totalSwaps, completedSwaps, symbol, decimals],
  );
}
