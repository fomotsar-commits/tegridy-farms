// "Open <symbol>" switches the skin in place and stays on the Earn page, which
// re-reads the room through the skin store. A document navigation would load
// the app again for a switch the store already carries.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { VenuePoolIndex } from './VenuePoolIndex';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS, subscribeActiveBungalow } from '../../lib/bungalows';

let realLocation: Location | null = null;

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (realLocation) Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  realLocation = null;
  localStorage.clear();
});

describe('VenuePoolIndex', () => {
  it('opens a room in place, with no document navigation', () => {
    realLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost/farm', search: '', pathname: '/farm', assign, reload: vi.fn() },
    });
    const room = BUNGALOWS.find((b) => b.live && (b.stakePool || b.ladderPool))!;
    let path = '';
    function WhereAmI() {
      path = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/farm']}>
        <VenuePoolIndex />
        <WhereAmI />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: `Open ${room.symbol}` }));
    expect(assign, 'no document navigation').not.toHaveBeenCalled();
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe(room.id);
    expect(path).toBe('/farm');
    expect(window.scrollTo, 'the room opens at its top').toHaveBeenCalledWith(0, 0);
  });

  it('announces the switch, so the page and the nav read the new room', () => {
    const room = BUNGALOWS.find((b) => b.live && (b.stakePool || b.ladderPool))!;
    const heard = vi.fn();
    const off = subscribeActiveBungalow(heard);
    try {
      render(
        <MemoryRouter initialEntries={['/farm']}>
          <VenuePoolIndex />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: `Open ${room.symbol}` }));
    } finally {
      off();
    }
    expect(heard).toHaveBeenCalled();
  });
});
