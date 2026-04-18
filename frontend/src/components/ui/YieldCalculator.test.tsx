import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { YieldCalculator } from './YieldCalculator';

// framer-motion passthrough (same shape as OnboardingModal.test.tsx).
// Use an explicit object with common tags rather than a Proxy to avoid
// stale-reference issues that can block re-renders under some setups.
vi.mock('framer-motion', () => {
  const passthrough = {
    div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    section: ({ children, ...props }: { children?: React.ReactNode }) => <section {...props}>{children}</section>,
    span: ({ children, ...props }: { children?: React.ReactNode }) => <span {...props}>{children}</span>,
    button: ({ children, ...props }: { children?: React.ReactNode }) => <button {...props}>{children}</button>,
  };
  return {
    motion: passthrough,
    m: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
  };
});

function renderCalc() {
  return render(
    <MemoryRouter>
      <YieldCalculator />
    </MemoryRouter>,
  );
}

describe('YieldCalculator', () => {
  beforeEach(() => {
    // Ensure a clean DOM between tests.
  });

  it('renders headline + baseline-APR chip', () => {
    renderCalc();
    expect(screen.getByText(/see what you'd earn/i)).toBeInTheDocument();
    // "Baseline 12% APR" text is split across child text nodes, so querying
    // the concatenated string via a function matcher is more forgiving.
    const matches = screen.getAllByText(
      (_, node) => !!node && /Baseline\s*12\s*%\s*APR/i.test(node.textContent || ''),
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('starts with $1000 default and the default tier selected', () => {
    renderCalc();
    const input = screen.getByLabelText(/TOWELI amount/i) as HTMLInputElement;
    expect(input.value).toBe('1000');
    // Default selected tier is index 3 — "The Long Haul" (1 year).
    // Button's accessible name concatenates child text; use a regex that
    // tolerates surrounding sublabel/boost text.
    const radios = screen.getAllByRole('radio');
    const long = radios.find((r) => /The Long Haul/.test(r.textContent ?? ''));
    expect(long).toBeTruthy();
    expect(long!).toHaveAttribute('aria-checked', 'true');
  });

  it('renders all 6 lock-duration tiers', () => {
    renderCalc();
    // Expect 6 radios inside the radiogroup.
    const group = screen.getByRole('radiogroup', { name: /lock duration/i });
    const radios = group.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(6);
  });

  it('switches tier when a radio is clicked', () => {
    renderCalc();
    const radios = screen.getAllByRole('radio');
    const tasteTest = radios.find((r) => /The Taste Test/.test(r.textContent ?? ''))!;
    const long = radios.find((r) => /The Long Haul/.test(r.textContent ?? ''))!;
    fireEvent.click(tasteTest);
    expect(tasteTest).toHaveAttribute('aria-checked', 'true');
    expect(long).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles JBAC bonus and updates boost', () => {
    renderCalc();
    const checkbox = screen.getByRole('checkbox', { name: /JBAC NFT/i });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // Use the "Till Death Do Us Farm" tier which should max-boost at 4.0× (before JBAC).
    const radios = screen.getAllByRole('radio');
    const tillDeath = radios.find((r) => /Till Death Do Us Farm/.test(r.textContent ?? ''))!;
    fireEvent.click(tillDeath);

    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    // After toggling: boost should be clamped at 4.5× ceiling (4.0 + 0.5).
    const boostNode = screen.getByText(/Effective boost/i).parentElement!;
    expect(boostNode.textContent).toContain('4.5');
  });

  it('computes positive monthly + annual yield for positive amount', () => {
    renderCalc();
    const input = screen.getByLabelText(/TOWELI amount/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5000' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    const monthlyLabel = screen.getByText(/Est\. monthly/i).parentElement!;
    // Annual at 5000 * 12% * 2.2× (default tier ≈ 2.2) is meaningful; just check > $0.
    expect(annualLabel.textContent).not.toContain('$0.00');
    expect(monthlyLabel.textContent).not.toContain('$0.00');
  });

  it('shows $0.00 for zero or blank input', () => {
    renderCalc();
    const input = screen.getByLabelText(/TOWELI amount/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    expect(annualLabel.textContent).toContain('$0.00');
  });

  it('rejects negative amounts (clamped to 0)', () => {
    renderCalc();
    const input = screen.getByLabelText(/TOWELI amount/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-100' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    expect(annualLabel.textContent).toContain('$0.00');
  });

  it('renders a "Start farming" CTA that links to /farm', () => {
    renderCalc();
    const cta = screen.getByRole('link', { name: /Go to Farm page to stake/i });
    expect(cta).toHaveAttribute('href', '/farm');
  });

  it('annual yield scales linearly with amount (sanity check)', () => {
    renderCalc();
    const input = screen.getByLabelText(/TOWELI amount/i) as HTMLInputElement;

    // Parse just the USD figure following the dollar sign, ignoring label text
    // like "Est. 1 year" that also contains a digit.
    const parseAnnual = () => {
      const label = screen.getByText(/Est\. 1 year/i).parentElement!;
      // The value span sits right after the label.
      const valueSpan = label.querySelector('.font-mono') ?? label.children[1];
      const txt = valueSpan?.textContent ?? '';
      const match = txt.match(/\$([\d,]+(?:\.\d+)?)/);
      return match ? Number(match[1].replace(/,/g, '')) : 0;
    };

    fireEvent.change(input, { target: { value: '1000' } });
    const a = parseAnnual();

    fireEvent.change(input, { target: { value: '2000' } });
    const b = parseAnnual();

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 1.9);
    expect(b).toBeLessThan(a * 2.1);
  });
});
