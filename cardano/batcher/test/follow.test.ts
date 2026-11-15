// The chain-sync follower, against a stand-in Ogmios that answers as Ogmios v6/v7 does (the
// first nextBlock after an intersection steps back to it), and, with OGMIOS_WS set (e.g.
// wss://api.koios.rest/api/v1/ogmios), live on mainnet until a real block arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Follower, type Block, type SocketLike } from '../src/follow.ts';
import { parseExact, stringifyExact } from '../src/json.ts';

const TIP = { slot: 201_340_000n, id: 'aa'.repeat(32), height: 14_113_000n };
const block = (n: bigint, txs: string[]) => ({ type: 'praos', era: 'conway', id: n.toString(16).padStart(64, '0'), slot: TIP.slot + n, height: TIP.height + n, transactions: txs.map((id) => ({ id, spends: 'inputs' })) });
const atIntersection = { direction: 'backward', point: { slot: TIP.slot, id: TIP.id }, tip: TIP };

type Step = Record<string, unknown> | null | 'close' | { raw: unknown };

/** A stand-in Ogmios: answers findIntersection, then each nextBlock from `script` (null holds the request forever). */
class FakeOgmios implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  readonly sent: Record<string, unknown>[] = [];
  readonly #script: Step[];
  constructor(script: Step[]) {
    this.#script = [...script];
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string): void {
    const m = parseExact(data) as { method: string; id: bigint; params?: { points: unknown[] } };
    this.sent.push(m);
    const reply = (msg: unknown): void => void setTimeout(() => this.onmessage?.({ data: stringifyExact(msg) }), 0);
    if (m.method === 'findIntersection') {
      const p = m.params!.points[0];
      return reply({ jsonrpc: '2.0', method: m.method, result: { intersection: p === 'origin' ? 'origin' : p, tip: TIP }, id: m.id });
    }
    if (m.method === 'nextBlock') {
      const next = this.#script.shift();
      if (next === 'close') return void setTimeout(() => this.onclose?.({}), 0);
      if (next && 'raw' in next) return reply(next.raw);
      if (next) reply({ jsonrpc: '2.0', method: m.method, result: next, id: m.id });
    }
  }
  close(): void {
    this.closed = true;
  }
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('from the tip: each block with its transactions, then a real rollback; the step back to the intersection is no rollback', async () => {
  const seen: string[] = [];
  const blocks: Block[] = [];
  const fake = new FakeOgmios([atIntersection, { direction: 'forward', block: block(1n, ['11'.repeat(32), '22'.repeat(32)]), tip: TIP }, { direction: 'forward', block: block(2n, []), tip: TIP }, { direction: 'backward', point: { slot: TIP.slot + 1n, id: block(1n, []).id }, tip: TIP }, null]);
  const f = new Follower('wss://ogmios.invalid', { forward: (b) => (blocks.push(b), seen.push(`forward ${b.height}`)), backward: (p) => seen.push(`backward ${p === 'origin' ? 'origin' : p.slot}`), down: (e) => seen.push(`down ${e}`) }, { socket: () => fake });
  f.start();
  await until(() => seen.length === 3);
  f.stop();
  assert.deepEqual(seen, [`forward ${TIP.height + 1n}`, `forward ${TIP.height + 2n}`, `backward ${TIP.slot + 1n}`]);
  assert.deepEqual(blocks[0]!.txIds, ['11'.repeat(32), '22'.repeat(32)]);
  // It intersected at the tip it was told, not the origin.
  const intersections = fake.sent.filter((m) => m.method === 'findIntersection').map((m) => (m.params as { points: unknown[] }).points[0]);
  assert.deepEqual(intersections, ['origin', { slot: TIP.slot, id: TIP.id }]);
});

test('a lost connection is reported once and followed again from the new tip', async () => {
  const downs: string[] = [];
  const sockets: FakeOgmios[] = [];
  let forwards = 0;
  const f = new Follower(
    'wss://ogmios.invalid',
    { forward: () => forwards++, backward: () => {}, down: (e) => downs.push(e) },
    {
      socket: () => {
        const s = sockets.length === 0 ? new FakeOgmios(['close']) : new FakeOgmios([atIntersection, { direction: 'forward', block: block(3n, []), tip: TIP }, null]);
        sockets.push(s);
        return s;
      },
      maxBackoffMs: 10,
    },
  );
  f.start();
  await until(() => forwards === 1, 5_000);
  f.stop();
  assert.equal(sockets.length, 2);
  assert.deepEqual(downs, ['the connection closed']);
});

test('an error and a close on the same socket reconnect once, not twice', async () => {
  const sockets: FakeOgmios[] = [];
  const f = new Follower('wss://ogmios.invalid', { forward: () => {}, backward: () => {}, down: () => {} }, {
    socket: () => {
      const s = new FakeOgmios([null]);
      sockets.push(s);
      if (sockets.length === 1) setTimeout(() => (s.onerror?.({}), s.onclose?.({})), 20);
      return s;
    },
    maxBackoffMs: 10,
  });
  f.start();
  await until(() => sockets.length >= 2, 5_000);
  await new Promise((r) => setTimeout(r, 1_200));
  f.stop();
  assert.equal(sockets.length, 2);
});

test('a connection that goes silent (no block for the watchdog’s time) is dropped and made again', async () => {
  const downs: string[] = [];
  const sockets: FakeOgmios[] = [];
  const f = new Follower('wss://ogmios.invalid', { forward: () => {}, backward: () => {}, down: (e) => downs.push(e) }, {
    socket: () => {
      const s = new FakeOgmios([atIntersection, null]);
      sockets.push(s);
      return s;
    },
    silentMs: 100,
    maxBackoffMs: 10,
  });
  f.start();
  await until(() => sockets.length >= 2, 5_000);
  f.stop();
  assert.match(downs[0]!, /no block for 0.1 s/);
});

test('answers are matched by id: an answer to no request of ours is ignored; an error tied to none drops the connection', async () => {
  const seen: bigint[] = [];
  const downs: string[] = [];
  const stray = { raw: { jsonrpc: '2.0', method: 'nextBlock', result: { direction: 'forward', block: block(99n, []), tip: TIP }, id: 9_999n } };
  const sockets: FakeOgmios[] = [];
  const f = new Follower('wss://ogmios.invalid', { forward: (b) => seen.push(b.height), backward: () => {}, down: (e) => downs.push(e) }, {
    socket: () => {
      const s = sockets.length === 0 ? new FakeOgmios([stray]) : new FakeOgmios([{ raw: { jsonrpc: '2.0', method: 'nextBlock', error: { code: -32000, message: 'connection to the node lost' }, id: null } }]);
      sockets.push(s);
      return s;
    },
    maxBackoffMs: 10,
  });
  f.start();
  // The stray answer (id 9999) leaves our request waiting: nothing is reported for it.
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, []);
  assert.deepEqual(downs, []);
  sockets[0]!.onclose?.({});
  await until(() => downs.length >= 2, 5_000);
  f.stop();
  assert.match(downs[1]!, /connection to the node lost/);
});

const LIVE = process.env.OGMIOS_WS ?? '';
test('live: mainnet, followed from its tip until the next real block', { skip: LIVE ? false : 'set OGMIOS_WS (e.g. wss://api.koios.rest/api/v1/ogmios)', timeout: 180_000 }, async () => {
  let got: Block | null = null;
  const downs: string[] = [];
  let rollbacks = 0;
  const f = new Follower(LIVE, { forward: (b) => (got ??= b), backward: () => rollbacks++, down: (e) => downs.push(e) });
  f.start();
  await until(() => got !== null, 170_000);
  f.stop();
  const b = got as unknown as Block;
  assert.ok(b.slot > 200_000_000n, `slot ${b.slot}`);
  assert.match(b.id, /^[0-9a-f]{64}$/);
  assert.ok(b.height > 14_000_000n);
  assert.ok(b.txIds.every((t) => /^[0-9a-f]{64}$/.test(t)));
  assert.deepEqual(downs, []);
  assert.equal(rollbacks, 0, 'the step back to the intersection was reported as a rollback');
});
