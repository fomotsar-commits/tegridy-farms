import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { HTMLAttributes, ReactNode } from 'react';
// Side-effect import: installs vi.mock('wagmi', …) for the transitive
// wagmi calls inside SeasonalEvent's subtree. Without this the render
// throws WagmiProviderNotFoundError on `useConfig`.
import '../test-utils/wagmi-mocks';
import { renderWithProviders } from '../test-utils/render';
import { SeasonalEventBanner, SEASONAL_EVENTS } from './SeasonalEvent';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual('framer-motion');
  return {
    ...actual,
    motion: {
      div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    },
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

// 2026-07-19: this suite previously asserted that the "Ape Month" banner RENDERED
// during July — i.e. it locked in a live, sitewide promise of a "+10% NFT boost"
// that no contract paid. The events list is now empty, and these tests enforce the
// rule rather than the old behaviour.
describe('SeasonalEventBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing — no seasonal promo ships by default', () => {
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    const { container } = renderWithProviders(<SeasonalEventBanner />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['2026-01-15T12:00:00Z', 'January'],
    ['2026-06-02T12:00:00Z', 'the old Harvest Season window'],
    ['2026-07-15T12:00:00Z', 'the old Ape Month window'],
    ['2026-12-31T23:59:59Z', 'year end'],
  ])('renders nothing at %s (%s)', (when) => {
    vi.setSystemTime(new Date(when));
    const { container } = renderWithProviders(<SeasonalEventBanner />);
    expect(container.innerHTML).toBe('');
  });

  // ── REGRESSION GUARD ──────────────────────────────────────────────────────
  // The failure mode this file exists to prevent: someone re-adds a banner that
  // advertises a reward multiplier no contract actually pays. The multiplier
  // field is consumed in exactly one place in the component — to pick an emoji —
  // so a numeric promise here reaches users while changing nothing about rewards.
  describe('regression guard: no unbacked reward promises', () => {
    it('ships no seasonal events by default', () => {
      expect(SEASONAL_EVENTS).toHaveLength(0);
    });

    it('no event description may advertise a percentage or multiplier', () => {
      // If you add a genuinely code-backed event, keep the copy free of numeric
      // reward claims (or wire the multiplier into the real reward path first
      // and update this guard deliberately).
      for (const e of SEASONAL_EVENTS) {
        expect(
          /\d+\s*%|\bx\s*\d|\d+\s*x\b/i.test(e.description),
          `event "${e.id}" advertises a numeric reward in: "${e.description}"`,
        ).toBe(false);
      }
    });

    it('no event may claim a multiplier other than 1 while nothing consumes it', () => {
      for (const e of SEASONAL_EVENTS) {
        expect(e.multiplier, `event "${e.id}" sets multiplier=${e.multiplier} but no reward path reads it`).toBe(1);
      }
    });
  });
});
