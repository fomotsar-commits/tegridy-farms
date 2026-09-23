// The held-time line on the EVM ladder card: right under the pool figures, keyed by
// the pool registry from the card's own pool, shown only once the figures are read.
// No EVM pool is on the island's read list today, so the read state is driven by
// adding this fixture's pool to the list the registry matches against.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const READ = 'Staking keeps your held time.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };
const wagmiState = vi.hoisted(() => ({ answers: new Map<string, ReadCell>(), loading: false }));
const keyOf = (q: Query) => `${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContracts: ({ contracts }: { contracts: Query[] }) => ({
    data: wagmiState.loading
      ? undefined
      : contracts.map((q) => wagmiState.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) }),
    isLoading: wagmiState.loading,
    refetch: () => Promise.resolve(),
  }),
  useWriteContract: () => ({ writeContractAsync: () => Promise.resolve('0x' as `0x${string}`) }),
  useWaitForTransactionReceipt: () => ({ data: undefined }),
}));

// The island's list, as the registry holds it, plus whatever a test says it also reads.
const island = vi.hoisted(() => ({ alsoReads: [] as { chain: 'base'; pool: string }[] }));
vi.mock('../../lib/bungalows', async (orig) => {
  const actual = await orig<typeof import('../../lib/bungalows')>();
  return {
    ...actual,
    poolReadByIsland: (chain: Bungalow['chain'], pool: string | undefined) =>
      actual.poolReadByIsland(chain, pool, [...actual.ISLAND_READ_POOLS, ...island.alsoReads]),
  };
});

const { EvmLadderPoolLive } = await import('./EvmLadderPoolLive');

const E18 = 10n ** 18n;
const PLACEHOLDER = '0x0000000000000000000000000000000000000001';
const QR = {
  id: 'qr', name: 'QR', symbol: 'QR', chain: 'base',
  address: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf',
  stakePool: '0x55B72f09d31f43834bf7Eba42f53a419a716F554',
  poolKind: 'ladder', status: 'SETTLED', tagline: 'x', thumb: '/art/x.jpg', live: true,
} as unknown as Bungalow & { stakePool: string };

const ok = (result: unknown): ReadCell => ({ status: 'success', result });

function seedReads() {
  const future = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  wagmiState.answers = new Map(Object.entries({
    'totalSupply:': ok(200n * E18),
    'totalBoosted:': ok(200n * E18),
    'rewardSurplus:': ok(60n * E18),
    'rewardRate:': ok(1_000n),
    'periodFinish:': ok(future),
    'rewardsDuration:': ok(BigInt(60 * 86_400)),
    'decimals:': ok(18),
    [`earned:${PLACEHOLDER}`]: ok(0n),
    [`balanceOf:${PLACEHOLDER}`]: ok(0n),
    [`allowance:${PLACEHOLDER},${QR.stakePool}`]: ok(0n),
    [`positionsOf:${PLACEHOLDER}`]: ok([]),
    'stakingToken:': ok(QR.address),
  }));
}

beforeEach(() => {
  wagmiState.loading = false;
  island.alsoReads = [];
  seedReads();
});

const statGrid = () => screen.getByText('Reward vault').parentElement!.parentElement!;

describe('the held-time line on the EVM ladder card', () => {
  it('says the unread sentence right under the pool figures, since the island reads no EVM pool yet', () => {
    render(<EvmLadderPoolLive bungalow={QR} />);
    const line = screen.getByText(UNREAD);
    expect(screen.queryByText(READ)).toBeNull();
    expect(statGrid().nextElementSibling).toBe(line);
    const explainer = screen.getByText(/Longer locks earn a larger/);
    expect(line.compareDocumentPosition(explainer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the read sentence in the same place once the list reads this pool, with no card change', () => {
    island.alsoReads = [{ chain: 'base', pool: QR.stakePool.toLowerCase() }];
    render(<EvmLadderPoolLive bungalow={QR} />);
    const line = screen.getByText(READ);
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(statGrid().nextElementSibling).toBe(line);
  });

  it('shows no line when the pool cannot be read, because the figures are withheld', () => {
    wagmiState.answers = new Map();
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(screen.getByText(/The pool could not be read just now/)).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(screen.queryByText(READ)).toBeNull();
  });

  it('shows no line while the pool is still being read', () => {
    wagmiState.loading = true;
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(screen.getByText('Reward vault')).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(screen.queryByText(READ)).toBeNull();
  });
});
