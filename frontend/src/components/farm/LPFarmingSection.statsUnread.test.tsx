/**
 * OUTAGE-AS-ZERO — the LP farm's farm-wide reads, as a SET.
 *
 * `useLPFarming` batches eleven contract reads and every one of them collapses to
 * `0n` / `0` on failure. `positionUnread` covers the three wallet reads
 * (rawBalanceOf/earned/LP-balanceOf). Of the farm-wide reads, `poolStatsUnread`
 * covers the pool totals ([0] totalRawSupply, [4] totalRewardsFunded) and
 * `minStakeUnread` covers [10] MIN_STAKE -- and each was wired to ONE sentence:
 * the APR caption and the minimum-stake hint. Everything else still rendered an
 * unanswered read as a definite claim:
 *
 *   - the stat TILES printed "Total LP Staked 0.0000" and "0 TOWELI" off the very
 *     reads poolStatsUnread had flagged;
 *   - a failed `periodFinish` made `isActive` false: an amber "0 / day" under
 *     "Reward Rate (ended)", titled "The reward period has ended", and an amber
 *     "Period Ended" -- claims about a schedule nobody read;
 *   - a landed `totalRawSupply` beside a FAILED `rewardRate` gave the APR hero a
 *     finite denominator over a zero numerator: a confident green "0.00%", with
 *     neither flag set;
 *   - and nothing on the section said any of it had happened.
 *
 * `statsUnread` is the union: the pool totals, the minimum, and [1] rewardRate,
 * [2] periodFinish, [3] rewardsDuration, [9] LP totalSupply. With wagmi 3 / viem 2
 * a failure never rejects the query or leaves `data` undefined -- every entry is
 * submitted `allowFailure: true`, so an outage arrives as eleven 'failure' entries
 * and a single reverting sub-call as one 'failure' among 'success' siblings. And
 * `positionUnread` requires `!!address`, so on the logged-out surface
 * (FarmPage.tsx:429 mounts this section at isConnected={false}) the wallet flag is
 * structurally off; these are the only signals there are.
 *
 * Fixtures set the flags the hook would set for the read that failed: an unread
 * pool total sets poolStatsUnread AND statsUnread; an unread periodFinish or
 * rewardRate sets statsUnread alone.
 *
 * Both directions are pinned, because the cheap version of this fix -- treating
 * every zero as an outage -- is a new bug of its own:
 *   - UNREAD:       the figures render as an en-dash, the notice appears, and NO
 *                   claim about the farm (invitation, "ended", an APR) is made.
 *   - GENUINE ZERO: a landed 0n is a real empty farm on a real ended schedule. The
 *                   figures render as 0, the invitation and "(ended)" stay, and no
 *                   outage notice appears.
 *
 * Per-test, what the section did WITHOUT statsUnread is recorded in the test body.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ComponentProps } from 'react';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button type="button">Connect</button>,
}));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));
vi.mock('./ILCalculator', () => ({ ILCalculator: () => null }));

// The APR hero needs a loaded pool and a price to reach its non-null branch at all;
// without them `lpApr` is null for reasons that have nothing to do with this fix.
const poolTVL = { isLoaded: true, lpSupply: 10_000n * 10n ** 18n, tvl: 1_000 };
vi.mock('../../hooks/usePoolTVL', () => ({ usePoolTVL: () => poolTVL }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: 1 }) }));

import { LPFarmingSection } from './LPFarmingSection';

type SectionProps = ComponentProps<typeof LPFarmingSection>;
type LPFarm = SectionProps['lpFarm'];

/** An allowance no test amount exceeds. */
const PLENTY = 1_000_000n * 10n ** 18n;

/**
 * A farm whose eleven reads ALL landed, on an ended schedule with nothing staked --
 * i.e. the honest zeros this fix must not swallow. Overrides layer on top.
 */
function farm(overrides: Partial<LPFarm> = {}): LPFarm {
  const base = {
    isReadLoading: false,
    isDeployed: true,
    statsUnread: false,
    poolStatsUnread: false,
    minStakeUnread: false,
    positionUnread: false,
    // Farm-wide
    totalStaked: 0n,
    totalStakedFormatted: '0',
    rewardRatePerDay: 0,
    rewardRatePerYear: 0,
    isActive: false,
    periodFinish: 0,
    totalRewardsFundedFormatted: '0',
    minStake: 0n,
    minStakeFormatted: '0',
    // Position
    stakedBalance: 0n,
    stakedBalanceFormatted: '0',
    pendingReward: 0n,
    pendingRewardFormatted: '0',
    walletLPBalance: 0n,
    walletLPBalanceFormatted: '0',
    lpAllowance: 0n,
    // Plumbing the section touches
    refetch: vi.fn(),
    claim: vi.fn(), exit: vi.fn(), stake: vi.fn(), withdraw: vi.fn(), approveLP: vi.fn(),
    isPending: false, isConfirming: false, isSuccess: false,
    lastActionRef: { current: null },
  };
  return { ...base, ...overrides } as unknown as LPFarm;
}

/** An unread pool total, as the hook reports it: both flags. */
const POOL_TOTAL_UNREAD = { statsUnread: true, poolStatsUnread: true } as const;
/** An unread rate or schedule ([1]/[2]/[3]/[9]): poolStatsUnread stays false. */
const SCHEDULE_UNREAD = { statsUnread: true } as const;

/** The value `<p>` of a stat tile, found through its label `<p>`. */
function tileValue(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  const tile = labelEl.parentElement;
  if (!tile) throw new Error(`stat tile for "${label}" has no parent`);
  const ps = tile.querySelectorAll('p');
  const value = ps[ps.length - 1];
  if (!value || value === labelEl) throw new Error(`stat tile for "${label}" has no value node`);
  return value as HTMLElement;
}

/** The Stake box's amount field: the first of the two "0.0" inputs (Withdraw is second). */
function typeStakeAmount(value: string) {
  const [stakeInput] = screen.getAllByPlaceholderText('0.0');
  fireEvent.change(stakeInput!, { target: { value } });
}

const invitation = () => screen.queryByText(/be the first to stake LP/i);
const notice = () => screen.queryByTestId('lp-farming-stats-unread');
const endedTooltip = () => document.querySelector('[title*="reward period has ended"]');

// ── UNREAD ────────────────────────────────────────────────────────────────────
// Rendered DISCONNECTED unless stated: that is the surface where `positionUnread`
// is structurally unreachable, so these flags are the only signal there is.
describe('LPFarmingSection — farm-wide reads UNREAD (disconnected surface)', () => {
  it('renders the staked total as unknown, not as zero', () => {
    // WITHOUT statsUnread: poolStatsUnread was set, but it only reached the APR
    // caption -- the tile still printed "0.0000" off the read it had flagged.
    render(<LPFarmingSection lpFarm={farm(POOL_TOTAL_UNREAD)} isConnected={false} />);

    expect(tileValue('Total LP Staked').textContent).toBe('–');
  });

  it('does not invite the visitor to be the first staker off an unread total', () => {
    // The invitation is a claim that the farm is empty. poolStatsUnread already
    // withheld it; statsUnread must keep doing so, and name the notice's Retry.
    render(<LPFarmingSection lpFarm={farm(POOL_TOTAL_UNREAD)} isConnected={false} />);

    expect(invitation()).toBeNull();
    expect(screen.getByText(/the farm figures could not be read/i)).toBeInTheDocument();
  });

  it('does not claim the reward period has ended off an unread periodFinish', () => {
    // WITHOUT statsUnread: periodFinish is outside poolStatsUnread, so nothing was
    // set. It collapsed to 0, `isActive` went false, and the tiles printed an amber
    // "0 / day" under "Reward Rate (ended)" titled "The reward period has ended",
    // and an amber "Period Ended" -- claims about a schedule nobody read.
    render(<LPFarmingSection lpFarm={farm(SCHEDULE_UNREAD)} isConnected={false} />);

    expect(screen.queryByText('Reward Rate (ended)')).toBeNull();
    expect(screen.queryByText('Period Ended')).toBeNull();
    expect(endedTooltip()).toBeNull();
    expect(tileValue('Reward Rate').textContent).toBe('–');
    expect(tileValue('Period Ends').textContent).toBe('–');
    // Amber is this section's "ended" colour; an unknown is not an ending.
    expect(tileValue('Reward Rate')).not.toHaveClass('text-amber-300');
    expect(tileValue('Period Ends')).not.toHaveClass('text-amber-300');
  });

  it('renders the funding total as unknown, not as zero', () => {
    // WITHOUT statsUnread: "0 TOWELI" -- an unfunded farm rather than an unread one,
    // again beside a poolStatsUnread that had flagged it.
    render(<LPFarmingSection lpFarm={farm(POOL_TOTAL_UNREAD)} isConnected={false} />);

    expect(tileValue('Total Funded').textContent).toBe('–');
  });

  it('says the figures are unknown, and its Retry refetches', () => {
    // WITHOUT statsUnread: no element on the section said a read had failed.
    const lp = farm(SCHEDULE_UNREAD);
    render(<LPFarmingSection lpFarm={lp} isConnected={false} />);

    const panel = notice();
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(/could not be read just now/i);
    // And it must not be mistaken for a real empty, ended farm.
    expect(panel).toHaveTextContent(/unknown, not zero/i);
    expect(panel).toHaveTextContent(/not a statement that nothing is staked/i);

    fireEvent.click(within(panel!).getByRole('button', { name: /^retry$/i }));
    expect(lp.refetch).toHaveBeenCalledTimes(1);
  });

  it('suppresses the APR figure when the total landed but the rate did not', () => {
    // THE PARTIAL CASE neither earlier flag sees: totalRawSupply and
    // totalRewardsFunded LANDED, so poolStatsUnread is false. A failed `rewardRate`
    // made rewardRatePerYear 0 over a finite, non-zero denominator, so lpApr was
    // exactly 0 and the hero printed a confident green "0.00%".
    render(<LPFarmingSection
      lpFarm={farm({ ...SCHEDULE_UNREAD, totalStaked: 5_000n * 10n ** 18n, totalStakedFormatted: '5000', rewardRatePerYear: 0 })}
      isConnected={false}
    />);

    // Positively in its unknown state, saying why...
    expect(screen.getByText(/the farm figures could not be read/i)).toBeInTheDocument();
    // ...and not the figure or its "live" caption.
    expect(screen.queryByText(/^0\.00%$/)).toBeNull();
    expect(screen.queryByText(/estimated from staked TVL/i)).toBeNull();
  });

  it('hides a LANDED period date too while the set is unread', () => {
    // One flag for the set, by design: with the rate unknown, a lone landed date
    // would still read as a schedule. The LIVE badge keeps following the landed
    // periodFinish -- it is never derived from a failed read.
    // WITHOUT statsUnread: the date printed regardless of any failure elsewhere.
    const future = Math.floor(Date.now() / 1000) + 86_400;
    render(<LPFarmingSection lpFarm={farm({ ...SCHEDULE_UNREAD, periodFinish: future, isActive: true })} isConnected={false} />);

    expect(tileValue('Period Ends').textContent).toBe('–');
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('still fires on the connected surface, beside the position notice', () => {
    // The flags are different facts and none substitutes for another: a
    // whole-batch outage is every one of them at once.
    render(<LPFarmingSection
      lpFarm={farm({ ...POOL_TOTAL_UNREAD, minStakeUnread: true, positionUnread: true })}
      isConnected
    />);

    expect(notice()).toBeInTheDocument();
    expect(screen.getByTestId('lp-farming-position-unread')).toBeInTheDocument();
  });

  it('an unread MIN_STAKE raises the notice but, by design, does not block a stake', () => {
    // minStakeUnread's own decision, kept: the contract enforces MIN_STAKE either
    // way, so the section SAYS the minimum is unread and leaves Stake armed rather
    // than refuse a legitimate stake over one unanswered read of a constant.
    // statsUnread includes [10] only so the notice -- and its Retry -- appears too.
    render(<LPFarmingSection
      lpFarm={farm({ statsUnread: true, minStakeUnread: true, lpAllowance: PLENTY })}
      isConnected
    />);
    typeStakeAmount('1');

    expect(notice()).toBeInTheDocument();
    expect(screen.getByText(/minimum stake/i)).toHaveTextContent(/unread/i);
    expect(screen.getByRole('button', { name: /^stake$/i })).toBeEnabled();
  });
});

// ── GENUINE ZERO ──────────────────────────────────────────────────────────────
describe('LPFarmingSection — farm-wide reads GENUINE ZERO', () => {
  it('reports a real empty farm as 0, and keeps the invitation', () => {
    // The load-bearing counter-test: an empty farm is a real, publishable state and
    // "be the first to stake" is the correct thing to say about it. A fix that
    // blanked every zero would break this. On a LIVE schedule: on an ended one the
    // invitation is itself a bug (#509) — a deposit into a farm paying nothing.
    const future = Math.floor(Date.now() / 1000) + 86_400;
    render(<LPFarmingSection lpFarm={farm({ isActive: true, periodFinish: future })} isConnected={false} />);

    expect(tileValue('Total LP Staked').textContent).toBe('0.0000');
    expect(invitation()).toBeInTheDocument();
    expect(notice()).toBeNull();
  });

  it('reports a real ended schedule as ended', () => {
    // A landed `periodFinish` in the past is a genuine fact about the farm, and the
    // amber "0 / day" + "(ended)" + tooltip is exactly the disclosure it deserves.
    const past = Math.floor(Date.now() / 1000) - 3600;
    render(<LPFarmingSection lpFarm={farm({ periodFinish: past, isActive: false })} isConnected={false} />);

    expect(screen.getByText('Reward Rate (ended)')).toBeInTheDocument();
    expect(screen.getByText('Period Ended')).toBeInTheDocument();
    expect(endedTooltip()).not.toBeNull();
    expect(tileValue('Reward Rate (ended)')).toHaveTextContent('0 / day');
    expect(notice()).toBeNull();
  });

  it('reports a real unfunded farm as 0 TOWELI', () => {
    render(<LPFarmingSection lpFarm={farm()} isConnected={false} />);

    expect(tileValue('Total Funded').textContent).toBe('0 TOWELI');
    expect(notice()).toBeNull();
  });
});

// ── A FARM THAT WAS READ ──────────────────────────────────────────────────────
describe('LPFarmingSection — a live farm that was read', () => {
  // NOT discriminating -- a healthy farm renders the same with or without the
  // flags. Kept as the other guard rail: it fails if `statsUnread` is ever widened
  // into blanking figures that did land.
  it('prints the real figures and no notice', () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    render(<LPFarmingSection
      lpFarm={farm({
        totalStaked: 5_000n * 10n ** 18n,
        totalStakedFormatted: '5000',
        rewardRatePerDay: 100,
        rewardRatePerYear: 36_500,
        isActive: true,
        periodFinish: future,
        totalRewardsFundedFormatted: '1000000',
      })}
      isConnected={false}
    />);

    expect(tileValue('Total LP Staked')).toHaveTextContent('5000.0000');
    expect(tileValue('Reward Rate')).toHaveTextContent('100.00 / day');
    expect(tileValue('Total Funded')).toHaveTextContent('1M TOWELI');
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    // 36,500 TOWELI/yr at $1 over half of a $1,000 pool = 7,300%.
    expect(screen.getByText('7300.00%')).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(invitation()).toBeNull();
  });
});
