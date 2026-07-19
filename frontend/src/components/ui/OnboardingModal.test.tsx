import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { renderWithProviders } from '../../test-utils/render';
import { OnboardingModal } from './OnboardingModal';

// Mock framer-motion to avoid animation issues in tests.
// Batch 19: consumers now import `m` (LazyMotion alias) instead of `motion`.
// Both names are exported here so the mock remains back-compat with either
// import shape, and the post-batch code that uses `m.div` picks up the div
// passthrough without hitting the real framer animation engine.
vi.mock('framer-motion', () => {
  const passthrough = {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  };
  return {
    motion: passthrough,
    m: passthrough,
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
    domAnimation: {},
  };
});

// Shared providers (Router + Theme) — Modal calls useTheme transitively
// and OnboardingModal uses Link, both need their context here.
function renderWithRouter() {
  return renderWithProviders(<OnboardingModal />);
}

describe('OnboardingModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders when localStorage has no onboarding-seen key', () => {
    renderWithRouter();
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('does NOT render when localStorage has onboarding-seen = 1', () => {
    localStorage.setItem('tegridy-onboarding-seen', '1');
    renderWithRouter();
    expect(screen.queryByText('Welcome to Tegridy Farms')).not.toBeInTheDocument();
  });

  it('shows step 1 title by default', () => {
    renderWithRouter();
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('advances to step 2 on Next click', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('How It Works')).toBeInTheDocument();
  });

  it('advances to step 3 on two Next clicks', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Stay Safe')).toBeInTheDocument();
  });

  it('goes back to step 1 from step 2 via Back button', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('How It Works')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('shows Start Farming button on the last step', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Start Farming')).toBeInTheDocument();
  });

  it('Start Farming sets localStorage and closes modal', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Start Farming'));
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
    expect(screen.queryByText('Stay Safe')).not.toBeInTheDocument();
  });

  it('Escape key closes modal and sets localStorage', () => {
    // R039: Modal primitive handles Escape internally; the only "close" surfaces
    // the user sees are Start Farming, the Farm/Trade nav links, and Escape.
    // There is intentionally no X-close button — the onboarding is treated as
    // a TOS-style explicit-acknowledgment flow.
    renderWithRouter();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
    expect(screen.queryByText('Welcome to Tegridy Farms')).not.toBeInTheDocument();
  });

  it('renders 3 step dots', () => {
    const { container } = renderWithRouter();
    const dots = container.querySelectorAll('.rounded-full.w-2');
    expect(dots.length).toBe(4);
  });

  it('Back button is invisible on step 1', () => {
    renderWithRouter();
    const backBtn = screen.getByText('Back');
    expect(backBtn.className).toContain('invisible');
  });

  it('Back button is visible on step 2', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Next'));
    const backBtn = screen.getByText('Back');
    expect(backBtn.className).not.toContain('invisible');
  });

  it('clicking backdrop overlay closes the modal (non-blocking, dismissOnBackdrop=true)', () => {
    // 2026-07-18: onboarding is NON-BLOCKING — a backdrop click (or Escape / Skip) dismisses
    // the welcome so a first-timer can start exploring the hero immediately. close() sets
    // the seen flag so it doesn't reappear.
    const { container } = renderWithRouter();
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.click(backdrop);
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
    expect(screen.queryByText('Welcome to Tegridy Farms')).not.toBeInTheDocument();
  });
});
