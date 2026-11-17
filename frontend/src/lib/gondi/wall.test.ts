// L-01's wall (lib/gondi/wall.ts): it draws only what the market card read, the picture as
// tall as the floor, and the three zones FloorBar names. Unread is listed, never drawn at a height.
import { describe, expect, it } from 'vitest';
import { barZone } from './floorBar';
import type { LendingMarket } from './lenderPitch';
import { spreadTags, wallElevation, wallFacts, type WallFacts } from './wall';

const JBAC = { name: 'Jungle Bay Ape Club', symbol: 'JBAC', address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9' };
const read: LendingMarket = { floor: 0.05, sales30d: 76, bids: { bestBid: 0.0394, nearFloor: 0 } };
const SHARES = [
  { pct: 60, amount: '0.0300' },
  { pct: 75, amount: '0.0375' },
  { pct: 90, amount: '0.0450' },
];
const facts = (over: Partial<Parameters<typeof wallFacts>[0]> = {}): WallFacts =>
  wallFacts({ market: read, loading: false, principal: null, shares: SHARES, ...over });
const label = (f: WallFacts, id: string, W = 600) => wallElevation(W, f, JBAC).labels.find((l) => l.id === id);

describe('what the wall may draw (wallFacts)', () => {
  it('draws nothing at a height while the read is out', () => {
    const f = facts({ loading: true, principal: 0.045 });
    expect(f.mode).toBe('reading');
    expect([f.top, f.floor, f.bid, f.zone]).toEqual([null, null, null, null]);
    const d = wallElevation(600, f, JBAC);
    expect([d.floorY, d.bidY, d.loanY, d.zones, d.dim]).toEqual([null, null, null, null, null]);
    expect(d.labels.find((l) => l.k === 'stamp')).toMatchObject({ t: 'READING', tone: '' });
    expect(d.labels.filter((l) => l.k === 'tag' || l.k === 'loan')).toEqual([]);
  });

  it('with no floor read, nothing is to scale: no level, no zone, and the floor says NOT READ first', () => {
    const f = facts({ market: { floor: null, sales30d: null, bids: { bestBid: 0.012, nearFloor: null } }, principal: 0.02 });
    expect(f.mode).toBe('nts');
    expect([f.top, f.zone]).toEqual([null, null]);
    expect(f.shares).toEqual([]);
    const d = wallElevation(600, f, JBAC);
    expect([d.floorY, d.bidY, d.loanY, d.zones, d.dim]).toEqual([null, null, null, null, null]);
    // Largest first: the floor (unknown), the loan typed, the bid read.
    expect(d.labels.filter((l) => l.k === 'tag' || l.k === 'loan').map((l) => [l.t, l.v, l.tone])).toEqual([
      ['FLOOR', 'NOT READ', 'warn'],
      ['LOAN', '0.0200 WETH', ''],
      ['BEST BID', '0.012 WETH', 'ok'],
    ]);
    expect(d.labels.find((l) => l.k === 'stamp')).toMatchObject({ t: 'NOT TO SCALE', tone: 'warn' });
  });

  it('with the floor read, the picture is the floor: as tall as floor / top of the scale', () => {
    const f = facts({ principal: 0.045 });
    expect(f.mode).toBe('scaled');
    for (const W of [328, 600, 1040]) {
      const d = wallElevation(W, f, JBAC);
      expect(d.picture.side).toBe(Math.round((f.floor! / f.top!) * d.scaleH));
      // It stands on datum ±0, and its head is the FLOOR level.
      expect(d.picture.y + d.picture.side).toBe(d.y0);
      expect(Math.abs(d.floorY! - d.picture.y)).toBeLessThanOrEqual(0.5);
    }
  });

  it('names the zone the amount stands in exactly as FloorBar does', () => {
    for (const bids of [read.bids, { bestBid: null, nearFloor: null }, null]) {
      for (const principal of [0.01, 0.0394, 0.045, 0.05, 0.07]) {
        const f = facts({ market: { ...read, bids }, principal });
        expect(f.zone).toBe(barZone(principal, read.floor!, bids?.bestBid ?? null));
      }
    }
    expect(facts().zone).toBeNull();
  });

  it('says NONE only when the bids were read and none is open, and NOT READ when they were not read', () => {
    const none = facts({ market: { ...read, bids: { bestBid: null, nearFloor: null } } });
    const unread = facts({ market: { ...read, bids: null } });
    expect([none.bidState, unread.bidState]).toEqual(['none', 'unread']);
    expect(label(none, 'bid')).toMatchObject({ t: 'BEST BID', v: 'NONE' });
    expect(label(none, 'bid')?.tone).toBeUndefined();
    expect(label(unread, 'bid')).toMatchObject({ t: 'BEST BID', v: 'NOT READ', tone: 'warn' });
    expect(wallElevation(600, none, JBAC).bidY).toBeNull();
    expect(facts().bidState).toBe('read');
  });

  it('marks the staff only with the shares the page offers, and lights the one typed', () => {
    expect(wallElevation(600, facts({ shares: [] }), JBAC).shareMarks).toEqual([]);
    const d = wallElevation(600, facts({ principal: 0.045 }), JBAC);
    expect(d.shareMarks.map((s) => s.on)).toEqual([false, false, true]);
    expect(d.labels.filter((l) => l.k === 'share').map((l) => l.t)).toEqual(['60%', '75%', '90%']);
    // Not to scale, a share of an unread floor means nothing.
    const nts = wallElevation(600, facts({ market: { ...read, floor: null } }), JBAC);
    expect(nts.shareMarks).toEqual([]);
  });
});

describe('the levels (wallElevation)', () => {
  it('draws the loan only to scale and typed, and the dimension says how far under the floor it is', () => {
    expect(wallElevation(600, facts(), JBAC).loanY).toBeNull();
    // A bid well clear of the dimension's middle, so no tag stands where its words go.
    const market = { ...read, bids: { bestBid: 0.02, nearFloor: 0 } };
    const d = wallElevation(600, facts({ market, principal: 0.03 }), JBAC);
    expect(d.loanY).not.toBeNull();
    expect(d.loanY!).toBeGreaterThan(d.floorY!);
    expect(d.labels.find((l) => l.id === 'loan')).toMatchObject({ k: 'loan', t: 'LOAN', v: '0.0300 WETH' });
    expect(d.labels.find((l) => l.id === 'dim')).toMatchObject({ t: '40% UNDER THE FLOOR' });
    // The read bid at 0.0394 stands at the middle of 0.03 to 0.05: the words give way to its tag.
    expect(wallElevation(600, facts({ principal: 0.03 }), JBAC).labels.find((l) => l.id === 'dim')).toBeUndefined();
    const over = wallElevation(600, facts({ market, principal: 0.07 }), JBAC);
    expect(over.loanY!).toBeLessThan(over.floorY!);
    expect(over.labels.find((l) => l.id === 'dim')).toMatchObject({ t: '40% OVER THE FLOOR', tone: 'bad' });
  });

  it('compact, the tags are short and carry no unit', () => {
    const d = wallElevation(328, facts({ principal: 0.045 }), JBAC);
    expect(d.compact).toBe(true);
    expect(d.labels.filter((l) => l.k === 'tag' || l.k === 'loan').map((l) => `${l.t} ${l.v}`)).toEqual(['FLOOR 0.05', 'BID 0.0394', 'LOAN 0.0450']);
    expect(d.labels.find((l) => l.id === 'dim')).toBeUndefined();
  });

  it('keeps tags apart, in their order, inside the scale', () => {
    const out = spreadTags([{ y: 100 }, { y: 98 }, { y: 104 }], 90, 200, 17);
    expect(out.map((t) => t.ty)).toEqual([115, 98, 132]);
    const pinned = spreadTags([{ y: 195 }, { y: 199 }], 0, 200, 17);
    expect(pinned.map((t) => t.ty)).toEqual([183, 200]);
  });

  it('labels the wall with the whole address, and never a rate word', () => {
    const d = wallElevation(600, facts({ principal: 0.045 }), JBAC);
    expect(d.labels.find((l) => l.k === 'plate')).toMatchObject({ t: 'JUNGLE BAY APE CLUB · JBAC', v: JBAC.address });
    const words = d.labels.map((l) => `${l.t} ${l.v ?? ''}`).join(' ');
    expect(words).not.toMatch(/APR|APY|annual|daily|per day/i);
  });
});
