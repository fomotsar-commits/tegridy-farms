import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ERROR_REPORTING_STARTS_AT_MS } from '../../api/_lib/errorPolicy.js';

// We need to test internal functions. The module uses module-level state,
// so we re-import fresh for some tests via vi.resetModules().
// For sanitize/sanitizeUrl we test through the public reportError API
// and inspect localStorage side-effects.
//
// THE CLOCK IS PINNED to a fixed instant after 2026-10-16 (the day reports may first
// be sent), so no test here depends on the day it runs. The date itself is tested in
// its own block at the end, on both sides.
const OPEN = new Date('2026-11-20T12:00:00Z');

describe('errorReporting', () => {
  beforeEach(() => {
    localStorage.clear();
    // R046 H-1: reportError() is now deny-by-default behind the telemetry
    // consent gate (lib/consent.ts). Grant consent so the reporting pipeline
    // under test actually runs; the gate itself is covered separately below.
    localStorage.setItem('tegridy_telemetry_consent', 'granted');
    vi.useFakeTimers();
    vi.setSystemTime(OPEN);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no endpoint'))));
    // Ensure no VITE_ERROR_ENDPOINT so errors go to localStorage
    vi.stubEnv('VITE_ERROR_ENDPOINT', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    const mod = await import('./errorReporting');
    return mod;
  }

  function getStoredErrors(): Array<{ message: string; stack?: string; url: string }> {
    const raw = localStorage.getItem('tegridy_error_log');
    return raw ? JSON.parse(raw) : [];
  }

  it('reports a basic error to localStorage after flush', async () => {
    const { reportError } = await getModule();
    reportError(new Error('test error'));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored.length).toBe(1);
    expect(stored[0].message).toBe('test error');
  });

  it('strips private keys from error messages', async () => {
    const { reportError } = await getModule();
    const fakeKey = '0x' + 'a'.repeat(64);
    reportError(new Error(`Failed with key ${fakeKey}`));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].message).not.toContain(fakeKey);
    expect(stored[0].message).toContain('[REDACTED]');
  });

  it('strips mnemonic phrases from error messages', async () => {
    const { reportError } = await getModule();
    const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    reportError(new Error(`Wallet import failed: ${mnemonic}`));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].message).not.toContain('abandon ability');
    expect(stored[0].message).toContain('[REDACTED]');
  });

  it('strips bearer tokens from error messages', async () => {
    const { reportError } = await getModule();
    reportError(new Error('Auth failed: bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].message).not.toContain('eyJhbG');
    expect(stored[0].message).toContain('[REDACTED]');
  });

  it('strips JWT tokens from error messages', async () => {
    const { reportError } = await getModule();
    reportError(new Error('Token: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0'));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].message).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  it('sanitizes URLs by removing query params', async () => {
    const { reportError } = await getModule();
    // Simulate being on a page with query params. The real Location object is put
    // back afterwards, not a stand-in with only `href`: later tests resolve a
    // same-origin endpoint against window.location.origin.
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { href: 'https://app.tegridy.farms/swap?token=secret&ref=abc' },
      writable: true,
      configurable: true,
    });
    reportError(new Error('url test'));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].url).not.toContain('token=secret');
    expect(stored[0].url).not.toContain('ref=abc');
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('deduplicates identical errors within 60s window', async () => {
    const { reportError } = await getModule();
    // Reuse the same Error object so message + stack are identical
    const err = new Error('dup error');
    reportError(err);
    reportError(err);
    reportError(err);
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    const matching = stored.filter((e: { message: string }) => e.message === 'dup error');
    expect(matching.length).toBe(1);
  });

  it('allows same error after dedup window expires', async () => {
    const { reportError } = await getModule();
    const err = new Error('timed error');
    reportError(err);
    vi.advanceTimersByTime(6000); // flush first
    vi.advanceTimersByTime(61_000); // pass dedup window
    reportError(err);
    vi.advanceTimersByTime(6000); // flush second
    const stored = getStoredErrors();
    const matching = stored.filter((e: { message: string }) => e.message === 'timed error');
    expect(matching.length).toBe(2);
  });

  it('batches multiple different errors into one flush', async () => {
    const { reportError } = await getModule();
    reportError(new Error('error A'));
    reportError(new Error('error B'));
    reportError(new Error('error C'));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored.length).toBe(3);
  });

  it('truncates long messages to MAX_FIELD_LENGTH', async () => {
    const { reportError } = await getModule();
    const longMsg = 'x'.repeat(1000);
    reportError(new Error(longMsg));
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored[0].message.length).toBeLessThanOrEqual(500);
  });

  it('handles non-Error objects gracefully', async () => {
    const { reportError } = await getModule();
    reportError('plain string error');
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored.length).toBe(1);
    expect(stored[0].message).toBe('plain string error');
  });

  it('handles null/undefined error objects', async () => {
    const { reportError } = await getModule();
    reportError(null);
    reportError(undefined);
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    // Both should be recorded (they are different string representations)
    expect(stored.length).toBeGreaterThanOrEqual(1);
  });

  it('drops reports entirely while consent is not granted (R046 H-1 deny-by-default)', async () => {
    localStorage.removeItem('tegridy_telemetry_consent');
    const { reportError } = await getModule();
    reportError(new Error('pre-consent error'));
    vi.advanceTimersByTime(6000);
    expect(getStoredErrors().length).toBe(0);
  });

  it('F482: persists the batch to localStorage on an HTTP error response (4xx/5xx)', async () => {
    // fetch only rejects on network error; a 500 resolves with ok=false. The
    // old code never checked res.ok, so the batch was silently lost.
    vi.stubEnv('VITE_ERROR_ENDPOINT', 'https://errors.tegridy.farms/ingest');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );
    const { reportError } = await getModule();
    reportError(new Error('http-500 error'));
    vi.advanceTimersByTime(6000);
    // Let the resolved-promise .then() microtask run before asserting.
    await vi.runAllTimersAsync();
    const stored = getStoredErrors();
    expect(stored.some((e) => e.message === 'http-500 error')).toBe(true);
  });

  it('limits stored errors to MAX_BUFFER (50)', async () => {
    const { reportError } = await getModule();
    for (let i = 0; i < 60; i++) {
      reportError(new Error(`error-${i}`));
    }
    vi.advanceTimersByTime(6000);
    const stored = getStoredErrors();
    expect(stored.length).toBeLessThanOrEqual(50);
  });
});

// ── Sending to /api/errors: the operator gap, consent at send time, and backoff ──
//
// The route answers 503 until migration 026 is applied and Upstash is set, so the
// client must treat a refusal as "later", not "lost" and not "now, again". Each
// failure doubles a wait that is kept in localStorage, so a reload, which is what a
// crash loop does, cannot reset it.
describe('errorReporting: delivery', () => {
  const ENDPOINT = '/api/errors';
  type Sent = { consent?: string; errors: Array<{ message: string; timestamp: number }> };

  let fetchMock: ReturnType<typeof vi.fn>;
  let reply: () => Promise<Response>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('tegridy_telemetry_consent', 'granted');
    vi.useFakeTimers();
    vi.setSystemTime(OPEN);
    vi.stubEnv('VITE_ERROR_ENDPOINT', ENDPOINT);
    reply = () => Promise.resolve(new Response('{}', { status: 200 }));
    fetchMock = vi.fn(() => reply());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const load = () => import('./errorReporting');
  const stored = (): Array<{ message: string }> => JSON.parse(localStorage.getItem('tegridy_error_log') || '[]');
  /** The body of a request. A bare array is read as its entries, so the tests that are
   *  not about the envelope fail on what they are about. */
  const sent = (call = -1): Sent => {
    const body = JSON.parse(fetchMock.mock.calls.at(call)![1].body as string);
    return Array.isArray(body) ? { errors: body } : body;
  };
  /** Run the 5s batch timer and let the fetch promise chain settle. */
  const settle = async (ms = 6000) => { await vi.advanceTimersByTimeAsync(ms); };
  const unavailable = (retryAfter?: string) => () =>
    Promise.resolve(new Response('{"error":"Error sink unavailable"}', {
      status: 503,
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }));

  it('posts to a same-origin path, the shape .env.example configures', async () => {
    const { reportError } = await load();
    reportError(new Error('relative endpoint'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT);
  });

  it('never posts to a protocol-relative endpoint, which would leave the origin', async () => {
    // On an https page, as in production: there `//evil.example/x` resolved against
    // the origin is https://evil.example/x, which every later check would pass.
    const realLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { href: 'https://memetics.finance/farm', origin: 'https://memetics.finance' },
      writable: true,
      configurable: true,
    });
    try {
      vi.stubEnv('VITE_ERROR_ENDPOINT', '//evil.example/x');
      const { reportError } = await load();
      reportError(new Error('protocol relative'));
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(stored().map((e) => e.message)).toContain('protocol relative');
    } finally {
      Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true });
    }
  });

  it('states consent in the batch it sends', async () => {
    const { reportError } = await load();
    reportError(new Error('with consent'));
    await settle();
    expect(sent()).toEqual({ consent: 'granted', errors: [expect.objectContaining({ message: 'with consent' })] });
  });

  it('sends no cookie and no referrer, so a record carries nothing that names the session or the query string', async () => {
    const { reportError } = await load();
    reportError(new Error('bare request'));
    await settle();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
  });

  it('checks consent again at send time: a withdrawal before the flush sends nothing', async () => {
    const { reportError } = await load();
    const { setConsent } = await import('./consent');
    reportError(new Error('captured while granted'));
    setConsent('denied');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('a withdrawal clears what is waiting in the buffer', async () => {
    const { installGlobalHandlers } = await load();
    const { setConsent } = await import('./consent');
    localStorage.setItem('tegridy_error_log', JSON.stringify([{ message: 'waiting', timestamp: Date.now(), url: '' }]));
    installGlobalHandlers();
    setConsent('denied');
    expect(stored()).toEqual([]);
  });

  it('a buffer left from earlier is not sent once consent is gone', async () => {
    localStorage.setItem('tegridy_error_log', JSON.stringify([{ message: 'left over', timestamp: Date.now(), url: '' }]));
    localStorage.removeItem('tegridy_telemetry_consent');
    const { installGlobalHandlers } = await load();
    installGlobalHandlers();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('a 503 keeps the batch in the buffer', async () => {
    reply = unavailable();
    const { reportError } = await load();
    reportError(new Error('sink not ready'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored().map((e) => e.message)).toEqual(['sink not ready']);
  });

  it('a 503 starts a backoff: a crash loop does not become a request every five seconds', async () => {
    reply = unavailable();
    const { reportError } = await load();
    for (let i = 0; i < 12; i++) {
      reportError(new Error(`loop ${i}`));
      await settle(5000);
    }
    // One minute of errors, every one of them buffered, and one request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored().length).toBe(12);
  });

  it('the backoff survives a reload', async () => {
    reply = unavailable();
    let mod = await load();
    mod.reportError(new Error('before reload'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    mod = await load();
    mod.installGlobalHandlers();
    mod.reportError(new Error('after reload'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After when it asks for longer than the backoff', async () => {
    reply = unavailable('600');
    const { reportError } = await load();
    reportError(new Error('first'));
    await settle();
    await settle(4 * 60_000);
    // Four minutes on: past the one-minute backoff, inside the ten the server asked for.
    reportError(new Error('at four minutes'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await settle(6 * 60_000);
    reportError(new Error('after ten minutes'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the wait doubles on each refusal and never passes an hour', async () => {
    reply = unavailable();
    const { reportError } = await load();
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 400 && gaps.length < 8; i++) {
      const before = fetchMock.mock.calls.length;
      reportError(new Error(`e${i}`));
      await settle(30_000);
      if (fetchMock.mock.calls.length > before) {
        gaps.push(Date.now() - last);
        last = Date.now();
      }
    }
    // Sampled every 30s, so each gap is the wait rounded up to the next sample.
    expect(gaps.slice(1, 4).map((g) => Math.round(g / 60_000))).toEqual([1, 2, 4]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(61 * 60_000);
  });

  it('once the sink answers, the buffer is sent and emptied', async () => {
    reply = unavailable();
    const { reportError } = await load();
    reportError(new Error('during the gap'));
    await settle();
    expect(stored().length).toBe(1);

    reply = () => Promise.resolve(new Response('{}', { status: 200 }));
    await settle(61_000);
    reportError(new Error('after the gap'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent().errors.map((e) => e.message)).toEqual(['during the gap', 'after the gap']);
    expect(stored()).toEqual([]);
  });

  it('a page load with a buffer sends it without waiting for a new error', async () => {
    localStorage.setItem('tegridy_error_log', JSON.stringify([{ message: 'from last visit', timestamp: Date.now() - 60_000, url: '' }]));
    const { installGlobalHandlers } = await load();
    installGlobalHandlers();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().errors.map((e) => e.message)).toEqual(['from last visit']);
  });

  it('does not replay entries older than a week', async () => {
    const week = 7 * 24 * 60 * 60_000;
    localStorage.setItem('tegridy_error_log', JSON.stringify([
      { message: 'stale', timestamp: Date.now() - week - 1, url: '' },
      { message: 'fresh', timestamp: Date.now() - 1000, url: '' },
    ]));
    const { installGlobalHandlers } = await load();
    installGlobalHandlers();
    await settle();
    expect(sent().errors.map((e) => e.message)).toEqual(['fresh']);
  });

  it('never sends more than 50 entries in one request', async () => {
    const { reportError } = await load();
    for (let i = 0; i < 60; i++) reportError(new Error(`burst ${i}`));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().errors.length).toBe(50);
  });

  it('does not start a second request while one is still open', async () => {
    reply = () => new Promise<Response>(() => {});
    const { reportError } = await load();
    reportError(new Error('slow one'));
    await settle();
    reportError(new Error('while waiting'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored().map((e) => e.message)).toEqual(['while waiting']);
  });
});

// ── 2026-10-16T00:00:00Z: the first instant a report may leave the browser ──
//
// The owner's decision of 2026-10-02: the Privacy page gives 14 days' notice (its own
// section 9), so nothing is sent before the date even if VITE_ERROR_ENDPOINT is set early,
// and nothing that happened before the date is sent after it. The date is the shared
// constant in api/_lib/errorPolicy.js, which api/errors.js enforces again.
describe('errorReporting: nothing is sent before 2026-10-16', () => {
  const START = ERROR_REPORTING_STARTS_AT_MS;
  const BATCH_MS = 5_000;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('tegridy_telemetry_consent', 'granted');
    vi.useFakeTimers();
    vi.stubEnv('VITE_ERROR_ENDPOINT', '/api/errors');
    fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const load = () => import('./errorReporting');
  const sentMessages = () =>
    fetchMock.mock.calls.flatMap((c) => (JSON.parse(c[1].body as string).errors as Array<{ message: string }>).map((e) => e.message));

  it('is the constant the server enforces: 2026-10-16T00:00:00Z', () => {
    expect(new Date(START).toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });

  it('a batch whose send falls one millisecond before the start is not sent, with the endpoint set', async () => {
    vi.setSystemTime(START - BATCH_MS - 1);
    const { reportError } = await load();
    reportError(new Error('too early'));
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(Date.now()).toBe(START - 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on the day the notice was posted, nothing is sent however long the page stays open', async () => {
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const { reportError, installGlobalHandlers } = await load();
    installGlobalHandlers();
    for (let i = 0; i < 5; i++) {
      reportError(new Error(`early ${i}`));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('from the start instant, a report is sent', async () => {
    vi.setSystemTime(START);
    const { reportError } = await load();
    reportError(new Error('on time'));
    await vi.advanceTimersByTimeAsync(BATCH_MS + 1000);
    expect(sentMessages()).toEqual(['on time']);
  });

  it('a report captured before the start is never sent after it; a later one is', async () => {
    vi.setSystemTime(START - 60_000);
    const { reportError } = await load();
    reportError(new Error('captured before'));
    await vi.advanceTimersByTimeAsync(BATCH_MS + 1000);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.setSystemTime(START + 60_000);
    reportError(new Error('captured after'));
    await vi.advanceTimersByTimeAsync(BATCH_MS + 1000);
    expect(sentMessages()).toEqual(['captured after']);
    expect(localStorage.getItem('tegridy_error_log')).toBeNull();
  });

  it('a buffer left from before the start is dropped on the first page load after it, not sent', async () => {
    localStorage.setItem('tegridy_error_log', JSON.stringify([{ message: 'last week', timestamp: START - 1, url: '' }]));
    vi.setSystemTime(START + 60_000);
    const { installGlobalHandlers } = await load();
    installGlobalHandlers();
    await vi.advanceTimersByTimeAsync(BATCH_MS + 1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('tegridy_error_log')).toBeNull();
  });
});
