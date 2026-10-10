/**
 * One fetch for every LP read, with an end. A request the proxy never answers is given
 * up after READ_TIMEOUT_MS and throws a sentence the card can print beside Read again;
 * before this, a read that never answered left "Reading..." on the card for good.
 *
 * The abort is driven by setTimeout, not AbortSignal.timeout: the native timer ignores
 * vitest's fake clock (measured 2026-10-06), so the 20 seconds could not be tested.
 */

/** How long one read may take (the burn tracker's figure, CHANGELOG 2026-10-04). */
export const READ_TIMEOUT_MS = 20_000;
/** Calls a minute that must stay for the live reads; optional reads refuse below it (rpcBudget.ts). */
export const OPTIONAL_READ_FLOOR = 60;

/** What a read asks, as the sentence names it. */
export type ReadWhat = 'the chain' | 'the pool index' | 'Jupiter';

export function timeoutDetail(what: ReadWhat): string {
  return `${what} did not answer in ${READ_TIMEOUT_MS / 1000} seconds`;
}

/**
 * A fetch that ends: `signal` is the caller's merged with the timeout. A timeout throws
 * `new Error(timeoutDetail(what))`; every other error passes through. `onResponse` sees
 * every Response that arrives, before the caller does and before its body is read.
 * The time covers the body too: headers alone are not an answer, so a copy of the body is
 * read to its end under the same timer, and the caller's own Response keeps its body.
 */
export function lpFetch(opts: { what: ReadWhat; onResponse?: (res: Response) => void }): typeof fetch {
  const { what, onResponse } = opts;
  return async (input, init) => {
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
}
