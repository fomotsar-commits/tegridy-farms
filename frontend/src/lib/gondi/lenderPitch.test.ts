// The lender's pitch and risk numbers (lib/gondi/lenderPitch.ts). Each one only ever
// under-claims: an unread fee or bid is "unknown", never zero or "no buyers".
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GONDI_OWN_LOAN_ADDRESSES,
  LENDING_OPENSEA_SLUGS,
  bidBook,
  exitCheck,
  fetchLendingMarket,
  lowestOwnFeeBps,
  readStats,
  sameTakeHomeAprBps,
  underFloorPct,
  type CollectionBidLike,
} from './lenderPitch';
import { LENDING_COLLECTIONS } from './loanOffer.js';
import { COLLECTIONS as MARKET_COLLECTIONS } from '../../nakamigos/constants';
import { VENUE_SLUGS } from '../../../api/_lib/venue-registry.js';

describe('sameTakeHomeAprBps', () => {
  it('a 16.84% offer here (5% fee) keeps what a 20% offer keeps on a 20% contract', () => {
    expect(sameTakeHomeAprBps(1684, 500, 2000)).toBe(2000);
  });
  it('against Gondi v3.1 (15%): 10% here matches 11.18% there', () => {
    // 1000 x 9500 / 8500 = 1117.6
    expect(sameTakeHomeAprBps(1000, 500, 1500)).toBe(1118);
  });
  it('is null when a fee is unread or not a fee, or the rate is not a rate', () => {
    expect(sameTakeHomeAprBps(1000, null, 1500)).toBeNull();
    expect(sameTakeHomeAprBps(1000, 500, null)).toBeNull();
    expect(sameTakeHomeAprBps(1000, 500, 10_000)).toBeNull();
    expect(sameTakeHomeAprBps(1000, -1, 1500)).toBeNull();
    expect(sameTakeHomeAprBps(1000, 500.5, 1500)).toBeNull();
    expect(sameTakeHomeAprBps(0, 500, 1500)).toBeNull();
    expect(sameTakeHomeAprBps(Number.NaN, 500, 1500)).toBeNull();
  });
});

describe('lowestOwnFeeBps', () => {
  const ok = (fraction: bigint) => ({ status: 'success', result: { recipient: '0x0', fraction } });
  it('compares with the LOWER of Gondi\'s two fees', () => {
    expect(lowestOwnFeeBps([ok(1500n), ok(2000n)])).toBe(1500);
    expect(lowestOwnFeeBps([ok(2000n), ok(1500n)])).toBe(1500);
  });
  it('is null unless every read came back: one missing read could be the lower fee', () => {
    expect(lowestOwnFeeBps([ok(2000n), { status: 'failure' }])).toBeNull();
    expect(lowestOwnFeeBps([ok(2000n)])).toBeNull();
    expect(lowestOwnFeeBps(undefined)).toBeNull();
    expect(lowestOwnFeeBps([ok(1500n), { status: 'success', result: { fraction: 1500 } }])).toBeNull();
  });
  it('reads both of Gondi\'s own contracts, v3.1 first', () => {
    expect(GONDI_OWN_LOAN_ADDRESSES).toEqual([
      '0xf41B389E0C1950dc0B16C9498eaE77131CC08A56',
      '0xE365fF3cad44d19cb7aBa81df8ffd6818A66Ac0a',
    ]);
  });
});

const bid = (price: number | null, over: Partial<CollectionBidLike> = {}): CollectionBidLike => ({
  price,
  quantity: 1,
  quantityKnown: true,
  currency: 'WETH',
  criteria: { trait: null },
  ...over,
});

describe('bidBook', () => {
  it('best bid = the highest bid that buys ANY token; near floor = NFTs bought at 90% of the floor or more', () => {
    const book = bidBook([bid(0.28, { quantity: 3 }), bid(0.27, { quantity: 2 }), bid(0.26, { quantity: 9 })], 0.3);
    expect(book.bestBid).toBe(0.28);
    expect(book.nearFloor).toBe(5); // 0.27 is exactly 90% of 0.3: counted; 0.26 is not
  });
  it('ignores bids that do not buy the borrower\'s cheapest NFT, or whose unit price is unknown', () => {
    const book = bidBook(
      [
        bid(0.9, { criteria: { trait: { type: 'Hat', value: 'Crown' } } }),
        bid(0.8, { criteria: { traits: [{ type: 'Hat', value: 'Crown' }] } }),
        bid(0.7, { criteria: { numericTraits: [{ type: 'Level', min: 5 }] } }),
        bid(0.6, { criteria: { encoded_token_ids: '1,2,3' } }),
        bid(0.5, { quantityKnown: false }),
        bid(0.45, { currency: 'USDC' }),
        bid(0.44, { currency: null }),
        bid(Number.NaN),
        bid(null),
        bid(0.2, { criteria: { encoded_token_ids: '*' } }),
      ],
      0.3,
    );
    expect(book.bestBid).toBe(0.2);
    expect(book.nearFloor).toBe(0);
  });
  it('no usable bid = no best bid (that is "none", which the screen says)', () => {
    expect(bidBook([], 0.3)).toEqual({ bestBid: null, nearFloor: 0 });
  });
  it('an unknown floor leaves "near floor" unknown, not zero', () => {
    expect(bidBook([bid(0.28)], null)).toEqual({ bestBid: 0.28, nearFloor: null });
    expect(bidBook([bid(0.28)], 0)).toEqual({ bestBid: 0.28, nearFloor: null });
  });
});

describe('exitCheck', () => {
  const book = { bestBid: 0.28, nearFloor: 5 };
  it('covered when a buyer bids at or above what was lent', () => {
    expect(exitCheck(0.25, book)).toEqual({ kind: 'covered', bestBid: 0.28 });
    expect(exitCheck(0.28, book)).toEqual({ kind: 'covered', bestBid: 0.28 });
  });
  it('short by the gap when the amount is over the best bid', () => {
    const c = exitCheck(0.35, book);
    expect(c?.kind).toBe('short');
    expect(c && c.kind === 'short' ? c.gap : NaN).toBeCloseTo(0.07, 10);
  });
  it('no bids is said; an unread bid book is NOT "no bids"', () => {
    expect(exitCheck(0.25, { bestBid: null, nearFloor: 0 })).toEqual({ kind: 'no-bids' });
    expect(exitCheck(0.25, null)).toBeNull();
    expect(exitCheck(0, book)).toBeNull();
  });
});

describe('underFloorPct', () => {
  it('whole percent under (+) or over (-) the floor', () => {
    expect(underFloorPct(0.25, 0.3)).toBe(17);
    expect(underFloorPct(0.33, 0.3)).toBe(-10);
    expect(underFloorPct(0.25, null)).toBeNull();
    expect(underFloorPct(0, 0.3)).toBeNull();
  });
});

describe('readStats', () => {
  it('reads the floor and the 30-day sales from OpenSea\'s stats', () => {
    expect(
      readStats({ total: { floor_price: 0.3 }, intervals: [{ interval: 'one_day', sales: 2 }, { interval: 'thirty_day', sales: 41 }] }),
    ).toEqual({ floor: 0.3, sales30d: 41 });
  });
  it('junk reads as unknown, not zero', () => {
    expect(readStats(null)).toEqual({ floor: null, sales30d: null });
    expect(readStats({ total: { floor_price: '0.3' }, intervals: [{ interval: 'thirty_day', sales: -1 }] })).toEqual({ floor: null, sales30d: null });
    expect(readStats({ total: { floor_price: 0 } })).toEqual({ floor: null, sales30d: null });
  });
});

describe('LENDING_OPENSEA_SLUGS', () => {
  it('covers every lending collection with the marketplace\'s own slug for it, one the proxy allows', () => {
    for (const c of LENDING_COLLECTIONS) {
      const slug = LENDING_OPENSEA_SLUGS[c.address.toLowerCase()];
      expect(slug, c.symbol).toBeTruthy();
      // Solana collections there carry contract: null.
      const market = Object.values(MARKET_COLLECTIONS as Record<string, { contract: string | null; openseaSlug?: string | null }>).find(
        (m) => m.contract?.toLowerCase() === c.address.toLowerCase(),
      );
      expect(market?.openseaSlug, c.symbol).toBe(slug);
      expect(VENUE_SLUGS.has(slug!), c.symbol).toBe(true);
    }
    expect(Object.keys(LENDING_OPENSEA_SLUGS)).toHaveLength(LENDING_COLLECTIONS.length);
  });
});

describe('fetchLendingMarket', () => {
  afterEach(() => vi.unstubAllGlobals());
  const JBAC = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9';
  const seaportBid = (wei: string, qty = 1) => ({
    order_hash: '0x01',
    price: { currency: 'WETH', value: wei },
    criteria: { collection: { slug: 'junglebay' }, trait: null },
    protocol_data: { parameters: { offerer: '0x4444444444444444444444444444444444444444', offer: [{ startAmount: wei }], consideration: [{ itemType: 4, startAmount: String(qty) }] } },
  });
  function stub(routes: { stats?: unknown; offers?: unknown; offersStatus?: number; statsStatus?: number }) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).searchParams.get('path');
      if (path === 'collections/junglebay/stats') {
        return new Response(JSON.stringify(routes.stats ?? {}), { status: routes.statsStatus ?? 200 });
      }
      if (path === 'offers/collection/junglebay/all') {
        return new Response(JSON.stringify(routes.offers ?? {}), { status: routes.offersStatus ?? 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads the slug\'s stats and bids, price per item (a 2-item 0.56 bid is 0.28 each)', async () => {
    const f = stub({
      stats: { total: { floor_price: 0.3 }, intervals: [{ interval: 'thirty_day', sales: 41 }] },
      offers: { offers: [seaportBid('560000000000000000', 2), seaportBid('250000000000000000')] },
    });
    const m = await fetchLendingMarket(JBAC);
    expect(m).toEqual({ floor: 0.3, sales30d: 41, bids: { bestBid: 0.28, nearFloor: 2 } });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a failed bid read is unknown (null), never "no bids"', async () => {
    stub({ stats: { total: { floor_price: 0.3 } }, offersStatus: 500 });
    const m = await fetchLendingMarket(JBAC);
    expect(m.bids).toBeNull();
    expect(m.floor).toBe(0.3);
  });
  it('a failed stats read leaves the floor unknown but still reads the bids', async () => {
    stub({ statsStatus: 500, offers: { offers: [seaportBid('280000000000000000')] } });
    const m = await fetchLendingMarket(JBAC);
    expect(m).toEqual({ floor: null, sales30d: null, bids: { bestBid: 0.28, nearFloor: null } });
  });
  it('a collection this venue does not lend on is not read at all', async () => {
    const f = stub({});
    expect(await fetchLendingMarket('0x0000000000000000000000000000000000000001')).toEqual({ floor: null, sales30d: null, bids: null });
    expect(f).not.toHaveBeenCalled();
  });
});
