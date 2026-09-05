// THE WIRING, HELD TO THE SAME STANDARD AS THE LOGIC.
//
// A slice can be entirely honest inside its own modules and still ship a lie at
// the edges: a nav entry that reads as live, a route the a11y sweep never learns
// about, a backdrop the art studio cannot reach, or a panel imported by nothing.
// Each of those has bitten this repo before and each has a registry because of
// it. This file checks that this slice actually landed in all of them.
//
// The nav assertion is written in the shape navConfig.test.ts settled on: pin the
// PRECONDITION as a concrete computed fact first, then the value that must follow
// from it. Comparing the pill to the same function that sets it would pass for
// any implementation, including a hardcoded one.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAV, NAV_SECTIONS } from '../navConfig';
import { ROUTES } from '../../../e2e/fixtures/routes';
import { depositPlan } from './deposit';
import { YIELD_ADDRESSES } from './protocols';
import { hasRoutableYieldVenue, routableYieldVenues } from './venues';

const SRC = join(process.cwd(), 'src');
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8');

/**
 * Comments are prose, not behaviour. The repo's registry scanner draws the same
 * line (scripts/verify-addresses.mjs stripComments) for the same reason: a rule
 * that fires on a comment EXPLAINING the rule is a rule nobody can document.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ' '))
    .join('\n');

describe('the nav entry says what a visitor can actually do', () => {
  it('promotes /yield in the nav', () => {
    const entry = ALL_NAV.find((n) => n.to === '/yield');
    expect(entry, '/yield is missing from the nav').toBeTruthy();
    expect(entry!.label).toBe('Yield Routing');
    // 2026-09-05: MORE_NAV_SECTIONS became NAV_SECTIONS when the "More"
    // dropdown was deleted and its sections became the six top-bar words.
    // /yield is a tab on the Earn host either way.
    expect(NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.to)).toContain('/yield');
  });

  it('clears the pill, because the routing the label names now happens', () => {
    // Precondition as a concrete fact read out of the catalogue FIRST, then the
    // pill value that must follow from it. Comparing the pill to the same
    // function that sets it would pass for any implementation, including a
    // hardcoded one.
    expect(routableYieldVenues().map((v) => v.id)).toEqual([
      'lido-steth',
      'rocketpool-reth',
      'etherfi-weeth',
      'renzo-ezeth',
      'aave-v3-usdc',
      'compound-v3-usdc',
      'sky-susds',
    ]);
    expect(hasRoutableYieldVenue()).toBe(true);
    expect(ALL_NAV.find((n) => n.to === '/yield')!.soon).toBe(false);
  });

  it('THE VACUITY GUARD: every venue the pill counts has a button that would submit', () => {
    // The pill says "you can route from here". This is the assertion that the
    // sentence is true: for each venue it counts, a fully-satisfied plan reaches
    // 'ready' and its steps are addressed to that protocol's own contract.
    // Wiring an address without a working route clears the pill and fails here.
    for (const venue of routableYieldVenues()) {
      const plan = depositPlan({
        venue,
        amountText: '0.5',
        chainId: 1,
        account: '0x00000000000000000000000000000000000000A1',
        nativeBalance: 10n ** 19n,
        assetBalance: 10n ** 18n,
        allowance: 10n ** 18n,
        rocket: {
          resolvedPool: venue.depositTarget,
          resolvedSettings: YIELD_ADDRESSES.rocketSettingsDeposit,
          depositEnabled: true,
          minimumDeposit: 10n ** 16n,
          maxPoolSize: 6_000_000n * 10n ** 18n,
          poolBalance: 15n * 10n ** 18n,
        },
      });
      expect(plan.state, `${venue.id} does not reach a submittable plan`).toBe('ready');
      if (plan.state !== 'ready') continue;
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps[0]!.address).toBe(venue.depositTarget);
    }
  });

  it('is not keyed to the yield feed, which would clear the pill on the wrong signal', () => {
    // A configured feed with no wired destination is a working comparison table
    // and a router that cannot route. That mismatch is the /solana-launch bug.
    const source = read('lib', 'navConfig.ts');
    const line = source.split('\n').find((l) => l.includes("to: '/yield'"))!;
    expect(line).toContain('hasRoutableYieldVenue');
    expect(line).not.toContain('isYieldFeedConfigured');
  });
});

describe('the route is registered everywhere a route has to be', () => {
  it('is routed by App.tsx', () => {
    expect(read('App.tsx')).toMatch(/<Route\s+path="yield"/);
  });

  it('is in the a11y route table, with the reason its live branches are unreachable', () => {
    const route = ROUTES.find((r) => r.path === '/yield');
    expect(route, '/yield is missing from e2e/fixtures/routes.ts').toBeTruthy();
    expect(route!.owner).toBe('pages/YieldPage.tsx');
    expect(route!.gate).toBeNull();
    expect(route!.why?.length ?? 0).toBeGreaterThan(40);
  });

  it('has a backdrop the art studio can reach', () => {
    // The inventory moved to lib/artSurfaces.ts (2026-08-28) so /art-studio
    // and /bayla-studio share one list — assert against that file.
    const studio = read('lib', 'artSurfaces.ts');
    expect(studio, "PAGE_ROUTES has no 'yield' entry").toMatch(/yield: '\/yield'/);
    expect(studio, 'SURFACES registers no yield backdrop').toMatch(/pageId: 'yield'/);
    // The page must actually render the surface the studio offers to adjust,
    // or the studio is editing art nothing displays.
    expect(read('pages', 'YieldPage.tsx')).toContain('pageId="yield"');
  });
});

describe('the DCA extension reaches the panel it was written for', () => {
  it('mounts the idle-budget panel inside the existing DCA tab', () => {
    // The brief for this slice was to EXTEND the DCA tab, not to build a parallel
    // scheduler beside it. A panel that existed only on the yield page would have
    // left the surface that actually creates schedules saying nothing.
    const dca = read('components', 'swap', 'DCATab.tsx');
    expect(dca).toContain('DcaYieldPanel');
    expect(dca).toContain('dcaIdleTotal');
    // Anchored on the call, not the name: `setIntervalIdx` is the existing
    // frequency picker's setter and matching it would make this assertion a
    // tripwire on unrelated state.
    expect(dca, 'the DCA tab must not gain a second scheduler').not.toMatch(/\bsetInterval\s*\(|new Worker\b/);
  });

  it('states the TWAP mechanism in the TWAP panel', () => {
    expect(read('components', 'swap', 'TwapOrderPanel.tsx')).toContain('TWAP_IDLE_NOTE');
  });
});

describe('this slice invents no fee mechanism, and holds its addresses in one file', () => {
  it('lets exactly ONE file carry a live address, so nothing else can route money', () => {
    // protocols.ts is the file scripts/verify-yield-protocols.mjs verifies
    // against the chain. Concentrating the literals there is what makes it
    // impossible for a destination to arrive from a prop, a query string, a
    // feed answer, localStorage or an RPC response — there is nowhere else for
    // one to come from.
    for (const file of ['venues.ts', 'metrics.ts', 'display.ts', 'dcaYield.ts', 'deposit.ts', 'reads.ts', 'onchain.ts']) {
      const source = read('lib', 'yield', file);
      expect(source, `${file} declares a fee rate`).not.toMatch(/(FEE_BPS|feeBps|FEE_RATE)\s*=/);
      const addresses = source.match(/0x[0-9a-fA-F]{40}/g) ?? [];
      for (const address of addresses) {
        expect(address, `${file} carries a live address literal`).toBe(
          '0x0000000000000000000000000000000000000000',
        );
      }
    }
  });

  it('and protocols.ts actually holds them, so the rule above is not vacuous', () => {
    const source = read('lib', 'yield', 'protocols.ts');
    const distinct = new Set(
      (source.match(/0x[0-9a-fA-F]{40}/g) ?? []).filter(
        (a) => a !== '0x0000000000000000000000000000000000000000',
      ),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(20);
  });

  it('imports no fee module anywhere under lib/yield', () => {
    // The venue takes nothing on this route: there is no venue leg in the
    // transaction for a fee to ride on. An import of lib/fees here would be the
    // first step toward advertising a charge this surface cannot collect.
    for (const file of ['venues.ts', 'metrics.ts', 'display.ts', 'dcaYield.ts', 'deposit.ts', 'reads.ts', 'onchain.ts', 'protocols.ts']) {
      const imports = read('lib', 'yield', file)
        .split('\n')
        .filter((l) => l.trimStart().startsWith('import'));
      expect(imports.join('\n'), `${file} imports a fee module`).not.toContain('fees');
    }
  });

  it('reads the chain rather than a feed, and dates nothing by the browser clock', () => {
    // The feed path is gone: no VITE_YIELD_FEED_URL, no fetch of a rate
    // document, and no Date.now() anywhere in the hook. Every age on this page
    // is chain timestamp minus source timestamp, both read on-chain.
    const hook = code('hooks', 'useYieldMarkets.ts');
    expect(hook).toContain('usePublicClient');
    expect(hook).toContain('multicall');
    expect(hook, 'the hook dates a figure by the visitor’s own clock').not.toContain('Date.now');
    expect(hook).not.toContain('isYieldFeedConfigured');
    // batchSize 0 keeps the clock legs in the same aggregate3 as the values.
    expect(hook).toContain('batchSize: 0');
  });

  it('has actually deleted the feed and fee modules rather than orphaning them', () => {
    for (const file of ['feed.ts', 'fee.ts', 'feed.test.ts', 'fee.test.ts']) {
      expect(existsSync(join(SRC, 'lib', 'yield', file)), `lib/yield/${file} still exists`).toBe(false);
    }
  });
});
