// The chart used to be hardcoded to TOWELI/WETH on Ethereum, and its in-memory
// OHLCV cache was keyed by TIMEFRAME ALONE. That was harmless while exactly one
// pool existed and becomes a cross-pool cache the moment a second one does: the
// Bayla bungalow would have been served TOWELI's candles under her own ticker,
// with no error anywhere. Both halves of the fix are pinned here.

import { describe, it, expect } from 'vitest';
import { ohlcvCacheKey, ohlcvUrl, TOWELI_MARKET, type ChartMarket } from './market';

const BAYLA: ChartMarket = {
  network: 'solana',
  pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n',
  label: 'BAYLA',
};

describe('chart market parameterisation', () => {
  it('gives two pools different cache keys at the same timeframe', () => {
    expect(ohlcvCacheKey(BAYLA, '1d')).not.toBe(ohlcvCacheKey(TOWELI_MARKET, '1d'));
  });

  it('still separates timeframes within one pool', () => {
    expect(ohlcvCacheKey(BAYLA, '1h')).not.toBe(ohlcvCacheKey(BAYLA, '1d'));
  });

  it('is stable for the same pool + timeframe, so the cache still hits', () => {
    expect(ohlcvCacheKey(BAYLA, '4h')).toBe(ohlcvCacheKey({ ...BAYLA }, '4h'));
  });

  it('requests the bungalow pool on its own network', () => {
    const url = ohlcvUrl(BAYLA, '1d');
    expect(url).toContain('/networks/solana/');
    expect(url).toContain(BAYLA.pool);
    expect(url).not.toContain('/networks/eth/');
  });

  it('leaves the default TOWELI market on Ethereum, unchanged', () => {
    expect(TOWELI_MARKET.network).toBe('eth');
    const url = ohlcvUrl(TOWELI_MARKET, '1d');
    expect(url).toContain('/networks/eth/');
    expect(url).toContain(TOWELI_MARKET.pool);
  });
});

// `currency` became a parameter (2026-09-02) so a SOL-denominated chart of a SOL
// pair is possible: USD candles fold the quote token's own move into the token's,
// which on a volatile quote is a chart of two things at once. The default is the
// value that was hardcoded, so every pre-existing call site must be untouched —
// that is the half worth pinning, because a defaulted-away parameter lands in the
// URL as `currency=undefined` and GeckoTerminal answers it as a 404, silently.
describe('ohlcv currency', () => {
  it('defaults to usd, byte-identically to the hardcoded form', () => {
    expect(ohlcvUrl(BAYLA, '1d')).toBe(ohlcvUrl(BAYLA, '1d', 'usd'));
    expect(ohlcvUrl(BAYLA, '1d')).toContain('&currency=usd');
    expect(ohlcvUrl(BAYLA, '1d')).not.toContain('undefined');
  });

  it('asks for the quote token when told to', () => {
    expect(ohlcvUrl(BAYLA, '1d', 'token')).toContain('&currency=token');
    expect(ohlcvUrl(BAYLA, '1d', 'token')).not.toContain('currency=usd');
  });
});
