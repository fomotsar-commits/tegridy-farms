// The read stamp under an LP card's figures: how long ago they were read, on the device's own
// clock from the read to the render, never the chain's (the two are never mixed). Three forms,
// moving in five-second steps on a five-second tick, amber from two minutes, and a 44px Read
// again only when a caller gives one. Fake timers: the clock here is the test's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReadAt } from './ReadAt';

const AT = new Date('2026-10-06T12:00:00Z').getTime();
const stamp = () => screen.getByTestId('lp-read-at');
const text = () => screen.getByTestId('lp-read-at-text');
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the three forms', () => {
  it('under five seconds: Read just now', () => {
    render(<ReadAt at={AT} />);
    expect(text()).toHaveTextContent(/^Read just now$/);
    tick(4_000);
    expect(text()).toHaveTextContent(/^Read just now$/);
  });

  it('to a minute: Read {n} s ago in steps of five, moving on the five-second tick', () => {
    render(<ReadAt at={AT} />);
    tick(5_000);
    expect(text()).toHaveTextContent(/^Read 5 s ago$/);
    // Between ticks nothing moves.
    tick(2_000);
    expect(text()).toHaveTextContent(/^Read 5 s ago$/);
    tick(3_000);
    expect(text()).toHaveTextContent(/^Read 10 s ago$/);
    tick(45_000);
    expect(text()).toHaveTextContent(/^Read 55 s ago$/);
  });

  it('the step is the age rounded down to five, whatever the tick’s phase: a read 3 s before the mount', () => {
    render(<ReadAt at={AT - 3_000} />);
    expect(text()).toHaveTextContent(/^Read just now$/);
    // The first tick lands at 8 s of age.
    tick(5_000);
    expect(text()).toHaveTextContent(/^Read 5 s ago$/);
  });

  it('a read from before the page was opened counts from the read, not from the mount', () => {
    render(<ReadAt at={AT - 33_000} />);
    expect(text()).toHaveTextContent(/^Read 30 s ago$/);
  });

  it('from a minute: Read {n} min ago, whole minutes', () => {
    render(<ReadAt at={AT} />);
    tick(60_000);
    expect(text()).toHaveTextContent(/^Read 1 min ago$/);
    tick(55_000);
    expect(text()).toHaveTextContent(/^Read 1 min ago$/);
    tick(65_000);
    expect(text()).toHaveTextContent(/^Read 3 min ago$/);
  });

  it('a device clock set back never prints a negative age', () => {
    render(<ReadAt at={AT + 60_000} />);
    expect(text()).toHaveTextContent(/^Read just now$/);
  });
});

describe('amber past two minutes', () => {
  it('plain at 1 min 55 s, amber from 2 min', () => {
    render(<ReadAt at={AT} />);
    tick(115_000);
    expect(stamp()).toHaveAttribute('data-stale', 'false');
    expect(text()).not.toHaveClass('text-amber-300/90');
    tick(5_000);
    expect(text()).toHaveTextContent(/^Read 2 min ago$/);
    expect(stamp()).toHaveAttribute('data-stale', 'true');
    expect(text()).toHaveClass('text-amber-300/90');
  });
});

describe('Read again', () => {
  it('a finger-sized button when a caller gives one, and it calls back; none otherwise', () => {
    const again = vi.fn();
    const { unmount } = render(<ReadAt at={AT} onReadAgain={again} />);
    const button = screen.getByRole('button', { name: 'Read again' });
    expect(button).toHaveClass('min-h-[44px]');
    fireEvent.click(button);
    expect(again).toHaveBeenCalledTimes(1);
    unmount();
    render(<ReadAt at={AT} />);
    expect(screen.queryByRole('button', { name: 'Read again' })).toBeNull();
  });

  it('while a read runs it stays focusable and does nothing, so focus is not lost', () => {
    const again = vi.fn();
    render(<ReadAt at={AT} onReadAgain={again} busy />);
    const button = screen.getByRole('button', { name: 'Read again' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(again).not.toHaveBeenCalled();
  });
});
