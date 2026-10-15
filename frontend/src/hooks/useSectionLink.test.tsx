// A section link lands on its section once the section is drawn. Pinned:
//   - landOnSection lands now, or when the section is drawn or takes its id;
//     never past its limit, after the visitor moves the page, or once stopped;
//     it holds the section in place while the page settles, and then lets go;
//   - useSectionLink lands after a link, again when it is pressed again, and on
//     an address opened fresh; a reload and Back or Forward are the browser's.
//   - a link from another page shows it from its top until the section lands.
// e2e/section-links.spec.ts walks the same on a production build.

import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { landOnSection, useSectionLink, SECTION_WAIT_MS, SECTION_SETTLE_MS, __forgetOpeningForTests } from './useSectionLink';

let landed: string[];
/** window.scrollTo, which only the top-of-page reset calls. */
let toTop: ReturnType<typeof vi.spyOn>;
const proto = Element.prototype as { scrollIntoView?: unknown };
const realScrollIntoView = proto.scrollIntoView;
const realEntries = performance.getEntriesByType;

/** How this document was opened, as the browser reports it. */
const openedBy = (type: string) => {
  performance.getEntriesByType = ((kind: string) => (kind === 'navigation' ? [{ type }] : [])) as unknown as typeof performance.getEntriesByType;
};

/** The page's content width; jsdom reports 0, which would put every press on the scrollbar. */
const WIDTH = 990;

/** What a visitor does that moves the page. */
const MOVES: [string, () => Event][] = [
  ['a wheel', () => new Event('wheel', { bubbles: true })],
  ['a touch drag', () => new Event('touchmove', { bubbles: true })],
  ['a scrolling key', () => new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })],
  ['a press on the scrollbar', () => new MouseEvent('pointerdown', { clientX: WIDTH + 5, bubbles: true })],
];

beforeEach(() => {
  landed = [];
  proto.scrollIntoView = function (this: Element) { landed.push(this.id); };
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: WIDTH });
  toTop = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  __forgetOpeningForTests();
  openedBy('navigate');
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  proto.scrollIntoView = realScrollIntoView;
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  performance.getEntriesByType = realEntries;
});

const draw = (id: string) => {
  const section = document.createElement('section');
  section.id = id;
  document.body.append(section);
  return section;
};

/** Mutation observers report in a microtask. */
const reported = () => act(async () => { await Promise.resolve(); });

describe('landOnSection', () => {
  it('lands at once on a section already drawn', () => {
    draw('hall');
    landOnSection('#hall');
    expect(landed).toEqual(['hall']);
  });

  it('waits for a section drawn later, lands once, and stops watching', async () => {
    landOnSection('#hall');
    expect(landed).toEqual([]);
    draw('hall');
    await reported();
    expect(landed).toEqual(['hall']);
    draw('later');
    await reported();
    expect(landed).toEqual(['hall']);
  });

  it('lands when an element already drawn takes the id', async () => {
    const section = draw('');
    landOnSection('#hall');
    section.id = 'hall';
    await reported();
    expect(landed).toEqual(['hall']);
  });

  it('still waits just before its limit, and gives up at it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    landOnSection('#early');
    landOnSection('#late');
    vi.advanceTimersByTime(SECTION_WAIT_MS - 1);
    draw('early');
    await reported();
    vi.advanceTimersByTime(1);
    draw('late');
    await reported();
    expect(landed).toEqual(['early']);
  });

  it.each(MOVES)('stops waiting when the visitor moves the page: %s', async (_move, event) => {
    landOnSection('#hall');
    document.body.dispatchEvent(event());
    draw('hall');
    await reported();
    expect(landed).toEqual([]);
  });

  it('keeps waiting through a tap on the page and keys that scroll nothing', async () => {
    landOnSection('#hall');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    draw('hall');
    await reported();
    expect(landed).toEqual(['hall']);
  });

  it('does not move the page from under a visitor typing in a field', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    landOnSection('#hall');
    draw('hall');
    await reported();
    expect(landed).toEqual([]);
  });

  it('stops waiting when stopped', async () => {
    const stop = landOnSection('#hall');
    stop();
    draw('hall');
    await reported();
    expect(landed).toEqual([]);
  });

  it('reads a percent-encoded id, and takes one that is not encoding as written', () => {
    draw('the hall');
    draw('100%');
    expect(() => landOnSection('#the%20hall')).not.toThrow();
    expect(() => landOnSection('#100%')).not.toThrow();
    expect(landed).toEqual(['the hall', '100%']);
  });

  describe('once landed', () => {
    let top: number;
    const PUT = 64;

    /** A section whose top on screen is `top`; landing on it puts it at PUT. */
    const drawPlaced = (id: string) => {
      const section = draw(id);
      section.getBoundingClientRect = () => ({ top }) as DOMRect;
      section.scrollIntoView = function (this: Element) { landed.push(this.id); top = PUT; };
      return section;
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] });
      top = 900;
    });

    it('puts the section back each time the page moves it while it settles, then lets go', () => {
      drawPlaced('estimate');
      landOnSection('#estimate');
      expect(landed).toEqual(['estimate']);
      vi.advanceTimersByTime(100);
      expect(landed, 'nothing moved it, so it is not landed again').toEqual(['estimate']);
      top = PUT - 16;
      vi.advanceTimersByTime(50);
      expect(landed).toEqual(['estimate', 'estimate']);
      top = PUT - 24;
      vi.advanceTimersByTime(50);
      expect(landed).toHaveLength(3);
      vi.advanceTimersByTime(SECTION_SETTLE_MS);
      top = PUT - 40;
      vi.advanceTimersByTime(500);
      expect(landed, 'past the settle time the page is left alone').toHaveLength(3);
    });

    it.each(MOVES)('lets go when the visitor moves the page: %s', (_move, event) => {
      drawPlaced('estimate');
      landOnSection('#estimate');
      document.body.dispatchEvent(event());
      top = PUT - 16;
      vi.advanceTimersByTime(100);
      expect(landed).toEqual(['estimate']);
    });

    it('lets go when the visitor starts typing in a field', () => {
      drawPlaced('estimate');
      landOnSection('#estimate');
      const field = document.createElement('input');
      document.body.append(field);
      field.focus();
      top = PUT - 16;
      vi.advanceTimersByTime(100);
      expect(landed).toEqual(['estimate']);
    });

    it('lets go when stopped', () => {
      drawPlaced('estimate');
      const stop = landOnSection('#estimate');
      stop();
      top = PUT - 16;
      vi.advanceTimersByTime(100);
      expect(landed).toEqual(['estimate']);
    });
  });

  it('from another page, shows the page from its top until the section is drawn', async () => {
    landOnSection('#hall', { fromAnotherPage: true });
    expect(toTop).toHaveBeenCalledWith(0, 0);
    draw('hall');
    await reported();
    expect(landed).toEqual(['hall']);
    expect(toTop).toHaveBeenCalledTimes(1);
  });

  it('never sends the page to the top when the section is already drawn, or by default', () => {
    draw('hall');
    landOnSection('#hall', { fromAnotherPage: true });
    landOnSection('#later');
    expect(toTop).not.toHaveBeenCalled();
  });

  it('does not wait at all for an empty hash', () => {
    const watch = vi.spyOn(MutationObserver.prototype, 'observe');
    landOnSection('#');
    expect(watch).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
  });
});

let navigate: NavigateFunction;

function Venue() {
  useSectionLink();
  const go = useNavigate();
  useEffect(() => { navigate = go; }, [go]);
  return null;
}

const open = (entries: string[], index = entries.length - 1) =>
  render(<MemoryRouter initialEntries={entries} initialIndex={index}><Venue /></MemoryRouter>);

describe('useSectionLink', () => {
  it('lands after a link, and again each time it is pressed again', () => {
    draw('hall');
    open(['/']);
    act(() => { void navigate('/#hall'); });
    expect(landed).toEqual(['hall']);
    // A link to the address already shown replaces it.
    act(() => { void navigate('/#hall', { replace: true }); });
    act(() => { void navigate('/#hall', { replace: true }); });
    expect(landed).toEqual(['hall', 'hall', 'hall']);
    expect(toTop, 'the section was there: no trip to the top first').not.toHaveBeenCalled();
  });

  it('a link from another page shows it from its top until the section is drawn', async () => {
    open(['/island']);
    act(() => { void navigate('/#hall'); });
    expect(toTop).toHaveBeenCalledWith(0, 0);
    draw('hall');
    await reported();
    expect(landed).toEqual(['hall']);
  });

  it('a link on the same page, or an address opened fresh, is not sent to the top', () => {
    open(['/']);
    act(() => { void navigate('/#not-drawn-yet'); });
    cleanup();
    __forgetOpeningForTests();
    open(['/#not-drawn-yet']);
    expect(toTop).not.toHaveBeenCalled();
  });

  it('after a link, waits for the section to be drawn', async () => {
    open(['/island']);
    act(() => { void navigate('/#hall'); });
    expect(landed).toEqual([]);
    draw('hall');
    await reported();
    expect(landed).toEqual(['hall']);
  });

  it('stops waiting when the visitor goes to another page', async () => {
    open(['/island']);
    act(() => { void navigate('/#hall'); });
    act(() => { void navigate('/earn'); });
    draw('hall');
    await reported();
    expect(landed).toEqual([]);
  });

  it('lands on an address opened fresh', () => {
    draw('hall');
    open(['/#hall']);
    expect(landed).toEqual(['hall']);
  });

  it.each(['reload', 'back_forward'])('leaves an address the browser %s placed to the browser', (type) => {
    openedBy(type);
    draw('hall');
    open(['/#hall']);
    expect(landed).toEqual([]);
  });

  it('leaves Back and Forward to the browser', () => {
    draw('hall');
    open(['/#hall', '/earn']);
    act(() => { void navigate(-1); });
    act(() => { void navigate(1); });
    act(() => { void navigate(-1); });
    expect(landed).toEqual([]);
  });

  it('leaves Back to the address it opened with to the browser', () => {
    draw('hall');
    open(['/#hall']);
    expect(landed).toEqual(['hall']);
    act(() => { void navigate('/earn'); });
    act(() => { void navigate(-1); });
    expect(landed).toEqual(['hall']);
  });
});
