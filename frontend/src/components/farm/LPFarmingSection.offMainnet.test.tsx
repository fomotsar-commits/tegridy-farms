/**
 * LOGGED OUT, WITH A WALLET LAST ON ANOTHER CHAIN, THE LP FARM IS STILL THE
 * MAINNET FARM.
 *
 * FarmPage's logged-out branch mounts this section at isConnected={false}. There
 * is no wallet there, but wagmi still has a chain: it persists `state.chainId` to
 * localStorage (@wagmi/core createConfig.js, `partialize`) and a disconnect does
 * not reset it (actions/disconnect.js). So a returning visitor who was last
 * connected on Base lands on this surface with useChainId() === 8453.
 *
 * useLPFarming used to gate its batch on `useChainId() === CHAIN_ID`. Off mainnet
 * the query was disabled, and a disabled TanStack query is `pending` without
 * `fetching` -- isLoading false, data undefined -- so the skeleton never showed and
 * every read collapsed to 0. None of the unread flags fired, because each carried
 * the same chain term. The section then stated an empty, ended farm as fact:
 * "Total LP Staked 0.0000", "be the first to stake LP to activate the live APR",
 * "0 TOWELI" funded, an amber "Reward Rate (ended)" and "Period Ended". Nothing
 * on the page said why: WrongChainGuard and AppLayout's banner both require
 * isConnected.
 *
 * Every read in that batch was already pinned `chainId: CHAIN_ID`, so the gate
 * was the only thing stopping them. It is gone, and this pins the result where a
 * visitor sees it: the REAL hooks (useLPFarming, and usePoolTVL inside the
 * section), under the shared wagmi mock -- which now honours `query.enabled`, as
 * real wagmi does. Before that it answered disabled queries anyway, so no test
 * could see this gate.
 *
 * MUTATION CHECK: put `&& onMainnet` back on either hook's `enabled` and every
 * off-mainnet case here fails. Put a chain term back on useLPFarming's
 * `statsUnread` alone and the failed-read case fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button type="button">Connect</button>,
}));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));
vi.mock('./ILCalculator', () => ({ ILCalculator: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Both the section's APR and usePoolTVL's USD TVL need a price; without one the
// APR is null for reasons that have nothing to do with the chain.
vi.mock('../../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 0.001, ethUsd: 2000, ethUsdForDisplay: 2000, priceInEth: 0 }),
}));

import { LPFarmingSection } from './LPFarmingSection';
import { useLPFarming } from '../../hooks/useLPFarming';
import { formatNumber } from '../../lib/formatting';
import { CHAIN_ID, LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS } from '../../lib/constants';

const E18 = 10n ** 18n;
const NOW = new Date('2026-09-10T12:00:00Z');
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** The logged-out branch as FarmPage mounts it: the real hook, isConnected={false}. */
function LoggedOutFarm() {
  const lpFarm = useLPFarming();
  return <LPFarmingSection lpFarm={lpFarm} isConnected={false} />;
}

/** A live, funded mainnet farm with LP staked in it -- nothing about it is empty or ended. */
function stubMainnetFarm() {
  const farm = (functionName: string, result: unknown) =>
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName, result });
  const lp = (functionName: string, result: unknown) =>
    wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName, result });

  farm('totalRawSupply', 5_000n * E18);
  farm('rewardRate', E18); // 1 TOWELI/s = 86,400/day
  farm('periodFinish', BigInt(Math.floor(NOW.getTime() / 1000) + 7 * 86_400));
  farm('rewardsDuration', 604_800n);
  farm('totalRewardsFunded', 1_000_000n * E18);
  farm('MIN_STAKE', E18 / 100n);
  farm('rawBalanceOf', 0n);
  farm('earned', 0n);
  lp('balanceOf', 0n);
  lp('allowance', 0n);
  lp('totalSupply', 10_000n * E18);
  // usePoolTVL, which the section calls for the APR's USD denominator.
  lp('getReserves', [1_000_000n * E18, 10n * E18, 0]);
  lp('token0', TOWELI_ADDRESS);
}

function renderAt(chainId: number) {
  wagmiMock.setChainId(chainId);
  return render(<LoggedOutFarm />);
}

/** The value `<p>` of a stat tile, found through its label `<p>`. */
function tileValue(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  const ps = labelEl.parentElement?.querySelectorAll('p') ?? [];
  const value = ps[ps.length - 1];
  if (!value || value === labelEl) throw new Error(`stat tile for "${label}" has no value node`);
  return value as HTMLElement;
}

describe('LPFarmingSection — logged out, wallet chain persisted from another network', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wagmiMock.reset();
    wagmiMock.setAccount({ address: undefined, isConnected: false });
    stubMainnetFarm();
  });
  afterEach(() => vi.useRealTimers());

  it.each(OFF_MAINNET)('on %s it makes no empty-or-ended claim about a live farm', (_label, chainId) => {
    renderAt(chainId);

    // The four claims the disabled batch used to print.
    expect(screen.queryByText(/be the first to stake LP/i)).toBeNull();
    expect(screen.queryByText('Reward Rate (ended)')).toBeNull();
    expect(screen.queryByText('Period Ended')).toBeNull();
    expect(document.querySelector('[title*="reward period has ended"]')).toBeNull();

    // ...and, positively, the figures of the farm that was stubbed.
    expect(tileValue('Total LP Staked')).toHaveTextContent('5000.0000');
    expect(tileValue('Total Funded')).toHaveTextContent('1M TOWELI');
    expect(tileValue('Reward Rate')).toHaveTextContent(`${formatNumber(86_400, 2)} / day`);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    // The APR's caption renders only when the figure does.
    expect(screen.getByText(/estimated from staked TVL/i)).toBeInTheDocument();
  });

  it.each(OFF_MAINNET)('on %s it renders exactly what a mainnet visitor sees', (_label, chainId) => {
    // The invariant, rather than a list of strings: the wallet's chain must not
    // change a single character of what this section says about a mainnet farm.
    const mainnet = renderAt(CHAIN_ID).container.textContent;
    cleanup();
    const offMainnet = renderAt(chainId).container.textContent;

    // Non-vacuity: two renders of an unread farm would also be equal.
    expect(mainnet).toContain('5000.0000');
    expect(offMainnet).toBe(mainnet);
  });

  it.each(OFF_MAINNET)('on %s a failed read says so, instead of claiming the period ended', (_label, chainId) => {
    // The reads now RUN off mainnet, so they can FAIL there too, and statsUnread
    // must fire for that failure exactly as it does on mainnet.
    //
    // ONE leg fails, and it is one the pool-total flags do not cover. statsUnread
    // is a union: with every read failing, poolStatsUnread raises the notice by
    // itself, and an earlier all-fail version of this test passed with a chain
    // term put back on statsUnread's own clause. With that term, a failed
    // periodFinish collapsed to 0 and this live farm was printed as ended.
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'periodFinish', result: undefined, status: 'failure' });
    renderAt(chainId);

    expect(screen.getByTestId('lp-farming-stats-unread')).toBeInTheDocument();
    expect(screen.queryByText('Reward Rate (ended)')).toBeNull();
    expect(screen.queryByText('Period Ended')).toBeNull();
    expect(tileValue('Period Ends').textContent).toBe('–');
  });
});
