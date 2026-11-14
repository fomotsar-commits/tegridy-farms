/**
 * The robot's reads over more than one RPC (KEEPER_RPC_FALLBACK_URLS): a call the first endpoint
 * is too busy to answer (429, a 5xx, no answer at all) goes to the next at once, and the busy one
 * is left alone for RPC_REST_MS.
 *
 * Why (the robot's log, 2026-11-14 05:56:39Z to 05:56:53Z): the public RPC answered 429 to five
 * passes in a row while BAYLA moved; the robot priced nothing for 15 s, and at 05:57:11Z another
 * wallet (Cn8LrZZn…) took 0.0013 SOL out of our pools before its first trip of the move went out.
 *
 * With one endpoint it behaves exactly as the call it replaces: one try, the same error text.
 * An error the chain itself gives (a JSON-RPC error that is not a rate limit) is the answer to the
 * call and is thrown as it is: another endpoint would say the same.
 */
export const RPC_REST_MS = 10_000;

/** A comma-separated list of RPC addresses (KEEPER_RPC_FALLBACK_URLS), each held to http(s); blank: none. */
export function fallbackUrls(raw) {
  const list = [...new Set((raw ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  const isHttp = (u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  };
  // Never echo the address: it may carry a key.
  if (!list.every(isHttp)) throw new Error('KEEPER_RPC_FALLBACK_URLS: every entry must be an http(s) address');
  return list;
}

const busyStatus = (status) => status === 429 || status >= 500;
const busyError = (e) => e?.code === 429 || e?.code === -32429 || /rate.?limit|too many requests/i.test(String(e?.message ?? ''));

/**
 * `call(method, params)` over `urls` (the first is the main one), and `counts`: calls made, calls
 * a later endpoint answered, and each endpoint's times found busy. `onBusy(url, why)` is told each
 * time an endpoint is set to rest.
 */
export function rpcWithFallback({ urls, fetchImpl = fetch, now = Date.now, onBusy = () => {} }) {
  if (!urls?.length) throw new Error('no RPC endpoint');
  const restUntil = new Map();
  const counts = { calls: 0, answeredByFallback: 0, busy: Object.fromEntries(urls.map((u) => [u, 0])) };
  const rest = (url, why) => {
    restUntil.set(url, now() + RPC_REST_MS);
    counts.busy[url]++;
    onBusy(url, why);
  };
  const call = async (method, params) => {
    counts.calls++;
    const t = now();
    // Endpoints not resting first, in their given order; a resting one is still tried last (it may be back).
    const order = [...urls.filter((u) => (restUntil.get(u) ?? 0) <= t), ...urls.filter((u) => (restUntil.get(u) ?? 0) > t)];
    let first = null;
    for (const url of order) {
      let r;
      try {
        r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      } catch (e) {
        // No answer at all (the connection, a timeout): the next endpoint is asked.
        first ??= e;
        if (urls.length > 1) rest(url, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (!r.ok) {
        const err = new Error(`${method}: the RPC answered ${r.status}`);
        if (!busyStatus(r.status)) throw err;
        first ??= err;
        if (urls.length > 1) rest(url, `answered ${r.status}`);
        continue;
      }
      const j = await r.json();
      if (j.error) {
        const err = new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
        if (!busyError(j.error)) throw err;
        first ??= err;
        if (urls.length > 1) rest(url, 'rate limit');
        continue;
      }
      if (url !== urls[0]) counts.answeredByFallback++;
      return j.result;
    }
    throw first;
  };
  return { call, counts };
}
