// THE LIGHTHOUSE CARD'S "YOUR SHARE" OBEYS THE LADDER'S RULES.
//
// A displayed value must never read better than the truth. The dynamic-pool ledger
// cell used to (a) ROUND — 2/3 printed 66.67%, and a half-up round can print a share
// the wallet does not hold; (b) have NO UPPER BOUND — a wallet total above the pool
// total (two reads that disagree) printed over 100%; and (c) print "nothing staked"
// for a wallet whose stakes had simply NOT BEEN READ — including one that was not
// connected at all. It now goes through the ladder's `sharePct`: floored to a tenth,
// null on any inconsistency, and "nothing staked" only from a COMPLETE read.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;

// A DYNAMIC reward pool — the only kind whose ledger carries "Your share".
const poolState = vi.hoisted(() => ({ totalEffective: 3_000_000n as bigint | null }));
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
  totalStakeRaw: 3_000_000n,
  totalEffectiveStakeRaw: poolState.totalEffective,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'dynamic' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000n, permissionless: true,
    rewardAmountRaw: '0', rewardPeriodSecs: 0,
    fundedAmountRaw: 1_000_000_000n, claimedAmountRaw: 0n, claimPeriodSecs: DAY,
    rateChangedAtTs: null,
  }],
});

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
const walletState = vi.hoisted(() => ({ publicKey: null as { toBase58: () => string } | null }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: walletState.publicKey,
    wallet: walletState.publicKey ? { adapter: { publicKey: walletState.publicKey } } : null,
    connected: !!walletState.publicKey,
  }),
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

const entry = (effective: bigint) => ({
  address: `E${effective}`, nonce: 0, amountRaw: effective, durationSecs: DAY,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: effective,
  pendingRaw: { 0: 0n }, accountedRaw: { 0: 0n },
});
const entriesState = vi.hoisted(() => ({
  result: { ok: true, entries: [] } as { ok: true; entries: unknown[] } | { ok: false; reason: string },
}));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => entriesState.result),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

/** The "Your share" footnote — its text says which state the cell is in. */
const shareNote = async () => (await screen.findByText('Your share —')).parentElement!.textContent ?? '';

beforeEach(() => {
  walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
  poolState.totalEffective = 3_000_000n;
  entriesState.result = { ok: true, entries: [] };
});

describe('the lighthouse "Your share" never reads better than the truth', () => {
  it('⚠️ FLOORS, never rounds: 2 of 3 prints 66.6%, not 66.67% or 66.7%', async () => {
    entriesState.result = { ok: true, entries: [entry(2_000_000n)] };
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/of each payout/);
    const text = document.body.textContent ?? '';
    expect(text).toContain('66.6%');
    expect(text).not.toMatch(/66\.67%|66\.7%/);
  });

  it('⚠️ a wallet total ABOVE the pool total is "could not be read", never over 100%', async () => {
    // The entries and the pool land in separate reads; right after a stake the wallet can
    // carry weight a not-yet-refreshed total does not.
    entriesState.result = { ok: true, entries: [entry(5_000_000n)] };
    poolState.totalEffective = 1_000_000n;
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/could not be read/);
    expect(document.body.textContent).not.toMatch(/500%|\b100%/);
  });

  it('⚠️ an UNREADABLE pool total is "could not be read" for a wallet that holds stake', async () => {
    entriesState.result = { ok: true, entries: [entry(2_000_000n)] };
    poolState.totalEffective = null;
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const note = await shareNote();
    expect(note).toMatch(/could not be read/);
    expect(note).not.toMatch(/nothing staked/);
  });

  it('⚠️ entries that FAILED to read never say "nothing staked"', async () => {
    entriesState.result = { ok: false, reason: 'Your stakes could not be read right now.' };
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const note = await shareNote();
    expect(note).not.toMatch(/nothing staked/);
    expect(note).toMatch(/could not be read/);
  });

  it('⚠️ with NO WALLET connected, it does not claim the visitor has nothing staked', async () => {
    walletState.publicKey = null;
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).not.toMatch(/nothing staked/);
  });

  it('a COMPLETE read that found nothing still says "nothing staked" — the real zero survives', async () => {
    entriesState.result = { ok: true, entries: [] };
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/nothing staked/);
  });
});
