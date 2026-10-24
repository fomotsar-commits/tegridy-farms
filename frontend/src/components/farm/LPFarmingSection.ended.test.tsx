/**
 * A FARM THAT STOPPED PAYING TAKES NO NEW STAKE (owner, 2026-10-14).
 *
 * Mainnet today: the LP farm's periodFinish is 2026-06-15T03:11:35Z, and one wallet
 * staked 528.2 LP into it between 2026-08-08 and 2026-09-07, earning nothing. The
 * section offered Stake on that farm the whole time.
 *
 * Now: an ended period (a LANDED past periodFinish) shows one line with that date and
 * no Stake box; Withdraw, Claim and Exit stay. An UNREAD periodFinish holds Stake and
 * says no date. A live period keeps Stake (negative control).
 *
 * The real useLPFarming runs on the shared wagmi mock, so the hook's own read of
 * entry [2] decides the branch, not a hand-built object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./ILCalculator', () => ({ ILCalculator: () => null }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));
vi.mock('../../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({ isLoaded: true, lpSupply: parseEther('10000'), tvl: 50_000 }) }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: 0.01 }) }));

import { useLPFarming } from '../../hooks/useLPFarming';
import { LPFarmingSection } from './LPFarmingSection';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, CHAIN_ID } from '../../lib/constants';

const USER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const ENDED_PERIOD_FINISH = 1_781_493_095n; // 2026-06-15T03:11:35Z, mainnet
const STAKED = 528_199_806_982_326_905_120n; // 528.2 LP, mainnet's one staker

function stubFarm(periodFinish: bigint | 'unread') {
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'totalRawSupply', result: STAKED });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'rewardRate', result: 3_306_878_306_878_306n });
  if (periodFinish === 'unread') {
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'periodFinish', result: undefined, status: 'failure' });
  } else {
    wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'periodFinish', result: periodFinish });
  }
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'rewardsDuration', result: 604_800n });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'totalRewardsFunded', result: parseEther('1000000') });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'rawBalanceOf', result: STAKED });
  wagmiMock.setReadResult({ functionName: 'earned', result: 0n });
  wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName: 'balanceOf', result: parseEther('3') });
  wagmiMock.setReadResult({ functionName: 'allowance', result: parseEther('1000000') });
  wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName: 'totalSupply', result: parseEther('10000') });
  wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName: 'MIN_STAKE', result: 10n ** 16n });
}

function Farm({ connected }: { connected: boolean }) {
  const lpFarm = useLPFarming();
  return <LPFarmingSection lpFarm={lpFarm} isConnected={connected} />;
}

const stakeButton = () => screen.queryByRole('button', { name: /^(stake|approve lp)$/i });

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
});

describe('LPFarmingSection: rewards ended', () => {
  it('says it ended with the read date and offers no stake; withdraw, claim and exit stay', () => {
    stubFarm(ENDED_PERIOD_FINISH);
    renderWithProviders(<Farm connected />);

    expect(screen.getByTestId('lp-farming-ended')).toHaveTextContent(
      'Rewards ended Jun 15, 2026, so new stakes are closed. Withdraw and claim still work.',
    );
    // The Period Ended tile says the same day as the line, wherever the visitor is.
    expect(screen.getByText('Period Ended').parentElement).toHaveTextContent('Jun 15, 2026');
    expect(screen.queryByText('Stake LP')).toBeNull();
    expect(stakeButton()).toBeNull();
    // The first-time staker's risk line is for money going in; none can.
    expect(screen.queryByText('Impermanent loss risk')).toBeNull();

    expect(screen.getByText('Withdraw LP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^withdraw$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claim rewards/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit \(withdraw all \+ claim\)/i })).toBeEnabled();
  });

  it('logged out, it asks to connect to withdraw or claim, not to stake', () => {
    stubFarm(ENDED_PERIOD_FINISH);
    renderWithProviders(<Farm connected={false} />);

    expect(screen.getByTestId('lp-farming-ended')).toBeInTheDocument();
    expect(screen.getByText('Connect an Ethereum wallet to withdraw or claim')).toBeInTheDocument();
    expect(screen.queryByText(/to stake LP tokens/i)).toBeNull();
  });
});

describe('LPFarmingSection: the end could not be read', () => {
  it('holds the stake and says no date', () => {
    stubFarm('unread');
    renderWithProviders(<Farm connected />);

    expect(screen.getByTestId('lp-farming-stake-held')).toHaveTextContent(
      'Whether rewards are still paid could not be read, so new stakes are held.',
    );
    expect(stakeButton()).toBeNull();
    expect(screen.queryByTestId('lp-farming-ended')).toBeNull();
    expect(screen.queryByText(/Rewards ended/)).toBeNull();
    expect(screen.getByRole('button', { name: /^withdraw$/i })).toBeInTheDocument();
  });
});

describe('LPFarmingSection: a live period (negative control)', () => {
  it('keeps the Stake box and its button', () => {
    stubFarm(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
    renderWithProviders(<Farm connected />);

    expect(screen.getByText('Stake LP')).toBeInTheDocument();
    expect(stakeButton()).toBeInTheDocument();
    expect(screen.queryByTestId('lp-farming-ended')).toBeNull();
    expect(screen.queryByTestId('lp-farming-stake-held')).toBeNull();
  });
});
