/**
 * What wakes the keeper between checks: the chain telling it a watched account changed, or a
 * trade landed in a listened-to outside pool. One websocket to the RPC: an `accountSubscribe` per
 * watched vault, a `logsSubscribe` per outside pool (keeper/streams.ts). Either ends the wait at
 * once; without one, the wait ends on its timer, so a socket that is down or slow only makes the
 * keeper as slow as it was with the timer alone.
 */
import { tradeLanded, type StreamPool } from './streams';

/** The little of a WebSocket this needs (Node's global one, or a test's). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface Wake {
  /** Watch these accounts, and listen for trades in these pools, from now on; the same again changes nothing. */
  watch(accounts: readonly string[], pools?: readonly StreamPool[]): void;
  /** Wait up to `ms`: 'change' as soon as a watched account changes or a pool trades (or one already did since the last wait), else 'time'. */
  wait(ms: number): Promise<'change' | 'time'>;
  /** The coins whose outside pool traded since this was last asked. */
  moved(): string[];
  close(): void;
}

/** How often an open socket says something, so the RPC does not drop it as idle. */
export const KEEP_ALIVE_MS = 25_000;

/** The websocket address for an RPC address: the same host, ws for http. */
export function socketUrlOf(rpcUrl: string): string {
  return rpcUrl.replace(/^http/i, 'ws');
}

export function accountWake(opts: {
  url: string;
  socket: (url: string) => SocketLike;
  log: (line: string) => void;
  /** How long after a socket closes it is opened again. */
  reopenMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Wake {
  const reopenMs = opts.reopenMs ?? 5_000;
  const setTimer = opts.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let accounts: string[] = [];
  let pools: StreamPool[] = [];
  let socket: SocketLike | null = null;
  let changed = false;
  const moved = new Set<string>();
  let waiter: (() => void) | null = null;
  let closed = false;
  let reopen: unknown = null;
  let saidDown = false;

  const wakeUp = () => {
    changed = true;
    waiter?.();
  };

  const open = () => {
    if (closed || (!accounts.length && !pools.length)) return;
    let s: SocketLike;
    try {
      s = opts.socket(opts.url);
    } catch (e) {
      down(`not opened (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    socket = s;
    const watching = accounts;
    const listening = pools;
    // A pool's trades arrive under the subscription number the RPC answered its request with.
    const asked = new Map<number, StreamPool>();
    const subs = new Map<number, StreamPool>();
    s.onopen = () => {
      saidDown = false;
      watching.forEach((a, i) =>
        s.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'accountSubscribe', params: [a, { encoding: 'base64', commitment: 'confirmed' }] })),
      );
      listening.forEach((p, i) => {
        const id = watching.length + i + 1;
        asked.set(id, p);
        s.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [p.pool] }, { commitment: 'confirmed' }] }));
      });
      keepAlive(s);
    };
    s.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      if (e.data.includes('"accountNotification"')) return wakeUp();
      let m: { id?: unknown; result?: unknown; method?: unknown; params?: { subscription?: unknown; result?: { value?: unknown } } };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.method === 'logsNotification') {
        const p = typeof m.params?.subscription === 'number' ? subs.get(m.params.subscription) : undefined;
        if (!p || !tradeLanded(m.params?.result?.value, p.program)) return;
        moved.add(p.mint);
        return wakeUp();
      }
      const p = typeof m.id === 'number' ? asked.get(m.id) : undefined;
      if (p && typeof m.result === 'number') subs.set(m.result, p);
    };
    s.onerror = () => {};
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      down('closed');
    };
  };

  // The public RPC drops a socket that has said nothing for 60 s (walked 2026-11-05, close code
  // 1006 at 60.7 s); a message every 25 s keeps it. Any message will do: it answers "Method not found".
  const keepAlive = (s: SocketLike) => {
    const beat = () => {
      if (socket !== s) return;
      s.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }));
      setTimer(beat, KEEP_ALIVE_MS);
    };
    setTimer(beat, KEEP_ALIVE_MS);
  };

  const down = (why: string) => {
    // Said once until it is back: a socket that keeps dropping is no reason to fill the log.
    if (!saidDown) opts.log(`Chain updates ${why}: checking on the timer, opening again in ${reopenMs / 1000} s`);
    saidDown = true;
    if (!closed && reopen === null) {
      reopen = setTimer(() => {
        reopen = null;
        open();
      }, reopenMs);
    }
  };

  const shut = () => {
    const s = socket;
    socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
  };

  return {
    watch(next, nextPools = []) {
      const sorted = [...new Set(next)].sort();
      const byPool = [...new Map(nextPools.map((p) => [p.pool, p])).values()].sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
      const same = (x: unknown[], y: unknown[]) => JSON.stringify(x) === JSON.stringify(y);
      if (same(sorted, accounts) && same(byPool, pools)) return;
      accounts = sorted;
      pools = byPool;
      shut();
      if (reopen !== null) {
        clearTimer(reopen);
        reopen = null;
      }
      open();
    },
    wait(ms) {
      if (changed) {
        changed = false;
        return Promise.resolve('change');
      }
      return new Promise((resolve) => {
        const timer = setTimer(() => {
          waiter = null;
          resolve('time');
        }, ms);
        waiter = () => {
          waiter = null;
          changed = false;
          clearTimer(timer);
          resolve('change');
        };
      });
    },
    moved() {
      const out = [...moved];
      moved.clear();
      return out;
    },
    close() {
      closed = true;
      shut();
      if (reopen !== null) clearTimer(reopen);
      waiter = null;
    },
  };
}
