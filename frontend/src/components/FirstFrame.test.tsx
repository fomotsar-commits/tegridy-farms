/**
 * WAVE SEVEN, answer ten, ruling 2, React's half: THE HOME PAGE NEVER SAYS "LOADING".
 *
 * index.html's static hero is pinned by src/lib/firstFrame.test.ts. This file pins
 * what happens when React takes over from it, the three places the island's
 * measurement of "one second of Loading..., then the H1" came from:
 *
 *   - the route fallback while the home page's chunk arrives (was PageSkeleton);
 *   - an address typed into the static field, wiped when #root is replaced;
 *   - the page entrance starting from opacity 0 over a hero already on screen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  // Exposes the one prop under test: whether the page entrance starts hidden.
  m: {
    div: ({ children, initial }: { children?: React.ReactNode; initial?: unknown }) => (
      <div data-initial={initial === false ? 'none' : String(initial)}>{children}</div>
    ),
  },
}));

const { FirstFrame } = await import('./FirstFrame');
const { PageTransition } = await import('./motion/PageTransition');
const { takeFirstFrameDraft, captureStaticFirstFrameDraft, setFirstFrameDraft } = await import('../lib/firstFrameDraft');
const { VENUE } = await import('../lib/arrival');

afterEach(() => {
  takeFirstFrameDraft();
  document.documentElement.removeAttribute('data-first-frame');
});

describe('the fallback on / is the first frame', () => {
  it('reads the hero, never the word Loading', () => {
    const { container } = render(<FirstFrame />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${VENUE.heroTitle} ${VENUE.heroLine}`);
    expect(container.textContent).not.toMatch(/loading/i);
  });

  it('is busy, so the e2e readiness probe waits for the real page', () => {
    const { container } = render(<FirstFrame />);
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the no-script read: GET / with the address named heat', () => {
    const { container } = render(<FirstFrame />);
    const form = container.querySelector('form');
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.getAttribute('action')).toBe('/');
    expect(form?.querySelector('input')?.getAttribute('name')).toBe('heat');
  });

  it('hands a typed address to the hero instead of dropping it', () => {
    render(<FirstFrame />);
    fireEvent.change(screen.getByLabelText(/Wallet address to read Heat for/), {
      target: { value: '  0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a  ' },
    });
    expect(takeFirstFrameDraft()).toBe('0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a');
  });
});

describe('the typed-address handoff', () => {
  it('is taken once, so a later visit never resurrects an old address', () => {
    setFirstFrameDraft('0xabc');
    expect(takeFirstFrameDraft()).toBe('0xabc');
    expect(takeFirstFrameDraft()).toBeNull();
  });

  it('reads what was typed into index.html’s own field before createRoot', () => {
    const doc = new DOMParser().parseFromString(
      '<div id="root"><div id="first-frame"><form><input name="heat" value="BaYLaMint111"></form></div></div>',
      'text/html',
    );
    captureStaticFirstFrameDraft(doc);
    expect(takeFirstFrameDraft()).toBe('BaYLaMint111');
  });
});

describe('the page does not fade in over the frame already on screen', () => {
  it('skips the entrance on the first route when the static frame was shown', () => {
    document.documentElement.setAttribute('data-first-frame', 'venue');
    const { container } = render(<PageTransition pathname="/">x</PageTransition>);
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('none');
  });

  it('keeps the entrance for every navigation after it', () => {
    document.documentElement.setAttribute('data-first-frame', 'venue');
    const { container, rerender } = render(<PageTransition pathname="/">x</PageTransition>);
    rerender(<PageTransition pathname="/farm">x</PageTransition>);
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('initial');
    rerender(<PageTransition pathname="/">x</PageTransition>);
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('initial');
  });

  it('keeps the entrance everywhere when no static frame was shown', () => {
    const { container } = render(<PageTransition pathname="/">x</PageTransition>);
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('initial');
  });
});
