// @vitest-environment node
//
// `board`: read-only, this computer only (a name pointed at 127.0.0.1 from elsewhere is turned
// away), GET only, and it serves status.json as the bot wrote it.
import { describe, it, expect } from 'vitest';
import nodeFs from 'node:fs';
import { boardHandler } from '../board.mjs';

function call(handler, { host = '127.0.0.1:8796', method = 'GET', url = '/' } = {}) {
  let status = 0;
  let headers = {};
  let body = '';
  const res = {
    writeHead(s, h = {}) {
      status = s;
      headers = h;
      return res;
    },
    end(b = '') {
      body = String(b);
      return res;
    },
  };
  handler({ headers: { host }, method, url }, res);
  return { status, headers, body };
}

const fsWith = (status) => ({ readFileSync: (p, enc) => (String(p).endsWith('status.json') ? (status === null ? (() => { throw new Error('ENOENT'); })() : status) : nodeFs.readFileSync(p, enc)) });

describe('board', () => {
  const h = boardHandler({ statusPath: 'K/status.json', port: 8796, fs: fsWith('{"mode":"shadow"}') });

  it('serves the page with a strict content security policy, and status.json as written', () => {
    const page = call(h);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(call(h, { url: '/status.json' }).body).toBe('{"mode":"shadow"}');
    expect(call(h, { url: '/app.js' }).status).toBe(200);
  });

  it('turns away another host name and anything but GET', () => {
    expect(call(h, { host: 'evil.example:8796' }).status).toBe(421);
    expect(call(h, { method: 'POST', url: '/status.json' }).status).toBe(405);
    expect(call(h, { url: '/../ledger.jsonl' }).status).toBe(404);
  });

  it('says there is no status yet rather than failing', () => {
    const empty = boardHandler({ statusPath: 'K/status.json', port: 8796, fs: fsWith(null) });
    expect(JSON.parse(call(empty, { host: 'localhost:8796', url: '/status.json' }).body).missing).toBe(true);
  });
});
