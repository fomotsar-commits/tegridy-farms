/**
 * THE APR HERO MUST NOT QUOTE A RATE ON AN ENDED REWARD PERIOD.
 *
 * useLPFarming zeroes `rewardRatePerYear` once `periodFinish` lapses (fix F100):
 * Synthetix-style `rewardRate` storage keeps its last value after the period while
 * earned() stops. The section's `lpApr` memo was never told. It returned null only
 * for an unloaded pool, a zero LP supply, nothing staked, or no price — so with LP
 * staked on an ENDED period it divided a zero rate and returned exactly 0, and the
 * hero printed a green "0.00%" captioned "estimated from staked TVL · falls as more
 * LP is staked": a live, diluting yield, on a farm paying nothing. The caption
 * written for that state sat in the null branch and could not be reached.
 *
 * With NOTHING staked it was worse. `totalStaked === 0n` was tested before
 * `!isActive`, so the hero invited "be the first to stake LP to activate the live
 * APR" onto a farm with no live APR to activate. That is mainnet today —
 * addresses.json records the LP farm's emissions ended 2026-06-15, 0 LP staked.
 *
 * These mount the REAL useLPFarming on the shared wagmi mock, not a hand-built
 * `lpFarm` object: the zero rate on an ended period is then what the hook actually
 * returns, rather than what this file assumes it returns. The fixture is mainnet's
 * own state (lib/lpEmissions.ts:9-11) — a past periodFinish with the residual
 * rewardRate still in storage — so a regression in EITHER layer shows up here.
 *
 * MUTATION CHECK, run against the pre-fix component: the two ended-period cases
 * fail (the first on "0.00%", the second on "be the first"). The live-period cases
 * are negative controls and pass both ways — they fail only if the fix were made by
 * deleting the APR or the invitation outright. The unread case also passes both
 * ways: it pins the ORDER the fix had to keep, and fails if `!isActive` is moved
 * above `poolStatsUnread`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));

// Everything lpApr divides by: loaded, non-zero, and priced. The old memo returned
// a number from exactly these inputs, so only the reward period decides the branch.
const pool = { isLoaded: true, lpSupply: parseEther('10000'), tvl: 50_000 };
vi.mock('../../hooks/usePoolTVL', () => ({ usePoolTVL: () => pool }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: 0.01 }) }));

import { useLPFarming } from '../../hooks/useLPFarming';
import { LPFarmingSection } from './LPFarmingSection';
import { LP_FARMING_ADDRESS, CHAIN_ID } from '../../lib/constants';

// Mainnet, lib/lpEmissions.ts:9-11: periodFinish is 2026-06-15, and the residual
// rewardRate (~0.0033 TOWELI/sec) is still in storage because nothing overwrote it.
const ENDED_PERIOD_FINISH = 1_781_493_095n;
const RESIDUAL_REWARD_RATE = 3_306_878_306_878_306n;
const livePeriodFinish = () => BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

function stubFarm({ periodFinish, totalStaked }: { periodFinish: bigint; totalStaked: bigint }) {
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'totalRawSupply', result: totalStaked });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'rewardRate', result: RESIDUAL_REWARD_RATE });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'periodFinish', result: periodFinish });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'totalRewardsFunded', result: parseEther('1000000') });
}

function Farm() {
  // A visitor, not a staker: the hero is a claim about the POOL, and rendering it
  // disconnected keeps the wallet panel and its own reads out of the question.
  const lpFarm = useLPFarming();
  return <LPFarmingSection lpFarm={lpFarm} isConnected={false} />;
}

/** The hero row — its label, its figure, and the caption beside it. Nothing else. */
function hero(): HTMLElement {
  return screen.getByText(/est\. apr/i).parentElement!;
}

describe('LPFarmingSection — APR hero on an ended reward period', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
  });

  it('with LP staked, shows no APR figure — not "0.00%" — and says the period ended', () => {
    stubFarm({ periodFinish: ENDED_PERIOD_FINISH, totalStaked: parseEther('1000') });
    renderWithProviders(<Farm />);

    // Preconditions, so nothing below can pass for the wrong reason: the hook
    // really reports an ended period, and the pool totals really were read.
    expect(screen.getByText('Period Ended')).toBeInTheDocument();
    expect(hero()).not.toHaveTextContent(/unread/i);

    expect(hero()).not.toHaveTextContent('0.00%');
    // Not merely "not zero": an ended period has no rate to quote at all.
    expect(hero()).not.toHaveTextContent('%');
    expect(hero()).not.toHaveTextContent(/falls as more LP is staked/i);
    expect(hero()).toHaveTextContent(/reward period ended/i);
  });

  it('with nothing staked, does not invite anyone to be first', () => {
    stubFarm({ periodFinish: ENDED_PERIOD_FINISH, totalStaked: 0n });
    renderWithProviders(<Farm />);

    expect(screen.getByText('Period Ended')).toBeInTheDocument();
    expect(hero()).not.toHaveTextContent(/be the first/i);
    expect(hero()).toHaveTextContent(/reward period ended/i);
  });

  it('an unread pool total still outranks the ended caption', () => {
    // periodFinish lands and says ENDED; totalRawSupply is left unstubbed, so it fails.
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'periodFinish', result: ENDED_PERIOD_FINISH });
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'totalRewardsFunded', result: parseEther('1000000') });
    renderWithProviders(<Farm />);

    expect(hero()).toHaveTextContent(/pool totals unread/i);
    expect(hero()).not.toHaveTextContent(/reward period ended/i);
    expect(hero()).not.toHaveTextContent(/be the first/i);
  });
});

describe('LPFarmingSection — APR hero on a live reward period (negative controls)', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
  });

  it('with LP staked, still quotes a positive APR', () => {
    // The same stored rate, now inside its period: a real, paying rate.
    stubFarm({ periodFinish: livePeriodFinish(), totalStaked: parseEther('1000') });
    renderWithProviders(<Farm />);

    const figure = within(hero()).getByText(/%$/);
    expect(parseFloat(figure.textContent ?? '')).toBeGreaterThan(0);
    expect(hero()).toHaveTextContent(/falls as more LP is staked/i);
    expect(hero()).not.toHaveTextContent(/ended/i);
  });

  it('with nothing staked, still invites the first staker', () => {
    stubFarm({ periodFinish: livePeriodFinish(), totalStaked: 0n });
    renderWithProviders(<Farm />);

    expect(hero()).toHaveTextContent(/be the first to stake LP/i);
    expect(hero()).not.toHaveTextContent(/ended/i);
  });
});
