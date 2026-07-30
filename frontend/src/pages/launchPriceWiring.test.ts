import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WIRING GUARD for the launch path's ETH/USD source.
//
// `useToweliPrice` exposes TWO ETH/USD values with deliberately different freshness
// windows: `ethUsd` (300s, for swaps) and `ethUsdForLaunch` (3900s ≈ the feed's own
// heartbeat + margin, for launches). LaunchPage must read the LAUNCH one.
//
// Reading `ethUsd` is not a type error and breaks no behavioural test — the component's
// onLaunch path has no unit coverage — yet it is exactly the defect that shipped: /launch
// refused ~85% of attempts against a perfectly healthy oracle, because a 300s window is
// 12x tighter than the 3600s publish cadence. A mutation test proved that reverting this
// one field reference turns the launcher off again with CI still fully green.
//
// So pin it at the source. This is a text assertion, which is a blunt instrument — it is
// here because it is the cheapest thing that actually fails when the bug returns, and the
// bug returning means the product silently stops working. Modelled on the same
// coverage-guard pattern as artStudioCoverage.test.ts.

const LAUNCH_PAGE = join(process.cwd(), 'src', 'pages', 'LaunchPage.tsx');

describe('LaunchPage ETH/USD wiring', () => {
  const src = readFileSync(LAUNCH_PAGE, 'utf8');

  /** Strip comments so prose mentioning a field never satisfies (or trips) the check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('sources the numeraire price from ethUsdForLaunch, not the swap-window ethUsd', () => {
    expect(code).toMatch(/numerairePriceUsd\s*=\s*price\?\.ethUsdForLaunch/);
  });

  it('does not read the 300s swap-window ethUsd anywhere in the launch path', () => {
    // `price?.ethUsd` followed by anything other than `ForLaunch`.
    expect(code).not.toMatch(/price\?\.ethUsd(?!ForLaunch)/);
  });

  it('the hook still exposes both values, so this guard is meaningful', () => {
    const hook = readFileSync(join(process.cwd(), 'src', 'hooks', 'useToweliPrice.ts'), 'utf8');
    expect(hook).toMatch(/ethUsdForLaunch/);
    expect(hook).toMatch(/MAX_LAUNCH_STALENESS_SECONDS\s*=\s*3900/);
    expect(hook).toMatch(/MAX_STALENESS_SECONDS\s*=\s*300/);
  });
});
