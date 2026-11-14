import { describe, it, expect } from 'vitest';
import { RPC_REST_MS, fallbackUrls, rpcWithFallback } from './rpc-fallback.mjs';

const MAIN = 'https://main.example/rpc';
const SECOND = 'https://second.example/rpc';
const THIRD = 'https://third.example/rpc';

/** Endpoints answering as `answers[url]()` says (a Response, or an Error thrown), and a clock that moves only when told. */
function rig(urls, answers) {
  let clock = 5_000_000;
  const asked = [];
  const busy = [];
  const r = rpcWithFallback({
    urls,
    fetchImpl: async (url, init) => {
      asked.push({ url, method: JSON.parse(init.body).method });
      const a = answers[url]();
      if (a instanceof Error) throw a;
      return a;
    },
    now: () => clock,
    onBusy: (url, why) => busy.push({ url, why }),
  });
  return { ...r, asked, busy, tick: (ms) => (clock += ms) };
}
const ok = (result) => () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const status = (code) => () => new Response('{}', { status: code });

describe('fallbackUrls (KEEPER_RPC_FALLBACK_URLS)', () => {
  it('reads a comma-separated list once each, and nothing from a blank', () => {
    expect(fallbackUrls(undefined)).toEqual([]);
    expect(fallbackUrls('  ')).toEqual([]);
    expect(fallbackUrls(` ${SECOND} , ${THIRD},${SECOND}`)).toEqual([SECOND, THIRD]);
  });

  it('refuses an entry that is not an http(s) address, without echoing it (it may carry a key)', () => {
    expect(() => fallbackUrls('wss://x.example/?api-key=SECRET')).toThrow(/every entry must be an http\(s\) address/);
    expect(() => fallbackUrls('not a url SECRET')).toThrow(/every entry must be an http\(s\) address/);
    try {
      fallbackUrls('ftp://x.example/SECRET');
    } catch (e) {
      expect(String(e.message)).not.toContain('SECRET');
    }
  });
});

describe('rpcWithFallback: reads over more than one RPC', () => {
  it('with one endpoint behaves as the call it replaces: one try, the same error text', async () => {
    const good = rig([MAIN], { [MAIN]: ok({ value: 7 }) });
    expect(await good.call('getSlot', [])).toEqual({ value: 7 });
    expect(good.asked).toEqual([{ url: MAIN, method: 'getSlot' }]);

    const busy = rig([MAIN], { [MAIN]: status(429) });
    await expect(busy.call('getMultipleAccounts', [])).rejects.toThrow('getMultipleAccounts: the RPC answered 429');
    expect(busy.asked).toHaveLength(1);
    expect(busy.busy).toEqual([]);

    const down = rig([MAIN], { [MAIN]: () => new TypeError('fetch failed') });
    await expect(down.call('getSlot', [])).rejects.toThrow('fetch failed');
  });

  it('a call the main endpoint is too busy for goes to the next at once', async () => {
    for (const main of [status(429), status(503), () => new TypeError('fetch failed'), () => new Response(JSON.stringify({ error: { code: 429, message: 'Too many requests for a specific RPC call' } }))]) {
      const r = rig([MAIN, SECOND], { [MAIN]: main, [SECOND]: ok('from the second') });
      expect(await r.call('getMultipleAccounts', [['a']])).toBe('from the second');
      expect(r.asked.map((a) => a.url)).toEqual([MAIN, SECOND]);
      expect(r.counts).toMatchObject({ calls: 1, answeredByFallback: 1 });
      expect(r.busy).toHaveLength(1);
      expect(r.busy[0].url).toBe(MAIN);
    }
  });

  it('leaves the busy one alone for RPC_REST_MS, then asks it first again', async () => {
    let mainBusy = true;
    const r = rig([MAIN, SECOND], { [MAIN]: () => (mainBusy ? status(429)() : ok('main')()), [SECOND]: ok('second') });
    expect(await r.call('getSlot', [])).toBe('second');
    r.asked.length = 0;
    // Resting: the second is asked first, the main not at all.
    expect(await r.call('getSlot', [])).toBe('second');
    expect(r.asked.map((a) => a.url)).toEqual([SECOND]);
    r.tick(RPC_REST_MS);
    mainBusy = false;
    r.asked.length = 0;
    expect(await r.call('getSlot', [])).toBe('main');
    expect(r.asked.map((a) => a.url)).toEqual([MAIN]);
    expect(r.counts.answeredByFallback).toBe(2);
  });

  it('still tries a resting endpoint last when the others fail too', async () => {
    let n = 0;
    const r = rig([MAIN, SECOND], { [MAIN]: () => (n++ === 0 ? status(429)() : ok('main, back')()), [SECOND]: status(503) });
    await expect(r.call('getSlot', [])).rejects.toThrow('getSlot: the RPC answered 429');
    // Both rest now; the next call asks them in their given order all the same.
    expect(await r.call('getSlot', [])).toBe('main, back');
  });

  it('throws the main endpoint’s own error when every endpoint is too busy', async () => {
    const r = rig([MAIN, SECOND, THIRD], { [MAIN]: status(429), [SECOND]: () => new TypeError('fetch failed'), [THIRD]: status(502) });
    await expect(r.call('getMultipleAccounts', [])).rejects.toThrow('getMultipleAccounts: the RPC answered 429');
    expect(r.asked.map((a) => a.url)).toEqual([MAIN, SECOND, THIRD]);
    expect(r.counts.busy).toEqual({ [MAIN]: 1, [SECOND]: 1, [THIRD]: 1 });
  });

  it('throws the chain’s own answer as it is: another endpoint would say the same', async () => {
    const r = rig([MAIN, SECOND], { [MAIN]: () => new Response(JSON.stringify({ error: { code: -32602, message: 'Invalid param: WrongSize' } })), [SECOND]: ok('never asked') });
    await expect(r.call('getAccountInfo', ['x'])).rejects.toThrow('getAccountInfo: Invalid param: WrongSize');
    expect(r.asked.map((a) => a.url)).toEqual([MAIN]);

    const refused = rig([MAIN, SECOND], { [MAIN]: status(403), [SECOND]: ok('never asked') });
    await expect(refused.call('getSlot', [])).rejects.toThrow('getSlot: the RPC answered 403');
    expect(refused.asked).toHaveLength(1);
  });

  it('refuses to be built with no endpoint', () => {
    expect(() => rpcWithFallback({ urls: [] })).toThrow(/no RPC endpoint/);
  });
});
