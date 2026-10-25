// The alarm: healthchecks.io pings, as the venue's other jobs send them (scripts/ops), on two
// checks. A ping counts only when healthchecks.io answers exactly "OK". The dead-man gets an ok
// every tick whatever happens; the alerts check fails when the batcher stopped, when no round has
// reached a source for 10 minutes, while the last three batches never reached a block, or for
// what it alerted on (one such fail an hour at most; one that does not get through is tried
// again). A new reason while it is DOWN flips it first, so every new reason is an email. Every
// body is scrubbed; the URL is never logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERTS_PING_ENV, Heartbeat, PING_ENV, clampBody, pingTarget, resolvePingUrl, sendPing, type HeartbeatConfig, type PingKind } from '../src/heartbeat.ts';

const ALIVE = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-ALIVE';
const ALERTS = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-ALERTS';
const MIN = 60_000;

test('the ping URLs: https only, no user name or password, never echoed when wrong; the three kinds of ping', () => {
  assert.deepEqual(resolvePingUrl({}), { url: null, problem: 'unset' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: 'http://hc-ping.invalid/x' }), { url: null, problem: 'not https' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: 'not a url SECRET' }), { url: null, problem: 'not a URL' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: 'https://user:pass@hc-ping.invalid/x' }), { url: null, problem: 'carrying a user name or password' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: `${ALIVE}/` }), { url: ALIVE, problem: null });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: ALIVE, [ALERTS_PING_ENV]: ALERTS }, ALERTS_PING_ENV), { url: ALERTS, problem: null });
  assert.equal(pingTarget(ALIVE, 'start'), `${ALIVE}/start`);
  assert.equal(pingTarget(ALIVE, 'fail'), `${ALIVE}/fail`);
  assert.equal(pingTarget(ALIVE, 'ok'), ALIVE);
  assert.ok(clampBody('x'.repeat(20_000)).length < 10_001);
});

test('a ping is a POST of plain text, clamped; it retries, says why it failed without the URL, and a hung one is cut off', async () => {
  let calls = 0;
  const failing = (async () => {
    calls++;
    throw new TypeError('fetch failed for the host');
  }) as unknown as typeof fetch;
  const r = await sendPing({ url: ALIVE, kind: 'ok', fetchImpl: failing, sleep: async () => {} });
  assert.equal(calls, 3);
  assert.equal(r.ok, false);
  assert.ok(!String(r.error).includes('SECRET'));
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = await sendPing({ url: ALIVE, kind: 'fail', body: 'y'.repeat(20_000), fetchImpl: (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('OK', { status: 200 }))) as unknown as typeof fetch, sleep: async () => {} });
  assert.deepEqual(ok, { ok: true, status: 200 });
  assert.equal(seen[0]!.url, `${ALIVE}/fail`);
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal((seen[0]!.init.headers as Record<string, string>)['Content-Type'], 'text/plain; charset=utf-8');
  assert.ok(Buffer.byteLength(String(seen[0]!.init.body)) <= 10_000);
  // A server that never answers: each attempt ends at the timeout.
  const hung = ((_: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
  const t = await sendPing({ url: ALIVE, kind: 'ok', fetchImpl: hung, timeoutMs: 20, sleep: async () => {} });
  assert.equal(t.ok, false);
  assert.match(String(t.error), /^TimeoutError/);
});

test('a 200 is not enough: a check that does not exist answers "OK (not found)", a rate-limited ping "OK (rate limited)"; both are failures', async () => {
  for (const said of ['OK (not found)', 'OK (rate limited)', '']) {
    let calls = 0;
    const r = await sendPing({ url: ALIVE, kind: 'start', fetchImpl: (async () => (calls++, new Response(said, { status: 200 }))) as unknown as typeof fetch, sleep: async () => {} });
    assert.deepEqual(r, { ok: false, status: 200, error: `answered "${said}"` });
    assert.equal(calls, 3, 'retried');
  }
  const r = await sendPing({ url: ALIVE, kind: 'start', fetchImpl: (async () => new Response('OK\n', { status: 200 })) as unknown as typeof fetch, sleep: async () => {} });
  assert.deepEqual(r, { ok: true, status: 200 });
});

function rig(over: Partial<HeartbeatConfig> = {}) {
  let now = 0;
  const pings: { check: 'alive' | 'alerts'; kind: PingKind; body: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  let failing: ((p: { url: string; kind: PingKind }) => boolean) | null = null;
  const hb = new Heartbeat(
    {
      alive: ALIVE,
      alerts: ALERTS,
      everyMs: 5 * MIN,
      quietMs: 10 * MIN,
      alertGapMs: 60 * MIN,
      dryRun: false,
      now: () => now,
      send: async (p) => {
        pings.push({ check: p.url === ALIVE ? 'alive' : 'alerts', kind: p.kind, body: p.body });
        if (failing?.(p)) return { ok: false, error: over.scrub ? 'fetch failed: dmtr_secret.demeter.run' : 'HTTP 503' };
        return { ok: true, status: 200 };
      },
      ...over,
    },
    (e) => logs.push(e as Record<string, unknown>),
  );
  const of = (check: 'alive' | 'alerts') => pings.filter((p) => p.check === check);
  return { hb, pings, logs, of, at: (m: number) => (now = m * MIN), fail: (f: typeof failing) => (failing = f) };
}

test('healthy: both checks start, then both ok with what it did since the last report; the counts start again each report', async () => {
  const { hb, of, at } = rig();
  assert.equal(await hb.start(), true);
  hb.observe({ kind: 'idle', source: 'ogmios+kupo', slot: 1n, orders: 0 });
  hb.observe({ kind: 'sent', txId: 'ab'.repeat(32), pool: 'p', orders: ['x#0'], fee: 690_931n });
  hb.observe({ kind: 'sent', txId: 'cd'.repeat(32), pool: 'p', orders: ['y#0'], fee: 700_000n });
  hb.observe({ kind: 'wallet', held: 30_000_000n, cap: 100_000_000n });
  at(5);
  hb.tick();
  at(10);
  hb.observe({ kind: 'refused', pool: 'p', error: 'x', inARow: 1, benign: true });
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alive').map((p) => p.kind), ['start', 'ok', 'ok']);
  assert.deepEqual(of('alerts').map((p) => p.kind), ['start', 'ok', 'ok']);
  assert.equal(of('alive')[0]!.body, 'the batcher started, signing');
  assert.match(of('alive')[1]!.body, /^working\n/);
  assert.match(of('alive')[1]!.body, /since the last report: 0 batches prepared, 2 sent, 1390931 lovelace in network fees/);
  assert.match(of('alive')[1]!.body, /wallet: 30000000 lovelace, its cap 100000000/);
  assert.match(of('alive')[2]!.body, /0 batches prepared, 0 sent, 0 lovelace/);
  assert.match(of('alive')[2]!.body, /last round: a batch refused at submission \(pool p\)/);
  assert.equal(of('alerts')[1]!.body, of('alive')[1]!.body);
});

test('a dry run says so at start, in every report, and in every fail', async () => {
  const { hb, of, at } = rig({ dryRun: true });
  void hb.start();
  hb.observe({ kind: 'prepared', source: 'koios', pool: 'p', orders: ['a#0', 'b#0'], fee: 1n, dryRun: true });
  at(5);
  hb.tick();
  hb.observe({ kind: 'alert', reason: 'something' });
  await hb.flush();
  assert.equal(of('alive')[0]!.body, 'the batcher started: a dry run, it signs nothing');
  assert.match(of('alive')[1]!.body, /^DRY RUN, signing nothing\. working\n.*last round: prepared 2 orders via koios \(dry run\)\n.*1 batches prepared, 0 sent/s);
  assert.equal(of('alerts').at(-1)!.body, 'DRY RUN, signing nothing. ALERT (1):\nsomething');
});

test('every kind of round that reached a source keeps it healthy; a source down does not', async () => {
  const rounds = [
    { kind: 'idle', source: 'koios', slot: 1n, orders: 0 },
    { kind: 'prepared', source: 'koios', pool: 'p', orders: ['a#0'], fee: 1n, dryRun: false },
    { kind: 'refused', pool: 'p', error: 'x', inARow: 1, benign: false },
    { kind: 'inputs-gone', source: 'koios', error: 'spent' },
    { kind: 'sent', txId: 'ab'.repeat(32), pool: 'p', orders: ['a#0'], fee: 1n },
    { kind: 'set-aside', ref: 'a#0', reason: 'too big', alert: false },
  ] as const;
  for (const e of rounds) {
    const { hb, of, at } = rig();
    at(9);
    hb.observe(e);
    at(10);
    hb.tick();
    await hb.flush();
    assert.deepEqual(of('alerts').map((p) => p.kind), ['ok'], e.kind);
  }
  const { hb, of, at } = rig();
  at(9);
  hb.observe({ kind: 'source-down', source: 'koios', error: 'down' });
  at(10);
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail']);
});

test('a stop: the alerts check fails at once, flipped first when it was DOWN for an alert, then on every tick after; held alerts join it on the hour; the dead-man stays ok', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.observe({ kind: 'alert', reason: 'first' });
  at(20);
  hb.observe({ kind: 'alert', reason: 'held one' });
  hb.observe({ kind: 'stopped', reason: 'the batcher holds 120000000 lovelace, above its cap', fatal: false });
  at(25);
  hb.tick();
  at(30);
  hb.tick();
  await hb.flush();
  // DOWN for "first": the stop is a new reason, so an ok first (healthchecks.io emails only on a change).
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail', 'ok', 'fail', 'fail', 'fail']);
  assert.equal(of('alerts')[1]!.body, 'not recovered: a new problem follows');
  assert.equal(of('alerts')[2]!.body, 'STOPPED: the batcher holds 120000000 lovelace, above its cap');
  assert.equal(of('alerts')[3]!.body, 'STOPPED: the batcher holds 120000000 lovelace, above its cap');
  assert.deepEqual(of('alive').map((p) => p.kind), ['ok', 'ok']);
  assert.match(of('alive')[0]!.body, /^STOPPED: the batcher holds/);
  at(60);
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alerts').slice(-2).map((p) => [p.kind, p.body]), [['ok', 'not recovered: a new problem follows'], ['fail', 'STOPPED: the batcher holds 120000000 lovelace, above its cap\nALERT (1):\nheld one']]);
  const fatal = rig();
  fatal.hb.observe({ kind: 'stopped', reason: 'EMURGO', fatal: true });
  await fatal.hb.flush();
  assert.equal(fatal.of('alerts')[0]!.body, 'STOPPED (fatal: the process restarts): EMURGO');
});

test('no round reaching a source for 10 minutes fails the alerts check, saying the last problem; the dead-man stays ok; a round makes it ok again', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.observe({ kind: 'source-down', source: 'ogmios+kupo', error: 'down' });
  at(5);
  hb.tick();
  at(10);
  hb.tick();
  hb.observe({ kind: 'inputs-gone', source: 'koios', error: 'spent meanwhile' });
  at(15);
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['ok', 'fail', 'ok']);
  assert.equal(of('alerts')[1]!.body, 'no round has reached a source for 10 minutes (the last problem: ogmios+kupo: down)');
  assert.deepEqual(of('alive').map((p) => p.kind), ['ok', 'ok', 'ok']);
});

test('alerts: the first fails at once; more within the hour wait, then go together; one arriving at the hour goes at once; a quiet set-aside is no alert', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.observe({ kind: 'set-aside', ref: 'a#0', reason: 'too big alone', alert: false });
  hb.observe({ kind: 'set-aside', ref: 'b#0', reason: 'the node refused it: 3012', alert: true });
  hb.observe({ kind: 'alert', reason: '5 orders in a row were refused' });
  hb.observe({ kind: 'error', error: 'something unforeseen' });
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail']);
  assert.equal(of('alerts')[0]!.body, 'ALERT (1):\nset aside b#0: the node refused it: 3012');
  at(5);
  hb.tick();
  await hb.flush();
  assert.equal(of('alerts').at(-1)!.kind, 'ok');
  assert.match(of('alive').at(-1)!.body, /alerts held back .*: 2/);
  at(55);
  hb.observe({ kind: 'idle', source: 'koios', slot: 2n, orders: 0 });
  at(60);
  hb.tick();
  await hb.flush();
  assert.equal(of('alerts').at(-1)!.kind, 'fail');
  assert.equal(of('alerts').at(-1)!.body, 'ALERT (2):\n5 orders in a row were refused\nerror: something unforeseen');
  // Exactly an hour after that one, an alert goes out as it arrives.
  at(120);
  hb.observe({ kind: 'alert', reason: 'on the hour' });
  await hb.flush();
  assert.equal(of('alerts').at(-1)!.body, 'ALERT (1):\non the hour');
  assert.ok(!of('alerts').some((p) => p.body.includes('a#0')), 'a quiet set-aside raised an alert');
});

test('a new reason while DOWN flips the check first; the same reason again does not', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  at(10);
  hb.tick();
  at(15);
  hb.tick();
  hb.observe({ kind: 'idle', source: 'koios', slot: 2n, orders: 0 });
  hb.observe({ kind: 'stopped', reason: 'refused 5 in a row', fatal: false });
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail', 'fail', 'ok', 'fail']);
  assert.match(of('alerts')[0]!.body, /^no round has reached a source/);
  assert.equal(of('alerts')[3]!.body, 'STOPPED: refused 5 in a row');
  // Once a healthy report has set it UP, a new reason needs no flip: its fail is the change.
  const up = rig();
  up.hb.observe({ kind: 'alert', reason: 'first' });
  up.at(5);
  up.hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  up.hb.tick();
  up.hb.observe({ kind: 'stopped', reason: 'refused 5 in a row', fatal: false });
  await up.hb.flush();
  assert.deepEqual(up.of('alerts').map((p) => p.kind), ['fail', 'ok', 'fail']);
  assert.ok(!up.of('alerts').some((p) => p.body.startsWith('not recovered')));
});

test('the last three batches sent never reaching a block fail the alerts check on every tick, until one lands', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  for (const n of [1, 2]) hb.observe({ kind: 'unlanded', txId: 'aa'.repeat(32), validToSlot: 1n, inARow: n });
  at(5);
  hb.tick();
  hb.observe({ kind: 'unlanded', txId: 'aa'.repeat(32), validToSlot: 1n, inARow: 3 });
  hb.observe({ kind: 'idle', source: 'koios', slot: 2n, orders: 0 });
  at(9);
  hb.observe({ kind: 'idle', source: 'koios', slot: 3n, orders: 0 });
  at(10);
  hb.tick();
  at(14);
  hb.observe({ kind: 'unlanded', txId: 'aa'.repeat(32), validToSlot: 1n, inARow: 4 });
  hb.observe({ kind: 'idle', source: 'koios', slot: 4n, orders: 0 });
  at(15);
  hb.tick();
  hb.observe({ kind: 'landed', txId: 'bb'.repeat(32), slot: 5n });
  hb.observe({ kind: 'idle', source: 'koios', slot: 5n, orders: 0 });
  at(20);
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['ok', 'fail', 'fail', 'ok']);
  assert.match(of('alerts')[1]!.body, /^the last 3 batches sent never reached a block/);
  assert.match(of('alerts')[2]!.body, /^the last 4 batches sent/);
});

test('alerts raised during a quiet spell wait for the hour: no email on every tick', async () => {
  const { hb, of, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.observe({ kind: 'alert', reason: 'one' });
  for (let m = 10; m <= 50; m += 5) {
    at(m);
    hb.observe({ kind: 'error', error: `round ${m}` });
    hb.tick();
  }
  await hb.flush();
  // The alert at 0, then the quiet fail from minute 10 (a new reason: one flip), then the same quiet: no more flips.
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail', 'ok', ...Array(9).fill('fail')]);
  assert.ok(of('alerts').slice(2).every((p) => /^no round has reached a source/.test(p.body) && !p.body.includes('ALERT')));
  at(60);
  hb.tick();
  await hb.flush();
  assert.match(of('alerts').at(-1)!.body, /^no round has reached a source .*\nALERT \(9\):\nerror: round 10\n/s);
});

test('an alert whose fail does not get through is held, and goes at the next tick', async () => {
  const { hb, of, at, fail } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  fail((p) => p.kind === 'fail');
  hb.observe({ kind: 'alert', reason: 'our engine and the contract disagree' });
  await hb.flush();
  fail(null);
  at(5);
  hb.tick();
  await hb.flush();
  assert.deepEqual(of('alerts').map((p) => p.kind), ['fail', 'fail']);
  assert.equal(of('alerts')[1]!.body, 'ALERT (1):\nour engine and the contract disagree');
});

test('at exit, alerts still held back go out; a flush alone sends nothing new', async () => {
  const { hb, of } = rig();
  hb.observe({ kind: 'alert', reason: 'one' });
  hb.observe({ kind: 'alert', reason: 'two' });
  await hb.flush();
  assert.equal(of('alerts').length, 1);
  await hb.close();
  // DOWN for "one": the held one flips it first, so it is an email of its own.
  assert.deepEqual(of('alerts').map((p) => [p.kind, p.body]), [['fail', 'ALERT (1):\none'], ['ok', 'not recovered: a new problem follows'], ['fail', 'ALERT (1):\ntwo']]);
});

test('a flood of alerts in an hour: the first hundred kept, the rest counted', async () => {
  const { hb, of } = rig();
  for (let i = 0; i < 151; i++) hb.observe({ kind: 'alert', reason: `a${i}` });
  await hb.close();
  const body = of('alerts').at(-1)!.body;
  assert.match(body, /^ALERT \(150\):\na1\n/);
  assert.match(body, /\na100\n\(and 50 more\)$/);
});

test('pings go one at a time, in order; flush waits for every one', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hb = new Heartbeat(
    {
      alive: ALIVE,
      alerts: ALERTS,
      everyMs: 5 * MIN,
      quietMs: 10 * MIN,
      alertGapMs: 60 * MIN,
      dryRun: false,
      now: () => 0,
      send: async (p) => {
        order.push(`${p.url === ALIVE ? 'alive' : 'alerts'}:${p.kind}:start`);
        if (order.length === 1) await gate;
        order.push(`${p.url === ALIVE ? 'alive' : 'alerts'}:${p.kind}:end`);
        return { ok: true };
      },
    },
    () => {},
  );
  void hb.start();
  let flushed = false;
  const f = hb.flush().then(() => (flushed = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false);
  assert.deepEqual(order, ['alive:start:start']);
  release();
  await f;
  assert.deepEqual(order, ['alive:start:start', 'alive:start:end', 'alerts:start:start', 'alerts:start:end']);
});

test('every body and every ping error logged is scrubbed; the URL is never logged', async () => {
  const { hb, pings, logs, fail } = rig({ scrub: (t) => t.replaceAll('dmtr_secret', '[redacted]') });
  fail(() => true);
  hb.observe({ kind: 'error', error: 'connect to dmtr_secret.demeter.run failed' });
  await hb.flush();
  assert.equal(pings[0]!.body, 'ALERT (1):\nerror: connect to [redacted].demeter.run failed');
  assert.deepEqual(logs, [{ kind: 'heartbeat-failed', check: 'alerts', ping: 'fail', error: 'fetch failed: [redacted].demeter.run' }]);
  assert.ok(!JSON.stringify(logs).includes('SECRET') && !JSON.stringify(logs).includes('dmtr_secret'));
  const start = rig();
  start.fail((p) => p.url === ALERTS);
  assert.equal(await start.hb.start(), false, 'a start not answered by both checks');
});

test('with no ping URL nothing is sent, and the start says, once, that no alarm (or no alert) will reach anyone', async () => {
  const logs: Record<string, unknown>[] = [];
  let sent = 0;
  const hb = new Heartbeat({ alive: null, alerts: null, everyMs: 5 * MIN, quietMs: 10 * MIN, alertGapMs: 60 * MIN, dryRun: true, send: async () => (sent++, { ok: true }) }, (e) => logs.push(e as Record<string, unknown>));
  assert.equal(await hb.start(), true);
  hb.tick();
  hb.fail('x');
  await hb.close();
  assert.equal(sent, 0);
  assert.deepEqual(logs, [{ kind: 'heartbeat-off', reason: `${PING_ENV} and ${ALERTS_PING_ENV}: not set up, so no alarm will reach anyone` }]);
  const half: Record<string, unknown>[] = [];
  void new Heartbeat({ alive: ALIVE, alerts: null, everyMs: 5 * MIN, quietMs: 10 * MIN, alertGapMs: 60 * MIN, dryRun: true, send: async () => ({ ok: true }) }, (e) => half.push(e as Record<string, unknown>)).start();
  assert.match(String(half[0]!.reason), /^HC_PING_URL_CARDANO_BATCHER_ALERTS: not set up, so no alert will reach anyone$/);
});
