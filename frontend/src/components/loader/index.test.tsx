// PERF-16. AppLoader and its eight phase modules and three fx modules — an
// audio engine and a post-processing pass among them — were STATIC imports from
// the layout, which put ~93 KB of intro source in the ENTRY chunk. Every
// visitor downloaded it before first paint, including the two groups the loader
// itself decides, synchronously at mount, never to play for.
//
// Splitting it created exactly one way to get this wrong, and it is the
// expensive way: putting `children` inside the Suspense boundary, which holds
// the whole app tree until the intro chunk lands and makes first paint WORSE
// than before the split. That is what the last test here is for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('./AppLoader', () => ({
  AppLoader: ({ onComplete }: { onComplete?: () => void }) => {
    onComplete?.();
    return <div data-testid="intro-overlay" />;
  },
}));

import { AppLoader } from './index';

const realMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  sessionStorage.clear();
  setReducedMotion(false);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  sessionStorage.clear();
});

describe('the splash shell', () => {
  it('renders the app and completes exactly once for a repeat visitor', async () => {
    sessionStorage.setItem('tf_loaded', '1');
    const onComplete = vi.fn();

    const { rerender } = render(
      <AppLoader onComplete={onComplete}>
        <p>the app</p>
      </AppLoader>,
    );

    expect(screen.getByText('the app')).toBeTruthy();
    expect(screen.queryByTestId('intro-overlay')).toBeNull();

    // AppLayout's whole first-visit sequence — the onboarding modal and the
    // bungalow picker — hangs off a SINGLE onComplete, and it passes an inline
    // arrow, so the callback is a new identity on every parent render. An effect
    // keyed on it therefore re-runs constantly; only the ref stops the repeat.
    // Two re-renders with two fresh callbacks is the shape that actually ships.
    rerender(
      <AppLoader onComplete={() => onComplete()}>
        <p>the app</p>
      </AppLoader>,
    );
    rerender(
      <AppLoader onComplete={() => onComplete()}>
        <p>the app</p>
      </AppLoader>,
    );
    await waitFor(() => expect(screen.getByText('the app')).toBeTruthy());
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('skips for a reduced-motion visitor and records it before the app reads it', () => {
    setReducedMotion(true);
    const onComplete = vi.fn();

    render(
      <AppLoader onComplete={onComplete}>
        <p>the app</p>
      </AppLoader>,
    );

    expect(screen.queryByTestId('intro-overlay')).toBeNull();
    // The write has to land during the shell's own render: AppLayout's
    // `freshSplash` initializer reads this key, and it runs when children do.
    expect(sessionStorage.getItem('tf_loaded')).toBe('1');
  });

  it('paints the app WITHOUT waiting for the intro chunk', async () => {
    const onComplete = vi.fn();

    render(
      <AppLoader onComplete={onComplete}>
        <p>the app</p>
      </AppLoader>,
    );

    // Synchronously, on the first commit — the lazy import has not resolved yet,
    // so the overlay is absent while the app is already there. Children inside
    // the Suspense boundary would make this a blank screen.
    expect(screen.getByText('the app')).toBeTruthy();
    expect(screen.queryByTestId('intro-overlay')).toBeNull();

    // ...and the intro does still arrive.
    await waitFor(() => expect(screen.getByTestId('intro-overlay')).toBeTruthy());
    expect(screen.getByText('the app')).toBeTruthy();
  });
});
