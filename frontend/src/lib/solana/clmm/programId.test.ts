import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_PROGRAM_ADDRESS, RANGE_PROGRAM_ADDRESS, rangePoolsVisible } from './programId';
import { POOLS_SECTION } from '../../navConfig';
import { tabChains } from '../../sectionChains';

/**
 * Range pools stay out of sight while the program id is the placeholder: no tab, no route.
 * Only a build made with `--mode range-preview` shows them early, for a walk of the screen.
 * The deploy changes RANGE_PROGRAM_ADDRESS, and this test with it, on purpose.
 */
describe('range pools are hidden while the program id is the placeholder', () => {
  it('the committed id is the placeholder today', () => {
    expect(RANGE_PROGRAM_ADDRESS).toBe(PLACEHOLDER_PROGRAM_ADDRESS);
  });

  it('a production build hides them; a preview build or a real id shows them', () => {
    expect(rangePoolsVisible(PLACEHOLDER_PROGRAM_ADDRESS, 'production')).toBe(false);
    expect(rangePoolsVisible(PLACEHOLDER_PROGRAM_ADDRESS, 'development')).toBe(false);
    expect(rangePoolsVisible(PLACEHOLDER_PROGRAM_ADDRESS, 'range-preview')).toBe(true);
    expect(rangePoolsVisible('11111111111111111111111111111111', 'production')).toBe(true);
  });

  it('this build lists no Range tab', () => {
    expect(rangePoolsVisible()).toBe(false);
    expect(POOLS_SECTION.items.map((i) => i.to)).not.toContain('/range-pools');
  });

  it('the tab, when shown, sits on the Solana network', () => {
    expect(tabChains('/range-pools')).toEqual(['solana']);
  });
});
