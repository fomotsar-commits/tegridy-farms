// The jump to the top lands before the paint, and once per opening. Pinned:
//   - it runs in the layout phase, ahead of a layout effect declared after it;
//   - one jump per key, none for null, and one more when the key comes back;
//   - a Suspense boundary that hides the view and shows it again re-runs layout
//     effects, and that does not put a visitor back at the top mid-session.

import { Suspense, useLayoutEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useOpensAtTheTop } from './useOpensAtTheTop';

let order: string[];
const realScrollTo = window.scrollTo;

beforeEach(() => {
  order = [];
  window.scrollTo = vi.fn(() => { order.push('jump'); }) as unknown as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
  window.scrollTo = realScrollTo;
});

const jumps = () => order.filter((step) => step === 'jump').length;

function View({ openKey }: { openKey: string | null }) {
  useOpensAtTheTop(openKey);
  useLayoutEffect(() => { order.push('layout'); }, []);
  return <p>the view</p>;
}

interface Hold { waiting: boolean; promise: Promise<void> }

/** Suspends for as long as its hold is waiting. */
function Held({ on }: { on: Hold | null }) {
  if (on?.waiting) throw on.promise;
  return null;
}

describe('useOpensAtTheTop', () => {
  it('jumps to the top in the layout phase, before the frame is painted', () => {
    render(<View openKey="a" />);
    expect(order).toEqual(['jump', 'layout']);
    // Left as well: the venue's reset has always cleared a sideways scroll too.
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('jumps once per key, never for null, and again when the key comes back', () => {
    const { rerender } = render(<View openKey="a" />);
    rerender(<View openKey="a" />);
    expect(jumps()).toBe(1);
    rerender(<View openKey="b" />);
    expect(jumps()).toBe(2);
    rerender(<View openKey={null} />);
    expect(jumps()).toBe(2);
    rerender(<View openKey="b" />);
    expect(jumps()).toBe(3);
  });

  it('does not jump when it mounts with a null key', () => {
    render(<View openKey={null} />);
    expect(jumps()).toBe(0);
  });

  it('does not jump again when a Suspense boundary hides the view and shows it again', async () => {
    let release = () => {};
    const hold: Hold = { waiting: true, promise: new Promise<void>((resolve) => { release = resolve; }) };
    const tree = (on: Hold | null) => (
      <Suspense fallback={<p>waiting</p>}>
        <View openKey="a" />
        <Held on={on} />
      </Suspense>
    );
    const { rerender } = render(tree(null));
    expect(jumps()).toBe(1);

    rerender(tree(hold));
    expect(screen.getByText('waiting')).toBeTruthy();
    // React keeps a hidden subtree in the document with display:none.
    expect(screen.getByText('the view').style.display).toBe('none');

    await act(async () => { hold.waiting = false; release(); await hold.promise; });
    expect(screen.queryByText('waiting')).toBeNull();
    expect(screen.getByText('the view').style.display).not.toBe('none');
    // The view's layout effects ran a second time: that is the trap.
    expect(order.filter((step) => step === 'layout')).toHaveLength(2);
    expect(jumps()).toBe(1);
  });
});
