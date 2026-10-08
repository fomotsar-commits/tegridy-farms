// @vitest-environment node
// The transports wagmi.ts hands to wagmi, driven as the app builds them. Node, not jsdom:
// the last test opens a real socket, and Node's fetch only takes Node's own AbortSignal.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, TimeoutError, type Chain } from 'viem';
import { WAGMI_CHAINS, WAGMI_TRANSPORTS } from './viemChains';

/** How a roster host behaves. `half-body` sends a 200, its headers and half an answer, then nothing. */
type Host = 'silent' | 'half-body' | 'answers' | 'rate-limited';
type Asked = { host: string; method: string };

const HALF_ANSWER = '{"jsonrpc":"2.0","id":1,';
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** A body that sends half an answer and then ends only by being aborted. */
function halfBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(HALF_ANSWER));
      signal?.addEventListener('abort', () => stream.error(abortError()));
    },
  });
}

/** Every roster host behaves as `host` does. Nothing here ends a request except its own abort. */
function fakeFetch(host: Host, asked: Asked[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const { method, id } = JSON.parse(String(init?.body)) as { method: string; id: number };
    asked.push({ host: new URL(String(input)).host, method });
    const signal = init?.signal;
    const json = { 'content-type': 'application/json' };
    if (host === 'silent') {
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(abortError())));
    }
    if (host === 'half-body') return Promise.resolve(new Response(halfBody(signal), { status: 200, headers: json }));
    if (host === 'rate-limited') {
      return Promise.resolve(new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' }), { status: 200, headers: json }));
  }) as typeof fetch;
}

type Ended = { afterMs: number; error: unknown; value: unknown };
const READ = { method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x18160ddd' }, 'latest'] };

/** The chain's transport, built the way wagmi's client builds it: a chain and nothing else. */
function build(chain: Chain) {
  const transport = WAGMI_TRANSPORTS[chain.id]!({ chain });
  const roster = (transport.value as { transports: { value?: { url?: string } }[] }).transports.map(
    (t) => new URL(t.value!.url!).host,
  );
  return { transport, roster };
}

/**
 * One read through the chain's transport on a fake clock, with every roster host behaving
 * as `host`. Reports when the read ended, or null if it was still pending after `watchMs`.
 */
async function readOnFakeClock(chain: Chain, host: Host, watchMs: number, options?: { signal: AbortSignal }) {
  vi.useFakeTimers();
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', fakeFetch(host, asked));
  try {
    const { transport, roster } = build(chain);
    const start = Date.now();
    let ended: Ended | null = null;
    transport.request(READ, options).then(
      (value) => (ended = { afterMs: Date.now() - start, value, error: null }),
      (error: unknown) => (ended = { afterMs: Date.now() - start, value: null, error }),
    );
    // Small steps: a timer armed by a promise chain is only seen once the chain has run.
    while (ended === null && Date.now() - start < watchMs) await vi.advanceTimersByTimeAsync(50);
    return { ended: ended as Ended | null, asked, roster };
  } finally {
    // Dropping the fake clock drops this build's ranker with it.
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

const hostsAsked = (asked: Asked[], method: string) => [...new Set(asked.filter((a) => a.method === method).map((a) => a.host))].sort();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a chain read is given up on one clock, whether a host is silent or stops part-way through its answer', () => {
  // Five minutes: what the notes watched a held read for. A silent roster is given up well inside it.
  const WATCH_MS = 300_000;

  it.each(WAGMI_CHAINS.map((chain) => [chain.name, chain] as const))(
    '%s: hosts that send headers and half a body are given up exactly when silent hosts are',
    async (_name, chain) => {
      const silent = await readOnFakeClock(chain, 'silent', WATCH_MS);
      const stalled = await readOnFakeClock(chain, 'half-body', WATCH_MS);

      // The yardstick: viem's own timeout, per host and per retry.
      expect(silent.ended?.error, 'a silent roster ends as a timeout').toBeInstanceOf(TimeoutError);
      // The claim: half a body ends the same way, at the same moment, after every host was tried.
      expect(stalled.ended, `still pending after ${WATCH_MS / 1000} s`).not.toBeNull();
      expect(stalled.ended?.error).toBeInstanceOf(TimeoutError);
      expect(stalled.ended?.afterMs).toBe(silent.ended?.afterMs);      expect(hostsAsked(stalled.asked, 'eth_call')).toEqual([...stalled.roster].sort());
    },
  );

  // The clock is the signal viem hands its fetch. Given a caller's signal, viem's http
  // transport hands that over instead, and nothing would time the read at all.
  it.each(WAGMI_CHAINS.map((chain) => [chain.name, chain] as const))(
    "%s: a read that carries its caller's own signal is given up all the same",
    async (_name, chain) => {
      const callers = new AbortController();
      const stalled = await readOnFakeClock(chain, 'half-body', WATCH_MS, { signal: callers.signal });
      expect(stalled.ended, `still pending after ${WATCH_MS / 1000} s`).not.toBeNull();
      expect(stalled.ended?.error).toBeInstanceOf(TimeoutError);
    },
  );

  it.each(WAGMI_CHAINS.map((chain) => [chain.name, chain] as const))(
    '%s: the ranker gives up a ping whose body stops, and pings again a minute later',
    async (_name, chain) => {
      vi.useFakeTimers();
      const asked: Asked[] = [];
      vi.stubGlobal('fetch', fakeFetch('half-body', asked));
      const { roster } = build(chain);
      // The ranker waits for every ping of a round before it starts the next one.
      for (let t = 0; t < 70_000; t += 50) await vi.advanceTimersByTimeAsync(50);
      const pings = asked.filter((a) => a.method === 'eth_blockNumber');
      expect(pings).toHaveLength(roster.length * 2);
    },
  );

  it.each(WAGMI_CHAINS.map((chain) => [chain.name, chain] as const))(
    '%s: a whole answer is still read, and a refusal still carries its status and its words',
    async (_name, chain) => {
      const answered = await readOnFakeClock(chain, 'answers', WATCH_MS);
      expect(answered.ended).toMatchObject({ value: '0x2a', error: null });
      expect(answered.ended?.afterMs, 'an answer is not kept waiting on the clock').toBeLessThan(1_000);

      const refused = await readOnFakeClock(chain, 'rate-limited', WATCH_MS);
      const error = refused.ended?.error as HttpRequestError;
      expect(error).toBeInstanceOf(HttpRequestError);
      expect(error.status).toBe(429);
      expect(error.details).toContain('slow down');
    },
  );
});

// What a fake cannot show: how a real fetch ends a body read that is cut off. A real server,
// real sockets and viem's own clock, shortened through the knob viem gives every transport.
describe('against a real server that sends headers and half a body', () => {
  let server: Server;
  let origin = '';
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(HALF_ANSWER);
      // Never ended: the body stays open until the client hangs up.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('a read through the Ethereum roster ends as a timeout, and every host was tried', async () => {
    const hosts = new Set<string>();
    // Left in place when the test ends, so a ranker that outlives it never reaches a real host.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      hosts.add(new URL(String(input)).host);
      return realFetch(origin, init);
    }) as typeof fetch;

    const chain = WAGMI_CHAINS.find((c) => c.id === 1)!;
    const transport = WAGMI_TRANSPORTS[chain.id]!({ chain, timeout: 150 });
    const roster = (transport.value as { transports: { value?: { url?: string } }[] }).transports.map(
      (t) => new URL(t.value!.url!).host,
    );

    const WATCH_MS = 20_000;
    const outcome = await Promise.race([
      transport.request(READ).then(
        () => 'answered',
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve(`still pending after ${WATCH_MS / 1000} s`), WATCH_MS)),
    ]);

    expect(outcome).toBeInstanceOf(TimeoutError);
    expect([...hosts].sort()).toEqual([...roster].sort());
  }, 30_000);
});
