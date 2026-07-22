import { describe, it, expect } from 'vitest';
import {
  slippagePctToBps,
  applyBuySlippage,
  buildCowSwapQuoteBody,
  parseCowSwapQuote,
  buildCowSwapOrder,
  requiredSellBalance,
  cowApiUrl,
  COW_SWAP_DEFAULT_TTL_SECONDS,
  type ParsedCowSwapQuote,
} from './cowSwap';
import { COW_APP_DATA_HASH } from './cowProtocol';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

describe('slippagePctToBps', () => {
  it('converts whole and fractional percents to basis points', () => {
    expect(slippagePctToBps(1)).toBe(100n);
    expect(slippagePctToBps(0.5)).toBe(50n);
    expect(slippagePctToBps(0.3)).toBe(30n);
    expect(slippagePctToBps(2)).toBe(200n);
  });
  it('returns 0 for zero / negative / non-finite', () => {
    expect(slippagePctToBps(0)).toBe(0n);
    expect(slippagePctToBps(-5)).toBe(0n);
    expect(slippagePctToBps(NaN)).toBe(0n);
  });
  it('clamps above the 20% envelope', () => {
    expect(slippagePctToBps(50)).toBe(2000n);
  });
});

describe('applyBuySlippage', () => {
  it('haircuts by exactly the bps', () => {
    // 1% off 1_000_000 = 990_000
    expect(applyBuySlippage(1_000_000n, 100n)).toBe(990_000n);
    // 0.5% off 1_000_000 = 995_000
    expect(applyBuySlippage(1_000_000n, 50n)).toBe(995_000n);
  });
  it('returns the input unchanged for 0 bps', () => {
    expect(applyBuySlippage(777n, 0n)).toBe(777n);
  });
  it('returns 0 for a non-positive buy amount', () => {
    expect(applyBuySlippage(0n, 100n)).toBe(0n);
  });
  it('is a strict floor — never rounds the min UP', () => {
    // 3 * 1bp = 0.03% ; 1/10000 of 100 = 0.01 -> integer floor keeps min <= buy
    expect(applyBuySlippage(100n, 1n)).toBe(100n - 0n); // 100*1/10000 = 0 (floored)
    expect(applyBuySlippage(100_000n, 1n)).toBe(100_000n - 10n);
  });
});

describe('buildCowSwapQuoteBody', () => {
  it('builds a sell quote body with matching from/receiver', () => {
    const body = buildCowSwapQuoteBody({ sellToken: WETH, buyToken: TOWELI, owner: USER, sellAmount: 5n });
    expect(body).toMatchObject({
      sellToken: WETH,
      buyToken: TOWELI,
      from: USER,
      receiver: USER,
      sellAmountBeforeFee: '5',
      kind: 'sell',
      signingScheme: 'eip712',
      onchainOrder: false,
      priceQuality: 'fast',
    });
  });
});

describe('parseCowSwapQuote', () => {
  const good = {
    quote: {
      sellToken: WETH,
      buyToken: TOWELI,
      sellAmount: '1000000000000000000',
      buyAmount: '25000000000000000000000000',
      feeAmount: '0',
      validTo: 1900000000,
    },
    id: 42,
  };

  it('parses amounts to bigints and echoes the quote id', () => {
    const q = parseCowSwapQuote(good);
    expect(q).not.toBeNull();
    expect(q!.sellAmount).toBe(1000000000000000000n);
    expect(q!.buyAmount).toBe(25000000000000000000000000n);
    expect(q!.feeAmount).toBe(0n);
    expect(q!.validTo).toBe(1900000000);
    expect(q!.quoteId).toBe(42);
  });

  it('defaults feeAmount to 0 when absent', () => {
    const q = parseCowSwapQuote({ quote: { sellAmount: '10', buyAmount: '20' } });
    expect(q!.feeAmount).toBe(0n);
    expect(q!.quoteId).toBeNull();
  });

  it('returns null on missing quote / non-numeric / zero amounts', () => {
    expect(parseCowSwapQuote(null)).toBeNull();
    expect(parseCowSwapQuote({})).toBeNull();
    expect(parseCowSwapQuote({ quote: { sellAmount: 'oops', buyAmount: '1' } })).toBeNull();
    expect(parseCowSwapQuote({ quote: { sellAmount: '0', buyAmount: '1' } })).toBeNull();
    expect(parseCowSwapQuote({ quote: { sellAmount: '1', buyAmount: '0' } })).toBeNull();
  });
});

describe('buildCowSwapOrder', () => {
  const quote: ParsedCowSwapQuote = {
    sellAmount: 1_000_000n,
    buyAmount: 2_000_000n,
    feeAmount: 1_234n,
    validTo: 111,
    quoteId: 7,
  };

  it('sets buyAmount to the slippage floor and passes fee/sell through', () => {
    const { order, buyAmountMin } = buildCowSwapOrder({
      sellToken: WETH,
      buyToken: TOWELI,
      receiver: USER,
      quote,
      slippageBps: 100n, // 1%
      now: 1_000_000, // ms
    });
    expect(buyAmountMin).toBe(1_980_000n); // 2_000_000 - 1%
    expect(order.buyAmount).toBe(1_980_000n);
    expect(order.sellAmount).toBe(1_000_000n);
    expect(order.feeAmount).toBe(1_234n);
    expect(order.kind).toBe('sell');
    expect(order.partiallyFillable).toBe(false);
    expect(order.receiver).toBe(USER);
    expect(order.appData).toBe(COW_APP_DATA_HASH);
    // validTo defaults to now(sec) + TTL
    expect(order.validTo).toBe(Math.floor(1_000_000 / 1000) + COW_SWAP_DEFAULT_TTL_SECONDS);
  });

  it('honors an explicit validTo', () => {
    const { order } = buildCowSwapOrder({
      sellToken: WETH,
      buyToken: TOWELI,
      receiver: USER,
      quote,
      slippageBps: 0n,
      validTo: 42424242,
    });
    expect(order.validTo).toBe(42424242);
    expect(order.buyAmount).toBe(2_000_000n); // 0 slippage = full quote
  });
});

describe('cowApiUrl', () => {
  it('uses the explicitly-rewritten /api/cow proxy alias', () => {
    expect(cowApiUrl('quote')).toBe('/api/cow/mainnet/api/v1/quote');
    expect(cowApiUrl('orders')).toBe('/api/cow/mainnet/api/v1/orders');
    expect(cowApiUrl('orders/0xabc')).toBe('/api/cow/mainnet/api/v1/orders/0xabc');
  });
});

describe('requiredSellBalance', () => {
  it('is sellAmount plus feeAmount', () => {
    expect(
      requiredSellBalance({ sellAmount: 100n, buyAmount: 5n, feeAmount: 7n, validTo: 1, quoteId: null }),
    ).toBe(107n);
  });
});
