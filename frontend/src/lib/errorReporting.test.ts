import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// We need to test internal functions. The module uses module-level state,
// so we re-import fresh for some tests via vi.resetModules().
// For sanitize/sanitizeUrl we test through the public reportError API
// and inspect localStorage side-effects.

describe('errorReporting', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
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
    // Simulate being on a page with query params
    const originalHref = window.location.href;
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
      value: { href: originalHref },
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
