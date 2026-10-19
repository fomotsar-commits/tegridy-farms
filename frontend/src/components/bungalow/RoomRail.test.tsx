// The room's rail (owner, 2026-10-19): the page's own index, the sections the room renders,
// numbered, lit as you scroll, one tap to each.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RoomRail, type RoomStop } from './RoomRail';

const LABELS = ['Doors', 'Market', 'Burn', 'Held time', 'Holders', 'Lore'];
const STOPS: RoomStop[] = LABELS.map((label) => ({ id: `room-${label.toLowerCase().replace(/ /g, '-')}`, label }));

/** A room's page: its slots, then the rail, as HomePage.tsx mounts them. */
function Room({ stops }: { stops: RoomStop[] }) {
  return (
    <>
      {stops.map((s) => (
        <div key={s.id} id={s.id} style={{ height: 800 }} />
      ))}
      <RoomRail stops={stops} />
    </>
  );
}

beforeEach(() => {
  // jsdom has neither; the rail reads both.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => vi.restoreAllMocks());

describe('RoomRail', () => {
  it("lists the room's sections in page order, numbered, the first lit until the page scrolls", () => {
    render(<Room stops={STOPS} />);
    const links = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual(
      STOPS.map((s, i) => [`${String(i + 1).padStart(2, '0')}${s.label}`, `#${s.id}`]),
    );
    // The number is decoration (aria-hidden): each link's name is its section's word alone.
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual(['location', null, null, null, null, null]);
    expect(screen.getByRole('link', { name: 'Held time' })).toHaveAttribute('href', '#room-held-time');
  });

  it('renders nothing for a page with fewer than two sections', () => {
    render(<Room stops={STOPS.slice(0, 1)} />);
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
  });

  it('a tap scrolls the section under the header and the strip, smoothly, and lights it', () => {
    render(<Room stops={STOPS} />);
    const market = document.getElementById('room-market')!;
    market.getBoundingClientRect = () => ({ top: 1000, bottom: 1800, left: 0, right: 0, width: 0, height: 800, x: 0, y: 1000, toJSON: () => ({}) });
    const link = screen.getByRole('link', { name: 'Market' });
    fireEvent.click(link);
    // No <header> in this page, so its 56px row stands in; the strip itself measures 0 here, plus its 8px; then 12px of air.
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1000 - 56 - 8 - 12, behavior: 'smooth' });
    expect(link).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Doors' })).not.toHaveAttribute('aria-current');
  });

  it('scrolls without easing for a reduced-motion visitor', () => {
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('reduced-motion') })) as unknown as typeof window.matchMedia;
    render(<Room stops={STOPS} />);
    fireEvent.click(screen.getByRole('link', { name: 'Burn' }));
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it("the home page names a resident's six slots in this order, gates each as its slot is gated, and mounts the rail once a room is entered", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'HomePage.tsx'), 'utf8');
    const stops = [...src.matchAll(/\{ id: '(room-[a-z-]+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
    expect(stops).toEqual(STOPS.map((s) => [s.id, s.label]));
    // Every named slot carries its id, once.
    for (const s of STOPS) expect(src.match(new RegExp(`id=\\{ROOM_STOPS\\.[a-zA-Z]+\\.id\\}`, 'g'))?.length, s.id).toBe(STOPS.length);
    expect(src).toMatch(/<RoomRail key=\{bungalowIdentity\.id\} stops=\{\[/);
    expect(src).toMatch(/bungalowIdentity\.market \? \[ROOM_STOPS\.market\]/);
    expect(src).toMatch(/burnRoom \? \[ROOM_STOPS\.burn\]/);
    expect(src).toMatch(/bungalowIdentity\.address \? \[ROOM_STOPS\.heldTime, ROOM_STOPS\.holders\]/);
    expect(src).toMatch(/bungalowIdentity\.identity\.lore \? \[ROOM_STOPS\.lore\]/);
  });

  // CI, 2026-10-19: the heading moved 2px from the first frame to the page (156.5 then 154.5)
  // when the rail's box was 70px (46 + a 24px margin) in 72px of air.
  it("stands in exactly the hero air it takes: a 72px box, pt-10 under it, pt-28 again once docked", () => {
    render(<Room stops={STOPS} />);
    const classes = screen.getByRole('navigation', { name: 'On this page' }).className.split(/\s+/);
    expect(classes).toContain('h-[72px]');
    expect(classes).toContain('min-[1440px]:h-auto');
    const home = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'HomePage.tsx'), 'utf8');
    expect(home).toContain("bungalowIdentity ? 'pt-10 min-[1440px]:pt-28 pb-20' : 'pt-28 pb-20'");
  });
});
