import { describe, it, expect } from 'vitest';
import { PRIMARY_NAV, POINTS_NAV, ALL_NAV } from './navConfig';

// Session 1 consolidated the navigation from 21 routes to 5 primary entries.
// MORE_NAV / MORE_PATHS were removed; ALL_NAV now contains the primary set
// plus the right-aligned Points action. This test file is updated to match
// the post-consolidation shape.

describe('navConfig', () => {
  it('PRIMARY_NAV has items with `to` and `label`', () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('PRIMARY_NAV is the agreed 5-item consolidation', () => {
    // Keep the top-nav tight. If this ever exceeds 5, revisit the IA
    // consolidation rationale in the session-1 battle plan before
    // relaxing the assertion.
    expect(PRIMARY_NAV.length).toBeLessThanOrEqual(5);
    const paths = PRIMARY_NAV.map((n) => n.to);
    // Spot-check the core surfaces actually exist in the primary set.
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/farm');
    expect(paths).toContain('/swap');
    expect(paths).toContain('/lending');
  });

  it('POINTS_NAV is the right-aligned Points action', () => {
    expect(POINTS_NAV.to).toBe('/leaderboard');
    expect(POINTS_NAV.label).toBe('Points');
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
