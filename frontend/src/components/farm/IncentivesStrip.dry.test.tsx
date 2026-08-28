import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IncentivesStrip } from './IncentivesStrip';

// STAKING_LOOK §2.2 — the regression this suite exists to prevent (it had
// no net before): on the day the reward reserve runs dry, the strip used to
// fall back to the CUMULATIVE "Reward Pool 6,400,000 TOWELI" figure while
// still advertising nominal APR and daily emissions — a dead pool dressed
// as a live one. The dry-day contract: real zeros, with the reason attached.

const LIVE_PROPS = {
  apr: '1237.33',
  aprNum: 1237.33,
  rewardPool: '6,400,000 TOWELI',
  dailyEmissions: '71,220 TOWELI',
  rewardsRemaining: '2,556,889 TOWELI',
  secondsRemaining: 3_100_000,
};

describe('IncentivesStrip — dry reserve day (§2.2)', () => {
  it('renders real zeros with the reason when the reserve is empty', () => {
    render(
      <IncentivesStrip
        {...LIVE_PROPS}
        apr="0"
        aprNum={0}
        rewardsRemaining="0 TOWELI"
        secondsRemaining={0}
        reserveEmpty
      />,
    );
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('0 TOWELI')).toBeTruthy();
    expect(screen.getByText('0 / day')).toBeTruthy();
    // The reason line rides the APR and Remaining tiles.
    expect(screen.getAllByText(/reserve empty — emissions paused/i).length).toBeGreaterThanOrEqual(2);
    // The cumulative figure must NOT reappear anywhere on the dry day.
    expect(screen.queryByText(/6,400,000/)).toBeNull();
    expect(screen.queryByText('Reward Pool')).toBeNull();
  });

  it('keeps the live rendering when the reserve holds funds', () => {
    render(<IncentivesStrip {...LIVE_PROPS} />);
    expect(screen.getByText('1237.33%')).toBeTruthy();
    expect(screen.getByText('2,556,889 TOWELI')).toBeTruthy();
    expect(screen.getByText(/71,220 TOWELI \/ day/)).toBeTruthy();
    expect(screen.getByText('Rewards Remaining')).toBeTruthy();
    expect(screen.queryByText(/reserve empty/i)).toBeNull();
  });

  it('never conflates unread with zero: no reserveEmpty flag → no zeros invented', () => {
    render(<IncentivesStrip apr="–" rewardPool="–" dailyEmissions="–" />);
    // Unread renders as dashes, not fabricated zeros.
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText('0 / day')).toBeNull();
  });
});
