// AN OLDER READ MUST NEVER LAND ON TOP OF A NEWER ONE.
//
// Every write on the lighthouse card re-reads the pool when it confirms. Those re-reads
// used to be fired by a bare `refresh()` whose cancellation nobody kept, and
// setPoolRead accepted whatever resolved LAST. Two confirmed writes in a row start two
// pool reads; if the first one is slow, it lands after the second and puts the OLDER
// pool — a stale, smaller total — back on screen, under every figure the card derives
// from it (the vault, total staked, the share). The ladder card has not had this since
// it keyed its one read effect on a generation counter (SolanaLadderPoolLive.tsx); this
// pins the same rule here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;

const pool = (totalStakeRaw: bigint) => ({
  address: 'PooLAddr1111111111111111111111111111111111',
  mint: 'MintAddr',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: 5n * WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw,
  totalEffectiveStakeRaw: totalStakeRaw,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'fixed' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000_000n, permissionless: true,
    rewardAmountRaw: '1000', rewardPeriodSecs: DAY,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
    rateChangedAtTs: null,
  }],
});

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
const PK = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: PK, wallet: { adapter: { publicKey: PK } }, connected: true }),
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

// An open position with something accrued, so "Claim rewards" is live — the write
// whose confirmation starts the re-read.
const ENTRY = {
  address: 'Entry0', nonce: 0, amountRaw: 1_000_000n, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: 1_000_000n,
  pendingRaw: { 0: 900_000n }, accountedRaw: { 0: 0n },
};

// Each readPool call returns a promise the TEST settles, so their order is ours.
type PoolResult = { ok: true; pool: ReturnType<typeof pool> };
const poolCalls = vi.hoisted(() => ({ resolvers: [] as ((r: PoolResult) => void)[] }));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(() => new Promise<PoolResult>((res) => { poolCalls.resolvers.push(res); })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [ENTRY] })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  claimRewards: vi.fn(async () => ({ ok: true as const, txId: 'TX' })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

beforeEach(() => { poolCalls.resolvers = []; });

describe('lighthouse reads land in order', () => {
  it('⚠️ an OLDER pool read resolving after a NEWER one does not overwrite it', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await waitFor(() => expect(poolCalls.resolvers.length).toBe(1));
    await act(async () => { poolCalls.resolvers[0]!(({ ok: true, pool: pool(5_555_000_000n) })); });
    expect(document.body.textContent).toContain('5,555');

    // Two confirmed claims -> two re-reads, both left in flight.
    const claim = await screen.findByRole('button', { name: 'Claim rewards' });
    await act(async () => { fireEvent.click(claim); });
    await waitFor(() => expect(poolCalls.resolvers.length).toBe(2));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Claim rewards' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Claim rewards' })); });
    await waitFor(() => expect(poolCalls.resolvers.length).toBe(3));

    // The NEWER read answers first; the OLDER one straggles in after it.
    await act(async () => { poolCalls.resolvers[2]!({ ok: true, pool: pool(7_777_000_000n) }); });
    await act(async () => { poolCalls.resolvers[1]!({ ok: true, pool: pool(1_234_000_000n) }); });

    const text = document.body.textContent ?? '';
    expect(text).toContain('7,777');
    expect(text).not.toContain('1,234');
  });
});
