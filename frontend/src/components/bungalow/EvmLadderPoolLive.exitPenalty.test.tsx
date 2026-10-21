// The room staking card reads the early-exit penalty from the pool itself and never
// assumes it. Owner, 2026-10-18: the room ladders keep the ladder's law, the time left
// over four years capped at 75%, as the BAYLA ladder charges it. The six ladders live
// on Ethereum and Base charge a flat 25% until the owner redeploys them
// (docs/LADDER_EXIT_75_REDEPLOY.md), so the card must say 25% on those, quote each
// position from the new pools, and show no number at all when a read failed. Red
// first, twice: the card printed a constant 25% whatever the pool answered, then a
// flat rate whatever the lock had left.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };
const USER = '0x00000000000000000000000000000000000000a1';
const wagmiState = vi.hoisted(() => ({ answers: new Map<string, ReadCell>(), loading: false, chainIds: [] as unknown[] }));
const keyOf = (q: Query) => `${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000a1', isConnected: true }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContracts: ({ contracts }: { contracts: (Query & { chainId?: number })[] }) => ({
    ...(contracts[0] && wagmiState.chainIds.push(contracts[0].chainId) && {}),
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

const AMOUNT = 1_000n * E18;
const LOCK_END = NOW + 20n * 86_400n;
/** 20 days left on a 1,000 QR lock under the ladder's law: 20/1460 of principal. */
const QUOTE_20D = (AMOUNT * 20n) / 1460n;

/**
 * A live pool with one locked 1,000 QR position. `flat` seeds the retired flat-rate
 * getter (the six live today); `cap` seeds the ladder's-law cap and `quote` the pool's
 * own penaltyFor() for the position; anything left out reads as failed.
 */
function seed({ flat, cap, quote }: { flat?: bigint; cap?: bigint; quote?: bigint } = {}) {
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
    'positions:1': ok([USER, LOCK_END, AMOUNT, 400n * E18]),
    ...(flat === undefined ? {} : { 'EARLY_EXIT_PENALTY_BPS:': ok(flat) }),
    ...(cap === undefined ? {} : { 'MAX_EARLY_EXIT_PENALTY_BPS:': ok(cap) }),
    ...(quote === undefined ? {} : { [`penaltyFor:${AMOUNT},${LOCK_END}`]: ok(quote) }),
  }));
}

describe('EvmLadderPoolLive: the early-exit penalty is read from the pool', () => {
  it('a flat pool that answers 2500 (the six live today) says 25%, in the line and on both exits', async () => {
    seed({ flat: 2_500n });
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent('Leaving before your lock opens costs 25%.');
    const exit = await screen.findByRole('button', { name: /^Exit early \(−250\)$/ });
    expect(exit).toHaveAttribute('title', expect.stringContaining('250 QR (25%)'));
    const hatch = screen.getByRole('button', { name: /^emergency \(−250\)$/ });
    expect(hatch).toHaveAttribute('title', expect.stringContaining('250 QR (25%)'));
    expect(screen.getByText(/costs 25%, which stays in the pool/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/75%|time left/);
  });

  it("a ladder's-law pool (cap 7500) says the schedule, and quotes the position from the pool", async () => {
    seed({ cap: 7_500n, quote: QUOTE_20D });
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent(
      'Leaving before your lock opens costs the time left on it over four years, capped at 75%.',
    );
    // 20 of 1460 days: 13.698... QR, about 1.36% of the position, floored.
    const exit = await screen.findByRole('button', { name: /^Exit early \(−13\.69\)$/ });
    expect(exit).toHaveAttribute('title', expect.stringContaining('13.69 QR (about 1.36%)'));
    expect(exit).toHaveAttribute('title', expect.stringContaining('capped at 75%'));
    const hatch = screen.getByRole('button', { name: /^emergency \(−13\.69\)$/ });
    expect(hatch).toHaveAttribute('title', expect.stringContaining('13.69 QR (about 1.36%)'));
    expect(screen.getByText(/costs the time left on it over four years, capped at 75%, which stays in the pool/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/25%/);
  });

  it('a seven-day lock left at once costs 7/1460: the card says about 0.47%, never a flat rate', async () => {
    const lockEnd = NOW + 7n * 86_400n;
    const quote = (AMOUNT * 7n) / 1460n;
    seed({ cap: 7_500n });
    wagmiState.answers.set('positions:1', ok([USER, lockEnd, AMOUNT, 400n * E18]));
    wagmiState.answers.set(`penaltyFor:${AMOUNT},${lockEnd}`, ok(quote));
    render(<EvmLadderPoolLive bungalow={QR} />);
    const exit = await screen.findByRole('button', { name: /^Exit early \(−4\.79\)$/ });
    expect(exit).toHaveAttribute('title', expect.stringContaining('4.79 QR (about 0.47%)'));
    expect(document.body.textContent).not.toMatch(/\(75%\)|\(25%\)/);
  });

  it("a ladder's-law pool whose quote could not be read shows the schedule and no figure on the exits", async () => {
    seed({ cap: 7_500n });
    render(<EvmLadderPoolLive bungalow={QR} />);
    expect(await screen.findByTestId('ladder-exit-cost')).toHaveTextContent('capped at 75%.');
    const exit = await screen.findByRole('button', { name: /^Exit early$/ });
    expect(exit).not.toBeDisabled();
    expect(exit).toHaveAttribute('title', expect.stringContaining('could not be read'));
    expect(screen.getByRole('button', { name: /^emergency$/ })).toBeInTheDocument();
  });

  it('a penalty that could not be read at all is no number, and the exits still work', async () => {
    seed();
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

  // Owner, 2026-10-18: the same ladder serves Robinhood Chain the day a room lives there.
  // The card's chain map used to fall back to Ethereum for any chain it did not name, so a
  // Robinhood pool would have read mainnet under a Robinhood label. Red first.
  it('a Robinhood room reads chain 4663, never the Ethereum fallback', async () => {
    seed({ cap: 7_500n, quote: QUOTE_20D });
    wagmiState.chainIds = [];
    render(<EvmLadderPoolLive bungalow={{ ...QR, chain: 'robinhood' } as unknown as Bungalow & { stakePool: string }} />);
    await screen.findByTestId('ladder-exit-cost');
    expect(wagmiState.chainIds).toContain(4663);
    expect(wagmiState.chainIds).not.toContain(1);
    expect(screen.getByText(/The lighthouse · Robinhood Chain · lock ladder/)).toBeInTheDocument();
  });
});
