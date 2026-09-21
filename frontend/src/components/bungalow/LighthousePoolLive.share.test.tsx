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
import { render, screen, waitFor } from '@testing-library/react';
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

// THE SAME-SLOT BASIS (readShareBasis): the wallet's open entries and the pool account
// re-read in ONE getMultipleAccountsInfo call. `undefined` = derive a CONSISTENT basis
// from the fixtures (mine = the open entries, total = the pool's), so every case above
// the same-slot block reads exactly as it did before the basis existed; `null` = the
// call could not establish one.
const basisState = vi.hoisted(() => ({
  value: undefined as { mineEffectiveRaw: bigint; totalEffectiveRaw: bigint } | null | undefined,
}));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => entriesState.result),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => {
    if (basisState.value !== undefined) return basisState.value;
    const r = entriesState.result;
    if (!r.ok || poolState.totalEffective === null) return null;
    const mine = (r.entries as { closedTs: number; effectiveAmountRaw: bigint }[])
      .filter((e) => e.closedTs === 0).reduce((a, e) => a + e.effectiveAmountRaw, 0n);
    return { mineEffectiveRaw: mine, totalEffectiveRaw: poolState.totalEffective };
  }),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

/**
 * The "Your share" footnote — its text says which state the cell is in. Waits out the
 * transient "reading your stakes…" (the entries read, then the same-slot basis read).
 */
const shareNote = async () => {
  const el = await screen.findByText('Your share —');
  await waitFor(() => expect(el.parentElement!.textContent).not.toMatch(/reading your stakes/));
  return el.parentElement!.textContent ?? '';
};

beforeEach(() => {
  walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
  poolState.totalEffective = 3_000_000n;
  entriesState.result = { ok: true, entries: [] };
  basisState.value = undefined;
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

// THE SAME-SLOT RULE — the ladder's (add8127f), now on the lighthouse.
//
// The entries and the pool used to land in SEPARATE requests and be divided with no
// link between them. On a stake both rise: pool 100, you hold 10, you stake +10 — you
// hold 20 of 110 (18.2%), and an entries read carrying the new 20 over a pool read
// still carrying the old 100 printed 20%. `mine > total` cannot see it (20 < 100). So
// the share's inputs now come from ONE getMultipleAccountsInfo call, and the
// separately read pool can only LOWER the figure.
describe('the lighthouse share is read from one slot, and never prints the larger reading', () => {
  it('⚠️ entries 20 over a STALE pool 100 with no same-slot basis: "could not be read", never 20%', async () => {
    entriesState.result = { ok: true, entries: [entry(20_000_000n)] };
    poolState.totalEffective = 100_000_000n;
    basisState.value = null;
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/could not be read/);
    expect(document.body.textContent).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('⚠️ the same-slot basis (20 of 110) beats the stale pool read (100): 18.1%, not 20%', async () => {
    entriesState.result = { ok: true, entries: [entry(20_000_000n)] };
    poolState.totalEffective = 100_000_000n;
    basisState.value = { mineEffectiveRaw: 20_000_000n, totalEffectiveRaw: 110_000_000n };
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/of each payout/);
    const text = document.body.textContent ?? '';
    expect(text).toContain('18.1%');
    expect(text).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('a FRESHER, LARGER separately read pool total (others staked since) lowers it, and a share IS printed', async () => {
    entriesState.result = { ok: true, entries: [entry(20_000_000n)] };
    poolState.totalEffective = 200_000_000n;
    basisState.value = { mineEffectiveRaw: 20_000_000n, totalEffectiveRaw: 110_000_000n };
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    expect(await shareNote()).toMatch(/of each payout/);
    const text = document.body.textContent ?? '';
    expect(text).toContain('10%');
    expect(text).not.toMatch(/18\.1%/);
  });
});
