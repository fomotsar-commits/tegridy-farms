// The liquidity scope's notes hold forms IN THIS TAB, not only after a reload (B review
// funds-2). The LP provider asks for `live` notes: every note it writes (sent, an unknown
// answer) and every note it clears is in `notes` at once, and a note it wrote stays there
// even when sessionStorage throws. The curve page does not ask for it, and is unchanged:
// its own panel keeps the "sent" step on screen, and only a reload finds the note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { KEY, SIG, buySummary, prepared } from './fakeWriteApi.fixture';
import { LP_PENDING_SCOPE, curveTradeScope, readPendingTrades } from './pendingTrade';
import { usePendingTrades, type CheckSignature } from './usePendingTrades';
import { lpCreateSummary } from '../lp/fakeLpWriteApi.fixture';
import { createHeld } from '../lp/offers';

const SIG2 = '4'.repeat(88);
const POOL = KEY(30);
const opening = () => prepared(lpCreateSummary(POOL, KEY(31)));
const live = (check: CheckSignature | null = null) => renderHook(() => usePendingTrades(LP_PENDING_SCOPE, check, vi.fn(), { live: true }));

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('live notes (the liquidity scope)', () => {
  it('a sent opening holds at once, in this tab; its confirmed answer lets go at once', () => {
    const { result } = live();
    expect(result.current.notes).toEqual([]);
    act(() => result.current.sent(SIG, opening()));
    expect(result.current.notes).toMatchObject([{ kind: 'lp-create', signature: SIG, pool: POOL.toBase58() }]);
    expect(createHeld(result.current.notes)).toBe(true);
    act(() => result.current.record({ status: 'confirmed', signature: SIG, slot: 7 }, opening(), SIG));
    expect(result.current.notes).toEqual([]);
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
  });

  it('an unknown answer holds at once and keeps holding; only the chain or "I checked my wallet" lets go', () => {
    const { result } = live();
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, opening(), SIG));
    expect(result.current.notes).toMatchObject([{ kind: 'lp-create', signature: SIG }]);
    act(() => result.current.dismiss());
    expect(result.current.notes).toEqual([]);
  });

  it('with sessionStorage throwing, a note this tab wrote still holds here, and the chain still settles it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const check = vi.fn<CheckSignature>(async () => ({ status: 'confirmed', signature: SIG, slot: 9 }));
    const { result } = live(check);
    act(() => result.current.sent(SIG, opening()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, opening(), SIG));
    expect(result.current.notes).toMatchObject([{ kind: 'lp-create', signature: SIG }]);
    // Check again looks the remembered note up, and the chain's answer clears it.
    await act(async () => result.current.recheck());
    expect(check).toHaveBeenCalledWith(SIG, 1234, 'lp-create');
    await waitFor(() => expect(result.current.notes).toEqual([]));
  });

  it("a note written while its own panel waits is not 'checked on arrival': the arrival check is for notes found on load", async () => {
    const check = vi.fn<CheckSignature>(async () => ({ status: 'unknown', signature: SIG, message: 'not yet' }));
    const { result } = live(check);
    act(() => result.current.sent(SIG2, opening()));
    await act(async () => {});
    expect(check).not.toHaveBeenCalled();
    expect(result.current.notes).toHaveLength(1);
  });
});

describe('the curve page does not ask for live notes, and is unchanged', () => {
  it('a sent trade is written to storage only: its own panel keeps showing "sent"', () => {
    const mint = KEY(50).toBase58();
    const { result } = renderHook(() => usePendingTrades(curveTradeScope(mint), null, vi.fn()));
    act(() => result.current.sent(SIG, prepared(buySummary())));
    expect(readPendingTrades(curveTradeScope(mint))).toHaveLength(1);
    expect(result.current.notes).toEqual([]);
  });
});
