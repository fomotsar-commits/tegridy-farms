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
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const { peekFirstFrameDraft, clearFirstFrameDraft, captureStaticFirstFrameDraft, setFirstFrameDraft, setFirstFrameFocus } =
  await import('../lib/firstFrameDraft');
const { VENUE } = await import('../lib/arrival');

const ADDRESS = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

function mountFrame(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FirstFrame />
    </MemoryRouter>,
  );
}
const field = () => screen.getByLabelText(/Wallet address to read Heat for/) as HTMLInputElement;
const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  clearFirstFrameDraft();
  document.documentElement.removeAttribute('data-first-frame');
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('the fallback on / is the first frame', () => {
  it('reads the hero, never the word Loading', () => {
    const { container } = mountFrame();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${VENUE.heroTitle} ${VENUE.heroLine}`);
    expect(container.textContent).not.toMatch(/loading/i);
  });

  it('is busy, so the e2e readiness probe waits for the real page', () => {
    const { container } = mountFrame();
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the no-script read: GET / with the address named heat', () => {
    const { container } = mountFrame();
    const form = container.querySelector('form');
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.getAttribute('action')).toBe('/');
    expect(form?.querySelector('input:not([type="hidden"])')?.getAttribute('name')).toBe('heat');
  });

  it('records what is typed for the hero instead of dropping it', () => {
    mountFrame();
    fireEvent.change(field(), { target: { value: `  ${ADDRESS}  ` } });
    expect(peekFirstFrameDraft().value).toBe(ADDRESS);
  });
});

// A review walked the fallback against a slow build and found it was a NEW, empty
// field: it blanked what the static frame held, dropped the focus, and had no hidden
// inputs, so a submit from it lost ?ref= before the home page could record it.
describe('the fallback takes over the static field, it does not replace it', () => {
  it('shows what the static field held and takes its focus', () => {
    setFirstFrameDraft('0xd71caf9f');
    setFirstFrameFocus(true);
    mountFrame();
    expect(field().value, 'the fallback blanked the typed address').toBe('0xd71caf9f');
    expect(document.activeElement, 'the focus fell out of the field').toBe(field());
  });

  it('catches what is typed between its render and its commit', () => {
    // React renders, then commits later; the static field is live until the commit.
    // A sibling writing during render stands in for a keystroke in that gap.
    function TypedDuringRender() {
      setFirstFrameDraft('0xd71caf9fdb');
      return null;
    }
    setFirstFrameDraft('0xd71c');
    render(
      <MemoryRouter>
        <FirstFrame />
        <TypedDuringRender />
      </MemoryRouter>,
    );
    expect(field().value).toBe('0xd71caf9fdb');
  });

  it('does not take focus the static field did not have', () => {
    setFirstFrameDraft('0xd71caf9f');
    mountFrame();
    expect(document.activeElement).not.toBe(field());
  });

  it('fills a shared ?heat= link when nothing was typed', () => {
    mountFrame(`/?heat=${ADDRESS}`);
    expect(field().value).toBe(ADDRESS);
  });

  it('carries every other query parameter as a hidden input, so a submit keeps the referral', () => {
    const { container } = mountFrame(`/?ref=0x1111111111111111111111111111111111111111&heat=${ADDRESS}&utm_source=x`);
    const hidden = Array.from(container.querySelectorAll<HTMLInputElement>('form input[type="hidden"]')).map((i) => [i.name, i.value]);
    expect(hidden).toEqual([
      ['ref', '0x1111111111111111111111111111111111111111'],
      ['utm_source', 'x'],
    ]);
  });

  it('keeps its focus record when React removes it, and loses it when the visitor taps away', async () => {
    const first = mountFrame();
    fireEvent.focus(field());
    expect(peekFirstFrameDraft().focused).toBe(true);
    // Chromium fires blur on a focused node as it is removed, while still connected.
    fireEvent.blur(field());
    first.unmount();
    await microtask();
    expect(peekFirstFrameDraft().focused, 'a swap was read as the visitor leaving the field').toBe(true);

    mountFrame();
    fireEvent.blur(field());
    await microtask();
    expect(peekFirstFrameDraft().focused).toBe(false);
  });

  it('forgets the draft when the visitor leaves / before the hero mounts, and keeps it for the hero on /', () => {
    setFirstFrameDraft(ADDRESS);
    const stay = mountFrame();
    stay.unmount();
    expect(peekFirstFrameDraft().value, 'the hero replacing the fallback on / lost the draft').toBe(ADDRESS);

    const leave = mountFrame();
    window.history.pushState(null, '', '/farm');
    leave.unmount();
    expect(peekFirstFrameDraft().value, 'an unsubmitted address would come back on a later visit').toBeNull();
  });
});

describe('the static field, before React', () => {
  function staticField(value = '') {
    document.body.innerHTML = `<div id="root"><div id="first-frame"><form><input name="heat" value="${value}"></form></div></div>`;
    return document.querySelector<HTMLInputElement>('#first-frame input[name="heat"]')!;
  }

  it('reads what was already typed into the field in index.html', () => {
    staticField('BaYLaMint111');
    captureStaticFirstFrameDraft();
    expect(peekFirstFrameDraft().value).toBe('BaYLaMint111');
  });

  it('keeps following the field until React removes it: the commit is scheduled, not immediate', () => {
    const el = staticField('0xd7');
    captureStaticFirstFrameDraft();
    el.value = '0xd71caf';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(peekFirstFrameDraft().value).toBe('0xd71caf');
    el.focus();
    expect(peekFirstFrameDraft().focused).toBe(true);
  });

  it('is captured by main.tsx before createRoot replaces the markup', () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.tsx'), 'utf8');
    const capture = main.indexOf('captureStaticFirstFrameDraft();');
    expect(capture, 'main.tsx no longer captures the static field').toBeGreaterThan(-1);
    expect(capture).toBeLessThan(main.indexOf('createRoot('));
  });
});

describe('peeking', () => {
  it('is safe to repeat from a render that may be thrown away', () => {
    setFirstFrameDraft('0xabc');
    expect(peekFirstFrameDraft().value).toBe('0xabc');
    expect(peekFirstFrameDraft().value).toBe('0xabc');
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
