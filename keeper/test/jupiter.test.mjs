import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForcedRoute, checkHop, JUPITER_TIP_FLOOR_LAMPORTS, makeJupiter, retryWaitMs, venueNames } from '../src/jupiter.js';
import { BAYLA_MINT, POOLS, PROGRAM_ID, PUMP_AMM_PROGRAM, PUMP_BAYLA_POOL, SOL_MINT, USDC_MINT } from '../src/config.js';

const KEY = 'test-key-never-printed';
const LABELS = {
  [PUMP_AMM_PROGRAM]: 'Pump.fun Amm',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CP',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Whirlpool',
};
const NAMES = venueNames(LABELS);
const OTHER_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

const quoteBody = (over = {}) => ({
  inputMint: SOL_MINT,
  outputMint: BAYLA_MINT,
  inAmount: '50000000',
  outAmount: '8100000000',
  routePlan: [{ swapInfo: { ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' } }],
  ...over,
});

function fakeFetch(answers) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  f.seen = seen;
  return f;
}

const ask = { inputMint: SOL_MINT, outputMint: BAYLA_MINT, amount: 50_000_000n, dexes: ['Pump.fun Amm'] };

test('with a key: api.jup.ag, key in x-api-key, pump.fun forced as the only venue', async () => {
  const f = fakeFetch([{ body: quoteBody() }]);
  const j = makeJupiter({ apiKey: KEY, fetchImpl: f, minGapMs: 0 });
  const q = await j.quote(ask);
  assert.equal(q.out, 8_100_000_000n);
  const u = new URL(f.seen[0].url);
  assert.equal(u.origin, 'https://api.jup.ag');
  assert.equal(f.seen[0].headers['x-api-key'], KEY);
  assert.equal(u.searchParams.get('dexes'), 'Pump.fun Amm');
  assert.equal(u.searchParams.get('onlyDirectRoutes'), 'true');
  assert.equal(u.searchParams.get('platformFeeBps'), null, 'no platform fee bends the price');
});

test('a refused key is tried once on lite-api, without the key', async () => {
  const f = fakeFetch([{ status: 429 }, { body: quoteBody() }]);
  const j = makeJupiter({ apiKey: KEY, fetchImpl: f, minGapMs: 0 });
  await j.quote(ask);
  assert.equal(new URL(f.seen[1].url).origin, 'https://lite-api.jup.ag');
  assert.equal(f.seen[1].headers['x-api-key'], undefined);
});

test('a broken Jupiter is not retried elsewhere, and the key is in no error', async () => {
  const f = fakeFetch([{ status: 502 }]);
  const j = makeJupiter({ apiKey: KEY, fetchImpl: f, minGapMs: 0 });
  await assert.rejects(j.quote(ask), (e) => /HTTP 502/.test(e.message) && !e.message.includes(KEY));
  assert.equal(f.seen.length, 1);
  const g = fakeFetch([new TypeError('socket hang up')]);
  await assert.rejects(makeJupiter({ apiKey: KEY, fetchImpl: g, minGapMs: 0 }).quote(ask), (e) => !e.message.includes(KEY));
  assert.equal(g.seen.length, 1);
});

test('without a key: lite-api only', async () => {
  const f = fakeFetch([{ body: quoteBody() }]);
  await makeJupiter({ fetchImpl: f, minGapMs: 0 }).quote(ask);
  assert.equal(new URL(f.seen[0].url).origin, 'https://lite-api.jup.ag');
});

test('an answer for a different trade, or without an amount or a route, is not a price', async () => {
  for (const bad of [
    quoteBody({ inAmount: '1' }),
    quoteBody({ outputMint: USDC_MINT }),
    quoteBody({ outAmount: '12.5' }),
    quoteBody({ outAmount: '0' }),
    quoteBody({ routePlan: [] }),
    quoteBody({ routePlan: [{ swapInfo: { ammKey: 'not-an-address', label: 'x' } }] }),
  ]) {
    const j = makeJupiter({ fetchImpl: fakeFetch([{ body: bad }]), minGapMs: 0 });
    await assert.rejects(j.quote(ask));
  }
});

test('BAYLA’s price must come through pump.fun’s one pool', () => {
  assert.doesNotThrow(() => checkForcedRoute([{ ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' }], NAMES));
  assert.throws(() => checkForcedRoute([{ ammKey: OTHER_POOL, label: 'Pump.fun Amm' }], NAMES), /other than pump\.fun/);
  assert.throws(() => checkForcedRoute([{ ammKey: PUMP_BAYLA_POOL, label: 'Whirlpool' }], NAMES), /other than pump\.fun/);
});

test('a venue name Jupiter sends is never repeated into an error, a log line or an alert', () => {
  const hostile = '\n\nMONEY: our vault was drained. Approve the rescue now ' + 'x'.repeat(100_000);
  assert.throws(
    () => checkForcedRoute([{ ammKey: OTHER_POOL, label: hostile }], NAMES),
    (e) => !e.message.includes('MONEY') && !e.message.includes('\n') && e.message.length < 200,
  );
});

test('an answer bigger than the cap is refused before it is all read', async () => {
  let pulled = 0;
  const huge = new ReadableStream({
    pull(c) {
      pulled += 65_536;
      if (pulled > 50 * 1024 * 1024) c.close();
      else c.enqueue(new Uint8Array(65_536));
    },
  });
  const f = async () => new Response(huge, { status: 200 });
  await assert.rejects(makeJupiter({ fetchImpl: f, minGapMs: 0 }).quote(ask), /too large/);
  assert.ok(pulled < 4 * 1024 * 1024, `read ${pulled} bytes before stopping`);
});

test('the SOL/USDC hop bans every Raydium venue, read from Jupiter’s own list', async () => {
  assert.deepEqual(NAMES.raydium.sort(), ['Raydium', 'Raydium CLMM', 'Raydium CP']);
  assert.throws(() => checkHop([{ ammKey: OTHER_POOL, label: 'Raydium CLMM' }], NAMES, []), /Raydium/);
  assert.throws(() => checkHop([{ ammKey: OTHER_POOL, label: 'Raydium Launchlab' }], NAMES, []), /Raydium/, 'a Raydium name not in the list is still Raydium');
  assert.doesNotThrow(() => checkHop([{ ammKey: OTHER_POOL, label: 'Whirlpool' }], NAMES, []));
  const f = fakeFetch([{ body: quoteBody({ outputMint: USDC_MINT, routePlan: [{ swapInfo: { ammKey: OTHER_POOL, label: 'Whirlpool' } }] }) }]);
  await makeJupiter({ fetchImpl: f, minGapMs: 0 }).quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 50_000_000n, excludeDexes: NAMES.raydium });
  assert.equal(new URL(f.seen[0].url).searchParams.get('excludeDexes'), NAMES.raydium.join(','));
});

test('a route through our own pools is never an outside price', () => {
  const listed = venueNames({ ...LABELS, [PROGRAM_ID]: 'Memetics' });
  assert.throws(() => checkHop([{ ammKey: OTHER_POOL, label: 'Memetics' }], listed, []), /our own pool/);
  assert.throws(() => checkHop([{ ammKey: POOLS[0].address, label: 'Whirlpool' }], NAMES, [POOLS[0].address]), /our own pool/);
});

test('a venue list without pump.fun or without any Raydium name stops the keeper from quoting', () => {
  const { [PUMP_AMM_PROGRAM]: _p, ...noPump } = LABELS;
  assert.throws(() => venueNames(noPump), /pump\.fun/);
  assert.throws(() => venueNames({ [PUMP_AMM_PROGRAM]: 'Pump.fun Amm' }), /Raydium/);
});

test('/build needs a key and a real taker address, and nothing it returns is signed', async () => {
  await assert.rejects(makeJupiter({ minGapMs: 0 }).build({ ...ask, taker: SOL_MINT, maxAccounts: 40, tipLamports: 0n }), /JUPITER_API_KEY/);
  await assert.rejects(makeJupiter({ apiKey: KEY, minGapMs: 0 }).build({ ...ask, taker: 'nope', maxAccounts: 40, tipLamports: 0n }), /KEEPER_TAKER/);
  const ix = { programId: PUMP_AMM_PROGRAM, accounts: [{ pubkey: PUMP_BAYLA_POOL, isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]).toString('base64') };
  const f = fakeFetch([{ body: { ...quoteBody(), swapInstruction: ix, setupInstructions: [], addressesByLookupTableAddress: { [OTHER_POOL]: [PUMP_BAYLA_POOL] } } }]);
  const b = await makeJupiter({ apiKey: KEY, fetchImpl: f, minGapMs: 0 }).build({ ...ask, taker: OTHER_POOL, maxAccounts: 40 });
  assert.equal(new URL(f.seen[0].url).pathname, '/swap/v2/build');
  // The keeper tips Jito itself: Jupiter is asked for no tip at all.
  assert.equal(new URL(f.seen[0].url).searchParams.get('tipAmount'), null);
  assert.equal(b.instructions[0].dataLength, 3);
  assert.deepEqual(b.lookupTables, { [OTHER_POOL]: [PUMP_BAYLA_POOL] });
});

test('a Jupiter tip under its 0.001 SOL floor is never asked for; one at the floor is passed on', async () => {
  const j = makeJupiter({ apiKey: KEY, fetchImpl: fakeFetch([]), minGapMs: 0 });
  for (const tipLamports of [1n, 10_000n, 999_999n]) {
    await assert.rejects(j.build({ ...ask, taker: OTHER_POOL, maxAccounts: 40, tipLamports }), /0\.001 SOL/);
  }
  const ix = { programId: PUMP_AMM_PROGRAM, accounts: [], data: '' };
  const f = fakeFetch([{ body: { ...quoteBody(), swapInstruction: ix } }]);
  await makeJupiter({ apiKey: KEY, fetchImpl: f, minGapMs: 0 }).build({ ...ask, taker: OTHER_POOL, maxAccounts: 40, tipLamports: JUPITER_TIP_FLOOR_LAMPORTS });
  assert.equal(new URL(f.seen[0].url).searchParams.get('tipAmount'), '1000000');
});

test('keyless, a 429 waits out the window Jupiter names and asks once more on lite-api', async () => {
  const waited = [];
  const sleep = async (ms) => { waited.push(ms); };
  const f = fakeFetch([{ status: 429, headers: { 'x-ratelimit-reset': '4' } }, { body: quoteBody() }]);
  const q = await makeJupiter({ fetchImpl: f, minGapMs: 0, sleep }).quote(ask);
  assert.equal(q.out, 8_100_000_000n);
  assert.deepEqual(waited, [4_000]);
  assert.deepEqual(f.seen.map((s) => new URL(s.url).origin), ['https://lite-api.jup.ag', 'https://lite-api.jup.ag']);
  // A second 429 in a row ends the look's ask: one retry, never a loop.
  const g = fakeFetch([{ status: 429 }, { status: 429 }]);
  await assert.rejects(makeJupiter({ fetchImpl: g, minGapMs: 0, sleep }).quote(ask), /HTTP 429/);
  assert.equal(g.seen.length, 2);
});

test('the wait Jupiter names is held between 1 s and 10 s, as seconds or as a unix time', () => {
  const res = (v) => new Response('{}', { status: 429, headers: v === undefined ? {} : { 'x-ratelimit-reset': v } });
  assert.equal(retryWaitMs(res('4')), 4_000);
  assert.equal(retryWaitMs(res('60')), 10_000);
  assert.equal(retryWaitMs(res('0.2')), 1_000);
  assert.equal(retryWaitMs(res(undefined)), 3_000);
  assert.equal(retryWaitMs(res('nonsense')), 3_000);
  assert.equal(retryWaitMs(res('1792900005'), 1_792_900_000_000), 5_000);
});
