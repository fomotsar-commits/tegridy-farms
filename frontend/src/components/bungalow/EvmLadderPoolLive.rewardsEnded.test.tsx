// An EVM ladder whose reward period has ENDED takes no new stake (owner, 2026-10-14):
// one line with the date periodFinish returned, no amount field, no Approve or Stake.
// Claim stays. A pool paying 0 now (never funded, or a rate of 0, as QR reads today)
// takes none either: a lock would earn nothing and leaving early costs the penalty. A
// never-funded pool is "not started", never "ended". An end or a rate that could not
// be read holds Stake (money review 2026-10-14, m-3 and m-4). A live one keeps it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };
const USER = '0x00000000000000000000000000000000000000a1';
const wagmiState = vi.hoisted(() => ({ answers: new Map<string, ReadCell>(), loading: false }));
const keyOf = (q: Query) => `${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContracts: ({ contracts }: { contracts: Query[] }) => ({
    data: contracts.map((q) => wagmiState.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) }),
    isLoading: wagmiState.loading,
    refetch: () => Promise.resolve(),
  }),
  useWriteContract: () => ({ writeContractAsync: () => Promise.resolve('0x' as `0x${string}`) }),
  useWaitForTransactionReceipt: () => ({ data: undefined }),
}));

const { EvmLadderPoolLive } = await import('./EvmLadderPoolLive');

const E18 = 10n ** 18n;
const QR = {
  id: 'qr', name: 'QR', symbol: 'QR', chain: 'base',
  address: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf',
  stakePool: '0x55B72f09d31f43834bf7Eba42f53a419a716F554',
  poolKind: 'ladder', status: 'SETTLED', tagline: 'x', thumb: '/art/x.jpg', live: true,
} as unknown as Bungalow & { stakePool: string };

const ok = (result: unknown): ReadCell => ({ status: 'success', result });
// 2026-06-15T03:11:35Z, the LP farm's real end: any past landed time will do.
const ENDED = 1_781_493_095n;

function seed(periodFinish: bigint, rate = 1_000n) {
  wagmiState.loading = false;
  wagmiState.answers = new Map(Object.entries({
    'totalSupply:': ok(200n * E18),
    'totalBoosted:': ok(200n * E18),
    'rewardSurplus:': ok(60n * E18),
    'rewardRate:': ok(rate),
    'periodFinish:': ok(periodFinish),
    'rewardsDuration:': ok(BigInt(60 * 86_400)),
    'decimals:': ok(18),
    [`earned:${USER}`]: ok(5n * E18),
    [`balanceOf:${USER}`]: ok(500n * E18),
    [`allowance:${USER},${QR.stakePool}`]: ok(10_000n * E18),
    [`positionsOf:${USER}`]: ok([]),
    'stakingToken:': ok(QR.address),
  }));
}

const stakeButton = () => screen.queryByRole('button', { name: /^Stake for/ });

describe('EvmLadderPoolLive: an ended reward period', () => {
  beforeEach(() => seed(ENDED));

  it('says it ended with the read date, and offers no stake', async () => {
    render(<EvmLadderPoolLive bungalow={QR} />);
    const line = await screen.findByTestId('ladder-rewards-ended');
    expect(line).toHaveTextContent('Rewards ended Jun 15, 2026, so new stakes are closed.');
    expect(stakeButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByLabelText(/Amount of QR to stake/)).toBeNull();
    // Claim stays.
    expect(screen.getByRole('button', { name: /Claim rewards/ })).toBeInTheDocument();
  });
});

describe('EvmLadderPoolLive: not ended (negative controls)', () => {
  it('a live period keeps Stake and says nothing about an end', async () => {
    seed(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByRole('button', { name: /^Stake for/ })).toBeInTheDocument();
    expect(screen.queryByTestId('ladder-rewards-ended')).toBeNull();
  });
});

describe('EvmLadderPoolLive: a pool that pays 0 now', () => {
  it('a period that runs at a rate of 0 (QR today) takes no new stake; claim stays', async () => {
    seed(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), 0n);
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-rewards-zero')).toHaveTextContent(
      'This pool pays 0 rewards now, so new stakes are closed. Withdraw and claim still work.',
    );
    expect(stakeButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByLabelText(/Amount of QR to stake/)).toBeNull();
    expect(screen.queryByTestId('ladder-rewards-ended')).toBeNull();
    expect(screen.getByRole('button', { name: /Claim rewards/ })).toBeInTheDocument();
  });

  it('a never-funded pool (periodFinish 0) is not called ended, and takes no new stake', async () => {
    seed(0n, 0n);
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-rewards-zero')).toHaveTextContent('No reward period has started, so new stakes are closed.');
    expect(screen.queryByTestId('ladder-rewards-ended')).toBeNull();
    expect(stakeButton()).toBeNull();
  });
});

describe('EvmLadderPoolLive: a figure that could not be read holds Stake', () => {
  it('an end that could not be read: no Approve or Stake, and no date', async () => {
    seed(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
    wagmiState.answers.delete('periodFinish:');
    wagmiState.loading = true;
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByRole('button', { name: /Claim rewards/ })).toBeInTheDocument();
    expect(stakeButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByTestId('ladder-rewards-ended')).toBeNull();
    expect(screen.queryAllByText(/Rewards ended|Jun 15|2026/)).toHaveLength(0);
  });

  it('a rate that could not be read: no Approve or Stake', async () => {
    seed(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
    wagmiState.answers.delete('rewardRate:');
    wagmiState.loading = true;
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByRole('button', { name: /Claim rewards/ })).toBeInTheDocument();
    expect(stakeButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });
});
