// L1: "sent, not confirmed yet" must survive a reload. Before this, the lock lived in
// one panel's React state only, so a reload handed back a fresh, unlocked trade form
// while the first trade could still land: the way to pay twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SIG, buySummary, prepared } from './fakeWriteApi.fixture';
import { PENDING_TRADE_TTL_MS, readPendingTrades, savePendingTrade } from './pendingTrade';
import { usePendingTrades, type CheckSignature } from './usePendingTrades';
import type { TxOutcome } from './ports';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const SIG2 = '4'.repeat(88);

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.useRealTimers());

describe('pending trade notes', () => {
  it('an unknown outcome is written down per mint, with its blockhash window; a settled one clears it', () => {
    const { result } = renderHook(() => usePendingTrades(MINT_A, null, vi.fn()));
    const p = prepared(buySummary());
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, p));
    expect(readPendingTrades(MINT_A)).toMatchObject([{ kind: 'buy', signature: SIG, lastValidBlockHeight: 1234 }]);
    expect(readPendingTrades(MINT_B)).toEqual([]);
    act(() => result.current.record({ status: 'confirmed', signature: SIG, slot: 3 }, p));
    expect(readPendingTrades(MINT_A)).toEqual([]);
  });

  it('nothing is written for an unknown with no signature, a not-sent, or a create', () => {
    const { result } = renderHook(() => usePendingTrades(MINT_A, null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: '', message: 'lost' }, prepared(buySummary())));
    act(() => result.current.record({ status: 'not-sent', stage: 'sign', message: 'no' }, prepared(buySummary())));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, null));
    expect(readPendingTrades(MINT_A)).toEqual([]);
  });

  it('after a reload the note is back, and it is checked against the chain before it lets go', async () => {
    savePendingTrade(MINT_A, { kind: 'sell', signature: SIG, lastValidBlockHeight: 99 });
    let answer: TxOutcome = { status: 'unknown', signature: SIG, message: 'The network has no record of it yet.' };
    const check = vi.fn<CheckSignature>(async () => answer);
    const resolved = vi.fn();
    // A fresh mount: what a reload or a trip away and back does.
    const { result } = renderHook(() => usePendingTrades(MINT_A, check, resolved));
    expect(result.current.notes).toHaveLength(1);
    await waitFor(() => expect(check).toHaveBeenCalledWith(SIG, 99));
    await waitFor(() => expect(result.current.checking).toBe(false));
    // Still unknown: the note (and so the lock) stands.
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.message).toMatch(/no record/);
    expect(resolved).not.toHaveBeenCalled();

    answer = { status: 'expired', signature: SIG, message: '' };
    await act(async () => result.current.recheck());
    await waitFor(() => expect(result.current.notes).toHaveLength(0));
    expect(readPendingTrades(MINT_A)).toEqual([]);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('a check that throws keeps the note: a failed read is not an answer', async () => {
    savePendingTrade(MINT_A, { kind: 'pool-buy', signature: SIG, lastValidBlockHeight: null });
    const check = vi.fn<CheckSignature>(async () => Promise.reject(new Error('HTTP 429')));
    const { result } = renderHook(() => usePendingTrades(MINT_A, check, vi.fn()));
    await waitFor(() => expect(check).toHaveBeenCalledWith(SIG, null));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.message).toMatch(/HTTP 429/);
  });

  it('"I checked my wallet" drops the notes; two sends on one mint are both kept and both checked', async () => {
    savePendingTrade(MINT_A, { kind: 'buy', signature: SIG, lastValidBlockHeight: 5 });
    savePendingTrade(MINT_A, { kind: 'migrate', signature: SIG2, lastValidBlockHeight: 6 });
    const check = vi.fn<CheckSignature>(async (s) => ({ status: 'unknown', signature: s, message: 'slow' }));
    const { result } = renderHook(() => usePendingTrades(MINT_A, check, vi.fn()));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.notes.map((n) => n.signature).sort()).toEqual([SIG, SIG2].sort());
    act(() => result.current.dismiss());
    expect(result.current.notes).toEqual([]);
    expect(readPendingTrades(MINT_A)).toEqual([]);
  });

  // A note written by the build that is live when a deploy lands must still be read by
  // the next build, or a trade sent just before the deploy loses its lock on reload.
  // So the key is pinned to the byte, in both directions.
  it('a curve note is stored at exactly curve-launch:pending-trade:<mint>, and a note found there is read back', () => {
    const { result } = renderHook(() => usePendingTrades(MINT_A, null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(buySummary())));
    const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    expect(keys).toEqual([`curve-launch:pending-trade:${MINT_A}`]);
    expect(JSON.parse(sessionStorage.getItem(`curve-launch:pending-trade:${MINT_A}`) ?? 'null')).toMatchObject([
      { kind: 'buy', signature: SIG, lastValidBlockHeight: 1234, sentAt: expect.any(Number) },
    ]);

    sessionStorage.clear();
    sessionStorage.setItem(
      `curve-launch:pending-trade:${MINT_B}`,
      JSON.stringify([{ kind: 'pool-sell', signature: SIG2, lastValidBlockHeight: 7, sentAt: Date.now() }]),
    );
    expect(readPendingTrades(MINT_B)).toMatchObject([{ kind: 'pool-sell', signature: SIG2, lastValidBlockHeight: 7 }]);
  });

  it('ignores storage it cannot trust: a bad signature, an unknown kind, or a note past its lifetime', () => {
    sessionStorage.setItem(
      `curve-launch:pending-trade:${MINT_A}`,
      JSON.stringify([
        { kind: 'buy', signature: 'not-a-signature', lastValidBlockHeight: 1, sentAt: Date.now() },
        { kind: 'transfer', signature: SIG, lastValidBlockHeight: 1, sentAt: Date.now() },
        { kind: 'sell', signature: SIG2, lastValidBlockHeight: 1, sentAt: Date.now() - PENDING_TRADE_TTL_MS - 1 },
      ]),
    );
    expect(readPendingTrades(MINT_A)).toEqual([]);
    sessionStorage.setItem(`curve-launch:pending-trade:${MINT_A}`, '{not json');
    expect(readPendingTrades(MINT_A)).toEqual([]);
  });
});
