// The room's rail (owner, 2026-10-19): the page's own index, read from the sections the room
// renders, numbered, lit as you scroll, one tap to each.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RoomRail, readRoomStops } from './RoomRail';

const slug = (s: string) => `room-${s.toLowerCase().replace(/ /g, '-')}`;

/** A room's page: its sections, then the rail, as HomePage.tsx mounts them. */
function Room({ sections, room = 'bayla' }: { sections: string[]; room?: string }) {
  return (
    <>
      {sections.map((s) => (
        <div key={s} id={slug(s)} data-room-section={s} style={{ height: 800 }} />
      ))}
      <RoomRail room={room} />
    </>
  );
}

const SECTIONS = ['Doors', 'Market', 'Burn', 'Held time', 'Holders', 'Lore'];

beforeEach(() => {
  // jsdom has neither; the rail reads both.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => vi.restoreAllMocks());

describe('RoomRail', () => {
  it("lists the room's sections in page order, numbered, the first lit until the page scrolls", () => {
    render(<Room sections={SECTIONS} />);
    const links = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual(
      SECTIONS.map((s, i) => [`${String(i + 1).padStart(2, '0')}${s}`, `#${slug(s)}`]),
    );
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual(['location', null, null, null, null, null]);
  });

  it('renders nothing for a page with fewer than two sections, and none for one with no marks', () => {
    const { unmount } = render(<Room sections={['Doors']} />);
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    unmount();
    render(<RoomRail room="toweli" />);
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
  });

  it('a tap scrolls the section under the header and the strip, smoothly, and lights it', () => {
    render(<Room sections={SECTIONS} />);
    const market = document.getElementById('room-market')!;
    market.getBoundingClientRect = () => ({ top: 1000, bottom: 1800, left: 0, right: 0, width: 0, height: 800, x: 0, y: 1000, toJSON: () => ({}) });
    // The number is decoration (aria-hidden): the link's name is the section's word alone.
    const link = screen.getByRole('link', { name: 'Market' });
    fireEvent.click(link);
    // No <header> in this page, so its 56px row stands in; the strip itself measures 0 here, plus its 8px; then 12px of air.
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1000 - 56 - 8 - 12, behavior: 'smooth' });
    expect(link).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Doors' })).not.toHaveAttribute('aria-current');
  });

  it('scrolls without easing for a reduced-motion visitor', () => {
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('reduced-motion') })) as unknown as typeof window.matchMedia;
    render(<Room sections={SECTIONS} />);
    fireEvent.click(screen.getByRole('link', { name: 'Burn' }));
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('reads only marks that have an id to scroll to', () => {
    document.body.innerHTML = '<div id="a" data-room-section="A"></div><div data-room-section="B"></div><div id="c" data-room-section="C"></div>';
    expect(readRoomStops()).toEqual([{ id: 'a', label: 'A' }, { id: 'c', label: 'C' }]);
    document.body.innerHTML = '';
  });

  it("the home page marks a resident's six slots, in this order, and mounts the rail once a room is entered", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'HomePage.tsx'), 'utf8');
    expect([...src.matchAll(/data-room-section="([^"]+)"/g)].map((m) => m[1])).toEqual(SECTIONS);
    expect(src).toMatch(/\{bungalowIdentity && <RoomRail room=\{bungalowIdentity\.id\} \/>\}/);
  });
});
