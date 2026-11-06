// @vitest-environment node
//
// The keeper wakes when the chain says a watched vault changed, instead of on a 10-s timer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { accountWake, socketUrlOf, type SocketLike } from './wake';

class FakeSocket implements SocketLike {
  sent: { method: string; params: unknown[] }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  notify() {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: 1, result: {} } }) });
  }
}

function rig() {
  const sockets: FakeSocket[] = [];
  const log = vi.fn();
  const wake = accountWake({
    url: 'wss://rpc',
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    log,
    reopenMs: 5_000,
  });
  return { wake, sockets, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('accountWake', () => {
  it('subscribes to every watched account once the socket opens', () => {
    const { wake, sockets } = rig();
    wake.watch(['B', 'A', 'B']);
    sockets[0]!.onopen!();
    expect(sockets[0]!.sent.map((m) => [m.method, m.params[0]])).toEqual([
      ['accountSubscribe', 'A'],
      ['accountSubscribe', 'B'],
    ]);
  });

  it('ends the wait as soon as a watched account changes', async () => {
    const { wake, sockets } = rig();
    wake.watch(['A']);
    sockets[0]!.onopen!();
    const said = wake.wait(10_000);
    await vi.advanceTimersByTimeAsync(300);
    sockets[0]!.notify();
    expect(await said).toBe('change');
  });

  it('ends on its timer when nothing changes', async () => {
    const { wake, sockets } = rig();
    wake.watch(['A']);
    sockets[0]!.onopen!();
    const said = wake.wait(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await said).toBe('time');
  });

  it('remembers a change that came while it was not waiting', async () => {
    const { wake, sockets } = rig();
    wake.watch(['A']);
    sockets[0]!.onopen!();
    sockets[0]!.notify();
    expect(await wake.wait(10_000)).toBe('change');
    // Once only.
    const next = wake.wait(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toBe('time');
  });

  it('keeps its socket for the same accounts, and opens a new one for others', () => {
    const { wake, sockets } = rig();
    wake.watch(['A', 'B']);
    wake.watch(['B', 'A']);
    expect(sockets).toHaveLength(1);
    wake.watch(['A', 'C']);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
  });

  it('opens again after the socket drops, and says so once', async () => {
    const { wake, sockets, log } = rig();
    wake.watch(['A']);
    sockets[0]!.onclose!();
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose!();
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(3);
  });

  it('says something every 25 s, so the RPC does not drop the socket as idle', async () => {
    const { wake, sockets } = rig();
    wake.watch(['A']);
    sockets[0]!.onopen!();
    const pings = (s: FakeSocket) => s.sent.filter((m) => m.method !== 'accountSubscribe').length;
    await vi.advanceTimersByTimeAsync(24_000);
    expect(pings(sockets[0]!)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(sockets[0]!)).toBe(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(pings(sockets[0]!)).toBe(2);
    // A replaced socket says nothing more.
    wake.watch(['B']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pings(sockets[0]!)).toBe(2);
  });

  it('opens nothing more once closed', async () => {
    const { wake, sockets } = rig();
    wake.watch(['A']);
    wake.close();
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('accountWake: trades in outside pools', () => {
  const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const POOLS = [
    { pool: 'P2', program: ORCA, mint: 'COIN2' },
    { pool: 'P1', program: ORCA, mint: 'COIN1' },
  ];
  const say = (s: FakeSocket, m: unknown) => s.onmessage!({ data: JSON.stringify(m) });
  const trade = (subscription: number, err: unknown = null, logs = [`Program ${ORCA} invoke [1]`]) => ({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { subscription, result: { context: { slot: 1 }, value: { signature: 'sig', err, logs } } },
  });
  /** Watching account A and both pools, the RPC having answered P1's ask with 901 and P2's with 902. */
  function listening() {
    const r = rig();
    r.wake.watch(['A'], POOLS);
    const s = r.sockets[0]!;
    s.onopen!();
    const ids = new Map(s.sent.filter((m) => m.method === 'logsSubscribe').map((m) => [(m.params[0] as { mentions: string[] }).mentions[0], (m as unknown as { id: number }).id]));
    say(s, { jsonrpc: '2.0', id: ids.get('P1'), result: 901 });
    say(s, { jsonrpc: '2.0', id: ids.get('P2'), result: 902 });
    return { ...r, s };
  }

  it('asks the socket for each pool’s logs, never its account data', () => {
    const { s } = listening();
    expect(s.sent.filter((m) => m.method !== 'ping').map((m) => [m.method, m.params[0]])).toEqual([
      ['accountSubscribe', 'A'],
      ['logsSubscribe', { mentions: ['P1'] }],
      ['logsSubscribe', { mentions: ['P2'] }],
    ]);
    // Every request its own number, so each answer names its pool.
    const ids = s.sent.map((m) => (m as unknown as { id: number }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens for pools alone, with no account to watch', () => {
    const { wake, sockets } = rig();
    wake.watch([], POOLS);
    expect(sockets).toHaveLength(1);
  });

  it('ends the wait when a trade lands in a pool, and says which coin moved', async () => {
    const { wake, s } = listening();
    const said = wake.wait(10_000);
    say(s, trade(902));
    expect(await said).toBe('change');
    expect(wake.moved()).toEqual(['COIN2']);
    expect(wake.moved()).toEqual([]);
  });

  it('sleeps through a failed trade, one in which the exchange never ran, and one under no subscription of its own', async () => {
    const { wake, s } = listening();
    const said = wake.wait(10_000);
    say(s, trade(901, { InstructionError: [0, 'Custom'] }));
    say(s, trade(901, null, ['Program 11111111111111111111111111111111 invoke [1]']));
    say(s, trade(777));
    s.onmessage!({ data: '{"method":"logsNotification", not json' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await said).toBe('time');
    expect(wake.moved()).toEqual([]);
  });

  it('listens again on a new socket when the pools change, and not when they are the same', () => {
    const { wake, sockets } = rig();
    wake.watch(['A'], POOLS);
    wake.watch(['A'], [...POOLS].reverse());
    expect(sockets).toHaveLength(1);
    wake.watch(['A'], POOLS.slice(0, 1));
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
  });
});

describe('socketUrlOf', () => {
  it('is the RPC’s own host over websocket', () => {
    expect(socketUrlOf('https://api.mainnet-beta.solana.com')).toBe('wss://api.mainnet-beta.solana.com');
    expect(socketUrlOf('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899');
  });
});
