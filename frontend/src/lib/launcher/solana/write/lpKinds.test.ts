// @vitest-environment node
//
// The one list of liquidity kinds (spec N1). Every site that asks "is this a liquidity
// kind?" asks isLpKind; a third kind that one hand-written list forgot is how an opening
// would reach the withdrawal check or lose its pool from a pending note.
import { describe, it, expect } from 'vitest';
import { LP_KINDS, isLpKind } from './lpKinds';
import type { LpKind, TxKind } from './types';

describe('LP_KINDS and isLpKind', () => {
  it('holds exactly the three liquidity kinds and the swap through a pool', () => {
    const all: LpKind[] = ['lp-deposit', 'lp-withdraw', 'lp-create', 'lp-swap'];
    expect(Object.keys(LP_KINDS).sort()).toEqual([...all].sort());
    for (const k of all) expect(isLpKind(k)).toBe(true);
  });

  it('says no to every other kind, to nonsense, and to nothing', () => {
    const others: TxKind[] = ['create', 'buy', 'sell', 'migrate', 'pool-buy', 'pool-sell'];
    for (const k of others) expect(isLpKind(k)).toBe(false);
    expect(isLpKind('lp-swap')).toBe(true);
    expect(isLpKind('lp-swop')).toBe(false);
    expect(isLpKind('')).toBe(false);
    expect(isLpKind(undefined)).toBe(false);
    expect(isLpKind(null)).toBe(false);
    // An inherited property name is not a kind.
    expect(isLpKind('toString')).toBe(false);
    expect(isLpKind('__proto__')).toBe(false);
  });
});
