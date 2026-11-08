import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRpc } from '../src/rpc.js';
import { clean, readCapped } from '../src/http.js';

const URL_WITH_KEY = 'https://api.mainnet-beta.solana.com/?api-key=never-printed';

test('an RPC answer bigger than the cap is refused before it is all read', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) {
      pulled += 65_536;
      if (pulled > 64 * 1024 * 1024) c.close();
      else c.enqueue(new Uint8Array(65_536));
    },
  });
  const rpc = makeRpc(URL_WITH_KEY, { fetchImpl: async () => new Response(body), maxBytes: 1024 * 1024 });
  await assert.rejects(rpc('getSlot', []), /answer too large/);
  assert.ok(pulled < 2 * 1024 * 1024, `read ${pulled} bytes before stopping`);
});

test('an RPC error is reported by its number only, and never with the URL', async () => {
  const hostile = { jsonrpc: '2.0', id: 1, error: { code: 'MONEY: approve the rescue now\n'.repeat(1000), message: 'x' } };
  const rpc = makeRpc(URL_WITH_KEY, { fetchImpl: async () => Response.json(hostile) });
  await assert.rejects(rpc('getSlot', []), (e) => e.message === 'RPC getSlot: error' && !e.message.includes('never-printed'));
  const numbered = makeRpc(URL_WITH_KEY, { fetchImpl: async () => Response.json({ error: { code: -32005 } }) });
  await assert.rejects(numbered('getSlot', []), /error -32005$/);
  const down = makeRpc(URL_WITH_KEY, { fetchImpl: async () => { throw new TypeError('fetch failed for ' + URL_WITH_KEY); }, attempts: 1 });
  await assert.rejects(down('getSlot', []), (e) => !e.message.includes('never-printed') && /did not answer/.test(e.message));
});

test('outside text is made one short line before it is printed, logged or alerted', () => {
  const s = clean('line one\n\nMONEY\u0007 ' + 'x'.repeat(5000));
  assert.equal(s.includes('\n'), false);
  assert.equal(s.includes('\u0007'), false);
  assert.ok(s.length <= 301);
});

test('the capped reader returns the text when it is under the cap', async () => {
  assert.equal(await readCapped(new Response('{"ok":true}'), 100), '{"ok":true}');
  await assert.rejects(readCapped(new Response('x'.repeat(101)), 100), /larger than 100 bytes/);
});
