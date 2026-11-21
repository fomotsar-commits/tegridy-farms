// A new page opens at the top; the same page with a new query does not move. Pinned with the
// jump itself (useOpensAtTheTop), as ScrollToTop runs them. The first case is the one that
// sent /pools to the top when a token was picked after a direct load (owner, 2026-11-15).

import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useNewPageKey } from './useNewPageKey';
import { useOpensAtTheTop } from './useOpensAtTheTop';

const realScrollTo = window.scrollTo;
let jumps = 0;
let go: NavigateFunction = () => {};

beforeEach(() => {
  jumps = 0;
  window.scrollTo = vi.fn(() => { jumps += 1; }) as unknown as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
  window.scrollTo = realScrollTo;
});

/** ScrollToTop's jump, and a handle to move around with. */
function Shell() {
  useOpensAtTheTop(useNewPageKey());
  const navigate = useNavigate();
  useEffect(() => { go = navigate; }, [navigate]);
  return null;
}

function open(at: string) {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Shell />
    </MemoryRouter>,
  );
}

const move = (to: string | number, opts?: { replace?: boolean }) =>
  act(() => { if (typeof to === 'number') go(to); else go(to, opts); });

describe('useNewPageKey with useOpensAtTheTop', () => {
  it('a page opened by its address does not jump when it writes its own query', () => {
    open('/pools');
    expect(jumps).toBe(0);
    move('/pools?mint=SOY');
    expect(jumps).toBe(0);
    move('/pools?mint=BAYLA');
    move('/pools?mint=RIZZ', { replace: true });
    expect(jumps).toBe(0);
  });

  it('a press to another page jumps once, and its own query moves after that do not', () => {
    open('/swap');
    move('/pools');
    expect(jumps).toBe(1);
    move('/pools?mint=SOY');
    move('/pools?mint=SOY&sheet=add', { replace: true });
    expect(jumps).toBe(1);
    move('/range');
    expect(jumps).toBe(2);
  });

  it('Back and Forward never jump, and a press after Back still does', () => {
    open('/swap');
    move('/pools');
    move('/pools?mint=SOY');
    expect(jumps).toBe(1);
    move(-1);
    move(-1);
    move(1);
    expect(jumps).toBe(1);
    // Back on /pools by a POP: its own query move after it is still the same page.
    move('/pools?mint=RIZZ');
    expect(jumps).toBe(1);
    move('/earn');
    expect(jumps).toBe(2);
  });

  it('a #section link to another page is useSectionLink to place, not a jump', () => {
    open('/swap');
    move('/learn#fees');
    expect(jumps).toBe(0);
    move('/learn?x=1');
    expect(jumps).toBe(0);
    move('/swap');
    expect(jumps).toBe(1);
  });
});
