// A door changes the skin in place: it writes the choice during its own render,
// paints its children on that same render, announces after commit, and never
// reloads. The venue's door is open when NO bungalow is active, the inverse of
// a room's `activeId === id`; conflating the two would switch the front page on
// every visit, so those no-switch cases are pinned as hard as the switches.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BungalowDoor, VENUE_ID } from './BungalowDoor';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS, subscribeActiveBungalow } from '../../lib/bungalows';

const reload = vi.fn();
const assign = vi.fn();
let realLocation: Location;
const liveId = BUNGALOWS.find((b) => b.live && b.id !== 'toweli' && b.id !== 'bayla')!.id;

beforeEach(() => {
  reload.mockClear();
  assign.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  realLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/', search: '', pathname: '/', reload, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  vi.restoreAllMocks();
});

/** Renders a door and records what its home read from storage on each render. */
function renderDoor(id: string) {
  const seen: (string | null)[] = [];
  function Home() {
    seen.push(localStorage.getItem(BUNGALOW_STORAGE_KEY));
    return <div data-testid="home">home</div>;
  }
  const view = render(
    <BungalowDoor id={id}>
      <Home />
    </BungalowDoor>,
  );
  return { ...view, seen };
}

/** Renders a door while listening to the skin store. */
function renderDoorListening(id: string) {
  const heard = vi.fn();
  const unsubscribe = subscribeActiveBungalow(heard);
  try {
    return { ...renderDoor(id), heard };
  } finally {
    unsubscribe();
  }
}

function expectOpenedInPlace(door: { seen: (string | null)[] }, stored: string) {
  expect(reload, 'a door never reloads the document').not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe(stored);
  expect(screen.getByTestId('home')).toBeTruthy();
  expect(door.seen[0], 'the home renders under the new skin on its first render').toBe(stored);
}

describe('a door switches the skin in place', () => {
  it('the venue door clears a stored room and renders home on the same render', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    expectOpenedInPlace(renderDoor(VENUE_ID), VENUE_ID);
  });

  it('a room door switches away from the venue', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    expectOpenedInPlace(renderDoor(liveId), liveId);
  });

  it('a room door switches away from another room', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    expectOpenedInPlace(renderDoor(liveId), liveId);
  });

  it('a cold arrival at a room door writes the choice and renders home once', () => {
    const door = renderDoor('bayla');
    expectOpenedInPlace(door, 'bayla');
    expect(door.seen).toEqual(['bayla']);
  });

  it('a switch is announced to the skin store after commit', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const door = renderDoorListening(VENUE_ID);
    expect(door.heard).toHaveBeenCalled();
    expect(door.seen[0]).toBe(VENUE_ID);
  });

  it('a door strips a crafted ?bungalow= so the door stays the choice', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost/bayla?bungalow=toweli', search: '?bungalow=toweli', pathname: '/bayla', reload, assign },
    });
    renderDoor('bayla');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(String(replaceState.mock.calls[0]![2])).toBe('http://localhost/bayla');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a door that is already open writes nothing', () => {
  it('a first-time visitor at the venue door', () => {
    renderDoor(VENUE_ID);
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a visitor already carrying the venue sentinel', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, VENUE_ID);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderDoor(VENUE_ID);
    expect(setItem).not.toHaveBeenCalledWith(BUNGALOW_STORAGE_KEY, expect.anything());
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a stored id that is not a live bungalow is already the venue', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'not-a-bungalow');
    renderDoor(VENUE_ID);
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe('not-a-bungalow');
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a room door whose skin is already active', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, liveId);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderDoor(liveId);
    expect(setItem).not.toHaveBeenCalledWith(BUNGALOW_STORAGE_KEY, expect.anything());
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('blocked storage cannot loop', () => {
  it('renders home under the current skin when the write fails', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderDoor(liveId);
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe('bayla');
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the sentinel cannot collide with a resident', () => {
  // A bungalow with the id 'venue' would make `/` render that bungalow.
  it('no registry bungalow claims the venue id', () => {
    expect(BUNGALOWS.map((b) => b.id)).not.toContain(VENUE_ID);
  });
});
