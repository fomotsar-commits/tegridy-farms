// The dashboard's drawn figures (IslandDashboard.tsx): each coin's share of the holdings, and a
// lock's place on the ladder. Both come from read rows only; neither estimates.

import { describe, expect, it } from 'vitest';
import { boostOf, holdingShares, pctText, type HoldingRow } from './walletRows';

const row = (o: Partial<HoldingRow>): HoldingRow => ({ key: o.symbol ?? 'x', symbol: 'BAYLA', chain: 'solana', amount: '1', usd: 1, roomId: 'bayla', to: '/bayla', ...o });

describe('holdingShares', () => {
  it('splits the whole by each priced coin, largest first, and the shares sum to the whole', () => {
    const shares = holdingShares([row({ symbol: 'BAYLA', usd: 12.5 }), row({ symbol: 'SOL', usd: 300, roomId: null, chain: 'solana' }), row({ symbol: 'ETH', usd: 0, chain: 'ethereum', roomId: null })]);
    expect(shares.map((s) => s.symbol)).toEqual(['SOL', 'BAYLA']);
    expect(shares[0]!.pct).toBeCloseTo(96, 5);
    expect(shares[1]!.pct).toBeCloseTo(4, 5);
    expect(shares.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 9);
  });

  it('draws nothing over no worth', () => {
    expect(holdingShares([])).toEqual([]);
    expect(holdingShares([row({ usd: 0 })])).toEqual([]);
  });
});

describe('pctText', () => {
  it('rounds to a whole percent, and never prints a held coin as 0%', () => {
    expect(pctText(96.04)).toBe('96%');
    expect(pctText(0.4)).toBe('<1%');
    expect(pctText(1)).toBe('1%');
  });
});

describe('boostOf', () => {
  it('reads the lock’s share from its own fact and from nothing else', () => {
    expect(boostOf(['10,000 BAYLA', 'unlocks 15 Jan 2030', '4.00×', 'earned 1.23 BAYLA'])).toBe(4);
    expect(boostOf(['0.40×'])).toBe(0.4);
    expect(boostOf(['10,000 BAYLA', 'unlocked'])).toBeNull();
    // An amount is never a boost.
    expect(boostOf(['52,000 BAYLA'])).toBeNull();
  });
});
