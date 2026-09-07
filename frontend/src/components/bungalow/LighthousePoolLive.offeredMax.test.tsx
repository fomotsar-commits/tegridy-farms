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
const walletState = vi.hoisted(() => ({
  publicKey: null as { toBase58: () => string } | null,
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: walletState.publicKey, wallet: null, connected: !!walletState.publicKey }),
}));
vi.mock('../solana/useSolanaConnect', () => ({
  useSolanaConnect: () => ({ connect: () => {}, connecting: false }),
}));
// u64::MAX + 1 — past the classic reward program's ceiling, so this position
// can never be paid again and its pending must not be counted as accruing.
const DEAD_ACCOUNTED = 18_446_744_073_709_551_616n;
const entry = (nonce: number, accounted: bigint, pending: bigint) => ({
  address: `Entry${nonce}`, nonce, amountRaw: 1_000_000n, durationSecs: 30 * DAY,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: 1_000_000n,
  pendingRaw: { 0: pending }, accountedRaw: { 0: accounted },
});
const entriesState = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  // The MATH stays real — that is the whole point of a wiring pin.
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: POOL })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: entriesState.list })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 0n })),
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

/**
 * THE HEADER TOTAL MUST NOT COUNT WHAT CAN NEVER BE PAID.
 *
 * `pendingTotal` was a byte-for-byte twin of the dashboard's reduce, with the
 * same defect: a position past u64::MAX still reports a pending figure, so the
 * "N accrued" line at the top of the page counted rewards the program will
 * revert on forever. Less visible than the dashboard's only because the rescue
 * button sits a few hundred pixels below it — the same lie, in smaller type.
 */
describe('the "accrued" header on the pool page', () => {
  it('excludes a position past the ceiling and names the stranded amount', async () => {
    walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
    entriesState.list = [
      entry(0, DEAD_ACCOUNTED, 4_000_000n), // dead: 4 BAYLA stranded
      entry(1, 10n, 900_000n),              // live: 0.9 BAYLA claimable
    ];
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const header = await screen.findByText(/accrued/);
    const line = header.textContent ?? '';
    // 0.9 accrued — NOT 4.9, which is what summing the dead position gives.
    expect(line).toMatch(/0\.9\s*accrued/);
    expect(line).not.toMatch(/4\.9\s*accrued/);
    // And the stranded 4 is named rather than silently dropped.
    expect(line).toMatch(/4\s*stranded/);
  });

  it('says nothing about stranding when every position is live', async () => {
    walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
    entriesState.list = [entry(0, 10n, 900_000n), entry(1, 20n, 100_000n)];
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const header = await screen.findByText(/accrued/);
    expect(header.textContent).toMatch(/1\s*accrued/);
    expect(header.textContent).not.toMatch(/stranded/);
  });
});
