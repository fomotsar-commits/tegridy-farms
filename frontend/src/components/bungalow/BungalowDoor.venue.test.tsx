// The venue's own door — `<BungalowDoor id="venue">` on the index route.
//
// WHY THIS FILE EXISTS. `/` used to render whatever bungalow was in storage, so
// `/` and `/bayla` served a byte-identical page under one title and the door
// grid (gated on `!bungalowIdentity`) simply vanished after any door visit. The
// fix routes `/` through the same component every door uses.
//
// THE FAILURE MODE THAT MAKES THESE TESTS LOAD-BEARING: a bungalow door is
// "already open" when its own id is the active one, but the venue is "already
// open" when NOTHING is active. No stored value is ever equal to 'venue' —
// `byId()` resolves the sentinel to null on purpose — so a version of this that
// reuses the bungalow's `activeId === id` test reloads the homepage FOREVER.
// That bug is invisible to a type checker, survives a render-only test, and
// takes the site's front page down for every visitor, so the no-reload cases
// below are asserted at least as hard as the reload one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BungalowDoor, VENUE_ID } from './BungalowDoor';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS } from '../../lib/bungalows';

const reload = vi.fn();
let realLocation: Location;

beforeEach(() => {
  reload.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  realLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/', search: '', pathname: '/', reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

function renderDoor(id: string) {
  return render(
    <BungalowDoor id={id}>
      <div data-testid="home">home</div>
    </BungalowDoor>,
  );
}

describe('the venue door clears a stored skin', () => {
  it('persists the venue sentinel and reloads when a bungalow is active', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    renderDoor(VENUE_ID);

    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe(VENUE_ID);
    expect(reload).toHaveBeenCalledTimes(1);
    // Nothing paints under the wrong skin on the way through.
    expect(screen.queryByTestId('home')).toBeNull();
  });
});

describe('the venue door does NOT reload when it is already the venue', () => {
  // Each of these would be an infinite reload of the site's front page if the
  // venue's "already here" test were written as `activeId === id`.
  it('a first-time visitor with no stored choice renders straight through', () => {
    renderDoor(VENUE_ID);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('home')).toBeTruthy();
  });

  it('a visitor already carrying the venue sentinel renders straight through', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    renderDoor(VENUE_ID);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('home')).toBeTruthy();
  });

  it('a stored id that is not a live bungalow is already the venue', () => {
    // `byId()` resolves an unknown or non-live id to null, which IS the venue.
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'not-a-bungalow');
    renderDoor(VENUE_ID);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('home')).toBeTruthy();
  });
});

describe('bungalow doors are unchanged by the venue case', () => {
  const liveId = BUNGALOWS.find((b) => b.live && b.id !== 'toweli')!.id;

  it('a door whose skin is already active renders straight through', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, liveId);
    renderDoor(liveId);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('home')).toBeTruthy();
  });

  it('a door still switches away from the venue', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    renderDoor(liveId);
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe(liveId);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a door still switches away from another bungalow', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const other = BUNGALOWS.find((b) => b.live && b.id !== 'bayla' && b.id !== 'toweli')!.id;
    renderDoor(other);
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe(other);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the sentinel cannot collide with a resident', () => {
  // If a bungalow ever took the id 'venue', the sentinel would resolve to a real
  // skin and `/` would render that bungalow — silently reintroducing the exact
  // bug this door exists to fix.
  it('no registry bungalow claims the venue id', () => {
    expect(BUNGALOWS.map((b) => b.id)).not.toContain(VENUE_ID);
  });
});
