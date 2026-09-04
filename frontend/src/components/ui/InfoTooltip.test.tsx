import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InfoTooltip, HowItWorks, StepIndicator, RiskBanner } from './InfoTooltip';
import { ThemeProvider } from '../../contexts/ThemeContext';

// InfoTooltip now reads useTheme() so it can swap its bubble background
// for light mode; the hook throws outside a provider. Tests wrap in
// <ThemeProvider> to mirror the real app tree.
const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

describe('InfoTooltip', () => {
  it('renders the ? icon', () => {
    renderWithTheme(<InfoTooltip text="Test tooltip" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('shows tooltip text on hover', () => {
    renderWithTheme(<InfoTooltip text="Helpful info" />);
    fireEvent.mouseEnter(screen.getByText('?').parentElement!);
    expect(screen.getByText('Helpful info')).toBeInTheDocument();
  });

  /* A11Y-R03 / A11Y-R14. This is the mechanism by which every DeFi term on the
     site is explained, at 33 call sites, and it shipped a 15x15px target and a
     224px bubble with no viewport clamp. The class assertions are the honest
     pin available in jsdom — it lays nothing out, so a geometric assertion here
     would be a fabricated measurement. All four fail on the pre-change file. */
  it('grows the hit area past 24px without growing the painted circle', () => {
    renderWithTheme(<InfoTooltip text="Test tooltip" />);
    const button = screen.getByText('?');
    // 15px painted circle: unchanged, so no call site's layout moves.
    expect(button.className).toContain('w-[15px]');
    expect(button.className).toContain('h-[15px]');
    // …and a transparent ::before overlay carrying the target to 24px (15 + 4.5
    // each side), 32px under max-md.
    expect(button.className).toContain("before:content-['']");
    expect(button.className).toContain('before:-inset-[4.5px]');
    expect(button.className).toContain('max-md:before:-inset-[8.5px]');
  });

  it('clamps the bubble to the viewport and keeps it hoverable', () => {
    renderWithTheme(<InfoTooltip text="Helpful info" />);
    fireEvent.click(screen.getByText('?'));
    const bubble = screen.getByRole('tooltip');
    expect(bubble.className).toContain('max-w-[calc(100vw-2rem)]');
    // WCAG 1.4.13: pointer-events-none made the bubble vanish when the pointer
    // reached it, because the hit test fell through to the page behind.
    expect(bubble.className).not.toContain('pointer-events-none');
  });

  /* The first TAP on a phone used to do nothing at all: a touch fires the
     compatibility mouseenter and focus BEFORE click — both of which open the
     bubble — and the old click handler toggled it straight back closed.
     Measured on Pixel 5 before the fix: aria-expanded stayed "false" after tap
     one and only went "true" on tap two. This replays that real event order. */
  it('opens on the first tap, and closes on the second', () => {
    renderWithTheme(<InfoTooltip text="Helpful info" />);
    const button = screen.getByText('?');
    const tap = () => {
      // Order a touchscreen actually delivers: pointerdown first, then the
      // mouse-compatibility events, then click.
      fireEvent.pointerDown(button);
      fireEvent.mouseEnter(button.parentElement!);
      fireEvent.focus(button);
      fireEvent.click(button);
    };
    tap();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    tap();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses on Escape', () => {
    renderWithTheme(<InfoTooltip text="Helpful info" />);
    fireEvent.click(screen.getByText('?'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByText('?'), { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('HowItWorks', () => {
  const steps = [
    { label: 'Step 1', description: 'First step' },
    { label: 'Step 2', description: 'Second step' },
  ];

  beforeEach(() => localStorage.clear());

  it('renders steps when open', () => {
    render(<HowItWorks storageKey="test-how" title="How It Works" steps={steps} />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    expect(screen.getByText('Step 2')).toBeInTheDocument();
  });

  it('collapses and expands on click', () => {
    render(<HowItWorks storageKey="test-toggle" title="How It Works" steps={steps} />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('How It Works'));
    expect(screen.queryByText('Step 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('How It Works'));
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });
});

describe('StepIndicator', () => {
  it('shows correct step states', () => {
    render(<StepIndicator steps={['Approve', 'Stake', 'Done']} currentStep={1} />);
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Stake')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

describe('RiskBanner', () => {
  it('renders warning variant', () => {
    render(<RiskBanner variant="warning">Be careful</RiskBanner>);
    expect(screen.getByText('Be careful')).toBeInTheDocument();
  });

  it('renders danger variant', () => {
    render(<RiskBanner variant="danger">High risk</RiskBanner>);
    expect(screen.getByText('High risk')).toBeInTheDocument();
  });

  it('renders info variant', () => {
    render(<RiskBanner variant="info">FYI</RiskBanner>);
    expect(screen.getByText('FYI')).toBeInTheDocument();
  });
});
