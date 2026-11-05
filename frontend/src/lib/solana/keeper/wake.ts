/**
 * What wakes the keeper between checks: the chain telling it a watched account changed. One
 * websocket to the RPC, one `accountSubscribe` per watched vault (our pools' and the outside
 * pools'). A change ends the wait at once; without one, the wait ends on its timer, so a socket
 * that is down or slow only makes the keeper as slow as it was with the timer alone. Free: no
 * Jupiter call, and the public RPC serves websockets.
 */

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
  /** Watch these accounts from now on; the same set again changes nothing. */
  watch(accounts: readonly string[]): void;
  /** Wait up to `ms`: 'change' as soon as a watched account changes (or one already did since the last wait), else 'time'. */
  wait(ms: number): Promise<'change' | 'time'>;
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
  let socket: SocketLike | null = null;
  let changed = false;
  let waiter: (() => void) | null = null;
  let closed = false;
  let reopen: unknown = null;
  let saidDown = false;

  const open = () => {
    if (closed || !accounts.length) return;
    let s: SocketLike;
    try {
      s = opts.socket(opts.url);
    } catch (e) {
      down(`not opened (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    socket = s;
    const watching = accounts;
    s.onopen = () => {
      saidDown = false;
      watching.forEach((a, i) =>
        s.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'accountSubscribe', params: [a, { encoding: 'base64', commitment: 'confirmed' }] })),
      );
      keepAlive(s);
    };
    s.onmessage = (e) => {
      if (typeof e.data !== 'string' || !e.data.includes('"accountNotification"')) return;
      changed = true;
      waiter?.();
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
    watch(next) {
      const sorted = [...new Set(next)].sort();
      if (sorted.length === accounts.length && sorted.every((a, i) => a === accounts[i])) return;
      accounts = sorted;
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
    close() {
      closed = true;
      shut();
      if (reopen !== null) clearTimer(reopen);
      waiter = null;
    },
  };
}
