// @vitest-environment node
//
// The pipe to the signer (BUILD-SPEC 2.3): newline-delimited JSON over a named pipe (a unix
// socket off Windows), answers matched by id, refusals returned as answers, transport problems
// thrown. Run against a real local pipe with a small fake server.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSignerClient, SignerError } from '../signerClient.mjs';

const pipePath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\house-bidder-test-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(os.tmpdir(), `hb-${process.pid}-${Math.random().toString(36).slice(2)}.sock`));

let servers = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  servers = [];
});

/** A fake signer server: `answer(request)` returns the reply object, an array of [delayMs, reply], or null for silence. */
async function serve(answer) {
  const p = pipePath();
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line);
        seen.push(req);
        const r = answer(req, sock);
        if (r === null) continue;
        const [delay, reply] = Array.isArray(r) ? r : [0, r];
        setTimeout(() => sock.write(`${JSON.stringify({ id: req.id, ...reply })}\n`), delay);
      }
    });
  });
  servers.push(server);
  await new Promise((ok) => server.listen(p, ok));
  return { path: p, seen };
}

describe('signer client', () => {
  it('sends one JSON line per request and matches answers by id, even out of order', async () => {
    const s = await serve((req) => (req.op === 'hello' ? [60, { ok: true, house: '0xabc' }] : [0, { ok: true, counter: '7' }]));
    const c = createSignerClient({ path: s.path });
    const [hello, status] = await Promise.all([c.hello(), c.status()]);
    expect(hello).toMatchObject({ ok: true, house: '0xabc' });
    expect(status).toMatchObject({ ok: true, counter: '7' });
    expect(s.seen.map((r) => r.op)).toEqual(['hello', 'status']);
    expect(new Set(s.seen.map((r) => r.id)).size).toBe(2);
    c.close();
  });

  it('returns a refusal as an answer, so the bot can halt on it', async () => {
    const s = await serve(() => ({ ok: false, field: 'P7', reason: 'over the ceiling' }));
    const c = createSignerClient({ path: s.path });
    const r = await c.signBid({ slug: 'junglebay', qty: 1, unitPriceWei: 46_000_000_000_000_000n, startTime: 1, endTime: 2, build: { zone: '0x', zoneHash: '0x', consideration: [], extra: 'dropped' } });
    expect(r).toMatchObject({ ok: false, field: 'P7' });
    // amounts travel as decimal strings, and only the three build pieces are sent
    expect(s.seen[0].unitPriceWei).toBe('46000000000000000');
    expect(Object.keys(s.seen[0].build)).toEqual(['zone', 'zoneHash', 'consideration']);
    c.close();
  });

  it('a caller cannot override the op or the id', async () => {
    const s = await serve(() => ({ ok: true }));
    const c = createSignerClient({ path: s.path });
    await c.request('sendTx', { op: 'kill', id: 'mine', kind: 'revokeWeth', params: {} });
    expect(s.seen[0].op).toBe('sendTx');
    expect(s.seen[0].id).not.toBe('mine');
    c.close();
  });

  it('ignores lines that are not JSON or answer nobody, and rejects an answer without ok', async () => {
    const s = await serve((req, sock) => {
      sock.write('not json\n');
      sock.write(`${JSON.stringify({ id: 'nobody', ok: true })}\n`);
      return { weird: true };
    });
    const c = createSignerClient({ path: s.path });
    await expect(c.hello()).rejects.toThrow(/without ok/);
    c.close();
  });

  it('times out an op the signer never answers', async () => {
    const s = await serve(() => null);
    const c = createSignerClient({ path: s.path, timeouts: { hello: 100 } });
    await expect(c.hello()).rejects.toMatchObject({ code: 'timeout' });
    c.close();
  });

  it('throws a connect error when no signer listens', async () => {
    const c = createSignerClient({ path: pipePath() });
    const e = await c.hello().catch((x) => x);
    expect(e).toBeInstanceOf(SignerError);
    expect(e.code).toBe('connect');
  });
});
