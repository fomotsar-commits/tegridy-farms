// The plain EVM lighthouse card on an ENDED reward period takes no new stake (owner,
// 2026-10-14): the ended line, with the read date, replaces the "staking works"
// note, and Stake/Approve are gone. Withdraw, Claim and Exit stay.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };
const USER = '0x00000000000000000000000000000000000000a1';
const wagmiState = vi.hoisted(() => ({ answers: new Map<string, ReadCell>() }));
const keyOf = (q: Query) => `${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContracts: ({ contracts }: { contracts: Query[] }) => ({
    data: contracts.map((q) => wagmiState.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) }),
    isLoading: false,
    refetch: () => Promise.resolve(),
  }),
  useWriteContract: () => ({ writeContractAsync: () => Promise.resolve('0x' as `0x${string}`) }),
  useWaitForTransactionReceipt: () => ({ data: undefined }),
}));

const { EvmLighthousePoolLive } = await import('./EvmLighthousePoolLive');

const E18 = 10n ** 18n;
const DRB = {
  id: 'drb', name: 'DRB', symbol: 'DRB', chain: 'base',
  address: '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2',
  stakePool: '0x00000000000000000000000000000000000c0FfE',
  status: 'SETTLED', tagline: 'x', thumb: '/art/x.jpg', live: false,
} as unknown as Bungalow & { stakePool: string };

const ok = (result: unknown): ReadCell => ({ status: 'success', result });
const ENDED = 1_781_493_095n; // 2026-06-15T03:11:35Z

function seed(periodFinish: bigint, poolBalance = 200n * E18) {
  wagmiState.answers = new Map(Object.entries({
    'totalSupply:': ok(200n * E18),
    [`balanceOf:${DRB.stakePool}`]: ok(poolBalance),
    'rewardRate:': ok(1_000n),
    'periodFinish:': ok(periodFinish),
    'rewardsDuration:': ok(BigInt(60 * 86_400)),
    'decimals:': ok(18),
    [`balanceOf:${USER}`]: ok(50n * E18),
    [`earned:${USER}`]: ok(1n * E18),
    [`allowance:${USER},${DRB.stakePool}`]: ok(10_000n * E18),
    'stakingToken:': ok(DRB.address),
  }));
}

describe('EvmLighthousePoolLive: an ended reward period', () => {
  beforeEach(() => seed(ENDED));

  it('says it ended with the read date and offers no stake; withdraw, claim and exit stay', async () => {
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(await screen.findByTestId('lighthouse-rewards-ended')).toHaveTextContent(
      'Rewards ended Jun 15, 2026, so new stakes are closed.',
    );
    // The empty-vault note invites a stake; an ended period outranks it.
    expect(screen.queryByText(/staking works but earns nothing/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stake$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Withdraw$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim rewards/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exit/ })).toBeInTheDocument();
  });
});

describe('EvmLighthousePoolLive: not ended (negative controls)', () => {
  it('a live period keeps Stake', async () => {
    seed(BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), 260n * E18);
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(await screen.findByRole('button', { name: /^Stake$/ })).toBeInTheDocument();
    expect(screen.queryByTestId('lighthouse-rewards-ended')).toBeNull();
  });

  it('a never-funded pool keeps Stake and is not called ended', async () => {
    seed(0n, 260n * E18);
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(await screen.findByRole('button', { name: /^Stake$/ })).toBeInTheDocument();
    expect(screen.queryByTestId('lighthouse-rewards-ended')).toBeNull();
    expect(screen.getByText(/No reward period has started/)).toBeInTheDocument();
  });
});
