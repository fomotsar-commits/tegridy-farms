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

describe('socketUrlOf', () => {
  it('is the RPC’s own host over websocket', () => {
    expect(socketUrlOf('https://api.mainnet-beta.solana.com')).toBe('wss://api.mainnet-beta.solana.com');
    expect(socketUrlOf('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899');
  });
});
