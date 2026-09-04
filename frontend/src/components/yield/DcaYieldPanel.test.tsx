// The one sentence on /swap that a wired venue could have turned into a promise.
//
// Before the venues were routable this panel's available branch was unreachable,
// so its wording cost nothing. The moment Lido and Aave became real destinations
// the old sentence — "Would route to Aave v3 — USDC market" — became a claim
// that this schedule does the deposit. It does not: nothing here holds funds,
// no keeper runs, and every leg is a transaction the user signs on /yield.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DcaYieldPanel } from './DcaYieldPanel';
import { dcaYieldPlan, type DcaAsset } from '../../lib/yield/dcaYield';

function renderPlan(asset: DcaAsset) {
  render(
    <MemoryRouter>
      <DcaYieldPanel amountPerSwap="0.1" totalSwaps={10} asset={asset} />
    </MemoryRouter>,
  );
  const result = dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0, asset });
  if (!result.ok) throw new Error(`expected a plan, got: ${result.reason}`);
  return result.plan;
}

describe('the idle-budget panel describes a destination, never an action', () => {
  it('says the deposit is signed on the yield page and never says "Would route"', () => {
    const plan = renderPlan({ symbol: 'ETH', decimals: 18 });
    // The ETH budget has a staking destination, so the available branch renders.
    expect(plan.autoStake.state).toBe('available');
    expect(screen.getByText(/sign there/i)).toBeTruthy();
    expect(screen.queryByText(/Would route/i)).toBeNull();
  });

  it('names the token a lending market would need rather than offering a mismatched one', () => {
    renderPlan({ symbol: 'ETH', decimals: 18 });
    expect(screen.getByText(/USDC and USDS markets take those tokens/i)).toBeTruthy();
  });

  it('keeps saying that nothing here executes on its own', () => {
    renderPlan({ symbol: 'ETH', decimals: 18 });
    expect(screen.getByText(/no keeper/i)).toBeTruthy();
  });
});
