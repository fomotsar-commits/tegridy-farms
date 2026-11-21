// The bot's side of the signer's pipe (BUILD-SPEC 2.3): newline-delimited JSON, one request per
// line, one answer per line, matched by id. The bot never holds the key; it can only ASK, and the
// signer answers { ok: false, field, reason } to anything outside its pins. A refusal comes back
// as an answer, not an error, so the executor can treat it as the integrity breaker it is; only a
// transport problem (no pipe, a dropped connection, no answer in time) throws.

import net from 'node:net';
import { jsonLine } from '../brain/util.mjs';

export const DEFAULT_PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\house-signer' : '/tmp/house-signer.sock';

/** Answers longer than this are not answers. */
const MAX_LINE = 1_000_000;

/** Signing is quick; a transaction waits for its block, and the kill waits for three. */
// sendTx: the signer simulates, signs, broadcasts and re-broadcasts each block for up to 3 minutes,
// and its README asks callers to wait at least 10 minutes for sendTx and kill answers. A shorter
// client timeout would report a transaction as failed while it may still land.
export const DEFAULT_TIMEOUTS = Object.freeze({ hello: 15_000, status: 15_000, signBid: 30_000, signCancel: 15_000, sendTx: 10 * 60_000, kill: 20 * 60_000 });

export class SignerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
  }
}

export function createSignerClient({ path = DEFAULT_PIPE, netImpl = net, timeouts = DEFAULT_TIMEOUTS, log = () => {} } = {}) {
  let socket = null;
  let connecting = null;
  let buffer = '';
  let seq = 0;
  const pending = new Map();

  function failAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
      socket?.destroy();
      failAll(new SignerError('the signer sent a line longer than 1 MB', 'protocol'));
      buffer = '';
      return;
    }
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('signer sent a line that is not JSON: ignored');
        continue;
      }
      const p = pending.get(String(msg?.id));
      if (!p) {
        log(`signer answered an id nobody asked (${String(msg?.id).slice(0, 40)}): ignored`);
        continue;
      }
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (typeof msg.ok !== 'boolean') p.reject(new SignerError('the signer answered without ok: true or false', 'protocol'));
      else p.resolve(msg);
    }
  }

  function connect() {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const s = netImpl.connect(path);
      const onError = (e) => {
        connecting = null;
        reject(new SignerError(`the signer's pipe ${path} did not answer (${e.code ?? e.message}): is house-signer serve running?`, 'connect'));
      };
      s.once('error', onError);
      s.once('connect', () => {
        s.off('error', onError);
        s.on('error', (e) => log(`signer pipe error: ${e.code ?? e.message}`));
        s.on('data', onData);
        s.on('close', () => {
          socket = null;
          failAll(new SignerError('the connection to the signer closed', 'closed'));
        });
        socket = s;
        connecting = null;
        resolve(s);
      });
    });
    return connecting;
  }

  async function request(op, body = {}) {
    const s = await connect();
    const id = `${Date.now().toString(36)}-${++seq}`;
    const timeoutMs = timeouts[op] ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SignerError(`the signer did not answer ${op} within ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      // Amounts go as decimal strings: the protocol is JSON, and JSON has no bigint.
      s.write(`${jsonLine({ ...body, id, op })}\n`);
    });
  }

  return {
    request,
    hello: () => request('hello'),
    status: () => request('status'),
    signBid: ({ slug, qty, unitPriceWei, startTime, endTime, build }) =>
      request('signBid', { slug, qty, unitPriceWei: String(unitPriceWei), startTime, endTime, build: { zone: build.zone, zoneHash: build.zoneHash, consideration: build.consideration } }),
    signCancel: (orderHash) => request('signCancel', { orderHash }),
    sendTx: (kind, params = {}) => request('sendTx', { kind, params }),
    kill: () => request('kill'),
    close() {
      failAll(new SignerError('closed by the bot', 'closed'));
      socket?.end();
      socket = null;
    },
  };
}
