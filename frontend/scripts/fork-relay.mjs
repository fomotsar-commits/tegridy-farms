/**
 * A retrying relay between anvil and its fork upstream.
 *
 * WHY THIS EXISTS. Measured 2026-09-11 on the e2e-anvil job (anvil 1.7.1, forking
 * https://eth.drpc.org on a free plan): drpc intermittently answers a fork read with
 *   HTTP 408 {"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}
 * and anvil does not retry it, whatever it is told. anvil's fork provider retries through
 * alloy's RetryBackoffLayer, and that layer's predicate (alloy-transport
 * `TransportErrorKind::is_retry_err`, identical in 1.1.1 and 2.0.1, the versions behind anvil
 * 1.5.1 and 1.7.1) accepts HTTP 429 and 503 and no other status. So `--retries` and
 * `--fork-retry-backoff` never engage on a 408. `--compute-units-per-second` and
 * `--no-rate-limit` only size the sleep BETWEEN those retries; they never slow a first
 * attempt. The unretried 408 reached CI two ways:
 *   - fixture setup: `anvil_setBalance` failed with "failed to get account … HTTP error 408";
 *   - block building: the EIP-2935 history-contract read failed inside
 *     `apply_pre_execution_changes().expect(…)`, which PANICS. anvil died with SIGABRT, and
 *     every test after it failed in ~150ms.
 * The retry therefore lives here, BELOW anvil, where it covers every read anvil makes:
 * fixture cheatcodes, the app's own reads, and block building alike. Everything that crosses
 * this relay is a read. anvil executes transactions locally and never sends a write to its
 * fork upstream, so asking again is safe.
 *
 * WHAT IT RETRIES, AND WHAT IT MUST NOT.
 *   retried  HTTP 408 / 502 / 504 (the upstream did not answer in time), and a keep-alive
 *            socket the upstream dropped under us (nothing was answered).
 *   passed   everything else, byte-for-byte, on the FIRST answer. A 401/403/404/410 is the
 *            endpoint refusing us: retrying it only delays the verdict and buries it (the
 *            publicnode archive gate was a 403). 429 and 503 are anvil's own retry layer's
 *            job. A refused connection or an unknown host is a wrong URL; it fails at once.
 * It gives up at DEADLINE_MS, inside anvil's own 45s per-request timeout, and hands anvil the
 * upstream's LAST answer unchanged. So a dead upstream still fails the run exactly as loudly
 * as before, in the upstream's own words. This makes a flaky upstream survivable; it must
 * never make a dead one invisible.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const RETRY_STATUSES = new Set([408, 502, 504]);
const RETRY_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
// Connection- and framing-scoped headers. They describe ONE hop and must not be copied onto
// the next. accept-encoding goes too, so fetch negotiates (and decodes) its own.
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'content-length',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'accept-encoding',
]);
// Response headers NOT passed back to anvil: framing and encoding belong to this hop (fetch
// has already decoded the body), and a cookie has no business in a JSON-RPC answer.
// Everything else IS passed back, because anvil prints an "HTTP diagnostics" block built
// from these headers — on a real 408 that is the provider's `cf-ray` and `server`, the ids
// you quote when you ask them why. Measured on anvil 1.7.1.
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
]);

/** Inside anvil's default `--timeout` (45_000 ms), so anvil hears the upstream, not its own clock. */
export const DEADLINE_MS = 40_000;
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

const rpcError = (message) =>
  Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message } }));

/**
 * Start the relay. Returns `{ url, stats, report, close }`: point `anvil --fork-url` at
 * `url`. A non-HTTP upstream (ws://, ipc) is handed back untouched, unrelayed.
 */
export async function startForkRelay({ upstream, deadlineMs = DEADLINE_MS, backoffMs = BACKOFF_MS }) {
  const stats = { requests: 0, retried: 0, recovered: 0, exhausted: 0, retrying: 0, answers: {} };
  if (!/^https?:\/\//i.test(upstream)) {
    return { url: upstream, stats, report: () => {}, close: async () => {}, bypassed: true };
  }
  const host = new URL(upstream).host; // never the path or query: that is where keys live

  async function attempt(body, headers, deadline) {
    try {
      const res = await fetch(upstream, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const answerHeaders = {};
      for (const [name, value] of res.headers) if (!SKIP_RESPONSE_HEADERS.has(name)) answerHeaders[name] = value;
      answerHeaders['content-type'] ??= 'application/json';
      return {
        status: res.status,
        headers: answerHeaders,
        body: buf,
        retry: RETRY_STATUSES.has(res.status),
        why: `HTTP ${res.status}`,
      };
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        return {
          status: 504,
          headers: { 'content-type': 'application/json' },
          body: rpcError(`fork relay: ${host} did not answer within ${deadlineMs / 1000}s`),
          retry: false,
          why: 'deadline',
        };
      }
      const code = err?.cause?.code ?? err?.code ?? 'fetch failed';
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: rpcError(`fork relay: could not reach ${host} (${code}): ${err?.cause?.message ?? err?.message}`),
        retry: RETRY_SOCKET_CODES.has(code),
        why: code,
      };
    }
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    const deadline = Date.now() + deadlineMs;
    stats.requests++;
    let answer;
    let attempts = 0;
    let retrying = false;
    for (;;) {
      const next = await attempt(body, headers, deadline);
      attempts++;
      // The deadline cutting a RETRY short says nothing new about the upstream. Hand anvil
      // the last answer the upstream actually gave, in its own words, not a relay-made 504.
      if (next.why === 'deadline' && answer) break;
      answer = next;
      if (!answer.retry) break;
      stats.answers[answer.why] = (stats.answers[answer.why] ?? 0) + 1;
      // Counted while it lasts: a run can end mid-retry (a 408 storm at the fork handshake
      // outlasts the orchestrator's 20s bind wait), and the report must still see it.
      if (!retrying) { retrying = true; stats.retrying++; }
      const wait = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
      if (Date.now() + wait >= deadline) break;
      await delay(wait);
    }
    if (retrying) stats.retrying--;
    if (attempts > 1) stats.retried++;
    if (answer.retry) stats.exhausted++;
    else if (attempts > 1) stats.recovered++;

    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(rpcError(`fork relay: ${err?.message ?? err}`));
    });
  });
  // Never hang up an idle anvil connection from this side. reqwest pools them for 90s, and a
  // server that closes first races the client's next request on that socket: the classic
  // "connection closed before message completed", which anvil would not retry either.
  server.keepAliveTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  function report(log = console.log) {
    const seen = Object.entries(stats.answers).map(([why, n]) => `${why} x${n}`).join(', ');
    const pending = stats.retrying ? `, ${stats.retrying} still retrying at exit` : '';
    log(
      `[e2e] fork relay: ${stats.requests} upstream read(s) to ${host}; ${stats.retried} retried, ` +
        `${stats.recovered} recovered, ${stats.exhausted} gave up${pending}${seen ? ` (${seen})` : ''}.`,
    );
    if (stats.exhausted + stats.retrying > 0) {
      const how = [
        stats.exhausted && `${stats.exhausted} still failed after retrying for up to ${deadlineMs / 1000}s`,
        stats.retrying && `${stats.retrying} still being retried when the run ended`,
      ].filter(Boolean).join(', ');
      log(
        `::error title=Fork upstream gave up::${stats.exhausted + stats.retrying} fork read(s) to ${host} kept ` +
          `failing (${seen}): ${how}. A red in this run can be the upstream, not the product: read the anvil ` +
          'tail and the FIRST attempt before debugging a spec.',
      );
    } else if (stats.retried > 0) {
      log(
        `::warning title=Fork upstream flaked (recovered)::${stats.retried} fork read(s) to ${host} were answered ` +
          `${seen} and succeeded on retry. No test saw a failure, so this run's results stand; the durable fix ` +
          'is a funded endpoint in ANVIL_FORK_URL (see the note at FORK_URL in run-e2e-with-anvil.mjs).',
      );
    }
  }

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    report,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
