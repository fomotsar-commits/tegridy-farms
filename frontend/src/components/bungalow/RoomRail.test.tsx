// The room's rail (owner, 2026-10-19): the page's own index, the sections the room renders,
// numbered, lit as you scroll, one tap to each.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * jsdom lays nothing out, so this lays the strip out as a 390px phone does (live walk,
 * 2026-10-20): a 366px list starting 12px in, six stops 100px apart and 90px wide, 600px in all.
 * The list's own scrollTo moves its scrollLeft, and every stop's box moves with it.
 */
function layOutPhoneStrip({ docked = false } = {}) {
  const ol = screen.getByRole('navigation', { name: 'On this page' }).querySelector('ol')!;
  let scrollLeft = 0;
  Object.defineProperty(ol, 'clientWidth', { configurable: true, value: 366 });
  Object.defineProperty(ol, 'scrollWidth', { configurable: true, value: docked ? 366 : 600 });
  Object.defineProperty(ol, 'scrollLeft', { configurable: true, get: () => scrollLeft, set: (v: number) => { scrollLeft = v; } });
  const box = (left: number, width: number) => ({ left, right: left + width, width, top: 64, bottom: 136, height: 72, x: left, y: 64, toJSON: () => ({}) });
  ol.getBoundingClientRect = () => box(12, 366);
  [...ol.children].forEach((li, i) => { li.getBoundingClientRect = () => box(12 + i * 100 - scrollLeft, 90); });
  const scrollTo = vi.fn((o: ScrollToOptions) => { scrollLeft = o.left ?? scrollLeft; });
  ol.scrollTo = scrollTo as unknown as typeof ol.scrollTo;
  return { ol, scrollTo, swipeTo: (x: number) => { scrollLeft = x; } };
}

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

  // Live walk, 2026-10-20: on a 390px phone the strip shows four of six stops, and reading Holders
  // or Lore lit a word off its right edge. The strip now brings the lit stop into view itself.
  describe('the lit stop stays in view on the strip', () => {
    it('a tap on a stop past the edge slides the strip to centre it (Lore: 500 − (366 − 90) / 2)', () => {
      render(<Room stops={STOPS} />);
      const { scrollTo } = layOutPhoneStrip();
      fireEvent.click(screen.getByRole('link', { name: 'Lore' }));
      expect(scrollTo).toHaveBeenCalledWith({ left: 362, behavior: 'smooth' });
    });

    it('scrolling the page onto a section whose stop is off the edge slides the strip, and only the strip', () => {
      let fire: (entries: Partial<IntersectionObserverEntry>[]) => void = () => {};
      vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: typeof fire) { fire = cb; }
        observe() {}
        disconnect() {}
      });
      render(<Room stops={STOPS} />);
      const { scrollTo } = layOutPhoneStrip();
      act(() => fire([{ isIntersecting: true, target: document.getElementById('room-holders')!, boundingClientRect: { top: 200 } as DOMRect }]));
      expect(screen.getByRole('link', { name: 'Holders' })).toHaveAttribute('aria-current', 'location');
      expect(scrollTo).toHaveBeenCalledWith({ left: 262, behavior: 'smooth' });
      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it('a lit stop already in full view leaves the strip where it is', () => {
      render(<Room stops={STOPS} />);
      const { scrollTo } = layOutPhoneStrip();
      fireEvent.click(screen.getByRole('link', { name: 'Market' }));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('a stop under the faded right edge counts as out of view', () => {
      render(<Room stops={STOPS} />);
      const { scrollTo, swipeTo } = layOutPhoneStrip();
      // Swiped 40px along: the strip shows 40 to 406, and Held time (300 to 390) ends inside the
      // last 28px, where the list fades to nothing. On screen, but not readable.
      swipeTo(40);
      fireEvent.click(screen.getByRole('link', { name: 'Held time' }));
      expect(scrollTo).toHaveBeenCalledWith({ left: 162, behavior: 'smooth' });
    });

    it('going back to the first stop slides the strip back to its start, without easing for a reduced-motion visitor', () => {
      render(<Room stops={STOPS} />);
      const { scrollTo } = layOutPhoneStrip();
      fireEvent.click(screen.getByRole('link', { name: 'Lore' }));
      window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('reduced-motion') })) as unknown as typeof window.matchMedia;
      fireEvent.click(screen.getByRole('link', { name: 'Doors' }));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'auto' });
    });

    it('docked (nothing to scroll), the list is left alone', () => {
      render(<Room stops={STOPS} />);
      const { scrollTo } = layOutPhoneStrip({ docked: true });
      fireEvent.click(screen.getByRole('link', { name: 'Lore' }));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("a re-render with the same sections does not pull back a strip the visitor swiped along", () => {
      // HomePage builds its stops array anew on every render (live price polling re-renders it).
      const { rerender } = render(<Room stops={STOPS} />);
      const { scrollTo, swipeTo } = layOutPhoneStrip();
      fireEvent.click(screen.getByRole('link', { name: 'Lore' }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      swipeTo(0);
      rerender(<Room stops={STOPS.map((s) => ({ ...s }))} />);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });
  });

  // CI, 2026-10-19: the heading moved 2px from the first frame to the page (156.5 then 154.5)
  // when the rail's box was 70px (46 + a 24px margin) in 72px of air.
  it("stands in exactly the hero air it takes: a 72px box, pt-10 under it, pt-28 again once docked", () => {
    render(<Room stops={STOPS} />);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const classes = nav.className.split(/\s+/);
    expect(classes).toContain('h-[72px]');
    expect(classes).toContain('min-[1440px]:h-auto');
    // CI, 2026-10-19: stuck 64px down, the box's empty lower part answered taps meant for the
    // chain pills under it. Only the line itself takes a tap.
    expect(classes).toContain('pointer-events-none');
    expect(nav.querySelector('ol')!.className.split(/\s+/)).toContain('pointer-events-auto');
    const home = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'HomePage.tsx'), 'utf8');
    expect(home).toContain("bungalowIdentity ? 'pt-10 min-[1440px]:pt-28 pb-20' : 'pt-28 pb-20'");
  });
});
