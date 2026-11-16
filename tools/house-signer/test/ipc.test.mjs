// The IPC round trip: a temp keystore is decrypted the way `serve` does it, the signer is
// served on a temp named pipe (Windows) or unix socket, and a client talks to it in
// newline-delimited JSON. The chain is a fake; nothing leaves this machine.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decryptKeystore, encryptKeystore, KEYSTORE_FILE } from '../src/keystore.mjs';
import { createSigner } from '../src/signer.mjs';
import { request, startServer } from '../src/server.mjs';
import { cancelDigest, orderDigest } from '../src/eip712.mjs';
import { fromJsonParameters } from '../src/order.mjs';
import { recoverAddress } from '../src/sign.mjs';
import { bidRequest, fakeChain, fakeClock, HOUSE, HOUSE_KEY, makePolicy, tempDir } from './support/helpers.mjs';

const NOW = 1_763_251_200;
const pipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\house-signer-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  : path.join(os.tmpdir(), `hs-${crypto.randomBytes(4).toString('hex')}.sock`);

let server;
let keysDir;

before(async () => {
  keysDir = tempDir('ipc');
  // A temp keystore (light scrypt so the test is quick), decrypted as `serve` would.
  const doc = await encryptKeystore(HOUSE_KEY, 'ipc test password', { n: 2 ** 10, r: 8, p: 1 });
  fs.writeFileSync(path.join(keysDir, KEYSTORE_FILE), JSON.stringify(doc));
  const privateKey = await decryptKeystore(fs.readFileSync(path.join(keysDir, KEYSTORE_FILE), 'utf8'), 'ipc test password');
  const clock = fakeClock(NOW * 1000);
  const signer = createSigner({
    privateKey, policy: makePolicy(), policySha256: 'cd'.repeat(32), keysDir, chain: fakeChain({ counter: 9n }), sendUrls: ['https://send.example'], mode: 'live', pinCommit: 'e'.repeat(40), nowMs: clock.nowMs, sleep: clock.sleep, watch: false,
  });
  server = await startServer({ pipePath, handle: signer.handle });
});

after(async () => {
  await server?.close();
});

/** Send raw text on one connection and collect `count` answer lines. */
function exchange(text, count) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const answers = [];
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`only ${answers.length} of ${count} answers`)), 10_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        answers.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
      if (answers.length >= count) {
        clearTimeout(timer);
        socket.end();
        resolve(answers);
      }
    });
    socket.on('error', reject);
  });
}

test('hello over the pipe', async () => {
  const res = await request(pipePath, { id: 'h1', op: 'hello' });
  assert.deepEqual(res, { ok: true, id: 'h1', house: HOUSE, policySha256: 'cd'.repeat(32), version: '1.0.0', stopped: false, pinCommit: 'e'.repeat(40), mode: 'live' });
});

test('signBid and signCancel over the pipe: the signatures recover to the house', async () => {
  const bid = await request(pipePath, bidRequest({ id: 'b1' }, NOW));
  assert.equal(bid.ok, true, bid.reason);
  assert.equal(bid.id, 'b1');
  const { orderHash, digest } = orderDigest(fromJsonParameters(bid.parameters));
  assert.equal(bid.orderHash, orderHash);
  assert.equal(recoverAddress(digest, bid.signature), HOUSE);
  const cancel = await request(pipePath, { id: 'c1', op: 'signCancel', orderHash });
  assert.equal(cancel.ok, true, cancel.reason);
  assert.equal(recoverAddress(cancelDigest(orderHash), cancel.signature), HOUSE);
});

test('refusals come back in the protocol shape', async () => {
  const res = await request(pipePath, bidRequest({ id: 'b2', unitPriceWei: '1' }, NOW));
  assert.deepEqual(Object.keys(res).sort(), ['field', 'id', 'ok', 'reason']);
  assert.equal(res.ok, false);
  assert.equal(res.id, 'b2');
  assert.equal(res.field, 'P7.tick');
});

test('several requests on one connection are answered, matched by id', async () => {
  const answers = await exchange(`${JSON.stringify({ id: 'm1', op: 'hello' })}\n${JSON.stringify({ id: 'm2', op: 'status' })}\n${JSON.stringify({ id: 'm3', op: 'nope' })}\n`, 3);
  const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.equal(byId.m1.ok, true);
  assert.equal(byId.m2.ok, true);
  assert.equal(byId.m2.counter, '9');
  assert.equal(byId.m3.field, 'op');
});

test('a line that is not JSON is refused and the connection keeps working', async () => {
  const answers = await exchange(`{not json\n${JSON.stringify({ id: 'after', op: 'hello' })}\n`, 2);
  assert.equal(answers[0].ok, false);
  assert.equal(answers[0].id, null);
  assert.match(answers[0].reason, /one line of JSON/);
  assert.equal(answers[1].id, 'after');
  assert.equal(answers[1].ok, true);
});

test('PIN:S.line a request line over 64 KiB is refused, not handled', async () => {
  const big = JSON.stringify({ id: 'big', op: 'hello', pad: 'x'.repeat(70 * 1024) });
  const [res] = await exchange(`${big}\n`, 1);
  assert.equal(res.ok, false);
  assert.equal(res.id, null);
  assert.match(res.reason, /at most 65536 bytes/);
});

test('a second server cannot take the same pipe', async () => {
  await assert.rejects(startServer({ pipePath, handle: async () => ({}) }), /already in use/);
});

test('PIN:S.close closing the server ends every open connection at once: a client that stays connected (as the bot does) gets nothing more', async () => {
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\house-signer-close-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    : path.join(os.tmpdir(), `hs-close-${crypto.randomBytes(4).toString('hex')}.sock`);
  let handled = 0;
  const srv = await startServer({ pipePath: pipe, handle: async (req) => { handled += 1; return { ok: true, id: req.id }; } });
  const socket = net.createConnection(pipe);
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const gone = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ id: 'before', op: 'hello' })}\n`);
    await new Promise((resolve) => socket.once('data', resolve));
    assert.equal(handled, 1);
    const result = await Promise.race([srv.close().then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('still serving'), 3000))]);
    assert.equal(result, 'closed', 'close() did not wait for the client to hang up');
    await gone;
    assert.equal(socket.destroyed, true);
    assert.equal(handled, 1);
  } finally {
    socket.destroy();
  }
});
