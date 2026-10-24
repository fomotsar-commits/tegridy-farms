import { describe, it, expect } from 'vitest';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';
import { EARN_PATH, earnPoolPath, isEarnPoolId, legacyFarmTarget, TOWELI_EARN_PATH } from './earnRoutes';
import { BAR_NAV, LOCK_SECTION } from './navConfig';

const live = BUNGALOWS.find((b) => b.live && b.id !== DEFAULT_BUNGALOW_ID)!;
const retired = BUNGALOWS.find((b) => !b.live);

describe("Earn's addresses", () => {
  it('the Lock word and its first tab go to the list, never to one pool', () => {
    // Owner, 2026-09-30: from inside a pool the word "stays on the same page" when it points
    // at an address whose content the active room chose.
    expect(BAR_NAV.find((n) => n.label === 'Lock')?.to).toBe(EARN_PATH);
    expect(LOCK_SECTION.hub).toBe(EARN_PATH);
    expect(LOCK_SECTION.items[0]?.to).toBe(EARN_PATH);
    expect(EARN_PATH).toBe('/earn');
  });

  it('gives each pool its own address under the list', () => {
    expect(earnPoolPath('bayla')).toBe('/earn/bayla');
    expect(TOWELI_EARN_PATH).toBe(`/earn/${DEFAULT_BUNGALOW_ID}`);
  });

  it('opens a pool page only for a live resident', () => {
    expect(isEarnPoolId(live.id)).toBe(true);
    expect(isEarnPoolId(DEFAULT_BUNGALOW_ID)).toBe(true);
    expect(isEarnPoolId('not-a-resident')).toBe(false);
    expect(isEarnPoolId('')).toBe(false);
    if (retired) expect(isEarnPoolId(retired.id)).toBe(false);
  });
});

describe('an old /farm link keeps its meaning', () => {
  it("goes to the active room's pool", () => {
    expect(legacyFarmTarget('', '', { id: live.id })).toBe(`/earn/${live.id}`);
    expect(legacyFarmTarget('', '', { id: DEFAULT_BUNGALOW_ID })).toBe('/earn/toweli');
  });

  it('goes to the list with no room, or a room that has no pool page', () => {
    expect(legacyFarmTarget('', '', null)).toBe('/earn');
    expect(legacyFarmTarget('', '', { id: 'not-a-resident' })).toBe('/earn');
  });

  it('spends ?bungalow= on the choice and keeps every other query and the hash', () => {
    expect(legacyFarmTarget(`?bungalow=${live.id}`, '', { id: live.id })).toBe(`/earn/${live.id}`);
    expect(legacyFarmTarget(`?bungalow=${live.id}&ref=0xabc`, '#lp', { id: live.id })).toBe(
      `/earn/${live.id}?ref=0xabc#lp`,
    );
    expect(legacyFarmTarget('?ref=0xabc', '', null)).toBe('/earn?ref=0xabc');
  });
});
