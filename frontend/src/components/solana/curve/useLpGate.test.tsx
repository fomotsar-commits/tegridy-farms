// The liquidity gate hook (spec D19): the same body as the launch page's gate, so a
// gate read that throws closes it, and a switched-off build never loads write code.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { useLpGate, type LpGateApi } from './useWriteGate';
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
