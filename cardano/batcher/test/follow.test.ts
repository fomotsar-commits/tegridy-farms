// The chain-sync follower, against a stand-in Ogmios that answers as Ogmios v6/v7 does (the
// first nextBlock after an intersection steps back to it), and, with OGMIOS_WS set (e.g.
// wss://api.koios.rest/api/v1/ogmios), live on mainnet until a real block arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Follower, type Block, type SocketLike } from '../src/follow.ts';
import { parseExact, stringifyExact } from '../src/json.ts';

const TIP = { slot: 201_340_000n, id: 'aa'.repeat(32), height: 14_113_000n };
const block = (n: bigint, txs: string[]) => ({ type: 'praos', era: 'conway', id: n.toString(16).padStart(64, '0'), slot: TIP.slot + n, height: TIP.height + n, transactions: txs.map((id) => ({ id, spends: 'inputs' })) });

/** A stand-in Ogmios: answers findIntersection, then each nextBlock from `script` (an entry of null holds the request forever). */
class FakeOgmios implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  readonly sent: Record<string, unknown>[] = [];
  readonly #script: (Record<string, unknown> | null | 'close')[];
  readonly #swap: boolean;
  #held: unknown[] = [];
  constructor(script: (Record<string, unknown> | null | 'close')[], opts: { swapAnswers?: boolean } = {}) {
    this.#script = [...script];
    this.#swap = opts.swapAnswers ?? false;
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string): void {
    const m = parseExact(data) as { method: string; id: bigint; params?: { points: unknown[] } };
    this.sent.push(m);
    const reply = (result: unknown) => this.#deliver({ jsonrpc: '2.0', method: m.method, result, id: m.id });
    if (m.method === 'findIntersection') {
      const p = m.params!.points[0];
      return reply({ intersection: p === 'origin' ? 'origin' : p, tip: TIP });
    }
    if (m.method === 'nextBlock') {
      const next = this.#script.shift();
      if (next === 'close') return void setTimeout(() => this.onclose?.({}), 0);
      if (next) reply(next);
    }
  }
  #deliver(msg: unknown): void {
    const text = stringifyExact(msg);
    if (this.#swap) {
      this.#held.push(text);
      return;
    }
    setTimeout(() => this.onmessage?.({ data: text }), 0);
  }
  /** Delivers held answers in reverse order (Ogmios orders answers only within one protocol). */
  flushReversed(): void {
    for (const t of this.#held.reverse()) setTimeout(() => this.onmessage?.({ data: t }), 0);
    this.#held = [];
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

test('from the tip: the step back to the intersection, then each block with its transactions, then a rollback', async () => {
  const seen: string[] = [];
  const blocks: Block[] = [];
  const fake = new FakeOgmios([{ direction: 'backward', point: { slot: TIP.slot, id: TIP.id }, tip: TIP }, { direction: 'forward', block: block(1n, ['11'.repeat(32), '22'.repeat(32)]), tip: TIP }, { direction: 'forward', block: block(2n, []), tip: TIP }, { direction: 'backward', point: { slot: TIP.slot + 1n, id: block(1n, []).id }, tip: TIP }, null]);
  const f = new Follower('wss://ogmios.invalid', { forward: (b) => (blocks.push(b), seen.push(`forward ${b.height}`)), backward: (p) => seen.push(`backward ${p === 'origin' ? 'origin' : p.slot}`), down: (e) => seen.push(`down ${e}`) }, { socket: () => fake });
  f.start();
  await until(() => seen.length === 4);
  f.stop();
  assert.deepEqual(seen, [`backward ${TIP.slot}`, `forward ${TIP.height + 1n}`, `forward ${TIP.height + 2n}`, `backward ${TIP.slot + 1n}`]);
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
        const s = sockets.length === 0 ? new FakeOgmios(['close']) : new FakeOgmios([{ direction: 'forward', block: block(3n, []), tip: TIP }, null]);
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

test('answers are matched to their requests by id: an answer to no request of ours is ignored', async () => {
  const seen: bigint[] = [];
  const fake = new FakeOgmios([{ direction: 'forward', block: block(1n, []), tip: TIP }, null], { swapAnswers: true });
  const f = new Follower('wss://ogmios.invalid', { forward: (b) => seen.push(b.height), backward: () => {}, down: () => {} }, { socket: () => fake });
  f.start();
  // An answer to no request of ours (a stray id) comes first, every time: it must be ignored.
  for (let i = 0; i < 4 && seen.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    fake.onmessage?.({ data: stringifyExact({ jsonrpc: '2.0', method: 'nextBlock', result: { direction: 'forward', block: block(99n, []), tip: TIP }, id: 9_999n }) });
    fake.flushReversed();
  }
  await until(() => seen.length === 1);
  f.stop();
  assert.deepEqual(seen, [TIP.height + 1n]);
});

const LIVE = process.env.OGMIOS_WS ?? '';
test('live: mainnet, followed from its tip until the next real block', { skip: LIVE ? false : 'set OGMIOS_WS (e.g. wss://api.koios.rest/api/v1/ogmios)', timeout: 180_000 }, async () => {
  let got: Block | null = null;
  const downs: string[] = [];
  const f = new Follower(LIVE, { forward: (b) => (got ??= b), backward: () => {}, down: (e) => downs.push(e) });
  f.start();
  await until(() => got !== null, 170_000);
  f.stop();
  const b = got as unknown as Block;
  assert.ok(b.slot > 200_000_000n, `slot ${b.slot}`);
  assert.match(b.id, /^[0-9a-f]{64}$/);
  assert.ok(b.height > 14_000_000n);
  assert.ok(b.txIds.every((t) => /^[0-9a-f]{64}$/.test(t)));
  assert.deepEqual(downs, []);
});
