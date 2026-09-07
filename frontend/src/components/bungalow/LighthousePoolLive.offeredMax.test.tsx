// THE HEADLINE MUST QUOTE A RUNG SOMEONE CAN ACTUALLY PICK.
//
// `OFFERED_LOCK_CEILING_DAYS` clamps the presets, the custom-days input and
// `chosenDays`, so 90 days is the longest lock this card will submit. The two
// headline stats went on reading `pool.maxDurationSecs`, and the result was
// visibly self-contradictory: the "Max boost" stat rendered the 365-day boost
// with the caption "at 90 days" underneath it. One number, two lock lengths.
//
// This is a WIRING pin. `stakeWeight` and `offeredMaxLockDays` are unit-tested
// in lib/; what only this file can catch is the component handing the wrong
// duration to the right helper — which no type check and no lib test can see.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;

// A BAYLA-shaped pool: 1-day minimum, 365-day maximum, 5.00x at the top rung.
// At the OFFERED 90-day ceiling the boost is 1.98x, so the two candidate
// answers are far apart and no rounding can blur them together.
const POOL = {
  address: 'PooLAddr1111111111111111111111111111111111',
  mint: 'MintAddr',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: 5n * WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw: 1_000_000_000n,
  totalEffectiveStakeRaw: 1_000_000_000n,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'fixed' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000n, permissionless: true,
    rewardAmountRaw: '1000', rewardPeriodSecs: 86_400,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
  }],
};

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: null, wallet: null, connected: false }),
}));
vi.mock('../solana/useSolanaConnect', () => ({
  useSolanaConnect: () => ({ connect: () => {}, connecting: false }),
}));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  // The MATH stays real — that is the whole point of a wiring pin.
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: POOL })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [] })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  // `address` is the Bungalow's mint field, and the card refuses to render
  // figures when it disagrees with the pool's staking mint (audit TF-035).
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: POOL.address, address: POOL.mint,
} as unknown as Bungalow & { stakePool: string };

describe('the offered-ceiling headline', () => {
  it('quotes the boost for the LONGEST SELECTABLE lock, not the pool maximum', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const boost = await screen.findByText(/^\d+\.\d\d×$/);
    // 1.98x is the 90-day rung. 5.00x is the 365-day rung the ladder never
    // offers — printing it advertises a return nobody in this form can get.
    expect(boost.textContent).toBe('1.98×');
    expect(boost.textContent).not.toBe('5.00×');
  });

  it('states the SAME lock length in the value and the caption', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const boost = await screen.findByText(/^\d+\.\d\d×$/);
    // The pre-fix bug was visible on its face: the card rendered "5.00× at 3
    // months" — the one-year boost captioned with the ninety-day lock. Whatever
    // the ceiling is set to, the number and the duration beside it must agree.
    // (`labelForDays(90)` humanises to "3 months", which is the offered rung.)
    const unit = boost.parentElement?.textContent ?? '';
    expect(unit).toMatch(/3 months/);
    expect(unit).toContain('1.98×');
    expect(unit).not.toMatch(/year/);
  });
});
