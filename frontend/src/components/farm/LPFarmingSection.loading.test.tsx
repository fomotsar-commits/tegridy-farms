/**
 * THE LOADING STATE MUST STILL NAME THE SECTION.
 *
 * `LPFarmingSection` early-returns a skeleton while `useLPFarming`'s batch read is
 * in flight. That skeleton used to stand two grey `animate-pulse` bars where the
 * section's heading and subtitle go:
 *
 *     <div className="h-6 w-40 rounded bg-white/10 animate-pulse" />
 *     <div className="h-4 w-64 rounded bg-white/10 animate-pulse mt-1.5" />
 *
 * Both strings are compile-time constants. Nothing about "LP Farming" depends on
 * the chain, so there was never anything to wait for — the section simply withheld
 * its own identity for the duration of an RPC round trip. To a screen reader that
 * is a region with no accessible name; to a sighted user it is an unlabelled
 * pulsing box among five labelled sections.
 *
 * The window is not small. App.tsx sets `retry: 2` on the shared QueryClient and
 * viem's http transport carries a 10s timeout behind a two-endpoint fallback, so a
 * degraded RPC can hold this state for tens of seconds — exactly the conditions
 * under which a user most needs to know WHICH section is struggling.
 *
 * It was also load-bearing for CI. e2e/claim-rewards.spec.ts asserts that /farm
 * mounts its reward-bearing sections, and its `getByRole('heading', /lp farming/i)`
 * could not see a mounted-but-loading section at all. On the Anvil fork job that
 * assertion is a race against cold-fork RPC latency and it lost roughly half the
 * time (measured on trunk: clean passes at 2.5-3.9s, failures at 6.4-6.7s against
 * a 5s budget), where `retries: 2` re-ran it against a now-warm fork and turned a
 * real UI defect into a "flaky" warning.
 *
 * MUTATION CHECK — run these against the pre-fix component before trusting them:
 * restore the two grey bars in place of the <h2>/<p> and `should still name itself`
 * fails on the missing heading. `keeps the loading state distinguishable` is the
 * other half: it fails if the skeleton is "fixed" by rendering the resolved panel,
 * which would make the e2e spec's separate did-the-read-land assertion vacuous.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));
// Both run ABOVE the early return, so they have to answer even for the skeleton.
vi.mock('../../hooks/usePoolTVL', () => ({
  usePoolTVL: () => ({ isLoaded: false, lpSupply: 0n, tvl: 0 }),
}));
vi.mock('../../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 0 }),
}));

import { LPFarmingSection } from './LPFarmingSection';

type LPFarm = ComponentProps<typeof LPFarmingSection>['lpFarm'];

/**
 * Only `isReadLoading` decides the branch under test, and asserting on a hand-built
 * copy of all ~35 hook fields would pin the hook's shape rather than this behaviour.
 * The cast keeps the test about the one input that selects the skeleton.
 */
function loadingFarm(overrides: Partial<LPFarm> = {}): LPFarm {
  return { isReadLoading: true, isDeployed: true, ...overrides } as unknown as LPFarm;
}

describe('LPFarmingSection — loading state', () => {
  it('should still name itself while the batch read is in flight', () => {
    renderWithProviders(<LPFarmingSection lpFarm={loadingFarm()} isConnected />);

    // The accessible heading, not the raw text: this is what a screen reader
    // announces and what the e2e spec looks for, and a <div> full of the right
    // characters would satisfy a text match while failing both.
    expect(screen.getByRole('heading', { name: /lp farming/i })).toBeInTheDocument();
    expect(screen.getByText(/earn TOWELI rewards/i)).toBeInTheDocument();
  });

  it('marks the section busy so the name is not mistaken for settled content', () => {
    const { container } = renderWithProviders(
      <LPFarmingSection lpFarm={loadingFarm()} isConnected />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('keeps the loading state distinguishable from a landed read', () => {
    // The heading is now free of the read, so it can no longer stand in for one.
    // e2e/claim-rewards.spec.ts leans on this: it asserts the heading to prove the
    // section MOUNTED and a read-derived stat to prove the read LANDED. If the
    // skeleton ever started rendering the stats too, that second assertion would
    // silently stop gating anything.
    renderWithProviders(<LPFarmingSection lpFarm={loadingFarm()} isConnected />);

    expect(screen.queryByText(/total lp staked/i)).toBeNull();
    expect(screen.queryByText(/est\. apr/i)).toBeNull();
  });
});
