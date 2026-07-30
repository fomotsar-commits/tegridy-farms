// Tests for the R080 external-boundary schemas.
//
// These three modules are security controls: they exist so that a malicious or
// merely broken upstream (DEX aggregator, GeckoTerminal, OpenSea — or anything
// that can impersonate one) cannot push a shape into BigInt math, owner gating,
// or the renderer. Until this file they had NO direct tests, which was found
// while evaluating the zod 3 -> 4 major bump (PR #154): the whole suite was
// green, but nothing actually exercised a schema, so "green" said nothing about
// whether validation still worked.
//
// Each `rejects` case below is a real attack shape, not a placeholder — the
// scientific-notation and negative-number cases in particular are the ones that
// make `BigInt(value)` throw or silently lose precision downstream.

import { describe, it, expect } from 'vitest';
import {
  swapApiResponseSchema,
  odosResponseSchema,
  cowSwapResponseSchema,
  liFiResponseSchema,
  kyberSwapResponseSchema,
  openOceanResponseSchema,
  paraSwapResponseSchema,
  parseOrNull,
} from './aggregator';
import {
  geckoTerminalTokenPriceSchema,
  geckoTerminalOhlcvSchema,
} from './geckoTerminal';
import {
  openSeaBestListingsResponseSchema,
  openSeaOrdersResponseSchema,
  openSeaEventsResponseSchema,
  openSeaCollectionStatsResponseSchema,
} from './opensea';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

describe('parseOrNull', () => {
  it('returns parsed data on success and null on failure', () => {
    expect(
      parseOrNull(swapApiResponseSchema, { amountOut: '100', priceImpact: 0.1 }),
    ).toEqual({ amountOut: '100', priceImpact: 0.1 });
    expect(parseOrNull(swapApiResponseSchema, { amountOut: 'oops' })).toBeNull();
  });

  it('never throws on hostile input — the call sites rely on null, not a catch', () => {
    for (const hostile of [null, undefined, 0, '', [], NaN, { __proto__: { a: 1 } }]) {
      expect(() => parseOrNull(swapApiResponseSchema, hostile)).not.toThrow();
      expect(parseOrNull(swapApiResponseSchema, hostile)).toBeNull();
    }
  });
});

describe('aggregator schemas — amountOut must stay BigInt-safe', () => {
  it('accepts well-formed integer strings', () => {
    expect(swapApiResponseSchema.safeParse({ amountOut: '1000000000000000000', priceImpact: 0.5 }).success).toBe(true);
  });

  // Every one of these would corrupt or throw in `BigInt(amountOut)`.
  it.each([
    ['scientific notation', '1e18'],
    ['negative', '-100'],
    ['decimal', '1.5'],
    ['hex', '0x64'],
    ['whitespace-padded', ' 100 '],
    ['empty', ''],
    ['not a number', 'Infinity'],
  ])('rejects amountOut that is %s', (_label, amountOut) => {
    expect(swapApiResponseSchema.safeParse({ amountOut, priceImpact: 0 }).success).toBe(false);
  });

  it('rejects a non-finite priceImpact', () => {
    expect(swapApiResponseSchema.safeParse({ amountOut: '1', priceImpact: Infinity }).success).toBe(false);
    expect(swapApiResponseSchema.safeParse({ amountOut: '1', priceImpact: NaN }).success).toBe(false);
  });

  it('coerces the number form to a string via intLike (Odos/Cow/LiFi et al)', () => {
    const r = odosResponseSchema.safeParse({ outAmounts: [12345] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.outAmounts[0]).toBe('12345');
  });

  it('rejects a negative or fractional number in intLike', () => {
    expect(odosResponseSchema.safeParse({ outAmounts: [-1] }).success).toBe(false);
    expect(odosResponseSchema.safeParse({ outAmounts: [1.5] }).success).toBe(false);
  });

  it('requires at least one quote in outAmounts', () => {
    expect(odosResponseSchema.safeParse({ outAmounts: [] }).success).toBe(false);
  });

  it('validates the remaining aggregator shapes at their nested amount key', () => {
    expect(cowSwapResponseSchema.safeParse({ quote: { buyAmount: '5' } }).success).toBe(true);
    expect(cowSwapResponseSchema.safeParse({ quote: { buyAmount: '5e3' } }).success).toBe(false);

    expect(liFiResponseSchema.safeParse({ estimate: { toAmount: '5' } }).success).toBe(true);
    expect(liFiResponseSchema.safeParse({ estimate: {} }).success).toBe(false);

    expect(kyberSwapResponseSchema.safeParse({ data: { routeSummary: { amountOut: '5' } } }).success).toBe(true);
    expect(kyberSwapResponseSchema.safeParse({ data: {} }).success).toBe(false);

    expect(openOceanResponseSchema.safeParse({ data: { outAmount: '5' } }).success).toBe(true);
    expect(openOceanResponseSchema.safeParse({ data: { outAmount: 'x' } }).success).toBe(false);

    expect(paraSwapResponseSchema.safeParse({ priceRoute: { destAmount: '5' } }).success).toBe(true);
    expect(paraSwapResponseSchema.safeParse({ priceRoute: {} }).success).toBe(false);
  });
});

describe('geckoTerminal schemas', () => {
  it('accepts a token_prices map keyed by address', () => {
    const r = geckoTerminalTokenPriceSchema.safeParse({
      data: { attributes: { token_prices: { [ADDR]: '0.00012345' } } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.data.attributes.token_prices[ADDR]).toBe('0.00012345');
  });

  // The module header states scientific notation is rejected on purpose:
  // Number() on it loses precision. Pin that.
  it.each([
    ['scientific notation', '1.2e-5'],
    ['negative', '-0.5'],
    ['NaN', 'NaN'],
    ['empty', ''],
  ])('rejects a price in %s form', (_label, price) => {
    expect(
      geckoTerminalTokenPriceSchema.safeParse({
        data: { attributes: { token_prices: { [ADDR]: price } } },
      }).success,
    ).toBe(false);
  });

  it('rejects a number where a decimal string is required', () => {
    expect(
      geckoTerminalTokenPriceSchema.safeParse({
        data: { attributes: { token_prices: { [ADDR]: 0.001 } } },
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed 6-element OHLCV tuple', () => {
    expect(
      geckoTerminalOhlcvSchema.safeParse({
        data: { attributes: { ohlcv_list: [[1700000000, 1, 2, 0.5, 1.5, 0]] } },
      }).success,
    ).toBe(true);
  });

  it('rejects an OHLCV row of the wrong arity or member type', () => {
    expect(
      geckoTerminalOhlcvSchema.safeParse({
        data: { attributes: { ohlcv_list: [[1700000000, 1, 2]] } },
      }).success,
    ).toBe(false);
    expect(
      geckoTerminalOhlcvSchema.safeParse({
        data: { attributes: { ohlcv_list: [[1700000000, '1', 2, 0.5, 1.5, 0]] } },
      }).success,
    ).toBe(false);
  });
});

describe('opensea schemas', () => {
  it('accepts a best-listing and preserves the wei price exactly', () => {
    const r = openSeaBestListingsResponseSchema.safeParse({
      listings: [
        {
          order_hash: '0xabc',
          protocol_address: ADDR,
          price: { current: { value: '1000000000000000000', currency: 'ETH', decimals: 18 } },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.listings[0]?.price?.current.value).toBe('1000000000000000000');
  });

  it('rejects a price that would break BigInt downstream', () => {
    for (const value of ['1e18', '-1', '1.0', '0x10', '']) {
      expect(
        openSeaBestListingsResponseSchema.safeParse({
          listings: [{ price: { current: { value } } }],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a malformed offerer address — owner gating reads this', () => {
    const bad = (offerer: unknown) =>
      openSeaOrdersResponseSchema.safeParse({
        orders: [{ protocol_data: { parameters: { offerer } } }],
      }).success;
    expect(bad(ADDR)).toBe(true);
    expect(bad('0x123')).toBe(false); // too short
    expect(bad(`${ADDR}00`)).toBe(false); // too long
    expect(bad('not-an-address')).toBe(false);
    expect(bad(null)).toBe(false);
  });

  it('keeps passthrough behaviour so additive upstream fields do not break us', () => {
    const r = openSeaOrdersResponseSchema.safeParse({
      orders: [{ order_hash: '0x1', brand_new_field: 'ignored' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.orders[0] as Record<string, unknown>).brand_new_field).toBe('ignored');
    }
  });

  it('requires the array container itself', () => {
    expect(openSeaBestListingsResponseSchema.safeParse({}).success).toBe(false);
    expect(openSeaOrdersResponseSchema.safeParse({ orders: {} }).success).toBe(false);
    expect(openSeaEventsResponseSchema.safeParse({ asset_events: null }).success).toBe(false);
  });

  it('validates event payment quantity and nft identifier as BigInt-safe strings', () => {
    const ok = openSeaEventsResponseSchema.safeParse({
      asset_events: [{ event_type: 'sale', payment: { quantity: '100', token_address: ADDR }, nft: { identifier: '42' } }],
    });
    expect(ok.success).toBe(true);
    expect(
      openSeaEventsResponseSchema.safeParse({
        asset_events: [{ nft: { identifier: '4.2' } }],
      }).success,
    ).toBe(false);
  });

  it('accepts collection stats with every field absent', () => {
    expect(openSeaCollectionStatsResponseSchema.safeParse({}).success).toBe(true);
    expect(
      openSeaCollectionStatsResponseSchema.safeParse({
        total: { volume: 1.5, sales: 2, floor_price: 0.1 },
        intervals: [{ interval: 'one_day', volume: 1, volume_change: -0.5 }],
      }).success,
    ).toBe(true);
  });
});
