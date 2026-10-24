import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, 2026-10-14: "have a glow around the staking or lp card position if a
 * person has staked so its easier to spot". One ring (`position-glow`) and one
 * pill (`PositionMark`) on every card a wallet can hold money in, keyed on the
 * card's own read of that wallet. A sibling that loses either line fails here,
 * and a new staking or LP card is added to this list.
 *
 * Source-level on purpose: the seven cards read seven different rails, and
 * their own test files hold the behaviour. This one holds the family together.
 */
const SIBLINGS: Record<string, string> = {
  'farm/StakingCard.tsx': 'pos.hasPosition',
  'farm/LPFarmingSection.tsx': 'lpFarm.stakedBalance > 0n',
  'bungalow/LighthousePoolLive.tsx': 'openEntries.length > 0',
  'bungalow/SolanaLadderPoolLive.tsx': 'positions.length > 0',
  'bungalow/EvmLadderPoolLive.tsx': 'positions.length > 0',
  'bungalow/EvmLighthousePoolLive.tsx': 'userStakedRaw > 0n',
  'solana/lp/YourPositions.tsx': 'inPosition',
  // The venue dashboard's two summary cards: drawn only for a position, ringed the same way.
  '../pages/DashboardPage.tsx': 'lpPos.hasPosition',
};

describe('position glow parity', () => {
  for (const [file, predicate] of Object.entries(SIBLINGS)) {
    it(`${file} wears the ring and the mark on ${predicate}`, () => {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src, 'ring on the card box').toMatch(/className=\{positionHost\(/);
      expect(src, 'the mark as a child').toMatch(/<PositionMark inPosition=\{/);
      expect(src, 'keyed on the card’s own read').toContain(predicate);
    });
  }
});
