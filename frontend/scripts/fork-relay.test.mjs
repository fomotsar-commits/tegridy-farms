// @vitest-environment node
//
// NODE, not the project's jsdom default: the subject is a CLI-side HTTP relay.
//
// PINS FOR `startForkRelay`, the relay that retries the fork upstream's HTTP 408s below
// anvil, because anvil will not (see the header of fork-relay.mjs for the measurement).
//
// Every case runs against a LOCAL fake upstream. The property under test is what the relay
// does with each kind of ANSWER, and a live endpoint cannot be made to give a chosen answer
// on demand. The two halves matter equally: a relay that retried too little would leave
// the 408 that killed anvil mid-suite, and a relay that retried too much would sit on a
// refused endpoint for 40s and bury the verdict the fork-handshake diagnosis prints.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { DEADLINE_MS, startForkRelay } from './fork-relay.mjs';

// Verbatim from CI run 34558450845, job 103138223493 (drpc, free plan).
const DRPC_408 =
  '{"id":443,"jsonrpc":"2.0","error":{"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}}';
// Verbatim from the 2026-09-09 publicnode archive gate.
const PUBLICNODE_403 =
  '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}';
const OK = '{"jsonrpc":"2.0","id":7,"result":"0x00000000000000000000000000000000000000000000000000000000000000ff"}';
// The read that took anvil down in CI run 34559491047: the EIP-2935 history contract.
const CALL =
  '{"jsonrpc":"2.0","id":7,"method":"eth_getStorageAt","params":["0x0000f90827f1c53a10cb7a02335b175320002935","0xa7e","0x18bf0f2"]}';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/**
 * A fake upstream that answers its Nth request with `script[N]` (the last step repeats).
 * `'drop'` destroys the socket without answering; `'hang'` never answers.
 */
async function fakeUpstream(script) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const step = script[Math.min(seen.length - 1, script.length - 1)];
    if (step === 'drop') return req.socket.destroy();
    if (step === 'hang') return;
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(step.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function relayTo(upstream, opts = {}) {
  const relay = await startForkRelay({ upstream, deadlineMs: 2_000, backoffMs: [20], ...opts });
  cleanups.push(() => relay.close());
  return relay;
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: await res.text() };
}

describe('startForkRelay', () => {
  it('passes a healthy answer through untouched, in one request', async () => {
    const up = await fakeUpstream([{ status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    expect(await post(relay.url, CALL)).toEqual({ status: 200, body: OK });
    expect(up.seen.map((s) => s.body)).toEqual([CALL]);
    expect(relay.stats).toMatchObject({ requests: 1, retried: 0, recovered: 0, exhausted: 0 });
  });

  it("retries the free plan's 408 until the read succeeds, re-sending the same request", async () => {
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }, { status: 408, body: DRPC_408 }, { status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    expect(await post(relay.url, CALL)).toEqual({ status: 200, body: OK });
    expect(up.seen.map((s) => s.body)).toEqual([CALL, CALL, CALL]);
    expect(relay.stats).toMatchObject({ requests: 1, retried: 1, recovered: 1, exhausted: 0, answers: { 'HTTP 408': 2 } });
  });

  it.each([502, 504])('treats a gateway %i like the 408: no answer in time, so ask again', async (status) => {
    const up = await fakeUpstream([{ status, body: 'bad gateway' }, { status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    expect(await post(relay.url, CALL)).toEqual({ status: 200, body: OK });
    expect(up.seen).toHaveLength(2);
  });

  it('retries a socket the upstream dropped before answering', async () => {
    const up = await fakeUpstream(['drop', { status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    expect(await post(relay.url, CALL)).toEqual({ status: 200, body: OK });
    expect(up.seen).toHaveLength(2);
    expect(relay.stats.recovered).toBe(1);
  });

  it.each([
    ['the publicnode archive gate', 403, PUBLICNODE_403],
    ['a missing key', 401, '{"message":"api key required"}'],
    ['a dead endpoint', 410, 'gone'],
    ['a rate limit (anvil retries 429 itself)', 429, '{"jsonrpc":"2.0","id":7,"error":{"code":429,"message":"Too many requests"}}'],
    ['a 503 (anvil retries 503 itself)', 503, 'unavailable'],
  ])('never retries %s: it reaches anvil verbatim, on the first answer', async (_label, status, body) => {
    const up = await fakeUpstream([{ status, body }, { status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    expect(await post(relay.url, CALL)).toEqual({ status, body });
    expect(up.seen).toHaveLength(1);
    expect(relay.stats).toMatchObject({ retried: 0, exhausted: 0 });
  });

  it("gives up by the deadline, never after it, and hands anvil the upstream's own last answer", async () => {
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }]);
    // The second backoff alone overshoots the deadline, so the relay must stop rather than
    // sleep through it: an answer that lands after anvil's own timeout is an answer anvil
    // never reads, and anvil then reports its clock instead of the upstream.
    const relay = await relayTo(up.url, { deadlineMs: 400, backoffMs: [50, 5_000] });
    const started = Date.now();
    // Unchanged, so anvil's error still reads "HTTP error 408 … free plan": a dead upstream
    // fails the run in its own words, exactly as it did before the relay existed.
    expect(await post(relay.url, CALL)).toEqual({ status: 408, body: DRPC_408 });
    expect(Date.now() - started).toBeLessThan(400);
    expect(up.seen).toHaveLength(2);
    expect(relay.stats).toMatchObject({ retried: 1, recovered: 0, exhausted: 1 });
  });

  it("hands anvil the upstream's last real answer when the deadline cuts a retry short", async () => {
    // 408, then a retry that never answers. The deadline aborts that retry, and what anvil
    // hears must still be the 408 the upstream actually sent, not a 504 the relay made up.
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }, 'hang']);
    const relay = await relayTo(up.url, { deadlineMs: 300, backoffMs: [50] });
    expect(await post(relay.url, CALL)).toEqual({ status: 408, body: DRPC_408 });
    expect(up.seen).toHaveLength(2);
    expect(relay.stats.exhausted).toBe(1);
  });

  it('answers 504 at the deadline instead of leaving anvil waiting on a hung upstream', async () => {
    const up = await fakeUpstream(['hang']);
    const relay = await relayTo(up.url, { deadlineMs: 300 });
    const res = await post(relay.url, CALL);
    expect(res.status).toBe(504);
    expect(res.body).toMatch(/did not answer within 0\.3s/);
    expect(up.seen).toHaveLength(1);
  });

  it("keeps its deadline inside anvil's own 45s per-request timeout", () => {
    // anvil --help (1.7.1): "--timeout <TIMEOUT>  Timeout in ms for requests sent to remote
    // JSON-RPC server in forking mode. Default value 45000". Past it, anvil gives up first
    // and reports its own timeout instead of the upstream's answer.
    expect(DEADLINE_MS).toBeLessThan(45_000);
  });

  it('fails a wrong URL at once instead of retrying it for a whole deadline', async () => {
    const closed = await fakeUpstream([{ status: 200, body: OK }]);
    const port = new URL(closed.url).port;
    await cleanups.pop()(); // close it: nothing listens there now
    const relay = await relayTo(`http://127.0.0.1:${port}`, { deadlineMs: 5_000 });
    const started = Date.now();
    const res = await post(relay.url, CALL);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/ECONNREFUSED/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(relay.stats.retried).toBe(0);
  });

  it("forwards anvil's own headers and drops only the per-connection ones", async () => {
    const up = await fakeUpstream([{ status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    await post(relay.url, CALL, { 'user-agent': 'foundry/1.7.1', 'x-api-key': 'k' });
    expect(up.seen[0].headers['user-agent']).toBe('foundry/1.7.1');
    expect(up.seen[0].headers['x-api-key']).toBe('k');
  });

  it('leaves a non-HTTP upstream alone', async () => {
    const relay = await startForkRelay({ upstream: 'ws://127.0.0.1:1' });
    expect(relay.url).toBe('ws://127.0.0.1:1');
    expect(relay.bypassed).toBe(true);
  });
});

describe('report', () => {
  const lines = (relay) => {
    const out = [];
    relay.report((line) => out.push(line));
    return out;
  };

  it('prints one summary line on a clean run, and no annotation', async () => {
    const up = await fakeUpstream([{ status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    await post(relay.url, CALL);
    const out = lines(relay);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/1 upstream read\(s\).*0 retried, 0 recovered, 0 gave up/);
  });

  it('warns when a flake was recovered, and says the results stand', async () => {
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }, { status: 200, body: OK }]);
    const relay = await relayTo(up.url);
    await post(relay.url, CALL);
    const out = lines(relay).join('\n');
    expect(out).toMatch(/::warning title=Fork upstream flaked \(recovered\)::/);
    expect(out).toMatch(/results stand/);
    expect(out).not.toMatch(/::error/);
  });

  it('errors when it gave up, so a red run names the upstream before anyone debugs a spec', async () => {
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }]);
    const relay = await relayTo(up.url, { deadlineMs: 200, backoffMs: [50] });
    await post(relay.url, CALL);
    expect(lines(relay).join('\n')).toMatch(/::error title=Fork upstream gave up::1 fork read/);
  });

  it('counts a read still being retried when the run ends as failing, not as nothing', async () => {
    // A 408 storm at the fork handshake outlasts the orchestrator's 20s bind wait, so the run
    // exits while the relay is still retrying. "0 gave up" would be a false all-clear.
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }]);
    const relay = await relayTo(up.url, { deadlineMs: 1_500, backoffMs: [50] });
    const inFlight = post(relay.url, CALL).catch(() => {});
    await expect.poll(() => up.seen.length).toBeGreaterThan(1);
    const out = lines(relay).join('\n');
    expect(out).toMatch(/0 gave up, 1 still retrying at exit/);
    expect(out).toMatch(/::error title=Fork upstream gave up::1 fork read/);
    await inFlight;
  });

  it('names the upstream by host only, never the path or query where a key lives', async () => {
    const up = await fakeUpstream([{ status: 408, body: DRPC_408 }]);
    const relay = await relayTo(`${up.url}/v2/SECRETKEY?dkey=SECRETTOO`, { deadlineMs: 200, backoffMs: [50] });
    await post(relay.url, CALL);
    const out = lines(relay).join('\n');
    expect(out).toContain(new URL(up.url).host);
    expect(out).not.toMatch(/SECRET/);
  });
});
