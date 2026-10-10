// The liquidity gate hook (spec D19): the same body as the launch page's gate, so a
// gate read that throws closes it, and a switched-off build never loads write code.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { GATE_RETRY_MS, useLpGate, type LpGateApi } from './useWriteGate';
import type { CurveWriteConfig, GateRpc, LpGate } from './ports';

const rpc = {} as GateRpc;
const cfg: CurveWriteConfig = {
  programId: new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2'),
  cpSwapProgram: new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT'),
  cluster: 'localnet',
};

function fakeLpGateApi(o: Partial<LpGateApi> = {}): LpGateApi {
  return {
    lpWriteConfig: vi.fn(() => cfg),
    readLpGate: vi.fn(async (_r: GateRpc, c: CurveWriteConfig | null): Promise<LpGate> => (c ? { kind: 'open', cfg: c, mode: 'on' } : { kind: 'off' })),
    ...o,
  };
}

describe('useLpGate', () => {
  it('switched off: never loads the write code', () => {
    const load = vi.fn(async () => fakeLpGateApi());
    const { result } = renderHook(() => useLpGate(rpc, { enabled: false, load }));
    expect(result.current.status).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
  });

  it('a chunk that does not load is load-failed, not open', async () => {
    const load = vi.fn(async () => Promise.reject(new Error('chunk 404')));
    const { result } = renderHook(() => useLpGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('load-failed'));
  });

  it('a gate reader that throws closes the gate, and so does a configuration that throws', async () => {
    for (const api of [
      fakeLpGateApi({ readLpGate: vi.fn(async () => Promise.reject(new Error('boom'))) }),
      fakeLpGateApi({ lpWriteConfig: vi.fn(() => { throw new Error('bad env'); }) }),
    ]) {
      const load = vi.fn(async () => api);
      const { result } = renderHook(() => useLpGate(rpc, { enabled: true, load }));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.status === 'ready' && result.current.gate).toMatchObject({ kind: 'blocked', reason: 'unreadable' });
      expect(result.current.status === 'ready' && result.current.cfg).toBeNull();
    }
  });

  it('reads the LP gate (never the launch page’s) with the LP configuration, and keeps the api', async () => {
    const api = fakeLpGateApi();
    const load = vi.fn(async () => api);
    const { result } = renderHook(() => useLpGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.readLpGate).toHaveBeenCalledWith(rpc, cfg);
    expect(result.current.status === 'ready' && result.current.gate).toEqual({ kind: 'open', cfg, mode: 'on' });
    expect(result.current.status === 'ready' && result.current.api).toBe(api);
  });

  it('refresh reads the gate again', async () => {
    const api = fakeLpGateApi();
    const load = vi.fn(async () => api);
    const { result } = renderHook(() => useLpGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    result.current.refresh();
    await waitFor(() => expect(api.readLpGate).toHaveBeenCalledTimes(2));
  });
});

// One failed answer at page load is not the page view's answer: a gate that could not be
// read, and write code that did not load, are asked for again with nothing pressed. A
// gate that WAS read and is closed is an answer, and is never asked again.
describe('useLpGate: an unread gate is asked for again', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const unread: LpGate = { kind: 'blocked', reason: 'unreadable', detail: 'HTTP 503' };
  const open: LpGate = { kind: 'open', cfg, mode: 'on' };
  /**
   * Runs the clock on, then draws what landed. A try is armed only once an answer is
   * drawn, so a wait never spans two tries: `wait(0)` first, then one period at a time.
   */
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const periods = async (n: number) => {
    for (let i = 0; i < n; i++) await wait(GATE_RETRY_MS);
  };
  function mount(load: () => Promise<LpGateApi>) {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLpGate(rpc, { enabled: true, load }));
    return { gate: () => (result.current.status === 'ready' ? result.current.gate : null), result };
  }

  it('opens by itself once a read lands, a whole period after the failed one, and is not read again', async () => {
    const api = fakeLpGateApi({ readLpGate: vi.fn().mockResolvedValueOnce(unread).mockResolvedValue(open) });
    const { gate } = mount(async () => api);
    await wait(0);
    expect(gate()).toEqual(unread);
    await wait(GATE_RETRY_MS - 1);
    expect(api.readLpGate).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(gate()).toEqual(open);
    await periods(4);
    expect(api.readLpGate, 'an open gate is an answer').toHaveBeenCalledTimes(2);
  });

  it('a reader that threw is asked again too, and a second throw still closes the gate', async () => {
    const readLpGate = vi.fn().mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom again')).mockResolvedValue(open);
    const { gate } = mount(async () => fakeLpGateApi({ readLpGate }));
    await wait(0);
    expect(gate()).toMatchObject({ kind: 'blocked', reason: 'unreadable', detail: 'boom' });
    await wait(GATE_RETRY_MS);
    expect(gate()).toMatchObject({ kind: 'blocked', reason: 'unreadable', detail: 'boom again' });
    await wait(GATE_RETRY_MS);
    expect(gate()).toEqual(open);
  });

  it.each<LpGate>([
    { kind: 'off' },
    { kind: 'blocked', reason: 'wrong-cluster', detail: '' },
    { kind: 'blocked', reason: 'cpswap-program-missing', detail: '' },
    { kind: 'blocked', reason: 'venue-mismatch', detail: '' },
    { kind: 'open', cfg, mode: 'withdraw-only' },
  ])('a gate that was read is an answer and is never asked again: %o', async (answer) => {
    const api = fakeLpGateApi({ readLpGate: vi.fn(async () => answer) });
    const { gate } = mount(async () => api);
    await wait(0);
    await periods(4);
    expect(gate()).toEqual(answer);
    expect(api.readLpGate).toHaveBeenCalledTimes(1);
  });

  it('write code that did not load is asked for again, and the page keeps saying so until it arrives', async () => {
    let arrive!: (api: LpGateApi) => void;
    const load = vi
      .fn<() => Promise<LpGateApi>>()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockImplementationOnce(() => new Promise((r) => (arrive = r)));
    const { gate, result } = mount(load);
    await wait(0);
    expect(result.current.status).toBe('load-failed');
    await wait(GATE_RETRY_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.status, 'no flash of "loading" while it is asked for again').toBe('load-failed');
    arrive(fakeLpGateApi());
    await wait(0);
    expect(gate()).toEqual(open);
  });

  it('is never asked sooner than a period after the last answer, a pressed Refresh included', async () => {
    const api = fakeLpGateApi({ readLpGate: vi.fn(async () => unread) });
    const { result } = mount(async () => api);
    await wait(0);
    await wait(GATE_RETRY_MS - 5_000);
    act(() => result.current.refresh());
    await wait(0);
    expect(api.readLpGate).toHaveBeenCalledTimes(2);
    await wait(GATE_RETRY_MS - 1);
    expect(api.readLpGate, 'the try armed by the first answer was dropped').toHaveBeenCalledTimes(2);
    await wait(1);
    expect(api.readLpGate).toHaveBeenCalledTimes(3);
  });
});
