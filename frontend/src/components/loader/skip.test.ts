// The arrival decision (wave seven, element A).
//
// This module is the ONE place that decides whether the venue's curtain plays at
// all, and it runs eagerly during render before a single frame. Everything it
// refuses is a visitor who must not be made to wait:
//
//   - somebody who has already arrived, ONCE PER BROWSER now, not per tab;
//   - a reduced-motion visitor;
//   - a deep link into a room, because the room IS the arrival there;
//   - a shared read, because /read/<address> must open ON THE NUMBER.
//
// The two-storage split is the subtle part and is pinned here: localStorage is
// the durable record, sessionStorage is a transient suppression the art studios
// and the e2e fixtures depend on, and a room or ?heat= arrival CONSUMES NEITHER.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNGALOWS } from '../../lib/bungalows';
import { ARRIVAL_SEEN_KEY, hasSeenArrival, markArrivalSeen, shouldSkipAtMount } from './skip';

const realMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function at(path: string) {
  window.history.replaceState({}, '', path);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setReducedMotion(false);
  at('/');
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  localStorage.clear();
  sessionStorage.clear();
  at('/');
});

describe('the arrival plays for a stranger', () => {
  it('does not skip on the venue root with nothing stored', () => {
    expect(shouldSkipAtMount()).toBe(false);
  });

  it('does not skip on an ordinary route that is not a room', () => {
    for (const p of ['/liquidity', '/launch', '/island', '/scan', '/farm']) {
      at(p);
      expect(shouldSkipAtMount(), `${p} is not a room`).toBe(false);
    }
  });
});

describe('once per BROWSER, not once per tab', () => {
  it('skips when the durable record is set', () => {
    markArrivalSeen();
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('writes the durable record to localStorage, never to sessionStorage', () => {
    markArrivalSeen();
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBe('1');
    expect(sessionStorage.getItem(ARRIVAL_SEEN_KEY)).toBeNull();
  });

  it('still honours a per-session suppression', () => {
    // The art studios write this to keep the splash out of their same-origin
    // preview iframes; the e2e fixtures seed it per context. Both must keep working.
    sessionStorage.setItem(ARRIVAL_SEEN_KEY, '1');
    expect(hasSeenArrival()).toBe(true);
    expect(shouldSkipAtMount()).toBe(true);
  });
});

describe('reduced motion', () => {
  it('skips and records it durably, so a new tab does not ask again', () => {
    setReducedMotion(true);
    expect(shouldSkipAtMount()).toBe(true);
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBe('1');
  });
});

describe('a room deep link is its own arrival', () => {
  it.each(BUNGALOWS.map((b) => b.id))('skips the curtain on /%s', (slug) => {
    at(`/${slug}`);
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('skips on the spelled-out towelie alias that App.tsx also routes', () => {
    at('/towelie');
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('skips on a deeper path inside a room', () => {
    at('/bayla/anything');
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('is case-insensitive, because a pasted link may not be', () => {
    at('/BAYLA');
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('does NOT consume the arrival — the venue still gets its curtain later', () => {
    at('/bayla');
    expect(shouldSkipAtMount()).toBe(true);
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBeNull();
    at('/');
    expect(shouldSkipAtMount()).toBe(false);
  });

  it('matches the real registry, so it cannot drift from the routes', () => {
    // If a bungalow is added to BUNGALOWS, its door is gated automatically.
    expect(BUNGALOWS.length).toBeGreaterThan(1);
    at(`/${BUNGALOWS[BUNGALOWS.length - 1].id}`);
    expect(shouldSkipAtMount()).toBe(true);
  });
});

describe('a shared read opens on the number', () => {
  it('skips the curtain on a ?heat= arrival', () => {
    at('/?heat=0x0000000000000000000000000000000000000000');
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('skips even when the address is malformed — the instrument answers that', () => {
    at('/?heat=not-an-address');
    expect(shouldSkipAtMount()).toBe(true);
  });

  it('does not skip for an unrelated query string', () => {
    at('/?ref=someone');
    expect(shouldSkipAtMount()).toBe(false);
  });

  it('does NOT consume the arrival', () => {
    at('/?heat=0x0000000000000000000000000000000000000000');
    expect(shouldSkipAtMount()).toBe(true);
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBeNull();
  });
});

describe('storage that throws', () => {
  it('reads as not-yet-arrived rather than crashing the shell', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('privacy mode');
    });
    try {
      expect(hasSeenArrival()).toBe(false);
      expect(shouldSkipAtMount()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('lets the splash play again rather than throwing when the write fails', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      expect(() => markArrivalSeen()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
