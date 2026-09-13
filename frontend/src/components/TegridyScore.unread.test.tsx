/**
 * OUTAGE-AS-SEEDLING — the two surfaces that render the Venue Score.
 *
 * `TegridyScore` (on /leaderboard) and `TegridyScoreMini` (on the dashboard)
 * both drew the number, the rank and the tier unconditionally. With an input
 * unread every component collapses to 0, so a long-standing staker was shown a
 * ring at zero, "Seedling 🌱" and "Tier: Seedling" — the score's whole claim,
 * about reads that never landed.
 *
 * Both directions are pinned: a wallet that READ as having no history is a real
 * Seedling and must still be rendered as one, ring and all.
 *
 * ⚠️ THE RING NEEDS THE CLOCK RUN FORWARD. Both cards ease the arc from 0 over
 * 1200ms of requestAnimationFrame, so at t=0 an empty ring proves nothing — the
 * first version of this file asserted there and a mutation that fills the ring
 * from the UNDERSTATED score survived it. Fake timers drive the animation to
 * completion deterministically (a wall-clock wait would be a threshold flake).
 *
 * The hook is driven directly; its flags are pinned in
 * useTegridyScore.scoreUnread.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { TegridyScoreBreakdown } from '../hooks/useTegridyScore';

const s = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../hooks/useTegridyScore', () => ({ useTegridyScore: () => s.current }));
vi.mock('./ArtImg', () => ({ ArtImg: () => null }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { TegridyScore } from './TegridyScore';
import { TegridyScoreMini } from './TegridyScoreMini';

const READ_BREAKDOWN: TegridyScoreBreakdown = {
  stakingScore: 80, lockScore: 60, activityScore: 50,
  governanceScore: 0, communityScore: 25, loyaltyScore: 100,
};

/** A wallet scoring 72. `unread` names the components whose reads did not land. */
function scoreState(unread: Partial<Record<keyof TegridyScoreBreakdown, boolean>> = {}) {
  const breakdownUnread: Record<keyof TegridyScoreBreakdown, boolean> = {
    stakingScore: false, lockScore: false, activityScore: false,
    governanceScore: false, communityScore: false, loyaltyScore: false,
    ...unread,
  };
  s.current = {
    score: 72,
    breakdown: READ_BREAKDOWN,
    rank: 'Farmer',
    tier: 'Tier: Platinum',
    tips: [],
    selfReported: [],
    breakdownUnread,
    scoreUnread: Object.values(breakdownUnread).some(Boolean),
  };
}

/** Run the 1200ms count-up/ring animation to completion in virtual time. */
function settleAnimation() {
  act(() => { vi.advanceTimersByTime(1500); });
}
/** The number inside the ring (the one big stat on each card). */
const ringText = (c: HTMLElement, cls: string) => c.querySelector(`span.stat-value.${cls}`)?.textContent ?? '';
/** A breakdown row's value, found through its label. */
const rowValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent ?? '';
/** The second <circle> is the progress arc; the first is its track. */
function progressRing(c: HTMLElement): SVGCircleElement {
  const ring = c.querySelectorAll('circle')[1];
  if (!ring) throw new Error('no progress ring rendered');
  return ring as SVGCircleElement;
}
/** Empty means offset == the full circumference — no dependence on RING_SIZE. */
const ringIsEmpty = (c: HTMLElement) =>
  progressRing(c).getAttribute('stroke-dashoffset') === progressRing(c).getAttribute('stroke-dasharray');
const notice = () => screen.queryByTestId('tegridy-score-unread');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  scoreState();
});
afterEach(() => vi.useRealTimers());

describe('TegridyScore — an input UNREAD', () => {
  it('withholds the score, rank and tier instead of drawing them short', () => {
    // OLD: rendered 72 — and on a full outage this card said "Seedling 🌱 /
    // Tier: Seedling" to a wallet whose reads had simply not landed.
    scoreState({ stakingScore: true, lockScore: true });
    const { container } = render(<TegridyScore />);
    settleAnimation();

    expect(ringText(container, 'text-4xl')).toBe('–');
    expect(screen.getByText('Score unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Farmer')).toBeNull();
    expect(screen.queryByText('Tier: Platinum')).toBeNull();
    expect(notice()).toHaveTextContent(/not a statement that you have no history/i);
    // The RING is a claim too: a filled arc says "you scored this" whatever the
    // number beside it reads. Asserted with the animation RUN, not at t=0.
    expect(ringIsEmpty(container)).toBe(true);
  });

  it('dashes only the components that could not be read', () => {
    scoreState({ loyaltyScore: true });
    render(<TegridyScore />);
    settleAnimation();

    expect(rowValue('Loyalty')).toBe('–');
    // The five that landed still show their figures — one outage is not six.
    expect(rowValue('Staking')).toBe('80');
    expect(rowValue('Activity')).toBe('50');
    // A READ zero is a figure, not an outage.
    expect(rowValue('Governance')).toBe('0');
  });

  it('TegridyScoreMini withholds the same claim', () => {
    scoreState({ activityScore: true });
    const { container } = render(<TegridyScoreMini />);
    settleAnimation();

    expect(ringText(container, 'text-2xl')).toBe('–');
    expect(screen.getByText('Score unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Tier: Platinum')).toBeNull();
    expect(ringIsEmpty(container)).toBe(true);
  });
});

describe('TegridyScore — every input READ', () => {
  // NOT DISCRIMINATING against the old code — identical before and after. These
  // fail if withholding ever widens to a wallet whose reads all landed.
  it('animates the ring to the real score and names the rank', () => {
    const { container } = render(<TegridyScore />);
    settleAnimation();

    expect(screen.getByText('Farmer')).toBeInTheDocument();
    expect(screen.getByText('Tier: Platinum')).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(ringText(container, 'text-4xl')).toBe('72');
    // …and the arc actually filled, so "empty ring" above means something.
    expect(ringIsEmpty(container)).toBe(false);
  });

  it('a READ zero component renders as 0, not as a dash', () => {
    render(<TegridyScore />);
    settleAnimation();

    expect(rowValue('Governance')).toBe('0');
    expect(notice()).toBeNull();
  });

  it('TegridyScoreMini renders the score, rank and tier', () => {
    const { container } = render(<TegridyScoreMini />);
    settleAnimation();

    expect(ringText(container, 'text-2xl')).toBe('72');
    expect(screen.getByText('Farmer')).toBeInTheDocument();
    expect(screen.getByText('Tier: Platinum')).toBeInTheDocument();
    expect(screen.queryByText('Score unavailable')).toBeNull();
  });
});
