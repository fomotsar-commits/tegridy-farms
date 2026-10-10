// Two ways a host goes quiet, for tests on a fake clock. Neither ends by itself: only the
// request's own abort ends it, which is all a real quiet host leaves its caller.

import { vi } from 'vitest';

/** A request that is never answered. It rejects when `signal` aborts, as fetch does. */
export function neverAnswered(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);
  });
}

/**
 * An answer whose headers came and whose body stops half-way. Reading it ends only when
 * `signal` aborts, and then as a parse error, not an AbortError: code that asks the
 * error's name whether it timed out is told it did not.
 */
export function stalledBody(signal?: AbortSignal | null, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"half":'));
      signal?.addEventListener('abort', () => stream.error(new SyntaxError('Unexpected end of JSON input')));
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

export interface Ended<T> {
  afterMs: number;
  value?: T;
  error?: unknown;
}

/**
 * Runs `call` on the fake clock. Says how it ended and when, or null if it was still
 * pending after `watchMs`. Small steps: a timer armed by a promise chain is only seen
 * once the chain has run.
 */
export async function watch<T>(call: () => Promise<T>, watchMs: number, stepMs = 50): Promise<Ended<T> | null> {
  const start = Date.now();
  const seen: { ended: Ended<T> | null } = { ended: null };
  void call().then(
    (value) => {
      seen.ended = { afterMs: Date.now() - start, value };
    },
    (error: unknown) => {
      seen.ended = { afterMs: Date.now() - start, error };
    },
  );
  while (seen.ended === null && Date.now() - start < watchMs) await vi.advanceTimersByTimeAsync(stepMs);
  return seen.ended;
}
