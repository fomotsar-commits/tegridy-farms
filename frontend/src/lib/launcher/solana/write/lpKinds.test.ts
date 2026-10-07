// @vitest-environment node
//
// The one list of liquidity kinds (spec N1). Every site that asks "is this a liquidity
// kind?" asks isLpKind; a third kind that one hand-written list forgot is how an opening
// would reach the withdrawal check or lose its pool from a pending note.
import { describe, it, expect } from 'vitest';
import { LP_KINDS, POOL_KINDS, isLpKind, isPoolKind } from './lpKinds';
import type { LpKind, TxKind } from './types';

describe('LP_KINDS and isLpKind', () => {
  it('holds exactly the three liquidity kinds', () => {
    const all: LpKind[] = ['lp-deposit', 'lp-withdraw', 'lp-create'];
    expect(Object.keys(LP_KINDS).sort()).toEqual([...all].sort());
    for (const k of all) expect(isLpKind(k)).toBe(true);
  });

  it('says no to every other kind, to nonsense, and to nothing', () => {
    const others: TxKind[] = ['create', 'buy', 'sell', 'migrate', 'pool-buy', 'pool-sell', 'venue-swap'];
    for (const k of others) expect(isLpKind(k)).toBe(false);
    expect(isLpKind('lp-swap')).toBe(false);
    expect(isLpKind('')).toBe(false);
    expect(isLpKind(undefined)).toBe(false);
    expect(isLpKind(null)).toBe(false);
    // An inherited property name is not a kind.
    expect(isLpKind('toString')).toBe(false);
    expect(isLpKind('__proto__')).toBe(false);
  });
});

// A swap in one of our pools is judged against the pool's pins like the liquidity kinds,
// and is still not a liquidity change: no liquidity copy, scope or pool note applies to it.
describe('POOL_KINDS and isPoolKind', () => {
  it('holds the three liquidity kinds and the venue swap, and nothing else', () => {
    expect(Object.keys(POOL_KINDS).sort()).toEqual(['lp-create', 'lp-deposit', 'lp-withdraw', 'venue-swap']);
    for (const k of Object.keys(POOL_KINDS)) expect(isPoolKind(k)).toBe(true);
    for (const k of ['create', 'buy', 'sell', 'migrate', 'pool-buy', 'pool-sell', '', 'toString', '__proto__']) expect(isPoolKind(k)).toBe(false);
    expect(isPoolKind(undefined)).toBe(false);
    expect(isLpKind('venue-swap')).toBe(false);
  });
});
