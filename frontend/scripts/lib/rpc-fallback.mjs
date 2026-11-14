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
 * An error the MAIN endpoint itself gives (a JSON-RPC error that is not a rate limit) is the
 * answer to the call and is thrown as it is: another endpoint would say the same.
 *
 * A FALLBACK's refusal is never the answer (first 40 min live, 2026-11-14 07:27Z to 07:54Z:
 * publicnode answered 403 to 14 reads handed to it, "A maximum of 10 accounts is allowed", and
 * each was thrown as the read's answer while the main endpoint rested). So:
 *   - an endpoint that says how many accounts a read may ask of it ("a maximum of N accounts") is
 *     remembered, and a larger getMultipleAccounts is split there into reads of N, sent at the same
 *     moment and put back together in order, under the lowest slot any part answered at;
 *   - any other refusal from a fallback rests it too and the next endpoint is asked, the resting
 *     main one last; with every endpoint failing, the main one's own error is the one thrown.
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
/** The most accounts a read may ask, as an endpoint's refusal says it (publicnode: "A maximum of 10 accounts is allowed"), or 0. */
const capSaid = (text) => {
  const n = Number(String(text ?? '').match(/maximum of (\d+) accounts/i)?.[1] ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * `call(method, params)` over `urls` (the first is the main one), and `counts`: calls made, calls
 * a later endpoint answered, reads split, and each endpoint's times found busy. `onBusy(url, why)`
 * is told each time an endpoint is set to rest; `onCap(url, n)` once when an endpoint says a read
 * may ask it at most `n` accounts.
 */
export function rpcWithFallback({ urls, fetchImpl = fetch, now = Date.now, onBusy = () => {}, onCap = () => {} }) {
  if (!urls?.length) throw new Error('no RPC endpoint');
  const restUntil = new Map();
  const caps = new Map();
  const counts = { calls: 0, answeredByFallback: 0, splitReads: 0, busy: Object.fromEntries(urls.map((u) => [u, 0])) };
  const rest = (url, why) => {
    restUntil.set(url, now() + RPC_REST_MS);
    counts.busy[url]++;
    onBusy(url, why);
  };

  /** One call to one endpoint: { ok: result }, { busy: Error, why } (too busy, or no answer), or { refused: Error, cap } (it will not answer this call). */
  const one = async (url, method, params) => {
    let r;
    try {
      r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    } catch (e) {
      return { busy: e, why: e instanceof Error ? e.message : String(e) };
    }
    if (!r.ok) {
      const err = new Error(`${method}: the RPC answered ${r.status}`);
      if (busyStatus(r.status)) return { busy: err, why: `answered ${r.status}` };
      return { refused: err, cap: capSaid(await r.text().catch(() => '')) };
    }
    const j = await r.json();
    if (j.error) {
      const err = new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
      if (busyError(j.error)) return { busy: err, why: 'rate limit' };
      return { refused: err, cap: capSaid(j.error.message) };
    }
    return { ok: j.result };
  };

  /** getMultipleAccounts of more accounts than `url` takes in one read: reads of `cap`, at the same moment, put back together in order. */
  const split = async (url, [keys, opts], cap) => {
    counts.splitReads++;
    const parts = [];
    for (let i = 0; i < keys.length; i += cap) parts.push(keys.slice(i, i + cap));
    const got = await Promise.all(parts.map((p) => one(url, 'getMultipleAccounts', [p, opts])));
    const bad = got.find((g) => !('ok' in g));
    if (bad) return bad;
    if (got.some((g, i) => !Array.isArray(g.ok?.value) || g.ok.value.length !== parts[i].length)) return { refused: new Error('getMultipleAccounts: a split read came back short'), cap: 0 };
    // The parts may answer a slot or two apart: the whole is no newer than its oldest part.
    const slot = Math.min(...got.map((g) => Number(g.ok.context?.slot ?? 0)));
    return { ok: { context: { ...got[0].ok.context, slot }, value: got.flatMap((g) => g.ok.value) } };
  };

  const call = async (method, params) => {
    counts.calls++;
    const t = now();
    // Endpoints not resting first, in their given order; a resting one is still tried last (it may be back).
    const order = [...urls.filter((u) => (restUntil.get(u) ?? 0) <= t), ...urls.filter((u) => (restUntil.get(u) ?? 0) > t)];
    const manyAccounts = method === 'getMultipleAccounts' && Array.isArray(params?.[0]) ? params[0].length : 0;
    let first = null;
    let mainSaid = null;
    for (const url of order) {
      const isMain = url === urls[0];
      const known = caps.get(url) ?? 0;
      let a = known > 0 && manyAccounts > known ? await split(url, params, known) : await one(url, method, params);
      // It said how many accounts a read may ask of it: remembered, and this read split there now.
      if ('refused' in a && a.cap > 0 && manyAccounts > a.cap) {
        if (caps.get(url) !== a.cap) {
          caps.set(url, a.cap);
          onCap(url, a.cap);
        }
        a = await split(url, params, a.cap);
      }
      if ('ok' in a) {
        if (!isMain) counts.answeredByFallback++;
        return a.ok;
      }
      const err = 'busy' in a ? a.busy : a.refused;
      first ??= err;
      if (isMain) {
        mainSaid = err;
        // The main endpoint's own refusal is the answer to the call, as it always was.
        if ('refused' in a) throw err;
        if (urls.length > 1) rest(url, a.why);
        continue;
      }
      // A fallback that is busy, or will not answer this call, rests; the next endpoint is asked.
      rest(url, 'busy' in a ? a.why : `refused the call: ${err.message}`);
    }
    throw mainSaid ?? first;
  };
  return { call, counts, caps };
}
