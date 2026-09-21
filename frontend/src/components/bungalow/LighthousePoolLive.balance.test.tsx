// THREE STATES, NOT TWO — the ladder card's rule for the wallet balance.
//
// "Still reading", "read and it failed" and "read and it is a number" are different
// facts. The lighthouse card printed "Balance: –" for the first two alike, so a reader
// could not tell a pending read from an outage. It now says "…" while reading and
// "unreadable" when the read failed; a real zero still prints 0.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const bal = vi.hoisted(() => ({ mode: 'pending' as 'pending' | 'fail' | 'zero' }));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [] })),
  readWalletBalance: vi.fn(() => bal.mode === 'pending'
    ? new Promise(() => {})
    : Promise.resolve(bal.mode === 'fail'
      ? { ok: false as const, reason: 'Your balance could not be read right now.' }
      : { ok: true as const, raw: 0n })),
  readShareBasis: vi.fn(async () => null),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

const balanceBtn = async () => screen.findByRole('button', { name: /^Balance:/ });

beforeEach(() => { bal.mode = 'pending'; });

describe('the lighthouse balance tells reading, failed and zero apart', () => {
  it('⚠️ while the read is in flight it says "…", not the outage dash', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const b = await balanceBtn();
    expect(b.textContent).toBe('Balance: …');
  });

  it('⚠️ a FAILED read says "unreadable", not the same dash as a pending one', async () => {
    bal.mode = 'fail';
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const b = await balanceBtn();
    await waitFor(() => expect(b.textContent).toBe('Balance: unreadable'));
  });

  it('a real zero still prints 0', async () => {
    bal.mode = 'zero';
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const b = await balanceBtn();
    await waitFor(() => expect(b.textContent).toBe('Balance: 0'));
  });
});
