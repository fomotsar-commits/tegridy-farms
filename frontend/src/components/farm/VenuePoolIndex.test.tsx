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

  it('a row says its coin once, and its number is a mark, not a word', () => {
    render(
      <MemoryRouter initialEntries={['/earn']}>
        <VenuePoolIndex />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole('row').slice(1);
    const live = BUNGALOWS.filter((b) => b.live && (b.stakePool || b.ladderPool));
    expect(rows.length).toBeGreaterThanOrEqual(live.length);
    // The room's name used to stand beside the ticker and repeat it ("QR QR", "PEPE Pepe").
    for (const b of live) {
      const head = screen.getByRole('rowheader', { name: b.symbol });
      expect(head.textContent).toBe(b.symbol);
    }
    // The numbers are drawn from an attribute, so the list's text (and its word count) has none.
    expect(screen.getByRole('table').textContent).not.toMatch(/\b0[1-9]\b/);
    expect(document.querySelectorAll('[data-n]').length).toBe(rows.length);
  });

  it('lights the row of the pool pointed at on the site model, and says which row is pointed at here', () => {
    const room = BUNGALOWS.find((b) => b.live && (b.stakePool || b.ladderPool))!;
    const onActive = vi.fn();
    render(
      <MemoryRouter initialEntries={['/earn']}>
        <VenuePoolIndex activeId={room.id} onActive={onActive} />
      </MemoryRouter>,
    );
    const row = screen.getByRole('link', { name: `Open ${room.symbol}` }).closest('tr')!;
    expect(row.hasAttribute('data-current')).toBe(true);
    expect(document.querySelectorAll('tr[data-current]')).toHaveLength(1);
    const other = screen.getAllByRole('row').slice(1).find((r) => r !== row)!;
    fireEvent.mouseEnter(other);
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(onActive.mock.calls[0]![0]).not.toBe(room.id);
    fireEvent.mouseLeave(screen.getByRole('table'));
    expect(onActive).toHaveBeenLastCalledWith(null);
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
