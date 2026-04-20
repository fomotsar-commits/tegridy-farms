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
