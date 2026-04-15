import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { OnboardingModal } from './OnboardingModal';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

describe('OnboardingModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders when localStorage has no onboarding-seen key', () => {
    render(<OnboardingModal />);
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('does NOT render when localStorage has onboarding-seen = 1', () => {
    localStorage.setItem('tegridy-onboarding-seen', '1');
    render(<OnboardingModal />);
    expect(screen.queryByText('Welcome to Tegridy Farms')).not.toBeInTheDocument();
  });

  it('shows step 1 title by default', () => {
    render(<OnboardingModal />);
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('advances to step 2 on Next click', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('How It Works')).toBeInTheDocument();
  });

  it('advances to step 3 on two Next clicks', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Stay Safe')).toBeInTheDocument();
  });

  it('goes back to step 1 from step 2 via Back button', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('How It Works')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Welcome to Tegridy Farms')).toBeInTheDocument();
  });

  it('shows Get Started button on the last step', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Get Started')).toBeInTheDocument();
  });

  it('Get Started sets localStorage and closes modal', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Get Started'));
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
    expect(screen.queryByText('Stay Safe')).not.toBeInTheDocument();
  });

  it('Close button (x) sets localStorage and closes modal', () => {
    render(<OnboardingModal />);
    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
    expect(screen.queryByText('Welcome to Tegridy Farms')).not.toBeInTheDocument();
  });

  it('renders 3 step dots', () => {
    const { container } = render(<OnboardingModal />);
    const dots = container.querySelectorAll('.rounded-full.w-2');
    expect(dots.length).toBe(3);
  });

  it('Back button is invisible on step 1', () => {
    render(<OnboardingModal />);
    const backBtn = screen.getByText('Back');
    expect(backBtn.className).toContain('invisible');
  });

  it('Back button is visible on step 2', () => {
    render(<OnboardingModal />);
    fireEvent.click(screen.getByText('Next'));
    const backBtn = screen.getByText('Back');
    expect(backBtn.className).not.toContain('invisible');
  });

  it('clicking backdrop overlay closes modal', () => {
    const { container } = render(<OnboardingModal />);
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.click(backdrop);
    expect(localStorage.getItem('tegridy-onboarding-seen')).toBe('1');
  });
});
