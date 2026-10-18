// The room staking card reads the early-exit penalty from the pool itself and never
// assumes it. Owner, 2026-10-18: every staking exit costs 75%. The six ladders live
// on Ethereum and Base charge 25% until the owner redeploys them
// (docs/LADDER_EXIT_75_REDEPLOY.md), so the card must say 25% on those, 75% on the
// new pools, and no number at all when the read failed. Red first: before this the
// card printed a constant 25% whatever the pool answered.
import { describe, it, expect, vi } from 'vitest';
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
const NOW = BigInt(Math.floor(Date.now() / 1000));

/** A live pool with one locked 1,000 QR position; `penalty` null leaves the read unanswered. */
function seed(penalty: bigint | null) {
  wagmiState.loading = false;
  wagmiState.answers = new Map(Object.entries({
    'totalSupply:': ok(1_000n * E18),
    'totalBoosted:': ok(400n * E18),
    'rewardSurplus:': ok(60n * E18),
    'rewardRate:': ok(1_000n),
    'periodFinish:': ok(NOW + 30n * 86_400n),
    'rewardsDuration:': ok(BigInt(60 * 86_400)),
    'decimals:': ok(18),
    [`earned:${USER}`]: ok(5n * E18),
    [`balanceOf:${USER}`]: ok(1_000n * E18),
    [`allowance:${USER},${QR.stakePool}`]: ok(10_000n * E18),
    [`positionsOf:${USER}`]: ok([1n]),
    'stakingToken:': ok(QR.address),
    'positions:1': ok([USER, NOW + 20n * 86_400n, 1_000n * E18, 400n * E18]),
    ...(penalty === null ? {} : { 'EARLY_EXIT_PENALTY_BPS:': ok(penalty) }),
  }));
}

describe('EvmLadderPoolLive: the early-exit penalty is read from the pool', () => {
  it('a pool that answers 2500 (the six live today) says 25%, in the line and on both exits', async () => {
    seed(2_500n);
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent('Leaving before your lock opens costs 25%.');
    const exit = await screen.findByRole('button', { name: /^Exit early \(−250\)$/ });
    expect(exit).toHaveAttribute('title', expect.stringContaining('250 QR (25%)'));
    const hatch = screen.getByRole('button', { name: /^emergency \(−250\)$/ });
    expect(hatch).toHaveAttribute('title', expect.stringContaining('250 QR (25%)'));
    expect(screen.getByText(/costs 25%, which stays in the pool/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/75%/);
  });

  it('a pool that answers 7500 (the redeployed build) says 75%', async () => {
    seed(7_500n);
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent('Leaving before your lock opens costs 75%.');
    const exit = await screen.findByRole('button', { name: /^Exit early \(−750\)$/ });
    expect(exit).toHaveAttribute('title', expect.stringContaining('750 QR (75%)'));
    expect(screen.getByRole('button', { name: /^emergency \(−750\)$/ })).toBeInTheDocument();
    expect(screen.getByText(/costs 75%, which stays in the pool/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/25%/);
  });

  it('a penalty that could not be read is no number at all, and the exits still work', async () => {
    seed(null);
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent(
      'Leaving before your lock opens costs a penalty that could not be read just now.',
    );
    const exit = await screen.findByRole('button', { name: /^Exit early$/ });
    expect(exit).not.toBeDisabled();
    expect(exit).toHaveAttribute('title', expect.stringContaining('could not be read'));
    expect(screen.getByRole('button', { name: /^emergency$/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/25%|75%/);
  });
});
