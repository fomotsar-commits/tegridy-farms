import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingModal } from './OnboardingModal';

// Mock framer-motion to avoid animation issues in tests.
// Batch 19: consumers now import `m` (LazyMotion alias) instead of `motion`.
// Both names are exported here so the mock remains back-compat with either
// import shape, and the post-batch code that uses `m.div` picks up the div
// passthrough without hitting the real framer animation engine.
vi.mock('framer-motion', () => {
  const passthrough = {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  };
  return {
    motion: passthrough,
    m: passthrough,
    AnimatePresence: ({ children }: any) => <>{children}</>,
    LazyMotion: ({ children }: any) => <>{children}</>,
    domAnimation: {},
  };
});

// Wrap in router since OnboardingModal uses Link
function renderWithRouter() {
  return render(<MemoryRouter><OnboardingModal /></MemoryRouter>);
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

  it('Close button (x) sets localStorage and closes modal', () => {
    renderWithRouter();
    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);
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

  it('clicking backdrop overlay closes modal', () => {
    const { container } = renderWithRouter();
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.click(backdrop);
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
  });
});
