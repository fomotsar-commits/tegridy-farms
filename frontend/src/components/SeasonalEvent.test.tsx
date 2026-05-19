import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
// Side-effect import: installs vi.mock('wagmi', …) for the transitive
// wagmi calls inside SeasonalEvent's subtree. Without this the render
// throws WagmiProviderNotFoundError on `useConfig`.
import '../test-utils/wagmi-mocks';
import { renderWithProviders } from '../test-utils/render';
import { SeasonalEventBanner } from './SeasonalEvent';

// Mock framer-motion if used indirectly
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

describe('SeasonalEventBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not render when no event is active (date outside all windows)', () => {
    // Set time to January 2026 — no events active
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    const { container } = renderWithProviders(<SeasonalEventBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders Harvest Season banner when date is within June 1-5 window', () => {
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    expect(screen.getByText('Harvest Season')).toBeInTheDocument();
    expect(screen.getByText('2x points on all staking activity')).toBeInTheDocument();
  });

  it('renders Ape Month banner when date is within July window', () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    expect(screen.getByText('Ape Month')).toBeInTheDocument();
  });

  it('does not render when event end date has passed', () => {
    vi.setSystemTime(new Date('2026-06-06T00:00:00Z'));
    const { container } = renderWithProviders(<SeasonalEventBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('dismiss button hides the banner', () => {
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    expect(screen.getByText('Harvest Season')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss event banner'));
    expect(screen.queryByText('Harvest Season')).not.toBeInTheDocument();
  });

  it('dismiss sets localStorage flag', () => {
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    fireEvent.click(screen.getByLabelText('Dismiss event banner'));
    // Storage key is scoped per-wallet (`address ?? 'guest'`) so a logged-in
    // user dismissing on one wallet doesn't suppress the banner for another.
    expect(localStorage.getItem('tegridy-event-dismissed-guest-harvest-season-q2-2026')).toBe('1');
  });

  it('does not render when previously dismissed (localStorage flag set)', () => {
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    localStorage.setItem('tegridy-event-dismissed-guest-harvest-season-q2-2026', '1');
    renderWithProviders(<SeasonalEventBanner />);
    expect(screen.queryByText('Harvest Season')).not.toBeInTheDocument();
  });

  it('shows countdown text when event is active', () => {
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    // Should display some countdown like "2d 12h 0m"
    const countdown = screen.getByText(/\d+d\s+\d+h\s+\d+m/);
    expect(countdown).toBeInTheDocument();
  });

  it('does not render before event start date', () => {
    vi.setSystemTime(new Date('2026-05-31T23:59:59Z'));
    const { container } = renderWithProviders(<SeasonalEventBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders at the exact start date boundary', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    renderWithProviders(<SeasonalEventBanner />);
    expect(screen.getByText('Harvest Season')).toBeInTheDocument();
  });
});
