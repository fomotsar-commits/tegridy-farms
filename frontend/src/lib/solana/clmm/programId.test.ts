import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_PROGRAM_ADDRESS, RANGE_POOLS_OPEN, RANGE_PROGRAM_ADDRESS, rangePoolsVisible } from './programId';
import { FEE_TIER_INDEXES } from './read';
import { POOLS_SECTION } from '../../navConfig';
import { tabChains } from '../../sectionChains';

/**
 * Range pools are shown: the Range tab, its route and range pools in the swap route (owner,
 * 2026-10-25: "show the Range tab on the live site now, even before the fee tiers are on
 * chain"). RANGE_POOLS_OPEN is the one line; this test and the route table's row change with it.
 */
describe('range pools are shown', () => {
  it('the committed id is the deployed program', () => {
    expect(RANGE_PROGRAM_ADDRESS).toBe('7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso');
    expect(RANGE_PROGRAM_ADDRESS).not.toBe(PLACEHOLDER_PROGRAM_ADDRESS);
  });

  it('this build lists the Range tab, right after Venue AMM', () => {
    expect(RANGE_POOLS_OPEN).toBe(true);
    expect(rangePoolsVisible()).toBe(true);
    const tabs = POOLS_SECTION.items.map((i) => i.to);
    expect(tabs.indexOf('/range-pools')).toBe(tabs.indexOf('/pools') + 1);
    expect(POOLS_SECTION.items.find((i) => i.to === '/range-pools')).toMatchObject({ label: 'Range pools', tabLabel: 'Range' });
  });

  // Owner, 2026-10-25: "there should only be one fee tier that is 1%". The deploy pack makes it at index 0.
  it('looks for one fee tier only, the one at index 0', () => {
    expect(FEE_TIER_INDEXES).toBe(1);
  });

  it('a production build shows them only once opened; a preview build always', () => {
    expect(rangePoolsVisible(false, 'production')).toBe(false);
    expect(rangePoolsVisible(false, 'development')).toBe(false);
    expect(rangePoolsVisible(false, 'range-preview')).toBe(true);
    expect(rangePoolsVisible(true, 'production')).toBe(true);
  });

  it('the tab sits on the Solana network', () => {
    expect(tabChains('/range-pools')).toEqual(['solana']);
  });
});
