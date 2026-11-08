// A JSON-RPC client that can only READ.
//
// The method list is closed: any method that writes to the chain is refused before
// a request leaves, and test/watchOnly.test.mjs pins the list. The URL is never put in an error or a log line, because a paid
// RPC's URL usually carries its key. Answers are read with a byte cap.

import { readCapped, TooLarge } from './http.js';

export const ALLOWED_METHODS = Object.freeze(['getMultipleAccounts', 'getAccountInfo', 'getSlot']);

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeRpc(url, { fetchImpl = fetch, timeoutMs = 8_000, attempts = 3, maxBytes = MAX_BODY_BYTES } = {}) {
  let id = 0;
  return async function call(method, params) {
    if (!ALLOWED_METHODS.includes(method)) throw new Error(`the keeper does not call ${method}`);
    let last = 'no answer';
    for (let a = 0; a < attempts; a++) {
      if (a > 0) await sleep(700 * a);
      let res;
      let text;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Busy or broken: try again. A 4xx other than 429 will not get better.
        if (res.status === 429 || res.status >= 500) {
          last = `HTTP ${res.status}`;
          continue;
        }
        if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
        text = await readCapped(res, maxBytes);
      } catch (e) {
        if (e?.message?.startsWith('RPC ')) throw e;
        if (e instanceof TooLarge) throw new Error(`RPC ${method}: answer too large`);
        last = e?.name === 'TimeoutError' ? 'timed out' : 'did not answer';
        continue;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`RPC ${method}: answer was not JSON`);
      }
      if (body?.error) {
        const code = Number.isInteger(body.error.code) ? ` ${body.error.code}` : '';
        throw new Error(`RPC ${method}: error${code}`);
      }
      if (!body || !('result' in body)) throw new Error(`RPC ${method}: answer had no result`);
      return body.result;
    }
    throw new Error(`RPC ${method}: ${last}`);
  };
}
