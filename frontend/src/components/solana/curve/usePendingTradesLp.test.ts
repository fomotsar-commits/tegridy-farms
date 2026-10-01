// The liquidity lock (spec D14): one storage scope, 'lp:pending', for every pool. Each
// note carries its pool, so a pending deposit holds that pool's Add only, and a
// note whose pool cannot be read holds every pool (it fails closed). The curve's
// scope stays byte-identical; usePendingTrades.test.ts pins it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { KEY, SIG, buySummary, prepared } from './fakeWriteApi.fixture';
import { LP_PENDING_SCOPE, curveTradeScope, readPendingTrades, savePendingTrade, type TradeKind } from './pendingTrade';
import { usePendingTrades } from './usePendingTrades';
import type { TxSummary } from './ports';

// Spelled out rather than imported, so this file says what the stored bytes are.
const LP = 'lp:pending';
const curve = (mint: string) => `curve-launch:pending-trade:${mint}`;
const POOL = KEY(30);
const MINT = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const SIG2 = '4'.repeat(88);

const lpSummary = (kind: 'lp-deposit' | 'lp-withdraw'): TxSummary =>
  kind === 'lp-deposit'
    ? {
        kind, pool: POOL, origin: 'standard', config: null, tokenMint: KEY(31), tokenDecimals: 6, solIsToken0: true,
        lpAmount: 1n, lpDecimals: 9, quoted: { sol: 1n, token: 1n }, max: { sol: 1n, token: 1n }, limitedByBalance: 'none',
        sharePct: { before: 0, after: 1 }, price: { state: 'no-trades-yet', pool: 1 }, tokenWarnings: [],
        unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
      }
    : {
        kind, pool: POOL, origin: 'standard', config: null, tokenMint: KEY(31), tokenDecimals: 6, solIsToken0: true,
        lpAccount: KEY(32), lpAmount: 1n, lpDecimals: 9, heldBefore: 1n, all: true, keep: 0n, quoted: { sol: 1n, token: 1n },
        min: { sol: 1n, token: 1n }, tokenAccount: KEY(33), tokenAccountRent: 0n, unwrapsWsol: true, notices: [],
      };

const stored = (key: string): unknown => JSON.parse(sessionStorage.getItem(key) ?? 'null');

beforeEach(() => sessionStorage.clear());

describe('liquidity notes', () => {
  it('the two scopes, as the pages use them, are these exact keys', () => {
    expect(LP_PENDING_SCOPE).toBe(LP);
    expect(curveTradeScope(MINT)).toBe(curve(MINT));
  });

  it('an lp-deposit note survives a reload read and carries its pool', () => {
    const { result } = renderHook(() => usePendingTrades(LP, null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(lpSummary('lp-deposit'))));
    expect(readPendingTrades(LP)).toMatchObject([{ kind: 'lp-deposit', signature: SIG, lastValidBlockHeight: 1234, pool: POOL.toBase58() }]);
    // A fresh mount reads it back: what a reload does.
    const again = renderHook(() => usePendingTrades(LP, null, vi.fn()));
    expect(again.result.current.notes).toMatchObject([{ kind: 'lp-deposit', pool: POOL.toBase58() }]);
  });

  it('a withdrawal is written the moment it is sent, with its pool', () => {
    const { result } = renderHook(() => usePendingTrades(LP, null, vi.fn()));
    act(() => result.current.sent(SIG2, prepared(lpSummary('lp-withdraw'))));
    expect(readPendingTrades(LP)).toMatchObject([{ kind: 'lp-withdraw', signature: SIG2, pool: POOL.toBase58() }]);
  });

  it('the liquidity scope is stored at exactly lp:pending, apart from every mint’s scope', () => {
    const lp = renderHook(() => usePendingTrades(LP, null, vi.fn()));
    act(() => lp.result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(lpSummary('lp-deposit'))));
    const mint = renderHook(() => usePendingTrades(curve(MINT), null, vi.fn()));
    act(() => mint.result.current.record({ status: 'unknown', signature: SIG2, message: 'slow' }, prepared(buySummary())));
    const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).sort();
    expect(keys).toEqual([curve(MINT), LP].sort());
    expect(readPendingTrades(LP).map((n) => n.signature)).toEqual([SIG]);
    expect(readPendingTrades(curve(MINT)).map((n) => n.signature)).toEqual([SIG2]);
    // Clearing one scope leaves the other.
    act(() => lp.result.current.dismiss());
    expect(readPendingTrades(LP)).toEqual([]);
    expect(readPendingTrades(curve(MINT))).toHaveLength(1);
  });

  it('a curve note carries no pool: none is written, and it reads back as null', () => {
    const { result } = renderHook(() => usePendingTrades(curve(MINT), null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(buySummary())));
    const raw = stored(curve(MINT)) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0]!).sort()).toEqual(['kind', 'lastValidBlockHeight', 'sentAt', 'signature']);
    expect(readPendingTrades(curve(MINT))).toMatchObject([{ kind: 'buy', pool: null }]);
    // A pool found on a curve note is not one: only a liquidity note names a pool.
    sessionStorage.setItem(curve(MINT), JSON.stringify([{ kind: 'sell', signature: SIG2, lastValidBlockHeight: 3, sentAt: Date.now(), pool: POOL.toBase58() }]));
    expect(readPendingTrades(curve(MINT))).toMatchObject([{ kind: 'sell', pool: null }]);
  });

  it('a liquidity note whose pool is missing or not an address is kept, with pool null (it then holds every pool)', () => {
    const now = Date.now();
    sessionStorage.setItem(
      LP,
      JSON.stringify([
        { kind: 'lp-deposit', signature: SIG, lastValidBlockHeight: 5, sentAt: now, pool: 'not-an-address!' },
        { kind: 'lp-withdraw', signature: SIG2, lastValidBlockHeight: 6, sentAt: now - 1 },
        { kind: 'lp-deposit', signature: '3'.repeat(88), lastValidBlockHeight: 7, sentAt: now - 2, pool: 42 },
      ]),
    );
    expect(readPendingTrades(LP)).toMatchObject([
      { kind: 'lp-deposit', signature: SIG, pool: null },
      { kind: 'lp-withdraw', signature: SIG2, pool: null },
      { kind: 'lp-deposit', signature: '3'.repeat(88), pool: null },
    ]);
  });

  it('a pool address is read back as the same address', () => {
    savePendingTrade(LP, { kind: 'lp-withdraw', signature: SIG, lastValidBlockHeight: 9, pool: POOL.toBase58() });
    expect(readPendingTrades(LP)).toMatchObject([{ kind: 'lp-withdraw', pool: POOL.toBase58() }]);
  });

  // usePendingTrades.test.ts's "ignores storage it cannot trust" now reads a scope
  // nothing writes (it passes a bare mint, unedited), so the same check is made here
  // against both real scopes.
  it('ignores storage it cannot trust, in both scopes: a bad signature, an unknown kind, a note past its lifetime, bad JSON', () => {
    for (const scope of [LP, curve(MINT)]) {
      sessionStorage.setItem(
        scope,
        JSON.stringify([
          { kind: 'buy', signature: 'not-a-signature', lastValidBlockHeight: 1, sentAt: Date.now() },
          { kind: 'transfer', signature: SIG, lastValidBlockHeight: 1, sentAt: Date.now() },
          { kind: 'lp-deposit', signature: SIG2, lastValidBlockHeight: 1, sentAt: Date.now() - 10 * 60_000 - 1, pool: POOL.toBase58() },
        ]),
      );
      expect(readPendingTrades(scope)).toEqual([]);
      sessionStorage.setItem(scope, '{not json');
      expect(readPendingTrades(scope)).toEqual([]);
    }
  });

  it('every kind a page can send survives a reload; an unknown kind does not, in either scope', () => {
    const kinds: TradeKind[] = ['buy', 'sell', 'migrate', 'pool-buy', 'pool-sell', 'lp-deposit', 'lp-withdraw'];
    const now = Date.now();
    const notes = kinds.map((kind, i) => ({ kind, signature: String(i + 2).repeat(88), lastValidBlockHeight: 1, sentAt: now - i }));
    for (const scope of [LP, curve(MINT)]) {
      sessionStorage.setItem(scope, JSON.stringify([...notes, { kind: 'transfer', signature: SIG, lastValidBlockHeight: 1, sentAt: now }]));
      expect(readPendingTrades(scope).map((n) => n.kind)).toEqual(kinds);
    }
  });
});
