import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

// A dialog taller than a short screen sits in a layer that scrolls, and a plain focus() scrolls
// that layer to bring the dialog into view. The receipt card puts its layer back once, as it
// rises; a focus that came after that (a busy phone's late first frame) left the card's head,
// where the moment plays, off the top. The dialog is already in place: it is focused where it is.
function Dialog({ focusContainer }: { focusContainer?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(true, focusContainer ? { focusContainer } : {});
  return (
    <div ref={ref} role="dialog" tabIndex={-1} data-testid="dialog">
      <button type="button" data-testid="first">one</button>
    </div>
  );
}

describe('useFocusTrap: where the focus goes on open, and whether the page scrolls to it', () => {
  let offsetParent: PropertyDescriptor | undefined;
  beforeEach(() => {
    // jsdom has no layout: every offsetParent is null, and the hook would find no control at all.
    offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
  });

  it('focusContainer: the dialog itself is focused, and the browser is told not to scroll it into view', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<Dialog focusContainer />);
    await waitFor(() => expect(focus).toHaveBeenCalled());
    expect((focus.mock.contexts.at(-1) as HTMLElement).getAttribute('data-testid')).toBe('dialog');
    expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  });

  it('without focusContainer the first control is focused, as before', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<Dialog />);
    await waitFor(() => expect(focus).toHaveBeenCalled());
    expect((focus.mock.contexts.at(-1) as HTMLElement).getAttribute('data-testid')).toBe('first');
    expect(focus.mock.calls.at(-1)).toEqual([]);
  });
});
