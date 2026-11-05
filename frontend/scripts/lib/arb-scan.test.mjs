import { describe, it, expect } from 'vitest';
import { ASSUMED_FEE, CHAINS, SWITCH_COST, addrKey, bestTrip, feeOf, parseDexPair, parsePool, placeOf, scan } from './arb-scan.mjs';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TTWO = '0x1111111111111111111111111111111111111111';
const FAKE = '0x2222222222222222222222222222222222222222';
const refs = CHAINS.robinhood.refs;
let n = 0;
const addr = () => `0x${(++n).toString(16).padStart(40, 'a')}`;

/** A pool in the scanner's own shape. */
function pool(over = {}) {
  return { address: addr(), dex: 'uni', name: 'TTWO / USDG', base: TTWO, quote: USDG, baseSymbol: 'TTWO', quoteSymbol: 'USDG', baseUsd: 100, quoteUsd: 1, baseInQuote: 100, reserveUsd: 1_000_000, volume24Usd: 1, tradesHour: 5, fee: 0.003, feeKnown: true, ...over };
}

describe('feeOf', () => {
  it('reads the fee at the end of a listed name', () => {
    expect(feeOf('USDG / WETH 0.01%')).toBeCloseTo(0.0001);
    expect(feeOf('TTWO / USDG 0.3%')).toBeCloseTo(0.003);
    expect(feeOf('WETH / USDG')).toBeNull();
    expect(feeOf('A / B 50%')).toBeNull();
  });
});

describe('parsePool (GeckoTerminal)', () => {
  const raw = {
    attributes: { address: WETH.replace('0bd7', '52e6'), name: 'TTWO / USDG 0.3%', base_token_price_usd: '101', quote_token_price_usd: '1.0', base_token_price_quote_token: '101', reserve_in_usd: '5000', volume_usd: { h24: '9' }, transactions: { h1: { buys: 2, sells: 3 } } },
    relationships: { base_token: { data: { id: `robinhood_${TTWO}` } }, quote_token: { data: { id: `robinhood_${USDG}` } }, dex: { data: { id: 'uniswap-v3-robinhood' } } },
  };
  it('takes the prices, the depth, the hour’s trades and the fee in the name', () => {
    expect(parsePool(raw, 'robinhood')).toMatchObject({ base: TTWO, quote: USDG, baseSymbol: 'TTWO', quoteSymbol: 'USDG', baseUsd: 101, baseInQuote: 101, reserveUsd: 5000, tradesHour: 5, fee: 0.003, feeKnown: true, dex: 'uniswap-v3-robinhood' });
  });
  it('assumes a fee when the name names none, and says so', () => {
    expect(parsePool({ ...raw, attributes: { ...raw.attributes, name: 'TTWO / USDG' } }, 'robinhood')).toMatchObject({ fee: ASSUMED_FEE, feeKnown: false });
  });
  it('refuses a pool missing a price, or with an address that is not one', () => {
    expect(parsePool({ ...raw, attributes: { ...raw.attributes, base_token_price_usd: null } }, 'robinhood')).toBeNull();
    expect(parsePool({ ...raw, attributes: { ...raw.attributes, address: '<script>' } }, 'robinhood')).toBeNull();
  });
});

describe('parseDexPair (DexScreener)', () => {
  const raw = { chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'], pairAddress: '0x52E65b17fb6e5ba00ed806f37afcd2daa50271ca', baseToken: { address: TTWO, symbol: 'TTWO' }, quoteToken: { address: USDG, symbol: 'USDG' }, priceNative: '100', priceUsd: '100.5', liquidity: { usd: 4000 }, volume: { h24: 7 }, txns: { h1: { buys: 1, sells: 0 } } };
  it('takes the fee GeckoTerminal named for the same pool, in any case', () => {
    const fees = new Map([[addrKey('0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca'), 0.0005]]);
    expect(parseDexPair(raw, fees)).toMatchObject({ dex: 'uniswap-v3', fee: 0.0005, feeKnown: true, baseUsd: 100.5, quoteUsd: 1.005, reserveUsd: 4000, tradesHour: 1 });
  });
  it('assumes a fee otherwise', () => {
    expect(parseDexPair(raw)).toMatchObject({ fee: ASSUMED_FEE, feeKnown: false });
  });
});

describe('placeOf', () => {
  it('prices a token against a chain coin in USD, whichever side it is on', () => {
    expect(placeOf(pool(), refs)).toMatchObject({ key: `token:${TTWO}`, token: TTWO, label: 'TTWO', price: 100, unit: 'USD', coin: USDG });
    expect(placeOf(pool({ base: USDG, quote: TTWO, baseSymbol: 'USDG', quoteSymbol: 'TTWO', baseUsd: 1, quoteUsd: 99, baseInQuote: 0.0101 }), refs)).toMatchObject({ key: `token:${TTWO}`, price: 99, coin: USDG });
  });
  it('compares a pool of two chain coins as that pair, the same way round whichever is listed first', () => {
    const a = placeOf(pool({ base: WETH, quote: USDG, baseSymbol: 'WETH', quoteSymbol: 'USDG', baseInQuote: 2400 }), refs);
    const b = placeOf(pool({ base: USDG, quote: WETH, baseSymbol: 'USDG', quoteSymbol: 'WETH', baseInQuote: 1 / 2410 }), refs);
    expect(a.key).toBe(b.key);
    expect(a.label).toBe(b.label);
    expect(b.price / a.price).toBeCloseTo(2410 / 2400, 9);
  });
});

describe('bestTrip', () => {
  const deep = { reserveUsd: 2_000_000 };
  it('pays nothing when the gap is under both fees', () => {
    expect(bestTrip({ ...deep, price: 100, fee: 0.003 }, { ...deep, price: 100.5, fee: 0.003 }).profitUsd).toBeLessThanOrEqual(0);
  });
  it('pays when the gap beats the fees, at a size the shallower pool allows', () => {
    const t = bestTrip({ reserveUsd: 20_000, price: 100, fee: 0.003 }, { ...deep, price: 102, fee: 0.003 });
    expect(t.profitUsd).toBeGreaterThan(0);
    expect(t.sizeUsd).toBeGreaterThan(0);
    expect(t.sizeUsd).toBeLessThan(10_000);
  });
  it('charges the extra swap on the way out', () => {
    const plain = bestTrip({ reserveUsd: 50_000, price: 100, fee: 0.001 }, { reserveUsd: 50_000, price: 101, fee: 0.001 });
    const switched = bestTrip({ reserveUsd: 50_000, price: 100, fee: 0.001 }, { reserveUsd: 50_000, price: 101, fee: 0.001 }, SWITCH_COST);
    expect(switched.profitUsd).toBeLessThan(plain.profitUsd);
  });
  it('makes less from shallower pools at the same gap', () => {
    const shallow = bestTrip({ reserveUsd: 10_000, price: 100, fee: 0.001 }, { reserveUsd: 10_000, price: 103, fee: 0.001 });
    const deeper = bestTrip({ reserveUsd: 100_000, price: 100, fee: 0.001 }, { reserveUsd: 100_000, price: 103, fee: 0.001 });
    expect(deeper.profitUsd).toBeGreaterThan(shallow.profitUsd * 5);
  });
});

describe('scan', () => {
  it('finds the best round trip for each token in two or more pools, most profitable first', () => {
    const cheap = pool({ baseUsd: 100, reserveUsd: 200_000 });
    const dear = pool({ baseUsd: 103, reserveUsd: 200_000, tradesHour: 0 });
    const middle = pool({ baseUsd: 101 });
    const alone = pool({ base: FAKE, baseSymbol: 'ONLY' });
    const pair1 = pool({ base: WETH, quote: USDG, baseSymbol: 'WETH', quoteSymbol: 'USDG', baseInQuote: 2400 });
    const pair2 = pool({ base: WETH, quote: USDG, baseSymbol: 'WETH', quoteSymbol: 'USDG', baseInQuote: 2400.2 });
    const rows = scan([cheap, dear, middle, alone, pair1, pair2], refs);
    expect(rows.map((r) => r.label)).toEqual(['TTWO', 'WETH / USDG']);
    const [t] = rows;
    expect(t).toMatchObject({ token: TTWO, pools: 3, quiet: true, suspect: false, feeAssumed: false, sameTicker: 0 });
    expect(t.buy.pool).toBe(cheap.address);
    expect(t.sell.pool).toBe(dear.address);
    expect(t.gapPct).toBeCloseTo(3, 6);
    expect(t.costPct).toBeCloseTo(0.6, 6);
    expect(t.profitUsd).toBeGreaterThan(0);
    expect(rows[1].profitUsd).toBe(0);
    expect(rows[1].sizeUsd).toBe(0);
  });

  it('weighs every two pools, not only the cheapest and dearest: a high fee can make the extremes lose', () => {
    const cheapButCostly = pool({ baseUsd: 99, fee: 0.05 });
    const cheap = pool({ baseUsd: 100, fee: 0.001 });
    const dear = pool({ baseUsd: 102, fee: 0.001 });
    const [r] = scan([cheapButCostly, cheap, dear], refs);
    expect(r.buy.pool).toBe(cheap.address);
  });

  it('adds the third swap when the two pools price the token in different coins', () => {
    const inUsdg = pool({ baseUsd: 100 });
    const inWeth = pool({ quote: WETH, quoteSymbol: 'WETH', baseUsd: 102, quoteUsd: 2400, baseInQuote: 102 / 2400 });
    const [r] = scan([inUsdg, inWeth], refs);
    expect(r.costPct).toBeCloseTo((0.003 + 0.003 + SWITCH_COST) * 100, 6);
    expect(r.buy.coin).not.toBe(r.sell.coin);
  });

  it('leaves out shallow pools, flags a gap over 50%, an assumed fee and a ticker two tokens claim', () => {
    const shallow = pool({ baseUsd: 50, reserveUsd: 500 });
    const a = pool({ baseUsd: 100, feeKnown: false });
    const b = pool({ baseUsd: 160 });
    const copyA = pool({ base: FAKE, baseUsd: 1 });
    const copyB = pool({ base: FAKE, baseUsd: 1.001 });
    const rows = scan([shallow, a, b, copyA, copyB], refs);
    const real = rows.find((r) => r.token === TTWO);
    expect(real.buy.pool).toBe(a.address);
    expect(real).toMatchObject({ suspect: true, feeAssumed: true, sameTicker: 1 });
    expect(rows.find((r) => r.token === FAKE).sameTicker).toBe(1);
  });

  it('counts one pool once, however often it is listed', () => {
    const a = pool({ baseUsd: 100 });
    expect(scan([a, { ...a }], refs)).toEqual([]);
  });
});
