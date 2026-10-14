// A section link lands on its section once the section is drawn. Pinned:
//   - landOnSection lands now, or when the section is drawn or takes its id;
//     never past its limit, after the visitor moves the page, or once stopped;
//   - useSectionLink lands after a link, again when it is pressed again, and on
//     an address opened fresh; a reload and Back or Forward are the browser's.
// e2e/section-links.spec.ts walks the same on a production build.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { landOnSection, useSectionLink, SECTION_WAIT_MS, __forgetOpeningForTests } from './useSectionLink';

let landed: string[];
const proto = Element.prototype as { scrollIntoView?: unknown };
const realScrollIntoView = proto.scrollIntoView;
const realEntries = performance.getEntriesByType;

/** How this document was opened, as the browser reports it. */
const openedBy = (type: string) => {
  performance.getEntriesByType = ((kind: string) => (kind === 'navigation' ? [{ type }] : [])) as typeof performance.getEntriesByType;
};

beforeEach(() => {
  landed = [];
  proto.scrollIntoView = function (this: Element) { landed.push(this.id); };
  __forgetOpeningForTests();
  openedBy('navigate');
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  proto.scrollIntoView = realScrollIntoView;
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

  it.each(['wheel', 'touchmove', 'keydown', 'pointerdown'])('stops waiting when the visitor moves the page (%s)', async (move) => {
    landOnSection('#hall');
    document.body.dispatchEvent(new Event(move, { bubbles: true }));
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

  it('does nothing for an empty hash', async () => {
    landOnSection('#');
    draw('');
    await reported();
    expect(landed).toEqual([]);
  });
});

let navigate: NavigateFunction;

function Venue() {
  useSectionLink();
  navigate = useNavigate();
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
