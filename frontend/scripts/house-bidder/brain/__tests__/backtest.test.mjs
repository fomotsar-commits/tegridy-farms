// @vitest-environment node
//
// The backtest (BUILD-SPEC 3.5 step 9): saved sales replayed through the planner and the
// breakers. With a stand-in fair value the expected fills and trips are worked out by hand.
import { describe, it, expect } from 'vitest';
import { runBacktest, normalizeSale, normalizeListing, pseudoListings } from '../backtest.mjs';
import { WETH } from '../constants.mjs';
import { fakeBuildTape, testPolicy, milli } from '../../exec/__tests__/fakes.mjs';

const END = 1_794_800_000;
const DAY = 86_400;
const policy = testPolicy('0x2222222222222222222222222222222222222222');
const sale = (n, time, price, over = {}) => ({ txHash: `0x${String(n).padStart(64, '0')}`, time, tokenId: String(n), priceWei: price, paymentToken: WETH, seller: '0x3333333333333333333333333333333333333333', buyer: '0x7777777777777777777777777777777777777777', orderHash: null, ...over });
const flatFair = (F) => (a) => ({ S: F, L: F, F, n: 20, sellers: 9, cheapestFillable: null, floorProxy: a.listings.length ? a.listings.reduce((m, l) => (l.priceWei < m ? l.priceWei : m), a.listings[0].priceWei) : null, reason: null, state: {} });

describe('backtest', () => {
  it('fills on sales at or below the standing price, re-planning edge as it fills', () => {
    const sales = [sale(1, END - 2 * DAY, milli(30)), sale(2, END - 1 * DAY, milli(30)), sale(3, END - DAY / 2, milli(40))];
    const r = runBacktest({ sales: { junglebay: sales }, policy, buildTape: fakeBuildTape, fairValue: flatFair(milli(40)), days: 3, endSec: END });
    const c = r.collections.junglebay;
    // bids 0.0352 at nothing held, 0.0332 at one held: both 0.030 sales fill, the 0.040 one does not
    expect(c.fills.map((f) => f.unitPriceWei)).toEqual([milli(35.2), milli(33.2)]);
    expect(c.held).toBe(2);
    expect(c.costWei).toBe(milli(68.4));
    // marked at F less OpenSea's 1% on the way out: 2 x 0.040 x 0.99 = 0.0792
    expect(c.markWei).toBe(milli(79.2));
    expect(c.pnlWei).toBe(milli(10.8));
  });

  it('counts a floor drop on the rebuilt listing side as a breaker trip', () => {
    // a listing at 0.050 stands from END-29h until it sells at END-5h; one at 0.040 appears at
    // END-10h (it sells a day later): the floor falls 20% within the hour at END-10h
    const eth = '0x0000000000000000000000000000000000000000';
    const sales = [sale(1, END - 5 * 3600, milli(50), { paymentToken: eth }), sale(2, END + 14 * 3600, milli(40), { paymentToken: eth })];
    const r = runBacktest({ sales: { junglebay: sales }, policy, buildTape: fakeBuildTape, fairValue: flatFair(milli(40)), days: 1, endSec: END });
    expect(r.collections.junglebay.trips).toEqual({ 'floor-drop-1h': 1 });
    expect(r.collections.junglebay.tripLog[0].at).toBe(new Date((END - 10 * 3600) * 1000).toISOString());
  });

  it('notes an insider sale into the bid', () => {
    const insider = '0x5555555555555555555555555555555555555555';
    const r = runBacktest({ sales: { junglebay: [sale(1, END - DAY / 2, milli(30), { seller: insider })] }, policy, buildTape: fakeBuildTape, fairValue: flatFair(milli(40)), days: 1, endSec: END, insiderWallets: [insider] });
    expect(r.collections.junglebay.integrity).toHaveLength(1);
  });

  it('counts a saved listing from its start time, so the arbitrage line holds the bid under it', () => {
    // a JBAC listing at 0.030 saved live, standing since END-12h, as OpenSea returns it
    const raw = {
      order_hash: `0x${'7c'.repeat(32)}`,
      protocol_address: '0x0000000000000068f116a894984e2db1123eb395',
      remaining_quantity: 1,
      price: { current: { value: '30000000000000000' } },
      protocol_data: { parameters: { offerer: '0x101bb8d14cc1632a6973eca68f97ec4c5fc8c421', offer: [{ itemType: 2, token: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', identifierOrCriteria: '1797', startAmount: '1', endAmount: '1' }], consideration: [], startTime: String(END - 12 * 3600), endTime: String(END + 3600), orderType: 0, zone: '0x0000000000000000000000000000000000000000' } },
    };
    expect(normalizeListing(raw)).toMatchObject({ tokenId: '1797', priceWei: milli(30), maker: '0x101bb8d14cc1632a6973eca68f97ec4c5fc8c421', startTime: END - 12 * 3600 });
    const cheapest = (a) => ({ ...flatFair(milli(40))(a), cheapestFillable: a.listings.length ? a.listings[0].priceWei : null });
    const sales = [sale(1, END - 13 * 3600, milli(28)), sale(2, END - 6 * 3600, milli(28))];
    const r = runBacktest({ sales: { junglebay: sales }, listings: { junglebay: [raw] }, policy, buildTape: fakeBuildTape, fairValue: cheapest, days: 1, endSec: END });
    // before the listing: 0.0352 fills the 0.028 sale; after it the bid is at most 0.030 x 0.99 - 0.001 = 0.0287
    expect(r.collections.junglebay.fills.map((f) => f.unitPriceWei)).toEqual([milli(35.2), milli(28.7)]);
  });

  it('reads OpenSea’s raw sale events (the saved research files) and rebuilds listings from ETH sales only', () => {
    const raw = { event_timestamp: END, transaction: '0xABC', order_hash: '0x01', payment: { quantity: '70000000000000000', token_address: '0x0000000000000000000000000000000000000000' }, seller: '0x3333333333333333333333333333333333333333', buyer: '0x7777777777777777777777777777777777777777', quantity: 2, nft: { identifier: '9' } };
    const s = normalizeSale(raw);
    expect(s).toMatchObject({ txHash: '0xabc', time: END, tokenId: '9', priceWei: milli(35) });
    // a listing stood the day before it sold, and only an ETH sale was a listing
    expect(pseudoListings([s, { ...s, paymentToken: WETH }], { atSec: END - 10 })).toHaveLength(1);
    expect(pseudoListings([s], { atSec: END - 2 * DAY })).toHaveLength(0);
    expect(pseudoListings([s], { atSec: END })).toHaveLength(0); // sold: gone
  });
});
