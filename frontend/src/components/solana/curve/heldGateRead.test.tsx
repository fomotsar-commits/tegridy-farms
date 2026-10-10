// A gate read that is held open and never answered, through the real transport and the
// real gate reader. The gate must end closed and unread when the wait is over: "loading"
// for the whole visit shows no form and no reason. One read has one clock, the sentence
// names the wait that applied, and the gate is asked again by itself until it answers.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { BROWSER_RPC_TIMEOUT_MS, browserCurveRpc, browserRpc, type SolanaRpc } from '../../../lib/launcher/solana/curve/rpc';
import { readLpGate } from '../../../lib/launcher/solana/write/config';
import { lpFetch, READ_TIMEOUT_MS } from '../../../lib/solana/lp/readFetch';
import { browserGateRpc } from './gateRpc';
import { GATE_RETRY_MS, useLpGate, type LpGateApi } from './useWriteGate';
import type { CurveWriteConfig } from './ports';

const cfg: CurveWriteConfig = {
  programId: new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2'),
  cpSwapProgram: new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT'),
  cluster: 'localnet',
};

/** What the network says when it answers: a local network, and a pool program that is there. */
const ANSWERS: Record<string, unknown> = {
  // An unknown hash is a local one.
  getGenesisHash: 'a-local-genesis-hash',
  // Under this loader there is no second account to read: the executable flag settles it.
  getAccountInfo: { context: { slot: 1 }, value: { data: ['', 'base64'], owner: 'BPFLoader2111111111111111111111111111111111', executable: true, lamports: 1 } },
};

/**
 * The proxy with one method held open: that request ends only by being aborted, as a
 * browser's does. `hold.method = null` is the network answering again. `asked` is every
 * method that reached it, in order.
 */
function proxy(hold: { method: string | null }): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    asked.push(method);
    if (method === hold.method) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: ANSWERS[method] }), { status: 200 }));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, asked };
}

/** The two ways a page builds the chain's transport, each with the one clock its reads have. */
const WIRINGS: { name: string; rpcOver(p: typeof fetch): SolanaRpc; limitMs: number; gaveUp(method: string): string }[] = [
  {
    name: 'as the Solana LP page wires it: the LP fetch is the clock, 20 seconds',
    // lpFetch calls the page's own fetch, so the proxy stands in as that.
    rpcOver: (p) => {
      vi.stubGlobal('fetch', p);
      return browserRpc(lpFetch({ what: 'the chain' }));
    },
    limitMs: READ_TIMEOUT_MS,
    gaveUp: () => 'the chain did not answer in 20 seconds',
  },
  {
    name: 'as a caller with no clock of its own wires it (the swap gate, the launch pages): the transport’s, 10 seconds',
    rpcOver: (p) => browserRpc(p),
    limitMs: BROWSER_RPC_TIMEOUT_MS,
    gaveUp: (method) => `${method}: no answer after 10 s`,
  },
];

describe.each(WIRINGS)('a gate read that is never answered, $name', ({ rpcOver, limitMs, gaveUp }) => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs the clock on, then draws what landed. */
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  function mountGate(hold: { method: string | null }) {
    const { fetchImpl, asked } = proxy(hold);
    const rpc = rpcOver(fetchImpl);
    const gateRpc = browserGateRpc(rpc, browserCurveRpc(rpc));
    const api: LpGateApi = { lpWriteConfig: () => cfg, readLpGate: (r, c) => readLpGate(r, c, 'on') };
    // One loader for the hook's life: a new function each render would read the gate each render.
    const load = async () => api;
    const { result } = renderHook(() => useLpGate(gateRpc, { enabled: true, load }));
    const gate = () => (result.current.status === 'ready' ? result.current.gate : result.current.status);
    return { gate, askedFor: (method: string) => asked.filter((m) => m === method).length };
  }

  it('the sentence names the wait that applies: no other number of seconds is in it', () => {
    const seconds = (gaveUp('getGenesisHash').match(/\d+(?= s)/g) ?? []).map(Number);
    expect(seconds).toEqual([limitMs / 1000]);
  });

  it.each([
    ['getGenesisHash', 'Could not read which network this is'],
    ['getAccountInfo', 'Could not read the pool program'],
  ])('a held %s closes the gate as unread when the wait is over and not a moment sooner, and says what was not read', async (held, said) => {
    vi.useFakeTimers();
    const { gate } = mountGate({ method: held });
    await wait(0);
    await wait(limitMs - 1);
    expect(gate()).toBe('loading');
    await wait(1);
    expect(gate()).toEqual({ kind: 'blocked', reason: 'unreadable', detail: `${said}: ${gaveUp(held)}` });
  });

  // Owed since the gate learned to ask again (GATE_RETRY_MS): a wait that ran out is a
  // failed read like any other, so nothing has to be pressed for the forms to come back.
  it('a held read closes at the limit, is asked again 15 seconds later with nothing pressed, and the gate opens when the network answers', async () => {
    vi.useFakeTimers();
    const hold: { method: string | null } = { method: 'getGenesisHash' };
    const { gate, askedFor } = mountGate(hold);
    const closed = { kind: 'blocked', reason: 'unreadable', detail: `Could not read which network this is: ${gaveUp('getGenesisHash')}` };
    await wait(0);
    await wait(limitMs);
    expect(gate()).toEqual(closed);
    expect(askedFor('getGenesisHash')).toBe(1);

    // A whole period after the failed answer landed, and not before.
    await wait(GATE_RETRY_MS - 1);
    expect(askedFor('getGenesisHash')).toBe(1);
    await wait(1);
    expect(askedFor('getGenesisHash')).toBe(2);
    // Held again: the page keeps saying so while it waits, and when that wait runs out too.
    await wait(limitMs - 1);
    expect(gate()).toEqual(closed);
    await wait(1);
    expect(gate()).toEqual(closed);

    // The network answers the next try: the gate opens, which is what brings the buttons back.
    hold.method = null;
    await wait(GATE_RETRY_MS);
    expect(askedFor('getGenesisHash')).toBe(3);
    expect(gate()).toEqual({ kind: 'open', cfg, mode: 'on' });

    // An open gate is an answer. It is not asked again.
    await wait(4 * (GATE_RETRY_MS + limitMs));
    expect(askedFor('getGenesisHash')).toBe(3);
    expect(gate()).toEqual({ kind: 'open', cfg, mode: 'on' });
  });
});
