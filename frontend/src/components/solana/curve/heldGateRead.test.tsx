// A gate read that is held open and never answered, through the real transport and the
// real gate reader, as the pools page wires them. The gate must end closed and unread
// when the wait is over: "loading" for the whole visit shows no form and no reason.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { BROWSER_RPC_TIMEOUT_MS, browserCurveRpc, browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { readLpGate } from '../../../lib/launcher/solana/write/config';
import { browserGateRpc } from './gateRpc';
import { useLpGate, type LpGateApi } from './useWriteGate';
import type { CurveWriteConfig } from './ports';

const cfg: CurveWriteConfig = {
  programId: new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2'),
  cpSwapProgram: new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT'),
  cluster: 'localnet',
};

/** The proxy with one method held open: that request ends only by being aborted. */
function proxyHolding(held: string): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    if (method === held) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }
    // The only other read the gate makes first is the network's: an unknown hash is a local one.
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: 'a-local-genesis-hash' }) } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('a gate read that is never answered', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the clock on, then draws what landed. */
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it.each([
    ['getGenesisHash', 'Could not read which network this is'],
    ['getAccountInfo', 'Could not read the pool program'],
  ])('a held %s closes the gate as unread when the wait is over, and says what was not read', async (held, said) => {
    vi.useFakeTimers();
    const rpc = browserRpc(proxyHolding(held));
    const gateRpc = browserGateRpc(rpc, browserCurveRpc(rpc));
    const api: LpGateApi = { lpWriteConfig: () => cfg, readLpGate: (r, c) => readLpGate(r, c, 'on') };
    // One loader for the hook's life: a new function each render would read the gate each render.
    const load = async () => api;
    const { result } = renderHook(() => useLpGate(gateRpc, { enabled: true, load }));
    await wait(0);
    await wait(BROWSER_RPC_TIMEOUT_MS - 1);
    expect(result.current.status).toBe('loading');
    await wait(1);
    expect(result.current.status === 'ready' && result.current.gate).toEqual({
      kind: 'blocked',
      reason: 'unreadable',
      detail: `${said}: ${held}: no answer after ${BROWSER_RPC_TIMEOUT_MS / 1000} s`,
    });
  });
});
