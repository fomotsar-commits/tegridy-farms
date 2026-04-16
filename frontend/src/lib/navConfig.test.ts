import { describe, it, expect } from 'vitest';
import { PRIMARY_NAV, MORE_NAV, ALL_NAV, MORE_PATHS } from './navConfig';

describe('navConfig', () => {
  it('PRIMARY_NAV has items with to and label', () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('MORE_NAV has items with to and label', () => {
    expect(MORE_NAV.length).toBeGreaterThan(0);
    for (const item of MORE_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('ALL_NAV is superset of PRIMARY_NAV and MORE_NAV', () => {
    const allPaths = ALL_NAV.map(n => n.to);
    for (const item of PRIMARY_NAV) {
      expect(allPaths).toContain(item.to);
    }
    for (const item of MORE_NAV) {
      expect(allPaths).toContain(item.to);
    }
  });

  it('MORE_PATHS matches MORE_NAV paths', () => {
    const navPaths = MORE_NAV.map(n => n.to);
    expect(MORE_PATHS).toEqual(navPaths);
  });

  it('no duplicate paths in ALL_NAV', () => {
    const paths = ALL_NAV.map(n => n.to);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
});
