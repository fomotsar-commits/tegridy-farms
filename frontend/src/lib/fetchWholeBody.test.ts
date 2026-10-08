// @vitest-environment node
// Node, not jsdom: the streams, Response and AbortSignal here are the ones a real fetch uses.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, ResponseBodyTooLargeError } from 'viem';
import { fetchWholeBody } from './fetchWholeBody';

const bytes = (text: string) => new TextEncoder().encode(text);
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const JSON_HEADERS = { 'content-type': 'application/json' };

/** The network answers every request with what `respond` builds. */
function network(respond: (init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => respond(init));
}

/** How a call ended, read without awaiting a promise that may never end. */
function watch(call: Promise<Response>): { outcome: unknown } {
  const seen: { outcome: unknown } = { outcome: 'pending' };
  call.then(
    (res) => (seen.outcome = res),
    (e: unknown) => (seen.outcome = e),
  );
  return seen;
}
/** Long enough for any promise chain here to run; no timer is involved. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A body that sends `first` and then ends only when `signal` aborts, failing with `failure()`. */
function endsOnlyByAbort(signal: AbortSignal, first: string, failure: () => unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(bytes(first));
      signal.addEventListener('abort', () => stream.error(failure()));
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWholeBody: the answer it returns has already arrived in full', () => {
  it('does not return at the headers: it waits for the last byte, then hands back the same answer', async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes('{"jsonrpc":"2.0","id":1,'));
        finish = () => {
          stream.enqueue(bytes('"result":"0x2a"}'));
          stream.close();
        };
      },
    });
    network(async () => new Response(body, { status: 200, statusText: 'OK', headers: JSON_HEADERS }));

    const seen = watch(fetchWholeBody('https://rpc.test'));
    await settle();
    expect(seen.outcome, 'the headers and half a body are not an answer').toBe('pending');

    finish();
    await settle();
    const res = seen.outcome as Response;
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":"0x2a"}');
  });

  it('keeps a refusal whole: its status, its headers and its words', async () => {
    network(async () => new Response('slow down', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '7' } }));
    const res = await fetchWholeBody('https://rpc.test');
    expect([res.status, res.statusText, res.headers.get('retry-after'), await res.text()]).toEqual([429, 'Too Many Requests', '7', 'slow down']);
  });

  // A fetch that predates streams (a polyfill a wallet's browser injects) has no `body` to
  // read in steps. Its answer must not come back empty: an empty answer reads as a result.
  it('reads an answer whole when the response has no stream to read it from', async () => {
    const answer = '{"jsonrpc":"2.0","id":1,"result":"0x2a"}';
    const noStream = {
      status: 200,
      statusText: 'OK',
      headers: new Headers(JSON_HEADERS),
      body: null,
      arrayBuffer: async () => bytes(answer).buffer,
    } as unknown as Response;
    network(async () => noStream);
    const res = await fetchWholeBody('https://rpc.test');
    expect(await res.text()).toBe(answer);
  });

  it('hands back an answer that has no body, which a 204 must not be given', async () => {
    network(async () => new Response(null, { status: 204 }));
    const res = await fetchWholeBody('https://rpc.test');
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});

describe('fetchWholeBody: a body that stops part-way ends when the signal says so', () => {
  it('waits on half a body until the signal aborts, then fails as an abort', async () => {
    const controller = new AbortController();
    network(async (init) => new Response(endsOnlyByAbort(init!.signal!, '{"jsonrpc":', abortError), { headers: JSON_HEADERS }));

    const seen = watch(fetchWholeBody('https://rpc.test', { signal: controller.signal }));
    await settle();
    expect(seen.outcome).toBe('pending');

    controller.abort();
    await settle();
    expect(seen.outcome).toMatchObject({ name: 'AbortError' });
  });

  // An abort during the body read does not always come back as one. Node reports a cut
  // stream as a TypeError, and a parser fed half a body reports bad JSON.
  it.each([
    ['a TypeError', () => new TypeError('terminated')],
    ['a SyntaxError', () => new SyntaxError('Unexpected end of JSON input')],
    ['a string', () => 'aborted'],
  ])('reads "aborted" from the signal, not from the error: %s still fails as an abort', async (_label, failure) => {
    const controller = new AbortController();
    network(async (init) => new Response(endsOnlyByAbort(init!.signal!, '{"jsonrpc":', failure), { headers: JSON_HEADERS }));

    const seen = watch(fetchWholeBody('https://rpc.test', { signal: controller.signal }));
    await settle();
    controller.abort();
    await settle();
    expect(seen.outcome).toMatchObject({ name: 'AbortError' });
  });

  it('a body that fails with the signal untouched keeps its own error, and is not called a timeout', async () => {
    const reset = new TypeError('network error');
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes('{"jsonrpc":'));
        stream.error(reset);
      },
    });
    network(async () => new Response(body, { headers: JSON_HEADERS }));
    await expect(fetchWholeBody('https://rpc.test', { signal: new AbortController().signal })).rejects.toBe(reset);
  });

  it('a request refused before any header keeps its own error too', async () => {
    const refused = new TypeError('Failed to fetch');
    network(() => Promise.reject(refused));
    await expect(fetchWholeBody('https://rpc.test', { signal: new AbortController().signal })).rejects.toBe(refused);
  });
});

describe("fetchWholeBody: viem's limit on an answer's size still holds", () => {
  const MEBIBYTE = 1_048_576;
  const VIEM_LIMIT = 10 * MEBIBYTE;

  /** A body with no end, one mebibyte at a time. Counts what was taken and notes a cancel. */
  function endless() {
    const taken = { bytes: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          taken.bytes += MEBIBYTE;
          stream.enqueue(new Uint8Array(MEBIBYTE));
        },
        cancel() {
          taken.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, taken };
  }

  it('stops reading just past the limit and hangs up, instead of holding a body with no end', async () => {
    const { body, taken } = endless();
    network(async () => new Response(body, { headers: JSON_HEADERS }));

    const res = await fetchWholeBody('https://rpc.test');
    expect(taken.cancelled).toBe(true);
    expect(taken.bytes).toBe(VIEM_LIMIT + MEBIBYTE);
    expect((await res.arrayBuffer()).byteLength, 'over the limit, so viem still refuses it').toBeGreaterThan(VIEM_LIMIT);
  });

  it("through a viem transport, the over-long answer ends as viem's own too-large error", async () => {
    network(async () => new Response(endless().body, { headers: JSON_HEADERS }));
    const transport = http('https://rpc.test', { fetchFn: fetchWholeBody })({ retryCount: 0 });
    await expect(transport.request({ method: 'eth_blockNumber' })).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it('an answer exactly at the limit is read whole', async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          if (sent === VIEM_LIMIT) {
            stream.close();
            return;
          }
          sent += MEBIBYTE;
          stream.enqueue(new Uint8Array(MEBIBYTE));
        },
      },
      { highWaterMark: 0 },
    );
    network(async () => new Response(body, { headers: JSON_HEADERS }));
    const res = await fetchWholeBody('https://rpc.test');
    expect((await res.arrayBuffer()).byteLength).toBe(VIEM_LIMIT);
  });
});
