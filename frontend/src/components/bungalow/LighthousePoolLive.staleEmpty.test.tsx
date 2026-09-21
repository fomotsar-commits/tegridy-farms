// A COMPLETE, EMPTY READ TAKEN BEFORE YOUR FIRST STAKE IS NOT "nothing staked" AFTER IT.
//
// The ladder card (its `staleRead`) stopped saying "No open positions" to a wallet that
// had just opened one. The lighthouse card had no such guard: after a first stake
// confirms, the pre-stake entries read — complete, and empty — stays on screen until the
// re-read lands, and "Your share" said "nothing staked." to someone whose stake had
// just confirmed. The read on screen when a write confirms is now "updating…" while it
// is still the one on screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;

const pool = () => ({
  address: 'PooLAddr1111111111111111111111111111111111',
  mint: 'MintAddr',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: 5n * WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw: 100_000_000n,
  totalEffectiveStakeRaw: 100_000_000n,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'dynamic' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000_000n, permissionless: true,
    rewardAmountRaw: '0', rewardPeriodSecs: 0,
    fundedAmountRaw: 1_000_000_000_000n, claimedAmountRaw: 0n, claimPeriodSecs: DAY,
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

// The first entries read answers at once (empty); every later one is held by the test.
const reads = vi.hoisted(() => ({ n: 0, held: [] as ((v: unknown) => void)[] }));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(() => {
    reads.n += 1;
    if (reads.n === 1) return Promise.resolve({ ok: true as const, entries: [] });
    return new Promise((res) => { reads.held.push(res); });
  }),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => null),
  readConfirmedSlot: vi.fn(async () => 500),
  stake: vi.fn(async () => ({ ok: true as const, txId: 'TX-FIRST-STAKE' })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

const noteText = () => screen.getByText('Your share —').parentElement!.textContent ?? '';

beforeEach(() => { reads.n = 0; reads.held = []; });

describe('the lighthouse never restates a pre-write empty read as empty', () => {
  it('⚠️ right after a first stake confirms, "Your share" is "updating…", not "nothing staked."', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await waitFor(() => expect(noteText()).toMatch(/nothing staked/));

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } });
    const stakeBtn = await screen.findByRole('button', { name: /^Stake & lock for/ });
    await waitFor(() => expect((stakeBtn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(stakeBtn); });
    await screen.findByText(/Stake confirmed\./);

    // The re-read is still in flight: the empty read on screen predates the stake.
    expect(reads.held.length).toBeGreaterThan(0);
    expect(noteText()).not.toMatch(/nothing staked/);
    expect(noteText()).toMatch(/updating…/);
  });

  it('a NEWER complete, empty read is "nothing staked." again — the real zero survives', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await waitFor(() => expect(noteText()).toMatch(/nothing staked/));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } });
    const stakeBtn = await screen.findByRole('button', { name: /^Stake & lock for/ });
    await waitFor(() => expect((stakeBtn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(stakeBtn); });
    await screen.findByText(/Stake confirmed\./);

    await act(async () => { for (const r of reads.held) r({ ok: true, entries: [] }); });
    await waitFor(() => expect(noteText()).toMatch(/nothing staked/));
  });
});
