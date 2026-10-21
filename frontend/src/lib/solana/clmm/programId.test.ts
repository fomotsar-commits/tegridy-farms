import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_PROGRAM_ADDRESS, RANGE_POOLS_OPEN, RANGE_PROGRAM_ADDRESS, rangePoolsVisible } from './programId';
import { POOLS_SECTION } from '../../navConfig';
import { tabChains } from '../../sectionChains';

/**
 * The range program is deployed (2026-10-21), and range pools stay out of sight until the
 * owner opens them: no tab, no route, nothing in the swap route. Opening is one line,
 * RANGE_POOLS_OPEN, once the fee tiers exist on chain; this test and the route table's
 * 'not-yet-routed' gate change with it, on purpose. A `--mode range-preview` build shows
 * them early, for a walk of the screen.
 */
describe('range pools are closed until the owner opens them', () => {
  it('the committed id is the deployed program', () => {
    expect(RANGE_PROGRAM_ADDRESS).toBe('7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso');
    expect(RANGE_PROGRAM_ADDRESS).not.toBe(PLACEHOLDER_PROGRAM_ADDRESS);
  });

  it('this build lists no Range tab', () => {
    expect(RANGE_POOLS_OPEN).toBe(false);
    expect(rangePoolsVisible()).toBe(false);
    expect(POOLS_SECTION.items.map((i) => i.to)).not.toContain('/range-pools');
  });

  it('a production build shows them only once opened; a preview build always', () => {
    expect(rangePoolsVisible(false, 'production')).toBe(false);
    expect(rangePoolsVisible(false, 'development')).toBe(false);
    expect(rangePoolsVisible(false, 'range-preview')).toBe(true);
    expect(rangePoolsVisible(true, 'production')).toBe(true);
  });

  it('the tab, when shown, sits on the Solana network', () => {
    expect(tabChains('/range-pools')).toEqual(['solana']);
  });
});
