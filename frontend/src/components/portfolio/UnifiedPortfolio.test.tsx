// The render honesty guard.
//
// The pure layer can be perfectly correct and the surface still lie, in three ways that
// have nothing to do with arithmetic:
//
//   - printing "$0.00" in the slot where `usd` is null
//   - printing the PARTIAL notice somewhere the eye reaches after the number
//   - printing "as of just now" over a figure whose oldest leg is minutes cold
//
// So these assertions are about pixels-worth-of-text, not values: what appears, and in
// what order. The DOM-order check is the one that matters most and is the easiest to
// regress, because moving a caveat below a headline is a purely cosmetic edit.

import { describe, it, expect, vi } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, {
    get: () => ({ children, ...props }: HTMLAttributes<HTMLElement>) => <section {...props}>{children}</section>,
  });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

import { UnifiedPortfolio } from './UnifiedPortfolio';
import { aggregatePortfolio, describeCompleteness } from '../../lib/portfolio/aggregate';
import type { PortfolioSourceReport, PortfolioSourceState } from '../../lib/portfolio/types';

const NOW = Math.floor(Date.now() / 1000);

function report(
  id: PortfolioSourceReport['id'],
  state: PortfolioSourceState,
  usd: number | null,
  extra: Partial<PortfolioSourceReport> = {},
): PortfolioSourceReport {
  return { id, label: `label:${id}`, state, usd, asOf: NOW, ...extra };
}

function renderWith(sources: PortfolioSourceReport[]) {
  const total = aggregatePortfolio(sources);
  const view = render(
    <UnifiedPortfolio sources={sources} total={total} summary={describeCompleteness(total)} />,
  );
  return { ...view, total };
}

const HEALTHY = [report('wallet-eth', 'ok', 100), report('wallet-toweli', 'ok', 25)];

describe('the total slot', () => {
  it('shows the figure when there is one', () => {
    renderWith(HEALTHY);
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('Portfolio value')).toBeInTheDocument();
  });

  it('shows no dollar figure at all when nothing could be read', () => {
    const { container } = renderWith([
      report('wallet-eth', 'unavailable', null),
      report('wallet-toweli', 'unavailable', null),
    ]);
    expect(screen.getByText(/no total available/i)).toBeInTheDocument();
    // The bug: an outage rendering as "$0.00" is indistinguishable from an empty wallet.
    expect(container.textContent).not.toMatch(/\$0\.00/);
  });

  it('labels a partial figure as partial where the number is, not only in the notice', () => {
    renderWith([...HEALTHY, report('staking', 'unavailable', null)]);
    expect(screen.getByText('Partial portfolio value')).toBeInTheDocument();
    expect(screen.queryByText('Portfolio value')).not.toBeInTheDocument();
  });
});

describe('the PARTIAL notice', () => {
  it('names every excluded source', () => {
    renderWith([
      ...HEALTHY,
      report('staking', 'unavailable', null),
      report('lp', 'unpriced', null),
    ]);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('PARTIAL');
    expect(notice.textContent).toContain('label:staking');
    expect(notice.textContent).toContain('label:lp');
  });

  it('appears BEFORE the figure in document order', () => {
    const { container } = renderWith([...HEALTHY, report('staking', 'unavailable', null)]);
    const notice = screen.getByRole('status');
    const figure = screen.getByText('$125.00');
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: `figure` comes after `notice`.
    expect(notice.compareDocumentPosition(figure) & 4).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('is absent when nothing was excluded, so it keeps its signal', () => {
    renderWith(HEALTHY);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('the freshness stamp', () => {
  it('dates the total from its oldest leg and says so', () => {
    renderWith([
      report('wallet-eth', 'ok', 100, { asOf: NOW - 300 }),
      report('wallet-toweli', 'ok', 25, { asOf: NOW }),
    ]);
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    expect(screen.getByText(/oldest of the 2 sources/i)).toBeInTheDocument();
  });

  it('states the spread in seconds when the legs were not read together', () => {
    renderWith([
      report('wallet-eth', 'ok', 100, { asOf: NOW - 120 }),
      report('wallet-toweli', 'ok', 25, { asOf: NOW }),
    ]);
    expect(screen.getByText(/not read together: 120s/i)).toBeInTheDocument();
  });

  it('says nothing has been read rather than implying a moment that never happened', () => {
    renderWith([report('wallet-eth', 'loading', null, { asOf: null })]);
    expect(screen.getByText(/no source has been read yet/i)).toBeInTheDocument();
  });
});

describe('the per-source list', () => {
  it('gives every source a state badge, including the ones with no value', () => {
    renderWith([
      report('wallet-eth', 'ok', 100),
      report('staking', 'unavailable', null, { detail: 'the network read failed' }),
      report('nft', 'unpriced', null, { detail: '3 held — no floor feed' }),
    ]);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Unpriced')).toBeInTheDocument();
    expect(screen.getByText('3 held — no floor feed')).toBeInTheDocument();
  });

  it('writes "not counted" against an excluded source — never a dash that reads as zero', () => {
    renderWith([report('wallet-eth', 'ok', 100), report('staking', 'unavailable', null)]);
    expect(screen.getByText('not counted')).toBeInTheDocument();
  });
});

describe('the standing scope disclosure', () => {
  const withScope = [
    ...HEALTHY,
    report('launched-tokens', 'out-of-scope', null, {
      asOf: null,
      detail: 'no per-wallet token index',
    }),
  ];

  it('prints what is outside the total even when the total is complete', () => {
    const { total } = renderWith(withScope);
    expect(total.completeness).toBe('complete');
    // A "complete" total with an undisclosed gap is the quietest version of the same lie.
    expect(screen.getByText(/outside this total/i).textContent).toContain('no per-wallet token index');
  });

  it('keeps that disclosure while a PARTIAL notice is also up', () => {
    renderWith([...withScope, report('lp', 'unavailable', null)]);
    expect(screen.getByRole('status').textContent).toContain('PARTIAL');
    expect(screen.getByText(/outside this total/i)).toBeInTheDocument();
  });
});
