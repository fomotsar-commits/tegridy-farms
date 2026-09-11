/**
 * OUTAGE-AS-ZERO — the LP farm's SEVEN farm-wide reads.
 *
 * `useLPFarming` batches eleven contract reads and every one of them collapses to
 * `0n` / `0` on failure. Only three of the eleven were signalled: `positionUnread`
 * covers rawBalanceOf/earned/LP-balanceOf. The other seven -- totalRawSupply,
 * rewardRate, periodFinish, rewardsDuration, totalRewardsFunded, LP totalSupply,
 * MIN_STAKE -- had nothing, so an unanswered read rendered as a definite figure:
 *
 *   - a failed `totalRawSupply` printed "Total LP Staked 0.0000", and the same zero
 *     took `lpApr` down the `staked === 0n` branch, whose caption is
 *     "be the first to stake LP to activate the live APR" -- an INVITATION derived
 *     from a read that never landed;
 *   - a failed `periodFinish` made `isActive` false, which dropped the LIVE badge and
 *     printed an amber "0 / day" under "Reward Rate (ended)", titled "The reward
 *     period has ended";
 *   - a landed `totalRawSupply` beside a FAILED `rewardRate` was worse than either:
 *     a finite denominator over a zero numerator renders a confident "0.00%" APR.
 *
 * Two things make this reachable rather than theoretical:
 *   1. `positionUnread` requires `!!address`. FarmPage.tsx:429 mounts this section at
 *      isConnected={false} for the logged-out public surface, where that flag can
 *      never be true -- so on that surface all seven zeros were unsignalled AND the
 *      one existing signal was structurally off.
 *   2. A TOTAL failure was already covered (`data` undefined trips every
 *      `!== 'success'`). The gap is PARTIAL failure, and viem produces it as a matter
 *      of course: every entry of a multicall is submitted `allowFailure: true`
 *      (viem/actions/public/multicall.js), so one reverting sub-call comes back
 *      `status: 'failure'` beside ten 'success' siblings; separately, a rejected
 *      chunk fails only its own entries.
 *
 * Both directions are pinned here, because the cheap version of this fix -- treating
 * every zero as an outage -- is a new bug of its own:
 *   - UNREAD:       the figures render as an en-dash, the notice appears, and NO
 *                   claim about the farm (invitation, "ended", an APR) is made.
 *   - GENUINE ZERO: a landed 0n is a real empty farm on a real ended schedule. The
 *                   figures render as 0, the invitation stays, "Reward Rate (ended)"
 *                   stays, and the outage notice is ABSENT.
 *
 * Per-test, what the UNPATCHED section did is recorded in the test body.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

/**
 * A farm whose eleven reads ALL landed, on an ended schedule with nothing staked --
 * i.e. the honest zeros this fix must not swallow. Overrides layer on top.
 */
function farm(overrides: Partial<LPFarm> = {}): LPFarm {
  const base = {
    isReadLoading: false,
    isDeployed: true,
    statsUnread: false,
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
    // Plumbing the section touches but this spec does not exercise
    refetch: vi.fn(),
    claim: vi.fn(), exit: vi.fn(), stake: vi.fn(), withdraw: vi.fn(), approveLP: vi.fn(),
    isPending: false, isConfirming: false, isSuccess: false,
    lastActionRef: { current: null },
  };
  return { ...base, ...overrides } as unknown as LPFarm;
}

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

const invitation = () => screen.queryByText(/be the first to stake LP/i);
const notice = () => screen.queryByTestId('lp-farming-stats-unread');
const endedTooltip = () => document.querySelector('[title*="reward period has ended"]');

// ── UNREAD ────────────────────────────────────────────────────────────────────
// Rendered DISCONNECTED throughout: that is the surface where `positionUnread`
// is structurally unreachable, so `statsUnread` is the only signal there is.
describe('LPFarmingSection — farm-wide reads UNREAD (disconnected surface)', () => {
  it('renders the staked total as unknown, not as zero', () => {
    // OLD: totalRawSupply collapsed to 0n and this printed "0.0000" -- a definite,
    // checkable-looking figure for a read the RPC never answered.
    render(<LPFarmingSection lpFarm={farm({ statsUnread: true })} isConnected={false} />);

    expect(tileValue('Total LP Staked')).toHaveTextContent('–');
    expect(tileValue('Total LP Staked').textContent).not.toContain('0');
  });

  it('does not invite the visitor to be the first staker off an unread total', () => {
    // OLD: `lpFarm.totalStaked === 0n` was true for the failed read, so the APR hero
    // read "be the first to stake LP to activate the live APR" -- a claim that the
    // farm is empty, sourced from nothing.
    render(<LPFarmingSection lpFarm={farm({ statsUnread: true })} isConnected={false} />);

    expect(invitation()).toBeNull();
    expect(screen.getByText(/farm figures could not be read/i)).toBeInTheDocument();
  });

  it('does not claim the reward period has ended off an unread periodFinish', () => {
    // OLD: periodFinish collapsed to 0, `isActive` went false, and the tile printed
    // an amber "0 / day" under "Reward Rate (ended)" with the title "The reward
    // period has ended" -- a statement about the emission schedule nobody had read.
    render(<LPFarmingSection lpFarm={farm({ statsUnread: true })} isConnected={false} />);

    expect(screen.queryByText('Reward Rate (ended)')).toBeNull();
    expect(screen.queryByText('Period Ended')).toBeNull();
    expect(endedTooltip()).toBeNull();
    expect(tileValue('Reward Rate')).toHaveTextContent('–');
    expect(tileValue('Reward Rate').textContent).not.toContain('0');
  });

  it('renders the funding total as unknown, not as zero', () => {
    // OLD: "0 TOWELI" -- reads as an unfunded farm rather than an unread one.
    render(<LPFarmingSection lpFarm={farm({ statsUnread: true })} isConnected={false} />);

    expect(tileValue('Total Funded')).toHaveTextContent('–');
    expect(tileValue('Total Funded').textContent).not.toContain('TOWELI');
  });

  it('says the figures are unknown rather than leaving the zeros unexplained', () => {
    // OLD: this element did not exist in any state. The seven reads had no signal at
    // all, which is the whole finding.
    render(<LPFarmingSection lpFarm={farm({ statsUnread: true })} isConnected={false} />);

    const panel = notice();
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(/could not be read just now/i);
    // And it must not be mistaken for a real empty, ended farm.
    expect(panel).toHaveTextContent(/unknown, not zero/i);
    expect(panel).toHaveTextContent(/not a statement that nothing is staked/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('suppresses the APR figure when the total landed but the rate did not', () => {
    // THE PARTIAL CASE, and the one an "is totalStaked zero?" fix would miss.
    // OLD: totalRawSupply landed at 5,000 LP so the denominator was finite and
    // non-zero, while a failed `rewardRate` made rewardRatePerYear 0 -- so lpApr
    // computed to exactly 0 and the hero printed a confident green "0.00%".
    render(<LPFarmingSection
      lpFarm={farm({ statsUnread: true, totalStaked: 5_000n * 10n ** 18n, totalStakedFormatted: '5000', rewardRatePerYear: 0 })}
      isConnected={false}
    />);

    expect(screen.queryByText(/^0\.00%$/)).toBeNull();
    expect(screen.queryByText(/estimated from staked TVL/i)).toBeNull();
    expect(notice()).toBeInTheDocument();
  });

  it('still fires on the connected surface, beside the position notice', () => {
    // The two flags are different facts and neither substitutes for the other:
    // `positionUnread` covers three reads about YOUR wallet, `statsUnread` seven
    // about the farm. A whole-batch outage is both.
    render(<LPFarmingSection
      lpFarm={farm({ statsUnread: true, positionUnread: true })}
      isConnected
    />);

    expect(notice()).toBeInTheDocument();
    expect(screen.getByTestId('lp-farming-position-unread')).toBeInTheDocument();
  });
});

// ── GENUINE ZERO ──────────────────────────────────────────────────────────────
describe('LPFarmingSection — farm-wide reads GENUINE ZERO', () => {
  it('reports a real empty farm as 0, and keeps the invitation', () => {
    // The load-bearing counter-test: an empty farm is a real, publishable state and
    // "be the first to stake" is the correct thing to say about it. A fix that
    // blanked every zero would break this.
    render(<LPFarmingSection lpFarm={farm()} isConnected={false} />);

    expect(tileValue('Total LP Staked')).toHaveTextContent('0.0000');
    expect(tileValue('Total LP Staked').textContent).not.toContain('–');
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

    expect(tileValue('Total Funded')).toHaveTextContent('0 TOWELI');
    expect(notice()).toBeNull();
  });
});

// ── A FARM THAT WAS READ ──────────────────────────────────────────────────────
describe('LPFarmingSection — a live farm that was read', () => {
  // NOT discriminating against the old code -- a healthy farm renders identically
  // either way. Kept as the other guard rail: it fails if `statsUnread` is ever
  // widened into blanking figures that did land.
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
