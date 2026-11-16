// @vitest-environment node
import { createServer } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { Connection } from '@solana/web3.js';
import { ANSWER_MS, RPC_REST_MS, fallbackUrls, fetchWithin, rpcWithFallback } from './rpc-fallback.mjs';

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

describe('rpcWithFallback: a fallback that will not answer a call (publicnode, 2026-11-14: at most 10 accounts a read)', () => {
  // publicnode's own answer to a read of more than 10 accounts, status 403, as read 2026-11-14 08:07Z.
  const CAP_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'A maximum of 10 accounts is allowed. No limit on a dedicated node: https://www.allnodes.com/sol/host/full-node' }, id: 1 });
  const keys = (n) => Array.from({ length: n }, (_, i) => `K${i}`);
  /**
   * MAIN answers `main()` each call; SECOND answers reads of at most `cap` accounts with one value
   * a key ("v:<key>") at slot `slotOf(call number)`, and larger ones as publicnode does.
   */
  function capped({ main, cap = 10, slotOf = () => 500, secondFails = () => false, secondShort = () => false, capStatus = 403 }) {
    let clock = 9_000_000;
    const asked = [];
    const said = { busy: [], caps: [] };
    let secondCalls = 0;
    const r = rpcWithFallback({
      urls: [MAIN, SECOND],
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        const n = Array.isArray(body.params?.[0]) ? body.params[0].length : 0;
        asked.push({ url, n });
        if (url === MAIN) {
          const a = main();
          if (a instanceof Error) throw a;
          return a;
        }
        const call = secondCalls++;
        if (secondFails(call)) return new Response('{}', { status: 503 });
        if (n > cap) return new Response(CAP_BODY, { status: capStatus });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { apiVersion: 'x', slot: slotOf(call) }, value: body.params[0].map((k) => `v:${k}`).slice(secondShort(call) ? 1 : 0) } }));
      },
      now: () => clock,
      onBusy: (url, why) => said.busy.push({ url, why }),
      onCap: (url, n) => said.caps.push({ url, n }),
    });
    return { ...r, asked, said, tick: (ms) => (clock += ms) };
  }
  const read = (r, n) => r.call('getMultipleAccounts', [keys(n), { encoding: 'base64', commitment: 'confirmed' }]);

  it('splits a read larger than the endpoint takes into reads of that size, back together in order under the lowest slot', async () => {
    // The parts answer at slots 502, 500 and 501.
    const r = capped({ main: status(429), slotOf: (call) => [0, 502, 500, 501][call] ?? 600 });
    const got = await read(r, 25);
    expect(got.value).toEqual(keys(25).map((k) => `v:${k}`));
    expect(got.context).toEqual({ apiVersion: 'x', slot: 500 });
    // The main one (busy), the whole read refused once, then 10 + 10 + 5.
    expect(r.asked).toEqual([{ url: MAIN, n: 25 }, { url: SECOND, n: 25 }, { url: SECOND, n: 10 }, { url: SECOND, n: 10 }, { url: SECOND, n: 5 }]);
    expect(r.said.caps).toEqual([{ url: SECOND, n: 10 }]);
    expect(r.counts).toMatchObject({ answeredByFallback: 1, splitReads: 1 });
    // The fallback was not set to rest: it answered.
    expect(r.said.busy.map((b) => b.url)).toEqual([MAIN]);
  });

  it('remembers the size: the next large read is split at once, and a small one is not split at all', async () => {
    const r = capped({ main: status(429) });
    await read(r, 25);
    r.asked.length = 0;
    // The main one rests, so the fallback is asked first: straight to 10 + 10 + 10 + 2, no refusal first.
    expect((await read(r, 32)).value).toHaveLength(32);
    expect(r.asked).toEqual([{ url: SECOND, n: 10 }, { url: SECOND, n: 10 }, { url: SECOND, n: 10 }, { url: SECOND, n: 2 }]);
    expect(r.said.caps).toHaveLength(1);
    r.asked.length = 0;
    expect((await read(r, 10)).value).toHaveLength(10);
    expect(r.asked).toEqual([{ url: SECOND, n: 10 }]);
  });

  it('learns the size from a refusal sent with status 200 too', async () => {
    const r = capped({ main: status(429), capStatus: 200 });
    expect((await read(r, 11)).value).toHaveLength(11);
    expect(r.caps.get(SECOND)).toBe(10);
  });

  it('a part the fallback is too busy for fails the split there: it rests and the main endpoint is asked again', async () => {
    let mainCalls = 0;
    // The main one: busy once, then back. The fallback: the whole read refused (call 0), then its second part busy (call 2).
    const r = capped({ main: () => (mainCalls++ === 0 ? status(429)() : ok({ context: { slot: 700 }, value: ['from the main one'] })()), secondFails: (call) => call === 2 });
    await expect(read(r, 25)).rejects.toThrow('getMultipleAccounts: the RPC answered 429');
    // Both rest now; the next read asks them in their given order, and the main one is back.
    expect((await read(r, 25)).value).toEqual(['from the main one']);
    expect(r.said.busy.map((b) => b.url)).toEqual([MAIN, SECOND]);
  });

  it('never puts a split read together from a part that came back short: the fallback rests and the main endpoint is asked again', async () => {
    let mainCalls = 0;
    // The fallback's third part (its call 3) answers with one account fewer than asked.
    const r = capped({ main: () => (mainCalls++ === 0 ? status(429)() : ok({ context: { slot: 700 }, value: ['from the main one'] })()), secondShort: (call) => call === 3 });
    await expect(read(r, 25)).rejects.toThrow('getMultipleAccounts: the RPC answered 429');
    expect(r.said.busy.map((b) => b.url)).toEqual([MAIN, SECOND]);
    expect(r.said.busy[1].why).toBe('refused the call: getMultipleAccounts: a split read came back short');
    expect((await read(r, 25)).value).toEqual(['from the main one']);
  });

  it('a fallback’s refusal is never the read’s answer: the resting main endpoint is asked last, and answers', async () => {
    let mainCalls = 0;
    const r = rig([MAIN, SECOND], { [MAIN]: () => (mainCalls++ === 0 ? status(429)() : ok('the main one, back')()), [SECOND]: status(403) });
    // First call: the main one busy, the fallback refuses (no size said): thrown as the main one's own error.
    await expect(r.call('getSlot', [])).rejects.toThrow('getSlot: the RPC answered 429');
    expect(r.busy.map((b) => b.url)).toEqual([MAIN, SECOND]);
    expect(r.busy[1].why).toBe('refused the call: getSlot: the RPC answered 403');
    // Both rest; the next call reaches the main one, which is back.
    expect(await r.call('getSlot', [])).toBe('the main one, back');
  });

  it('with the main endpoint resting and the fallback refusing, the call still reaches the main one', async () => {
    let mainCalls = 0;
    let secondRefuses = false;
    const r = rig([MAIN, SECOND], { [MAIN]: () => (mainCalls++ === 0 ? status(429)() : ok('main')()), [SECOND]: () => (secondRefuses ? status(403)() : ok('second')()) });
    expect(await r.call('getSlot', [])).toBe('second');
    // The main one rests; the fallback, asked first, now refuses: the main one is asked last and answers.
    secondRefuses = true;
    r.asked.length = 0;
    expect(await r.call('getSlot', [])).toBe('main');
    expect(r.asked.map((a) => a.url)).toEqual([SECOND, MAIN]);
  });

  it('a JSON-RPC error from a fallback is not the answer either, where the main endpoint’s own still is', async () => {
    const tokenNeeded = () => new Response(JSON.stringify({ error: { code: -32602, message: 'Indexed requests require a personal token.' } }));
    let mainCalls = 0;
    const r = rig([MAIN, SECOND], { [MAIN]: () => (mainCalls++ === 0 ? status(429)() : ok(['pools'])()), [SECOND]: tokenNeeded });
    await expect(r.call('getProgramAccounts', ['P'])).rejects.toThrow('getProgramAccounts: the RPC answered 429');
    expect(await r.call('getProgramAccounts', ['P'])).toEqual(['pools']);
    const mainRefuses = rig([MAIN, SECOND], { [MAIN]: tokenNeeded, [SECOND]: ok('never asked') });
    await expect(mainRefuses.call('getProgramAccounts', ['P'])).rejects.toThrow('getProgramAccounts: Indexed requests require a personal token.');
    expect(mainRefuses.asked).toHaveLength(1);
  });
});

// Real endpoints on this computer and the real fetch, as the robot runs.
const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});
/** A JSON-RPC endpoint on this computer: `answer(call, res)` answers it, or does not. */
async function endpoint(answer) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => answer(JSON.parse(body || 'null'), res));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const e = {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
  open.push(e);
  return e;
}
const never = () => {};
/** The headers and half the body, then nothing more. */
const halfway = (_call, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"jsonrpc":"2.0","id":1,"result":');
};
const answers = (result) => (_call, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const LIMIT = 300;
const POST = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };

describe('rpcWithFallback: a read an endpoint takes and never answers (the robot, 2026-11-16 01:52Z)', () => {
  for (const [what, stuckOne] of [
    ['takes the call and never answers', never],
    ['sends half an answer, then nothing', halfway],
  ]) {
    it(`a main endpoint that ${what}: the read goes to the next one within the limit`, async () => {
      const stuck = await endpoint(stuckOne);
      const second = await endpoint(answers({ value: 'from the second' }));
      const busy = [];
      const r = rpcWithFallback({ urls: [stuck.url, second.url], answerMs: LIMIT, onBusy: (url, why) => busy.push({ url, why }) });
      const started = Date.now();
      expect(await r.call('getMultipleAccounts', [['a']])).toEqual({ value: 'from the second' });
      expect(Date.now() - started).toBeLessThan(LIMIT + 2_000);
      expect(busy).toEqual([{ url: stuck.url, why: 'no answer in 0.3 s' }]);
      expect(r.counts).toMatchObject({ calls: 1, answeredByFallback: 1 });
    }, 10_000);
  }

  it('with one endpoint, a read it never answers throws within the limit, naming the call', async () => {
    const stuck = await endpoint(never);
    const r = rpcWithFallback({ urls: [stuck.url], answerMs: LIMIT });
    const started = Date.now();
    await expect(r.call('getLatestBlockhash', [])).rejects.toThrow('getLatestBlockhash: no answer in 0.3 s');
    expect(Date.now() - started).toBeLessThan(LIMIT + 2_000);
  }, 10_000);

  it('every endpoint stuck: one limit each, then the main one’s own error', async () => {
    const first = await endpoint(never);
    const second = await endpoint(halfway);
    const r = rpcWithFallback({ urls: [first.url, second.url], answerMs: LIMIT });
    const started = Date.now();
    await expect(r.call('getSlot', [])).rejects.toThrow('getSlot: no answer in 0.3 s');
    expect(Date.now() - started).toBeLessThan(2 * LIMIT + 2_000);
    expect(r.counts.busy).toEqual({ [first.url]: 1, [second.url]: 1 });
  }, 10_000);

  it('an answer within the limit is the answer, as before', async () => {
    const quick = await endpoint(answers(42));
    const r = rpcWithFallback({ urls: [quick.url], answerMs: LIMIT });
    expect(await r.call('getSlot', [])).toBe(42);
  });

  it('the robot’s reads wait ANSWER_MS at most: well above a normal read (up to ~5 s), far below the 11.7 min stall', () => {
    expect(ANSWER_MS).toBe(10_000);
  });
});

describe('fetchWithin: every other request of the robot ends too (its Connection, Jupiter, the site, Jito)', () => {
  it('a request never answered is aborted at the limit, saying so', async () => {
    const stuck = await endpoint(never);
    const started = Date.now();
    await expect(fetchWithin(LIMIT)(stuck.url, POST)).rejects.toThrow('no answer in 0.3 s');
    expect(Date.now() - started).toBeLessThan(LIMIT + 2_000);
  }, 10_000);

  it('the limit holds while the body is read too', async () => {
    const half = await endpoint(halfway);
    const res = await fetchWithin(LIMIT)(half.url, POST);
    await expect(res.text()).rejects.toThrow('no answer in 0.3 s');
  }, 10_000);

  it('an answer within the limit is untouched, and a caller’s own signal still ends a request first', async () => {
    const quick = await endpoint(answers(42));
    expect(await (await fetchWithin(LIMIT)(quick.url, POST)).json()).toEqual({ jsonrpc: '2.0', id: 1, result: 42 });
    const stuck = await endpoint(never);
    const mine = new AbortController();
    const asked = fetchWithin(60_000)(stuck.url, { ...POST, signal: mine.signal });
    mine.abort(new Error('the caller gave up'));
    await expect(asked).rejects.toThrow('the caller gave up');
  }, 10_000);

  it('web3.js asks through it: the robot’s Connection over an RPC that never answers throws at the limit', async () => {
    const stuck = await endpoint(never);
    const conn = new Connection(stuck.url, { commitment: 'confirmed', fetch: fetchWithin(LIMIT) });
    const started = Date.now();
    await expect(conn.getLatestBlockhash()).rejects.toThrow('no answer in 0.3 s');
    await expect(conn.sendRawTransaction(Uint8Array.from([1, 2, 3]))).rejects.toThrow('no answer in 0.3 s');
    expect(Date.now() - started).toBeLessThan(2 * LIMIT + 2_000);
  }, 10_000);
});
