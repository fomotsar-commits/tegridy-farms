// The alarm: healthchecks.io pings, as the venue's other jobs send them (scripts/ops), and what
// the batcher says each tick: ok while it works, fail when it stopped, when no source has answered
// for 10 minutes, or for what it alerted on (one such fail an hour at most). The URL is never logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heartbeat, PING_ENV, clampBody, pingTarget, resolvePingUrl, sendPing, type PingKind } from '../src/heartbeat.ts';

const URL_ = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-UUID';
const MIN = 60_000;

test('the ping URL: https only, never echoed when wrong; the three kinds of ping', () => {
  assert.deepEqual(resolvePingUrl({}), { url: null, problem: 'unset' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: 'http://hc-ping.invalid/x' }), { url: null, problem: 'not https' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: 'not a url SECRET' }), { url: null, problem: 'not a URL' });
  assert.deepEqual(resolvePingUrl({ [PING_ENV]: `${URL_}/` }), { url: URL_, problem: null });
  assert.equal(pingTarget(URL_, 'start'), `${URL_}/start`);
  assert.equal(pingTarget(URL_, 'fail'), `${URL_}/fail`);
  assert.equal(pingTarget(URL_, 'ok'), URL_);
  assert.ok(clampBody('x'.repeat(20_000)).length < 10_001);
});

test('a ping retries, and says why it failed without the URL', async () => {
  let calls = 0;
  const failing = (async () => {
    calls++;
    throw new TypeError(`fetch failed for ${URL_}`.replace(URL_, 'the host'));
  }) as unknown as typeof fetch;
  const r = await sendPing({ url: URL_, kind: 'ok', fetchImpl: failing, sleep: async () => {} });
  assert.equal(calls, 3);
  assert.equal(r.ok, false);
  assert.ok(!String(r.error).includes('SECRET'));
  const ok = await sendPing({ url: URL_, kind: 'fail', body: 'x', fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, sleep: async () => {} });
  assert.deepEqual(ok, { ok: true, status: 200 });
});

function rig() {
  let now = 0;
  const pings: { kind: PingKind; body: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  let failNext = false;
  const hb = new Heartbeat(
    {
      url: URL_,
      everyMs: 5 * MIN,
      quietMs: 10 * MIN,
      alertGapMs: 60 * MIN,
      now: () => now,
      send: async (p) => {
        pings.push({ kind: p.kind, body: p.body });
        if (failNext) return { ok: false, error: 'HTTP 503' };
        return { ok: true, status: 200 };
      },
    },
    (e) => logs.push(e as Record<string, unknown>),
  );
  return { hb, pings, logs, at: (m: number) => (now = m * MIN), failPings: (on: boolean) => (failNext = on) };
}

test('healthy rounds: ok, with what it did; a stop: fail, and fail on every tick after', async () => {
  const { hb, pings, at } = rig();
  hb.start();
  hb.observe({ kind: 'idle', source: 'ogmios+kupo', slot: 1n, orders: 0 });
  hb.observe({ kind: 'sent', txId: 'ab'.repeat(32), pool: 'p', orders: ['x#0'], fee: 690_931n });
  at(5);
  hb.tick();
  await hb.flush();
  assert.deepEqual(pings.map((p) => p.kind), ['start', 'ok']);
  assert.match(pings[1]!.body, /1 batches, 690931 lovelace/);
  hb.observe({ kind: 'stopped', reason: 'the batcher holds 120000000 lovelace, above its cap', fatal: false });
  at(10);
  hb.tick();
  await hb.flush();
  assert.deepEqual(pings.map((p) => p.kind), ['start', 'ok', 'fail', 'fail']);
  assert.match(pings[2]!.body, /^STOPPED: .*above its cap/);
});

test('no source answering for 10 minutes is a fail; a round that reaches a source makes it ok again', async () => {
  const { hb, pings, at } = rig();
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
  assert.deepEqual(pings.map((p) => p.kind), ['ok', 'fail', 'ok']);
  assert.match(pings[1]!.body, /no source has answered for 10 minutes/);
});

test('alerts: the first fails at once; more within the hour wait, then go together; a quiet set-aside is no alert', async () => {
  const { hb, pings, at } = rig();
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.observe({ kind: 'set-aside', ref: 'a#0', reason: 'too big alone', alert: false });
  hb.observe({ kind: 'set-aside', ref: 'b#0', reason: 'the node refused it: 3012', alert: true });
  hb.observe({ kind: 'alert', reason: '5 orders in a row were refused' });
  hb.observe({ kind: 'error', error: 'something unforeseen' });
  await hb.flush();
  assert.deepEqual(pings.map((p) => p.kind), ['fail']);
  assert.match(pings[0]!.body, /b#0/);
  at(5);
  hb.tick();
  await hb.flush();
  assert.equal(pings.at(-1)!.kind, 'ok');
  assert.match(pings.at(-1)!.body, /alerts held back .*: 2/);
  at(55);
  hb.observe({ kind: 'idle', source: 'koios', slot: 2n, orders: 0 });
  at(60);
  hb.tick();
  await hb.flush();
  assert.equal(pings.at(-1)!.kind, 'fail');
  assert.match(pings.at(-1)!.body, /ALERT \(2\):\n5 orders in a row were refused\nerror: something unforeseen/);
  assert.ok(!pings.some((p) => p.body.includes('a#0')), 'a quiet set-aside raised an alert');
});

test('a ping that does not get through is logged, without its URL; the loop is never held up by it', async () => {
  const { hb, logs, failPings } = rig();
  failPings(true);
  hb.observe({ kind: 'idle', source: 'koios', slot: 1n, orders: 0 });
  hb.tick();
  await hb.flush();
  assert.deepEqual(logs, [{ kind: 'heartbeat-failed', ping: 'ok', error: 'HTTP 503' }]);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});

test('with no ping URL nothing is sent, and the start says no alarm will reach anyone', async () => {
  const logs: Record<string, unknown>[] = [];
  let sent = 0;
  const hb = new Heartbeat({ url: null, everyMs: 5 * MIN, quietMs: 10 * MIN, alertGapMs: 60 * MIN, send: async () => (sent++, { ok: true }) }, (e) => logs.push(e as Record<string, unknown>));
  hb.start();
  hb.tick();
  hb.fail('x');
  await hb.flush();
  assert.equal(sent, 0);
  assert.equal(logs[0]!.kind, 'heartbeat-off');
});
