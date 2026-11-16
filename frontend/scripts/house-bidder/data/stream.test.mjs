// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStream, normalizeStreamFrame } from './stream.mjs';

const { frames } = JSON.parse(readFileSync(fileURLToPath(new URL('../__fixtures__/stream-frames.json', import.meta.url)), 'utf8'));
const KEY = 'test-only-opensea-key-0123456789';
const byHash = (h) => frames.find((f) => f[4]?.payload?.order_hash?.startsWith(h));
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

describe('normalizeStreamFrame on real frames (captured read-only 2026-11-16)', () => {
  it('reads a listing: token, maker, order hash, an exact price from the order itself', () => {
    const ev = normalizeStreamFrame(byHash('0xb42f723be6'));
    expect(ev).toMatchObject({
      type: 'listed', slug: 'gnssart', time: sec('2026-11-16T00:52:52.870000Z'), tokenId: '2047', contract: '0xa1de9f93c56c290c48849b1393b09eb616d55dbb',
      maker: '0xd93bea8972f02df40d1df236757de7b7cfb6a04c', orderHash: '0xb42f723be66afc26c1609f1c40c406cc863868ab9b840a5ff9fb91e68caf0536',
      priceWei: 17243300000000000n, priceExact: true, qty: 1, paymentToken: '0x0000000000000000000000000000000000000000',
    });
    expect(ev.raw.event_type).toBe('item_listed');
  });

  it('prices a collection offer per NFT from its own lines, not from the float-rounded base_price', () => {
    const frame = byHash('0x3683749684');
    expect(frame[4].payload.base_price).toBe('15800000000000002');
    const ev = normalizeStreamFrame(frame);
    expect(ev).toMatchObject({ type: 'collection_offer', slug: 'junglebay', qty: 4, priceWei: 15800000000000000n, priceExact: true });
    expect(ev.tokenId).toBeUndefined();
  });

  it('reads a multi-NFT offer as per-unit (OpenSea\'s base_price is per unit too)', () => {
    const frame = byHash('0x7c4f8b6144');
    const ev = normalizeStreamFrame(frame);
    expect(ev).toMatchObject({ type: 'collection_offer', slug: 'gnssart', qty: 4, priceWei: 4100000000000000n, priceExact: true });
    expect(BigInt(frame[4].payload.protocol_data.parameters.offer[0].startAmount)).toBe(4n * ev.priceWei);
  });

  it('labels a price it could only take from base_price as inexact', () => {
    const ev = normalizeStreamFrame(byHash('0x8ef2db6a4f'));
    expect(ev).toMatchObject({ type: 'cancelled', slug: 'junglebay', tokenId: '1802', priceWei: 39800000000000000n, priceExact: false, maker: '0xd1dc6e32109f10687f78c6f86a882699756ab317' });
  });

  it('reads invalidations and trait offers', () => {
    expect(normalizeStreamFrame(byHash('0xf73a72f755'))).toMatchObject({ type: 'invalidated', slug: 'gnssart', tokenId: '2047', orderHash: '0xf73a72f7553795c393ce7a76481d5447cf2726aedec4d10cbd14ec2926cc28e8' });
    expect(normalizeStreamFrame(byHash('0x4ea36f92d4'))).toMatchObject({ type: 'trait_offer', slug: 'junglebay', qty: 1, priceWei: 26300000000000000n, priceExact: true });
  });

  it('passes on nothing for replies, item-level bids or junk', () => {
    expect(normalizeStreamFrame(frames.find((f) => f[3] === 'phx_reply' && f[2] !== 'phoenix'))).toBe(null);
    expect(normalizeStreamFrame(frames.find((f) => f[2] === 'phoenix'))).toBe(null);
    expect(normalizeStreamFrame(byHash('0x55d2f1a1b6'))).toBe(null);
    expect(normalizeStreamFrame(['1', null, 'collection:x', 'item_listed'])).toBe(null);
    expect(normalizeStreamFrame('nope')).toBe(null);
  });
});

/** A WebSocket stand-in: records what is sent; the test opens it, feeds it frames and drops it. */
function fakeSocketClass() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      sockets.push(this);
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close(code, reason) {
      this.readyState = 3;
      this.closedWith = { code, reason };
      this.onclose?.({ code, reason });
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    receive(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code, reason: 'gone' });
    }
  }
  return { FakeWS, sockets };
}

/** Timers on a fake clock; advance() runs everything due, in order. */
function fakeTimers() {
  let t = 1_800_000_000_000;
  let id = 0;
  const tasks = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => (tasks.set(++id, { at: t + ms, fn }), id),
      clearTimeout: (i) => tasks.delete(i),
      setInterval: (fn, ms) => (tasks.set(++id, { at: t + ms, fn, every: ms }), id),
      clearInterval: (i) => tasks.delete(i),
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, task] of tasks) if (task.at <= end && (!next || task.at < next[1].at)) next = [i, task];
        if (!next) break;
        const [i, task] = next;
        t = task.at;
        if (task.every) task.at += task.every;
        else tasks.delete(i);
        task.fn();
      }
      t = end;
    },
  };
}

function setup({ random = () => 0 } = {}) {
  const { FakeWS, sockets } = fakeSocketClass();
  const clock = fakeTimers();
  const logs = [];
  const stream = createStream({ apiKey: KEY, slugs: ['junglebay', 'gnssart'], WebSocketImpl: FakeWS, now: clock.now, timers: clock.timers, random, log: (level, msg) => logs.push(`${level} ${msg}`) });
  const events = [];
  for (const type of ['listed', 'collection_offer', 'gap', 'open', 'close']) stream.on(type, (e) => events.push(e));
  return { stream, sockets, clock, events, logs, last: () => sockets[sockets.length - 1] };
}
const listedFrame = () => byHash('0xb42f723be6');
const heartbeatsIn = (ws) => ws.sent.filter((f) => f[2] === 'phoenix' && f[3] === 'heartbeat');

describe('createStream: the Phoenix protocol', () => {
  it('joins one topic per slug on open, with the key only in the socket URL', () => {
    const s = setup();
    s.stream.start();
    expect(s.sockets).toHaveLength(1);
    expect(s.last().url).toBe(`wss://stream-api.opensea.io/socket/websocket?token=${KEY}&vsn=2.0.0`);
    s.last().open();
    expect(s.last().sent.map((f) => [f[2], f[3]])).toEqual([['collection:junglebay', 'phx_join'], ['collection:gnssart', 'phx_join']]);
    expect(s.events.map((e) => e.type)).toEqual(['open']);
    s.last().receive(['1', '1', 'collection:junglebay', 'phx_reply', { status: 'ok', response: {} }]);
    expect(s.stream.state().joined).toEqual(['collection:junglebay']);
    expect(s.logs.join('\n')).not.toContain(KEY);
  });

  it('passes market events to their handlers and records when they came', () => {
    const s = setup();
    s.stream.start();
    s.last().open();
    s.clock.advance(5_000);
    s.last().receive(listedFrame());
    expect(s.events.at(-1)).toMatchObject({ type: 'listed', tokenId: '2047' });
    expect(s.stream.lastMessageAt()).toBe(s.clock.now());
  });

  it('sends a heartbeat every 30 s and stays connected while they are answered', () => {
    const s = setup();
    s.stream.start();
    const ws = s.last();
    ws.open();
    s.clock.advance(30_000);
    expect(heartbeatsIn(ws)).toHaveLength(1);
    const ref = heartbeatsIn(ws)[0][1];
    ws.receive([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]);
    s.clock.advance(30_000);
    expect(heartbeatsIn(ws)).toHaveLength(2);
    expect(s.sockets).toHaveLength(1);
  });

  it('replaces a socket whose heartbeat went unanswered, and reports the gap after reconnecting', () => {
    const s = setup();
    s.stream.start();
    const first = s.last();
    first.open();
    s.clock.advance(60_000); // heartbeat at 30 s, no reply by 60 s
    expect(first.closedWith?.code).toBe(4000);
    expect(s.events.some((e) => e.type === 'close')).toBe(true);
    s.clock.advance(500); // backoff: half of the 1 s span with jitter 0
    expect(s.sockets).toHaveLength(2);
    s.last().open();
    expect(s.events.filter((e) => e.type === 'gap').map((e) => e.reason)).toContain('reconnect');
    expect(s.events.find((e) => e.type === 'open' && e.reconnect)).toBeTruthy();
  });

  it('reports a gap after 30 s without a market message, once per quiet spell', () => {
    const s = setup();
    s.stream.start();
    s.last().open();
    s.last().receive(listedFrame());
    s.clock.advance(29_000);
    expect(s.events.filter((e) => e.type === 'gap')).toHaveLength(0);
    s.clock.advance(1_000);
    expect(s.events.filter((e) => e.type === 'gap').map((e) => e.reason)).toEqual(['silence']);
    s.clock.advance(60_000);
    expect(s.events.filter((e) => e.type === 'gap')).toHaveLength(1);
    s.last().receive(listedFrame());
    s.clock.advance(30_000);
    expect(s.events.filter((e) => e.type === 'gap')).toHaveLength(2);
  });

  it('counts heartbeat replies as alive but not as market messages', () => {
    const s = setup();
    s.stream.start();
    const ws = s.last();
    ws.open();
    ws.receive(listedFrame());
    const marketAt = s.clock.now();
    s.clock.advance(25_000);
    ws.receive([null, '99', 'phoenix', 'phx_reply', { status: 'ok', response: {} }]);
    expect(s.stream.lastAliveAt()).toBe(s.clock.now());
    expect(s.stream.lastMessageAt()).toBe(marketAt);
    s.clock.advance(5_000);
    expect(s.events.filter((e) => e.type === 'gap').map((e) => e.reason)).toEqual(['silence']);
  });

  it('backs off between reconnects: 1 s, 2 s, 4 s spans, never under half a span', () => {
    const s = setup({ random: () => 0 });
    s.stream.start();
    const times = [s.clock.now()];
    for (let i = 0; i < 3; i++) {
      s.last().drop();
      const before = s.sockets.length;
      let waited = 0;
      while (s.sockets.length === before) {
        s.clock.advance(100);
        waited += 100;
      }
      times.push(waited);
    }
    expect(times.slice(1)).toEqual([500, 1_000, 2_000]);
  });

  it('keeps other handlers running when one throws', () => {
    const s = setup();
    const seen = [];
    s.stream.on('listed', () => {
      throw new Error('a broken handler');
    });
    s.stream.on('listed', (e) => seen.push(e.tokenId));
    s.stream.start();
    s.last().open();
    s.last().receive(listedFrame());
    expect(seen).toEqual(['2047']);
    expect(s.logs.some((l) => l.includes('a broken handler'))).toBe(true);
  });

  it('reconnects when OpenSea refuses a join or closes a channel', () => {
    const s = setup();
    s.stream.start();
    s.last().open();
    s.last().receive(['1', '1', 'collection:junglebay', 'phx_reply', { status: 'error', response: { reason: 'unauthorized' } }]);
    s.clock.advance(500);
    expect(s.sockets).toHaveLength(2);
    s.last().open();
    s.last().receive(['3', '3', 'collection:gnssart', 'phx_error', {}]);
    s.clock.advance(1_000);
    expect(s.sockets).toHaveLength(3);
  });

  it('stops for good: no reconnect, no timers', () => {
    const s = setup();
    s.stream.start();
    s.last().open();
    s.stream.stop();
    expect(s.last().closedWith).toEqual({ code: 1000, reason: 'stopped' });
    s.clock.advance(10 * 60_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'gap')).toHaveLength(0);
  });

  it('stops for good even with a reconnect already waiting', () => {
    const s = setup();
    s.stream.start();
    s.last().open();
    s.last().drop(); // a reconnect is now scheduled
    s.stream.stop();
    s.clock.advance(10 * 60_000);
    expect(s.sockets).toHaveLength(1);
  });

  it('refuses an unknown event type or a bad slug up front', () => {
    const s = setup();
    expect(() => s.stream.on('item_received_bid', () => {})).toThrow(TypeError);
    expect(() => createStream({ apiKey: KEY, slugs: ['Jungle Bay'] })).toThrow(TypeError);
  });
});
