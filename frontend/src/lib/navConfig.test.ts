import { describe, it, expect } from 'vitest';
import { PRIMARY_NAV, POINTS_NAV, ALL_NAV, MORE_NAV, NFT_FINANCE_LIVE, COMMUNITY_LIVE } from './navConfig';

// Session 1 consolidated the navigation from 21 routes to a tight primary set.
// MORE_PATHS was removed; MORE_NAV is the flattened "More" destinations and
// ALL_NAV is PRIMARY_NAV + the right-aligned Tradermigos action + MORE_NAV.
// This test asserts the post-consolidation shape.

describe('navConfig', () => {
  it('PRIMARY_NAV has items with `to` and `label`', () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('PRIMARY_NAV is the agreed tight consolidation', () => {
    // Keep the top-nav tight. If this ever exceeds 5, revisit the IA
    // consolidation rationale in the session-1 battle plan before
    // relaxing the assertion.
    expect(PRIMARY_NAV.length).toBeLessThanOrEqual(5);
    const paths = PRIMARY_NAV.map((n) => n.to);
    // Spot-check the core surfaces actually exist in the primary set.
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/farm');
    expect(paths).toContain('/swap');
  });

  it('NFT Finance is promoted in primary nav ONLY when a contract is live', () => {
    // CREDIBILITY GATING (2026-06-09): a top-nav item whose every tab ends
    // in "Contract Not Deployed" leaks trust. The entry returns automatically
    // when any nft-finance relaunch address lands in constants.ts.
    const paths = PRIMARY_NAV.map((n) => n.to);
    expect(paths.includes('/nft-finance')).toBe(NFT_FINANCE_LIVE);
  });

  it('Community appears in the More menu ONLY when a governance contract is live', () => {
    const morePaths = MORE_NAV.map((n) => n.to);
    expect(morePaths.includes('/community')).toBe(COMMUNITY_LIVE);
  });

  it('POINTS_NAV is the right-aligned promoted action (Tradermigos)', () => {
    // Previously the right-aligned slot was Points; Tradermigos was swapped
    // in from the "More" dropdown so the art marketplace gets top-bar prominence.
    expect(POINTS_NAV.to).toBe('/nakamigos');
    expect(POINTS_NAV.label).toBe('Tradermigos');
  });

  it('ALL_NAV is a superset of PRIMARY_NAV', () => {
    const allPaths = ALL_NAV.map((n) => n.to);
    for (const item of PRIMARY_NAV) {
      expect(allPaths).toContain(item.to);
    }
  });

  it('no duplicate paths in ALL_NAV', () => {
    const paths = ALL_NAV.map((n) => n.to);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
});
