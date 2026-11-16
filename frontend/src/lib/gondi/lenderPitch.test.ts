// The lender's pitch and risk numbers (lib/gondi/lenderPitch.ts). Each one only ever
// under-claims: an unread fee or bid is "unknown", never zero or "no buyers".
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GONDI_OWN_LOAN_ADDRESSES,
  LENDING_OPENSEA_SLUGS,
  MAX_FUNDING_READS,
  OPENSEA_CONDUIT,
  OPENSEA_CONDUIT_KEY,
  bidBook,
  buysAnyTokenOrder,
  exitCheck,
  fetchLendingMarket,
  fundedNearFloor,
  fundingMakers,
  lowestOwnFeeBps,
  readStats,
  sameTakeHomeAprBps,
  underFloorPct,
  type BidBook,
  type CollectionBidLike,
  type FundingRead,
} from './lenderPitch';
import { LENDING_COLLECTIONS } from './loanOffer.js';
import { COLLECTIONS as MARKET_COLLECTIONS, CONDUIT_ADDRESS, CONDUIT_KEY } from '../../nakamigos/constants';
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

const MAKER_A = '0x' + 'a1'.repeat(20);
const MAKER_B = '0x' + 'b2'.repeat(20);
const HOUSE = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const wei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
const bid = (price: number | null, over: Partial<CollectionBidLike> = {}): CollectionBidLike => ({
  price,
  quantity: 1,
  quantityKnown: true,
  currency: 'WETH',
  criteria: { trait: null },
  maker: MAKER_A,
  unitWei: price === null || !Number.isFinite(price) ? null : wei(price),
  viaOpenSeaConduit: true,
  ...over,
});
const units = (book: BidBook) => book.nearFloorBids?.reduce((n, b) => n + b.units, 0) ?? null;
const ok = (result: bigint): FundingRead => ({ status: 'success', result });
const failed: FundingRead = { status: 'failure' };

describe('bidBook', () => {
  it('best bid = the highest bid that buys ANY token; near floor = the bids at 90% of the floor or more', () => {
    const book = bidBook([bid(0.28, { quantity: 3 }), bid(0.27, { quantity: 2 }), bid(0.26, { quantity: 9 })], 0.3);
    expect(book.bestBid).toBe(0.28);
    expect(units(book)).toBe(5); // 0.27 is exactly 90% of 0.3: counted; 0.26 is not
    expect(book.nearFloorBids?.map((b) => [b.maker, b.unitWei, b.units])).toEqual([
      [MAKER_A, wei(0.28), 3],
      [MAKER_A, wei(0.27), 2],
    ]);
  });

  it("the venue's own bids count in neither the best bid nor near the floor", () => {
    const isHouse = (a: string | null | undefined) => typeof a === 'string' && a.toLowerCase() === HOUSE.toLowerCase();
    const book = bidBook([bid(0.29, { maker: HOUSE, quantity: 2 }), bid(0.27, { quantity: 1 })], 0.3, { isHouse });
    expect(book.bestBid).toBe(0.27);
    expect(book.nearFloorBids?.map((b) => b.maker)).toEqual([MAKER_A]);
    // Any letter case: the registry matches addresses, not strings.
    const lower = bidBook([bid(0.29, { maker: HOUSE.toLowerCase() })], 0.3, { isHouse });
    expect(lower).toEqual({ bestBid: null, nearFloorBids: [] });
  });

  it('with the committed registry (empty), every bidder counts exactly as before', () => {
    expect(bidBook([bid(0.29, { maker: HOUSE })], 0.3).bestBid).toBe(0.29);
  });

  it('a near-floor bid whose WETH cannot be checked is never counted near the floor', () => {
    const book = bidBook(
      [
        bid(0.29, { maker: null }),
        bid(0.29, { maker: '0x1234' }),
        bid(0.29, { unitWei: null }),
        bid(0.29, { unitWei: 0n }),
        bid(0.29, { viaOpenSeaConduit: false }),
        bid(0.29, { viaOpenSeaConduit: undefined }),
      ],
      0.3,
    );
    expect(book.bestBid).toBe(0.29); // still a bid: the best-bid tile is unchanged
    expect(book.nearFloorBids).toEqual([]);
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
    expect(book.nearFloorBids).toEqual([]);
  });
  it('no usable bid = no best bid (that is "none", which the screen says)', () => {
    expect(bidBook([], 0.3)).toEqual({ bestBid: null, nearFloorBids: [] });
  });
  it('an unknown floor leaves "near floor" unknown, not zero', () => {
    expect(bidBook([bid(0.28)], null)).toEqual({ bestBid: 0.28, nearFloorBids: null });
    expect(bidBook([bid(0.28)], 0)).toEqual({ bestBid: 0.28, nearFloorBids: null });
  });
});

describe('fundingMakers: whose WETH is read', () => {
  it('each bidder once, the highest bid first', () => {
    const book = bidBook([bid(0.27, { maker: MAKER_A }), bid(0.29, { maker: MAKER_B }), bid(0.28, { maker: MAKER_A })], 0.3);
    expect(fundingMakers(book)).toEqual([MAKER_B, MAKER_A]);
  });
  it(`at most ${MAX_FUNDING_READS} bidders, the highest bids kept`, () => {
    const many = Array.from({ length: 60 }, (_, i) => bid(0.27 + i * 0.0001, { maker: '0x' + (i + 1).toString(16).padStart(40, '0') }));
    const makers = fundingMakers(bidBook(many, 0.3));
    expect(MAX_FUNDING_READS).toBe(50);
    expect(makers).toHaveLength(50);
    expect(makers[0]).toBe('0x' + (60).toString(16).padStart(40, '0'));
    expect(makers).not.toContain('0x' + (1).toString(16).padStart(40, '0'));
  });
  it('nothing to read without near-floor bids or a book', () => {
    expect(fundingMakers(bidBook([bid(0.1)], 0.3))).toEqual([]);
    expect(fundingMakers(bidBook([bid(0.29)], null))).toEqual([]);
    expect(fundingMakers(null)).toEqual([]);
  });
});

describe('fundedNearFloor: only what a bidder\'s WETH pays for', () => {
  const book = bidBook([bid(0.28, { maker: MAKER_A, quantity: 3 }), bid(0.27, { maker: MAKER_B, quantity: 2 })], 0.3);
  const makers = fundingMakers(book); // [A (0.28), B (0.27)]

  it('counts every unit when each bidder holds and has approved enough', () => {
    expect(fundedNearFloor(book, makers, [ok(wei(5)), ok(wei(5)), ok(wei(5)), ok(wei(5))])).toBe(5);
  });

  it('a bidder can spend the LOWER of its balance and its allowance to the conduit', () => {
    // A: 10 WETH held but 0.56 approved = 2 of 3 units; B: 0.27 held, plenty approved = 1 of 2.
    expect(fundedNearFloor(book, makers, [ok(wei(10)), ok(wei(0.56)), ok(wei(0.27)), ok(wei(9))])).toBe(3);
    // Nothing approved: nothing bought, however much is held.
    expect(fundedNearFloor(book, makers, [ok(wei(10)), ok(0n), ok(0n), ok(wei(9))])).toBe(0);
  });

  it('a bidder whose read failed counts 0: never invent a buyer', () => {
    expect(fundedNearFloor(book, makers, [failed, ok(wei(5)), ok(wei(5)), ok(wei(5))])).toBe(2);
    expect(fundedNearFloor(book, makers, [ok(wei(5)), { status: 'success', result: 'lots' }, ok(wei(5)), ok(wei(5))])).toBe(2);
  });

  it('no read answering at all is unknown, not "no buyers"', () => {
    expect(fundedNearFloor(book, makers, [failed, failed, failed, failed])).toBeNull();
    expect(fundedNearFloor(book, makers, undefined)).toBeNull();
    expect(fundedNearFloor(book, makers, [ok(wei(5))])).toBeNull(); // reads for other bidders
  });

  it('one bidder\'s WETH is spent on its highest bid first, never twice', () => {
    const one = bidBook([bid(0.29, { maker: MAKER_A, quantity: 1 }), bid(0.28, { maker: MAKER_A, quantity: 2 })], 0.3);
    const m = fundingMakers(one);
    // 0.58 WETH: one at 0.29, then 0.29 left buys one at 0.28 (not two).
    expect(fundedNearFloor(one, m, [ok(wei(0.58)), ok(wei(0.58))])).toBe(2);
    expect(fundedNearFloor(one, m, [ok(wei(0.85)), ok(wei(1))])).toBe(3);
    // 0.28 WETH cannot fill the 0.29 bid at all, but it does fill one unit of the 0.28 bid.
    expect(fundedNearFloor(one, m, [ok(wei(0.28)), ok(wei(1))])).toBe(1);
  });

  it('a bidder past the read cut counts 0', () => {
    expect(fundedNearFloor(book, [MAKER_A], [ok(wei(5)), ok(wei(5))])).toBe(3);
  });

  it('an unknown floor is unknown; no near-floor bid is 0 with no read', () => {
    expect(fundedNearFloor(bidBook([bid(0.28)], null), [], undefined)).toBeNull();
    expect(fundedNearFloor(bidBook([bid(0.1)], 0.3), [], undefined)).toBe(0);
    expect(fundedNearFloor(null, [], undefined)).toBeNull();
  });
});

describe('OpenSea conduit pins', () => {
  it('match the marketplace\'s own conduit and key', () => {
    expect(OPENSEA_CONDUIT).toBe(CONDUIT_ADDRESS);
    expect(OPENSEA_CONDUIT_KEY).toBe(CONDUIT_KEY);
  });
});

describe('exitCheck', () => {
  const book: BidBook = { bestBid: 0.28, nearFloorBids: [] };
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
    expect(exitCheck(0.25, { bestBid: null, nearFloorBids: [] })).toEqual({ kind: 'no-bids' });
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

describe('buysAnyTokenOrder', () => {
  const order = (consideration: unknown) => ({ protocol_data: { parameters: { consideration } } });
  it('only a criteria item with criteria 0 buys any token', () => {
    expect(buysAnyTokenOrder(order([{ itemType: 4, identifierOrCriteria: '0' }]))).toBe(true);
    expect(buysAnyTokenOrder(order([{ itemType: 5, identifierOrCriteria: '0' }]))).toBe(true);
    expect(buysAnyTokenOrder(order([{ itemType: 1, identifierOrCriteria: '0' }, { itemType: 4, identifierOrCriteria: '0' }]))).toBe(true);
  });
  it('an offer on one token, a trait root or a shape it cannot read does not', () => {
    expect(buysAnyTokenOrder(order([{ itemType: 2, identifierOrCriteria: '4321' }]))).toBe(false);
    expect(buysAnyTokenOrder(order([{ itemType: 3, identifierOrCriteria: '7' }]))).toBe(false);
    expect(buysAnyTokenOrder(order([{ itemType: 4, identifierOrCriteria: '0x9f3c' }]))).toBe(false);
    expect(buysAnyTokenOrder(order([{ itemType: 1, identifierOrCriteria: '0' }]))).toBe(false);
    expect(buysAnyTokenOrder({})).toBe(false);
    expect(buysAnyTokenOrder(null)).toBe(false);
  });
});

describe('fetchLendingMarket', () => {
  afterEach(() => vi.unstubAllGlobals());
  const JBAC = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9';
  // The shapes OpenSea returned 2026-11-09: a collection bid asks for item type 4 with
  // criteria 0; an offer on one JBAC asks for item type 2 with that token's id.
  const BIDDER = '0x4444444444444444444444444444444444444444';
  const seaportBid = (
    wei: string,
    qty = 1,
    nft: { itemType: number; identifierOrCriteria: string } = { itemType: 4, identifierOrCriteria: '0' },
    remaining?: number,
    { offerer = BIDDER, conduitKey = CONDUIT_KEY }: { offerer?: string; conduitKey?: string } = {},
  ) => ({
    order_hash: '0x01',
    price: { currency: 'WETH', value: wei },
    criteria: null,
    ...(remaining !== undefined ? { remaining_quantity: remaining } : {}),
    protocol_data: {
      parameters: {
        offerer,
        conduitKey,
        offer: [{ startAmount: wei }],
        consideration: [{ ...nft, startAmount: String(qty) }, { itemType: 1, identifierOrCriteria: '0', startAmount: '1550000000000000' }],
      },
    },
  });
  function stub(routes: { stats?: unknown; offers?: unknown; offersStatus?: number; statsStatus?: number }) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).searchParams.get('path');
      if (path === 'collections/junglebay/stats') {
        return new Response(JSON.stringify(routes.stats ?? {}), { status: routes.statsStatus ?? 200 });
      }
      // The collection-offers route: `/all` mixes in single-token offers.
      if (path === 'offers/collection/junglebay') {
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
    expect(m).toEqual({
      floor: 0.3,
      sales30d: 41,
      bids: { bestBid: 0.28, nearFloorBids: [{ maker: BIDDER, unitWei: 280000000000000000n, units: 2 }] },
    });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('reads each bid\'s bidder, WETH per NFT and conduit, so near-floor can be checked against funds', async () => {
    const OTHER_KEY = '0x' + '0'.repeat(64);
    stub({
      stats: { total: { floor_price: 0.3 } },
      offers: { offers: [seaportBid('810000000000000000', 3), seaportBid('290000000000000000', 1, undefined, undefined, { conduitKey: OTHER_KEY })] },
    });
    const m = await fetchLendingMarket(JBAC);
    expect(m.bids?.bestBid).toBe(0.29);
    // The 0.29 bid moves its WETH some other way, so its allowance cannot be read: not counted.
    expect(m.bids?.nearFloorBids).toEqual([{ maker: BIDDER, unitWei: 270000000000000000n, units: 3 }]);
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
    expect(m).toEqual({ floor: null, sales30d: null, bids: { bestBid: 0.28, nearFloorBids: null } });
  });
  it('an offer on ONE token is no buyer for the lender\'s NFT, however high (the 0.155 JBAC offers)', async () => {
    stub({
      stats: { total: { floor_price: 0.0278 } },
      offers: {
        offers: [
          seaportBid('155000000000000000', 1, { itemType: 2, identifierOrCriteria: '4321' }),
          seaportBid('90000000000000000', 1, { itemType: 4, identifierOrCriteria: '0x9f3c' }), // a trait root
          seaportBid('19900000000000000'),
        ],
      },
    });
    const m = await fetchLendingMarket(JBAC);
    expect(m.bids).toEqual({ bestBid: 0.0199, nearFloorBids: [] });
  });
  it('a part-filled bid counts only what is left of it, at its own price per NFT', async () => {
    stub({ stats: { total: { floor_price: 0.3 } }, offers: { offers: [seaportBid('1400000000000000000', 5, undefined, 2)] } });
    const m = await fetchLendingMarket(JBAC);
    expect(m.bids?.bestBid).toBeCloseTo(0.28, 10); // 1.4 / 5 in floats
    expect(m.bids?.nearFloorBids).toEqual([{ maker: BIDDER, unitWei: 280000000000000000n, units: 2 }]);
  });
  it('a collection this venue does not lend on is not read at all', async () => {
    const f = stub({});
    expect(await fetchLendingMarket('0x0000000000000000000000000000000000000001')).toEqual({ floor: null, sales30d: null, bids: null });
    expect(f).not.toHaveBeenCalled();
  });
});
