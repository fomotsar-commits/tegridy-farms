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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAV, MORE_NAV_SECTIONS } from '../navConfig';
import { ROUTES } from '../../../e2e/fixtures/routes';
import { hasRoutableYieldVenue } from './venues';

const SRC = join(process.cwd(), 'src');
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8');

describe('the nav entry says what a visitor can actually do', () => {
  it('promotes /yield in the More menu', () => {
    const entry = ALL_NAV.find((n) => n.to === '/yield');
    expect(entry, '/yield is missing from the nav').toBeTruthy();
    expect(entry!.label).toBe('Yield Routing');
    expect(MORE_NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.to)).toContain('/yield');
  });

  it('pills it, because the routing the label names cannot happen in this build', () => {
    // Precondition as a concrete fact read out of the catalogue: no venue has a
    // wired deposit address. Wire one and this assertion fails first, which is
    // the point — the pill is meant to self-clear and this test is meant to force
    // a re-read when it does.
    expect(hasRoutableYieldVenue(), 'no yield venue should be routable in this build').toBe(false);
    expect(ALL_NAV.find((n) => n.to === '/yield')!.soon).toBe(true);
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

describe('this slice invents no second fee mechanism', () => {
  it('defines no rate, recipient or bps constant of its own anywhere under lib/yield', () => {
    // lib/fees/swapFee.ts is the single place a fee figure may come from. A
    // literal bps or a hardcoded recipient here would be a charge no operator
    // dial can turn off.
    for (const file of ['venues.ts', 'feed.ts', 'metrics.ts', 'display.ts', 'dcaYield.ts', 'fee.ts']) {
      const source = read('lib', 'yield', file);
      expect(source, `${file} declares a fee rate`).not.toMatch(/(FEE_BPS|feeBps|FEE_RATE)\s*=/);
      // The only address literal permitted in this slice is the zero address,
      // which is the routing gate.
      const addresses = source.match(/0x[0-9a-fA-F]{40}/g) ?? [];
      for (const address of addresses) {
        expect(address, `${file} carries a live address literal`).toBe(
          '0x0000000000000000000000000000000000000000',
        );
      }
    }
  });

  it('takes its figure from providerFeeAttachment and from nowhere else', () => {
    // Checked against the IMPORTS rather than the file text: the header comment
    // names `swapFeePolicy` on purpose, to record why it is not imported.
    const source = read('lib', 'yield', 'fee.ts');
    expect(source).toContain('providerFeeAttachment');
    const imports = source.split('\n').filter((l) => l.trimStart().startsWith('import'));
    expect(
      imports.join('\n'),
      'importing the policy is how a surface ends up advertising a charge no request carried',
    ).not.toContain('swapFeePolicy');
  });
});
