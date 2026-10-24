// @vitest-environment node
//
// The page's budget: what the proxy's last answer said is left of this tab's calls a
// minute. An optional read (history) refuses to start under the floor so the live reads
// keep working. A missing header is no information, and the gate then does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONAL_READ_FLOOR } from './readFetch';

type Budget = typeof import('./rpcBudget');
let b: Budget;

// Module state is per tab in the browser; here it is per test.
beforeEach(async () => {
  vi.resetModules();
  b = await import('./rpcBudget');
});
afterEach(() => {
  vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** A proxy answer with the headers api/_lib/ratelimit.js sets (or without them). */
function answer(remaining: string | null, resetSec?: number): Response {
  const headers: Record<string, string> = {};
  if (remaining !== null) headers['X-RateLimit-Remaining'] = remaining;
  if (resetSec !== undefined) headers['X-RateLimit-Reset'] = String(resetSec);
  return new Response('{}', { status: 200, headers });
}

describe('rpcBudget', () => {
  it('knows nothing before a header: remaining() is null and optional reads are allowed', () => {
    expect(b.remaining()).toBeNull();
    expect(b.optionalReadAllowed()).toBe(true);
    // An answer with no header (vite preview, the e2e proxy) teaches nothing.
    b.noteResponse(answer(null));
    expect(b.remaining()).toBeNull();
    expect(b.optionalReadAllowed()).toBe(true);
  });

  it('59 left refuses an optional read; 60 allows it; the floor is 60', () => {
    expect(OPTIONAL_READ_FLOOR).toBe(60);
    b.noteResponse(answer('59', nowSec() + 60));
    expect(b.remaining()).toBe(59);
    expect(b.optionalReadAllowed()).toBe(false);
    b.noteResponse(answer('60', nowSec() + 60));
    expect(b.remaining()).toBe(60);
    expect(b.optionalReadAllowed()).toBe(true);
    b.noteResponse(answer('0', nowSec() + 60));
    expect(b.remaining()).toBe(0);
    expect(b.optionalReadAllowed()).toBe(false);
  });

  it('the newest answer wins, whichever way the number moved', () => {
    b.noteResponse(answer('12', nowSec() + 60));
    b.noteResponse(answer('250', nowSec() + 60));
    expect(b.remaining()).toBe(250);
    expect(b.optionalReadAllowed()).toBe(true);
    b.noteResponse(answer('3', nowSec() + 60));
    expect(b.remaining()).toBe(3);
    expect(b.optionalReadAllowed()).toBe(false);
  });

  it('a window that has reset is no information again: the old number does not pause the page for good', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    b.noteResponse(answer('5', nowSec() + 60));
    expect(b.remaining()).toBe(5);
    expect(b.optionalReadAllowed()).toBe(false);
    vi.setSystemTime(new Date('2026-10-06T12:00:59Z'));
    expect(b.remaining()).toBe(5);
    vi.setSystemTime(new Date('2026-10-06T12:01:00Z'));
    expect(b.remaining()).toBeNull();
    expect(b.optionalReadAllowed()).toBe(true);
    // Without a reset header the number is kept: nothing says when it stops being true.
    b.noteResponse(answer('5'));
    vi.setSystemTime(new Date('2026-10-06T13:00:00Z'));
    expect(b.remaining()).toBe(5);
  });

  it('a header that is not a count is ignored, and the last good one stands', () => {
    b.noteResponse(answer('40', nowSec() + 60));
    for (const junk of ['abc', '-1', '', '1.5', 'NaN']) b.noteResponse(answer(junk, nowSec() + 60));
    expect(b.remaining()).toBe(40);
    // A reset that is not a time is read as "no reset known", the count still counts.
    b.noteResponse(new Response('{}', { headers: { 'X-RateLimit-Remaining': '7', 'X-RateLimit-Reset': 'soon' } }));
    expect(b.remaining()).toBe(7);
  });

  it('the paused sentence, verbatim, with no em dash and no forecast word', () => {
    expect(b.pausedText()).toBe('History reads are paused so this page’s live reads keep working. Try again in about a minute.');
    expect(b.pausedText()).not.toMatch(/—/);
    expect(b.pausedText()).not.toMatch(/\bAPR\b|\bAPY\b|yield of|a year|annual|per day|per week|rate of return|earn fees on every trade/i);
  });
});
