/**
 * The robot's line to Jito's block engines (KEEPER_JITO_WARM): calls over connections kept open,
 * each one kept warm by a cheap call (getTipAccounts) once it has been idle JITO_WARM_EVERY_MS (2 min).
 *
 * Measured from this computer 2026-11-13: a call on a connection already open took 61 ms to the
 * nearby endpoint (mainnet.block-engine.jito.wtf), 140-200 ms to Europe and Asia; on a new one
 * 267 ms and 500-700 ms (the connection and its TLS first). Jito kept an idle connection open 5
 * minutes and more (a call after 300 s idle: 56 ms, on the same connection). The robot sends a bundle a few times a day, so every send paid for a new connection.
 *
 * Jito takes 1 call a second from an IP in each region: a bundle sent to a block engine within
 * JITO_SPACING_MS of this line's own warming call there waits out the rest, so the two never
 * share a second. The robot's own calls (sends, status reads) are never held.
 */
import https from 'node:https';

export const JITO_WARM_EVERY_MS = 120_000;
export const JITO_SPACING_MS = 1_200;
const WARM_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] });

/** One POST over Node's https with `agent` (connections kept open): its status and body text. */
export function httpsPost(agent = new https.Agent({ keepAlive: true, maxSockets: 4 })) {
  return (url, body, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)));
      req.on('error', reject);
      req.end(body);
    });
}

/**
 * `fetch`: what keeper/jito.ts jitoSender calls (status, ok, json()), over `post`. `warm(urls)`:
 * a warming call to each block engine in `urls` idle for `every` or longer; never throws.
 */
export function jitoLine({ post = httpsPost(), now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), every = JITO_WARM_EVERY_MS } = {}) {
  // origin → when it was last called (any call keeps a line warm), and when this line last warmed it.
  const last = new Map();
  const warmedAt = new Map();
  const fetchLike = async (url, init = {}) => {
    const origin = new URL(url).origin;
    const body = String(init.body ?? '');
    const warmed = warmedAt.get(origin);
    if (warmed !== undefined && body.includes('"method":"sendBundle"')) {
      const wait = JITO_SPACING_MS - (now() - warmed);
      if (wait > 0) await sleep(wait);
    }
    last.set(origin, now());
    const r = await post(url, body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.text) };
  };
  const warm = async (urls) => {
    const due = [...new Set(urls.map((u) => new URL(u).origin))].filter((o) => {
      const was = last.get(o);
      return was === undefined || now() - was >= every;
    });
    await Promise.all(
      due.map((o) => {
        last.set(o, now());
        warmedAt.set(o, now());
        return post(`${o}/api/v1/bundles`, WARM_BODY).catch(() => null);
      }),
    );
    return due.length;
  };
  return { fetch: fetchLike, warm };
}
