/**
 * The nav logo must keep its responsive candidates.
 *
 * It is a 512x512 PNG painted into a 28px (desktop) / 44px (mobile) box, which
 * makes it the single most over-served image on the site — and it is on EVERY
 * route, so it is also the most repeated.
 *
 * THIS HAS ALREADY REGRESSED ONCE. The srcSet was added, shipped, and then
 * silently removed when a later nav refactor rewrote the header and replaced the
 * element with a bare `<img src={...} />`. Nothing failed, no test went red, and
 * no reviewer could have seen it, because a missing optimisation looks exactly
 * like a working image. That is the whole reason this file exists.
 *
 * Two things are asserted, and the second is the one with teeth:
 *   1. a srcSet is present at all
 *   2. `sizes` is the EXPLICIT fixed-box value, not the `auto` default
 * `sizes="auto"` is only valid on a lazy image and this one is deliberately
 * eager, so `auto` here would be ignored by the browser, silently fall back to
 * the 100vw default, and pick the full-size original — a srcSet that saves
 * nothing while looking entirely correct.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}));
// TopNav reads `useAccount` (2026-09-05) to decide whether Dashboard is in the
// bar. The real hook throws without a WagmiProvider; this file is about an
// <img>, so the connection state is stubbed rather than provided.
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }) }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { TopNav } from './TopNav';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { pageArt } from '../../lib/artConfig';
import { artSrcSet, derivedUrl } from '../../lib/artSrcSet';

function navLogo(): HTMLImageElement {
  // The replay-splash button wraps it; it is the only <img> inside that control.
  const button = screen.getByLabelText('Replay splash screen (full reload)');
  const img = button.querySelector('img');
  expect(img, 'the nav logo <img> is gone from the splash-replay button').toBeTruthy();
  return img as HTMLImageElement;
}

function renderNav() {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('the nav logo keeps its responsive candidates', () => {
  // artSrcSet is production-only by design: the derivatives are gitignored, so in
  // dev the manifest describes files that are not there. Stub PROD so the real
  // behaviour is observable.
  beforeEach(() => vi.stubEnv('PROD', true));
  afterEach(() => vi.unstubAllEnvs());

  const src = pageArt('nav-logo', 0).src;

  it('has a source the manifest actually knows', () => {
    // If this fails the rest proves nothing — the art was re-pointed at a file
    // with no derivatives, and every assertion below would vacuously pass.
    expect(artSrcSet(src), `${src} is not in the derivative manifest`).toBeDefined();
  });

  it('renders a srcSet with a real derived candidate', () => {
    renderNav();
    const img = navLogo();
    const set = img.getAttribute('srcset');
    expect(set, 'the nav logo lost its srcSet — this regressed once before').toBeTruthy();
    expect(set).toContain('/_derived/');
    expect(set).toContain(`${derivedUrl(src, 128)} 128w`);
  });

  it('spells sizes out, because auto is inert on an eager image', () => {
    renderNav();
    const img = navLogo();
    const sizes = img.getAttribute('sizes');
    expect(sizes, 'srcSet without sizes is inert for w-descriptors').toBeTruthy();
    // The teeth: `auto` here would be ignored (eager image) and fall back to
    // 100vw, which selects the ORIGINAL and saves nothing.
    expect(sizes).not.toBe('auto');
    expect(sizes).toBe('(min-width: 768px) 28px, 44px');
  });

  it('keeps the original as the src so a candidate failure is survivable', () => {
    renderNav();
    expect(navLogo().getAttribute('src')).toBe(src);
  });
});
