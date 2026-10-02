// A FAILED POOL READ ON THE FULL CARD CAN BE TRIED AGAIN.
//
// readPool fails whenever either half of the reward-pool search fails, and everything on
// the card sits behind that read. The card reads again only on a wallet change or after a
// write, so without a Try again a disconnected visitor stays on the outage line until a
// reload. That hits every open Solana pool.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const FAIL = 'The pool could not be read right now. That is an outage, not a zero.';

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
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: null, wallet: null, connected: false }),
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

const poolState = vi.hoisted(() => ({ fail: true }));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => (poolState.fail
    ? { ok: false as const, reason: FAIL }
    : { ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [] })),
}));

const staking = await import('../../lib/bungalowStaking');
const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bobo', name: 'BOBO', symbol: 'BOBO', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

beforeEach(() => {
  poolState.fail = true;
  vi.mocked(staking.readPool).mockClear();
});

describe('the full card after a failed pool read', () => {
  it('offers Try again as a 44px tap target, and a retry that reads draws the card', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await screen.findByText(FAIL, { exact: false })).toBeTruthy();
    const retry = screen.getByRole('button', { name: /try again/i });
    expect(retry.className).toMatch(/\bmin-h-\[44px\]/);

    poolState.fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(FAIL, { exact: false })).toBeNull());
    expect(staking.readPool).toHaveBeenCalledTimes(2);
  });
});
