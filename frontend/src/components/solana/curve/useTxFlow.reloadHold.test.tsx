import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTxFlow } from './useTxFlow';
import { CREATOR, SIG, buySummary, fakeApi, prepared } from './fakeWriteApi.fixture';
import type { SubmitDeps, TxOutcome, TxSigner, WriteRpc } from './ports';
import { reloadHeld } from '../../../lib/reloadHold';

// The page reloads itself after a deploy (lib/staleBuild.ts), and never under a
// transaction: every Solana flow is built on this hook, so the hold is taken here.

const rpc = {} as WriteRpc;
const signer: TxSigner = { publicKey: CREATOR, signTransaction: async (t) => t };

describe('useTxFlow holds the page from the wallet to the answer', () => {
  it('free while a review is read, held at the wallet and while sent, free again once answered', async () => {
    let deps: SubmitDeps | undefined;
    let answer: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({
      submitPrepared: vi.fn((_rpc, _signer, _prepared, d) => {
        deps = d;
        return new Promise<TxOutcome>((r) => (answer = r));
      }),
    });
    const { result } = renderHook(() => useTxFlow(api, rpc));
    expect(reloadHeld()).toBe(false);

    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    expect(result.current.state.step).toBe('review');
    // Nothing is signed while a review is read: a reload here loses no transaction.
    expect(reloadHeld()).toBe(false);

    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    expect(result.current.state.step).toBe('submitting');
    expect(reloadHeld()).toBe(true);

    await act(async () => {
      deps?.onSent?.(SIG, 1234);
    });
    expect(result.current.state.step).toBe('sent');
    expect(reloadHeld()).toBe(true);

    await act(async () => {
      answer({ status: 'confirmed', signature: SIG, slot: 1 });
      await done;
    });
    expect(result.current.state.step).toBe('outcome');
    expect(reloadHeld()).toBe(false);
  });

  it('a panel that leaves the screen mid-send keeps the page held until the send is answered', async () => {
    let answer: (o: TxOutcome) => void = () => undefined;
    const api = fakeApi({ submitPrepared: vi.fn(() => new Promise<TxOutcome>((r) => (answer = r))) });
    const { result, unmount } = renderHook(() => useTxFlow(api, rpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.confirm(signer);
      await vi.waitFor(() => expect(api.submitPrepared).toHaveBeenCalled());
    });
    // The visitor moves to another page: the wallet prompt is still open.
    unmount();
    expect(reloadHeld()).toBe(true);
    answer({ status: 'not-sent', stage: 'sign', message: 'declined in the wallet' });
    await done;
    expect(reloadHeld()).toBe(false);
  });

  it('a send that throws gives the hold back', async () => {
    const api = fakeApi({ submitPrepared: vi.fn(async () => Promise.reject(new Error('the wallet went away'))) });
    const { result } = renderHook(() => useTxFlow(api, rpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(buySummary()) })));
    await act(() => result.current.confirm(signer));
    expect(result.current.state).toMatchObject({ step: 'outcome', outcome: { status: 'unknown' } });
    expect(reloadHeld()).toBe(false);
  });
});
