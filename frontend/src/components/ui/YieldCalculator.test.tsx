import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// YieldCalculator now prefers the live on-chain base APR via usePoolData()
// (wagmi useReadContracts), so the component can no longer render without a
// wagmi surface. Importing the shared mock installs vi.mock('wagmi'); with no
// read stubs configured the live APR resolves to 0 and the component falls
// back to the static "Baseline 12% APR" these tests assert.
import { wagmiMock } from '../../test-utils/wagmi-mocks';
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
    // Reset wagmi mock state so no stray read stubs flip the live-APR branch.
    wagmiMock.reset();
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
    const input = screen.getByLabelText(/Amount to stake/i) as HTMLInputElement;
    expect(input.value).toBe('1000');
    // Default selected tier is index 3 — "The Long Haul" (1 year).
    // F78: tiers are toggle buttons (aria-pressed), not role="radio".
    const buttons = screen.getAllByRole('button');
    const long = buttons.find((r) => /The Long Haul/.test(r.textContent ?? ''));
    expect(long).toBeTruthy();
    expect(long!).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders all 6 lock-duration tiers', () => {
    renderCalc();
    // F78: tiers live in a role="group" and carry aria-pressed (toggle buttons).
    const group = screen.getByRole('group', { name: /lock duration/i });
    const tiers = group.querySelectorAll('[aria-pressed]');
    expect(tiers).toHaveLength(6);
  });

  it('switches tier when a tier button is clicked', () => {
    renderCalc();
    const buttons = screen.getAllByRole('button');
    const tasteTest = buttons.find((r) => /The Taste Test/.test(r.textContent ?? ''))!;
    const long = buttons.find((r) => /The Long Haul/.test(r.textContent ?? ''))!;
    fireEvent.click(tasteTest);
    expect(tasteTest).toHaveAttribute('aria-pressed', 'true');
    expect(long).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles JBAC bonus and updates boost', () => {
    renderCalc();
    const checkbox = screen.getByRole('checkbox', { name: /JBAC NFT/i });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // Use the "Till Death Do Us Farm" tier which should max-boost at 4.0× (before JBAC).
    const buttons = screen.getAllByRole('button');
    const tillDeath = buttons.find((r) => /Till Death Do Us Farm/.test(r.textContent ?? ''))!;
    fireEvent.click(tillDeath);

    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    // After toggling: boost should be clamped at 4.5× ceiling (4.0 + 0.5).
    const boostNode = screen.getByText(/Effective boost/i).parentElement!;
    expect(boostNode.textContent).toContain('4.5');
  });

  it('computes positive monthly + annual yield for positive amount', () => {
    renderCalc();
    const input = screen.getByLabelText(/Amount to stake/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5000' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    const monthlyLabel = screen.getByText(/Est\. monthly/i).parentElement!;
    // Annual at 5000 * 12% * 2.2× (default tier ≈ 2.2) is meaningful; just check > $0.
    expect(annualLabel.textContent).not.toContain('$0.00');
    expect(monthlyLabel.textContent).not.toContain('$0.00');
  });

  it('shows $0.00 for zero or blank input', () => {
    renderCalc();
    const input = screen.getByLabelText(/Amount to stake/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    expect(annualLabel.textContent).toContain('$0.00');
  });

  it('rejects negative amounts (clamped to 0)', () => {
    renderCalc();
    const input = screen.getByLabelText(/Amount to stake/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-100' } });

    const annualLabel = screen.getByText(/Est\. 1 year/i).parentElement!;
    expect(annualLabel.textContent).toContain('$0.00');
  });

  it('renders a "Start farming" CTA that links to /farm', () => {
    renderCalc();
    const cta = screen.getByRole('link', { name: /Go to Farm page to stake/i });
    expect(cta).toHaveAttribute('href', '/farm');
  });

  // F65: the calculator must consume the numeric aprNum (not Number(apr), which
  // is NaN once apr >= 10,000 is comma-formatted), and must fall back to the
  // baseline above a sane ceiling so a bootstrap-inflated rate isn't multiplied
  // by the boost.
  it('uses the live base APR when it is in-range (<= ceiling)', () => {
    // aprNum = rewardRate / boostedStake * (100 * 31_536_000). With
    // boostedStake = 3_153_600_000, aprNum == rewardRate. So rewardRate=45 → 45%.
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 45n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 3_153_600_000n });
    renderCalc();
    const matches = screen.getAllByText(
      (_, node) => !!node && /Live\s*45\.0\s*%\s*base APR/i.test(node.textContent || ''),
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('falls back to the baseline when the live APR is above the ceiling', () => {
    // rewardRate=2000 with boostedStake=3_153_600_000 → APR = 2000% (> 1000
    // ceiling). usePoolData comma-formats this; the calculator must NOT parse the
    // string and must show the baseline chip, never "Live 2,000%".
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 2000n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 3_153_600_000n });
    renderCalc();
    const matches = screen.getAllByText(
      (_, node) => !!node && /Baseline\s*12\s*%\s*APR/i.test(node.textContent || ''),
    );
    expect(matches.length).toBeGreaterThan(0);
    // And the inflated rate must never leak into the chip.
    expect(screen.queryByText(/Live\s*2,?000/i)).toBeNull();
  });

  it('annual yield scales linearly with amount (sanity check)', () => {
    renderCalc();
    const input = screen.getByLabelText(/Amount to stake/i) as HTMLInputElement;

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
