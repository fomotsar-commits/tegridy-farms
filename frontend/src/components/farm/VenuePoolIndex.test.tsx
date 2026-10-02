// "Open <symbol>" is a real link to that pool's own address, /earn/<id>, and it
// navigates inside the app: the pool's route enters its room on arrival
// (App.tsx EarnPoolRoute). Until 2026-09-30 it was a button that switched the
// stored room and re-rendered /farm, so the address never said which pool, and
// nothing on the pool led back here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { VenuePoolIndex } from './VenuePoolIndex';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS } from '../../lib/bungalows';

let realLocation: Location | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (realLocation) Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  realLocation = null;
  localStorage.clear();
});

describe('VenuePoolIndex', () => {
  it("links each pool to its own address and opens it inside the app", () => {
    realLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost/earn', search: '', pathname: '/earn', assign, reload: vi.fn() },
    });
    const room = BUNGALOWS.find((b) => b.live && (b.stakePool || b.ladderPool))!;
    let path = '';
    function WhereAmI() {
      path = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/earn']}>
        <VenuePoolIndex />
        <WhereAmI />
      </MemoryRouter>,
    );
    const open = screen.getByRole('link', { name: `Open ${room.symbol}` });
    expect(open).toHaveAttribute('href', `/earn/${room.id}`);
    fireEvent.click(open);
    expect(assign, 'no document navigation').not.toHaveBeenCalled();
    expect(path).toBe(`/earn/${room.id}`);
  });

  it('writes no room itself: the address carries the choice', () => {
    const room = BUNGALOWS.find((b) => b.live && (b.stakePool || b.ladderPool))!;
    render(
      <MemoryRouter initialEntries={['/earn']}>
        <VenuePoolIndex />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: `Open ${room.symbol}` }));
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBeNull();
  });
});
