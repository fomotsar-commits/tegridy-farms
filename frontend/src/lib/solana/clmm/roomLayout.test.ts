import { describe, expect, it } from 'vitest';
import type { DepthProfile } from './depthProfile';
import { ROOM_COLUMNS, ROOM_REACH_TICKS, roomLayout, roomSparks } from './roomLayout';

/** 0 below 1,000, then 100 up to 2,000, then 300 up to 3,000, then 0 to the end of the reading. */
const profile: DepthProfile = {
  from: 0,
  to: 6_000,
  steps: [
    { from: 0, to: 1_000, liquidity: 0n },
    { from: 1_000, to: 2_000, liquidity: 100n },
    { from: 2_000, to: 3_000, liquidity: 300n },
    { from: 3_000, to: 6_000, liquidity: 0n },
  ],
};

describe('roomLayout', () => {
  it('closes in on the liquidity, with a margin, and never past what was read', () => {
    const l = roomLayout(profile, 1_500);
    // The liquidity runs 1,000 to 3,000; 8% of that is 160 either side.
    expect(l.tickFrom).toBe(840);
    expect(l.tickTo).toBe(3_160);
    expect(l.heights).toHaveLength(ROOM_COLUMNS);
  });

  it('draws each column against the deepest one, and the empty floor at 0', () => {
    const l = roomLayout(profile, 1_500);
    const at = (tick: number) => l.heights[Math.floor(((tick - l.tickFrom) / (l.tickTo - l.tickFrom)) * ROOM_COLUMNS)];
    expect(at(900)).toBe(0);
    expect(at(1_500)).toBeCloseTo(1 / 3, 3);
    expect(at(2_500)).toBe(1);
    expect(at(3_100)).toBe(0);
    expect(l.nowHeight).toBeCloseTo(1 / 3, 3);
    expect(l.now).toBeCloseTo((1_500 - 840) / (3_160 - 840), 6);
  });

  it('is a flat floor, not an error, when nothing in view holds liquidity', () => {
    const empty: DepthProfile = { from: 0, to: 6_000, steps: [{ from: 0, to: 6_000, liquidity: 0n }] };
    const l = roomLayout(empty, 100);
    expect(l.heights.every((h) => h === 0)).toBe(true);
    expect(l.nowHeight).toBe(0);
  });

  it('never reaches further than the cap from the price', () => {
    const wide: DepthProfile = { from: -500_000, to: 500_000, steps: [{ from: -500_000, to: 500_000, liquidity: 5n }] };
    const l = roomLayout(wide, 0);
    expect(l.tickFrom).toBe(-ROOM_REACH_TICKS);
    expect(l.tickTo).toBe(ROOM_REACH_TICKS);
    expect(l.now).toBeCloseTo(0.5, 6);
  });

  it('places a position’s slab, clips one that runs off the floor, and drops one wholly off it', () => {
    const l = roomLayout(profile, 1_500, [
      { lower: 1_000, upper: 2_000 },
      { lower: -10_000, upper: 10_000 },
      { lower: 4_000, upper: 5_000 },
    ]);
    expect(l.blocks).toHaveLength(2);
    expect(l.blocks[0]).toMatchObject({ openLeft: false, openRight: false, inRange: true });
    expect(l.blocks[0]!.from).toBeCloseTo((1_000 - 840) / 2_320, 6);
    expect(l.blocks[0]!.to).toBeCloseTo((2_000 - 840) / 2_320, 6);
    expect(l.blocks[1]).toEqual({ from: 0, to: 1, openLeft: true, openRight: true, inRange: true });
  });

  it('turns the floor round when a higher tick is a lower price: the cheap end stays on the left', () => {
    const positions = [
      { lower: 1_000, upper: 2_000 },
      { lower: 2_500, upper: 10_000 },
    ];
    const plain = roomLayout(profile, 1_500, positions);
    const turned = roomLayout(profile, 1_500, positions, true);
    expect(turned.heights).toEqual([...plain.heights].reverse());
    // The deep stretch (ticks 2,000 to 3,000) is the cheaper one here, so it is drawn on the left.
    expect(turned.heights[20]).toBe(1);
    expect(turned.heights[ROOM_COLUMNS - 20]).toBeCloseTo(1 / 3, 3);
    expect(turned.now).toBeCloseTo(1 - plain.now, 9);
    expect(turned.blocks[0]!.from).toBeCloseTo(1 - plain.blocks[0]!.to, 9);
    expect(turned.blocks[0]!.to).toBeCloseTo(1 - plain.blocks[0]!.from, 9);
    // The one that ran off the right edge by tick now runs off the left.
    expect(plain.blocks[1]).toMatchObject({ openLeft: false, openRight: true });
    expect(turned.blocks[1]).toMatchObject({ from: 0, openLeft: true, openRight: false });
  });

  it('marks a position the price has left as out of range', () => {
    const l = roomLayout(profile, 2_500, [{ lower: 1_000, upper: 2_000 }]);
    expect(l.blocks[0]!.inRange).toBe(false);
  });
});

describe('roomSparks', () => {
  const swap = (signature: string, slot: number, inSide: 'token' | 'coin', inAmount: bigint) => ({ signature, slot, blockTime: null, inSide, inAmount });

  it('flies them oldest first: a buy for the pairing coin in, a sell for the token in', () => {
    const s = roomSparks([swap('c', 30, 'coin', 5n), swap('b', 20, 'token', 9n), swap('a', 10, 'coin', 5n)]);
    expect(s.map((x) => x.signature)).toEqual(['a', 'b', 'c']);
    expect(s.map((x) => x.side)).toEqual(['buy', 'sell', 'buy']);
  });

  it('sizes each against the largest swap of its own side, never smaller than a spark you can see', () => {
    const s = roomSparks([swap('big', 1, 'coin', 10_000n), swap('small', 2, 'coin', 1n), swap('only', 3, 'token', 4n)]);
    expect(s[0]!.size).toBe(1);
    expect(s[1]!.size).toBeGreaterThanOrEqual(0.35);
    expect(s[1]!.size).toBeLessThan(0.37);
    expect(s[2]!.size).toBe(1);
  });
});
