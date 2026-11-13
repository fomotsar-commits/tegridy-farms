import { describe, it, expect } from 'vitest';
import { JITO_SPACING_MS, JITO_WARM_EVERY_MS, jitoLine } from './jito-line.mjs';

const NY = 'https://ny.mainnet.block-engine.jito.wtf';
const TOKYO = 'https://tokyo.mainnet.block-engine.jito.wtf';

/** A line over a fake POST and a clock that only moves when told (or slept). */
function rig() {
  let clock = 1_000_000;
  const posts = [];
  const slept = [];
  const line = jitoLine({
    post: async (url, body) => {
      posts.push({ url, method: JSON.parse(body).method, at: clock });
      return { status: 200, text: JSON.stringify({ result: 'ok' }) };
    },
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return { line, posts, slept, tick: (ms) => (clock += ms) };
}
const call = (method) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });

describe('jitoLine: the robot’s line to Jito kept warm (KEEPER_JITO_WARM)', () => {
  it('answers as jitoSender reads a fetch: ok, status and the body as JSON', async () => {
    const r = rig();
    const res = await r.line.fetch(`${NY}/api/v1/bundles`, call('sendBundle'));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'ok' });
  });

  it('warms each block engine once at the start, then only those idle for the while', async () => {
    const r = rig();
    expect(await r.line.warm([NY, TOKYO])).toBe(2);
    expect(r.posts.map((p) => p.method)).toEqual(['getTipAccounts', 'getTipAccounts']);
    r.tick(JITO_WARM_EVERY_MS - 1);
    expect(await r.line.warm([NY, TOKYO])).toBe(0);
    // A call of the robot's own keeps a line warm as well.
    await r.line.fetch(`${NY}/api/v1/bundles`, call('getInflightBundleStatuses'));
    r.tick(1);
    expect(await r.line.warm([NY, TOKYO])).toBe(1);
    expect(r.posts.at(-1).url).toBe(`${TOKYO}/api/v1/bundles`);
  });

  it('holds a bundle sent within a second of its own warming call there until the second is out, never longer', async () => {
    const r = rig();
    await r.line.warm([NY]);
    r.tick(300);
    await r.line.fetch(`${NY}/api/v1/bundles`, call('sendBundle'));
    expect(r.slept).toEqual([JITO_SPACING_MS - 300]);
    const send = r.posts.at(-1);
    expect(send.method).toBe('sendBundle');
    expect(send.at - r.posts[0].at).toBe(JITO_SPACING_MS);
  });

  it('never holds a send after the robot’s own calls, or a warming call long past, or a status read', async () => {
    const r = rig();
    await r.line.fetch(`${NY}/api/v1/bundles`, call('getInflightBundleStatuses'));
    await r.line.fetch(`${NY}/api/v1/bundles`, call('sendBundle'));
    await r.line.warm([TOKYO]);
    await r.line.fetch(`${TOKYO}/api/v1/bundles`, call('getInflightBundleStatuses'));
    r.tick(JITO_SPACING_MS);
    await r.line.warm([TOKYO]);
    r.tick(JITO_WARM_EVERY_MS);
    await r.line.warm([TOKYO]);
    r.tick(JITO_SPACING_MS);
    await r.line.fetch(`${TOKYO}/api/v1/bundles`, call('sendBundle'));
    expect(r.slept).toEqual([]);
  });

  it('never throws from a warming call that fails', async () => {
    const line = jitoLine({ post: async () => Promise.reject(new Error('fetch failed')), now: () => 0, sleep: async () => {} });
    await expect(line.warm([NY])).resolves.toBe(1);
  });
});
