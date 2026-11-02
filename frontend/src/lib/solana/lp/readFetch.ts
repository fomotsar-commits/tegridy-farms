/**
 * One fetch for every LP read, with an end. A request the proxy never answers is given
 * up after READ_TIMEOUT_MS and throws a sentence the card can print beside Read again;
 * before this, a read that never answered left "Reading..." on the card for good.
 *
 * The abort is driven by setTimeout, not AbortSignal.timeout: the native timer ignores
 * vitest's fake clock (measured 2026-10-06), so the 20 seconds could not be tested.
 */
import type { SelfEndingFetch } from '../../launcher/solana/curve/rpc';

/** How long one read may take (the burn tracker's figure, CHANGELOG 2026-10-04). */
export const READ_TIMEOUT_MS = 20_000;
/** Calls a minute that must stay for the live reads; optional reads refuse below it (rpcBudget.ts). */
export const OPTIONAL_READ_FLOOR = 60;
/**
 * A proxy's per-minute limit (api/_lib/ratelimit.js) answers 429 with Retry-After before anything
 * reaches the chain, so the read is asked again once that wait is over, as web3.js does for its
 * own reads, instead of "Couldn't read" over a queue of seconds. A phone shares its address with
 * the rest of its house, or with strangers on mobile data. At most this many asks again, each
 * after at most RATE_LIMIT_WAIT_MAX_MS (the limit's window).
 */
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_WAIT_MAX_MS = 60_000;

/** The wait a 429 names, in ms; null when it names none, or one longer than we wait. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('Retry-After')?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const ms = Number(raw) * 1000;
  return ms <= RATE_LIMIT_WAIT_MAX_MS ? ms : null;
}

/** Waits `ms`, or rejects with the caller's reason when the caller gives up first. */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const t = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** What a read asks, as the sentence names it. */
export type ReadWhat = 'the chain' | 'the pool index' | 'Jupiter';

export function timeoutDetail(what: ReadWhat): string {
  return `${what} did not answer in ${READ_TIMEOUT_MS / 1000} seconds`;
}

/**
 * A fetch that ends: `signal` is the caller's merged with the timeout. A timeout throws
 * `new Error(timeoutDetail(what))`; every other error passes through. `onResponse` sees
 * every Response that arrives, before the caller does and before its body is read.
 * The time covers the body too: a copy of the body is read to its end under the same
 * timer, and the caller's own Response keeps its body. `endsAfterMs` tells the chain's
 * transport this is the read's clock, so it starts no second one (curve/rpc.ts): each ask
 * ends, and a 429's waits are bounded (RATE_LIMIT_RETRIES, RATE_LIMIT_WAIT_MAX_MS).
 */
export function lpFetch(opts: { what: ReadWhat; onResponse?: (res: Response) => void }): SelfEndingFetch {
  const { what, onResponse } = opts;
  const once: typeof fetch = async (input, init) => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error(timeoutDetail(what)));
    }, READ_TIMEOUT_MS);
    // Rejects when the read is given up, whether or not the transport ends the body then.
    const gaveUp = new Promise<never>((_resolve, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true });
    });
    gaveUp.catch(() => undefined);
    const outer = init?.signal ?? null;
    const forward = () => ctrl.abort(outer?.reason);
    if (outer?.aborted) forward();
    else outer?.addEventListener('abort', forward, { once: true });
    try {
      const res = await fetch(input, { ...init, signal: ctrl.signal });
      onResponse?.(res);
      await Promise.race([res.clone().arrayBuffer(), gaveUp]);
      return res;
    } catch (e) {
      if (timedOut) throw new Error(timeoutDetail(what), { cause: e });
      throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    }
  };
  const ending: typeof fetch = async (input, init) => {
    for (let asked = 0; ; asked += 1) {
      const res = await once(input, init);
      const wait = res.status === 429 && asked < RATE_LIMIT_RETRIES ? retryAfterMs(res) : null;
      if (wait === null) return res;
      await pause(wait, init?.signal);
    }
  };
  return Object.assign(ending, { endsAfterMs: READ_TIMEOUT_MS });
}
