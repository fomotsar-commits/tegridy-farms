// AFTER YOUR OWN CONFIRMED WRITE, A SHARE READ FROM AN OLDER SLOT IS "updating…".
//
// The ladder card has had this since dc2a4578; the lighthouse card had not. Same-slot
// (readShareBasis) makes the PAIR consistent — it does not make it RECENT. The trace:
// the pool holds 100, you hold entries A=10 and B=10. Your exit of A confirms at slot
// 500. The re-read is served by an RPC node still at slot 498: A and B both open, total
// 100 — and the card printed 20%. The truth is 10 of 90 = 11.1%. And with no timed
// re-read on this card, that figure stayed until the next write or a reload.
//
// So the write's confirmed slot fences the basis: a basis below it, or a missing slot on
// either side, renders "updating…" (fail closed); a basis at or past it is a share again;
// and while it is fenced the card re-reads on a timer, so the wait cannot become permanent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';
import { FENCE_RETRY_MS } from '../../lib/ladder/writeFence';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const M = 1_000_000n; // one BAYLA, raw

const poolState = vi.hoisted(() => ({ totalEffective: 100_000_000n as bigint }));
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
  totalStakeRaw: poolState.totalEffective,
  totalEffectiveStakeRaw: poolState.totalEffective,
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
const walletState = vi.hoisted(() => ({ key: 'StakerPk1111111111111111111111111111111111' }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => {
    const pk = { toBase58: () => walletState.key };
    return { publicKey: pk, wallet: { adapter: { publicKey: pk } }, connected: true };
  },
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

// Unlocked (1-second lock, opened long ago), so "Unstake & claim" is live.
const entry = (address: string, nonce: number, effective: bigint) => ({
  address, nonce, amountRaw: effective, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: effective,
  pendingRaw: { 0: 1n }, accountedRaw: { 0: 0n },
});
const A = () => entry('EntryA', 0, 10n * M);
const B = () => entry('EntryB', 1, 10n * M);

type Basis = { mineEffectiveRaw: bigint; totalEffectiveRaw: bigint; slot: number | null } | null;
const s = vi.hoisted(() => ({
  entries: [] as (() => unknown)[],
  basis: null as unknown,
  writeSlot: null as number | null,
}));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  // A FRESH array every call, as a real read returns — the basis is keyed to it.
  readEntries: vi.fn(async () => ({ ok: true as const, entries: s.entries.map((f) => f()) })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => s.basis as Basis),
  readConfirmedSlot: vi.fn(async () => s.writeSlot),
  unstakeAndClaim: vi.fn(async () => ({ ok: true as const, txId: 'TX-EXIT-A' })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

const noteText = () => screen.getByText('Your share —').parentElement!.textContent ?? '';
const shareCellShows = async (re: RegExp) => {
  await waitFor(() => expect(noteText()).toMatch(re));
};

/** Mount with A and B open at a basis the truth agrees with (20 of 100, slot 400). */
async function mountHoldingAandB() {
  const view = render(<LighthousePoolLive bungalow={BUNGALOW} />);
  await shareCellShows(/of each payout/);
  expect(document.body.textContent).toContain('20%');
  return view;
}

/** Exit A. The confirmed slot and the re-read's basis are whatever the case sets. */
async function exitA() {
  const btn = await screen.findAllByRole('button', { name: 'Unstake & claim' });
  await act(async () => { fireEvent.click(btn[0]!); });
  await screen.findByText(/Unstake confirmed\./);
}

beforeEach(() => {
  walletState.key = 'StakerPk1111111111111111111111111111111111';
  poolState.totalEffective = 100_000_000n;
  s.entries = [A, B];
  s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 400 };
  s.writeSlot = 500;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the lighthouse write-slot fence', () => {
  it('⚠️ THE TRACE: a basis at slot 498 after an exit confirmed at 500 is "updating…", never 20%', async () => {
    await mountHoldingAandB();
    // The lagging node: A and B both still open, total still 100.
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 498 };
    await exitA();
    await shareCellShows(/updating…/);
    expect(document.body.textContent).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('⚠️ a basis at slot 400 after a write at slot 500 is "updating…"', async () => {
    await mountHoldingAandB();
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 400 };
    await exitA();
    await shareCellShows(/updating…/);
    expect(document.body.textContent).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('⚠️ the WRITE\'s slot unknown: "updating…" (fail closed), even over a basis at slot 900', async () => {
    await mountHoldingAandB();
    s.writeSlot = null;
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 900 };
    await exitA();
    await shareCellShows(/updating…/);
    expect(document.body.textContent).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('⚠️ the BASIS\'s slot unknown: "updating…" (fail closed)', async () => {
    await mountHoldingAandB();
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: null };
    await exitA();
    await shareCellShows(/updating…/);
    expect(document.body.textContent).not.toMatch(/(^|[^0-9.])20%/);
  });

  it('a basis AT the write slot IS a share again: 10 of 90 prints 11.1%', async () => {
    await mountHoldingAandB();
    s.entries = [B];
    poolState.totalEffective = 90_000_000n;
    s.basis = { mineEffectiveRaw: 10n * M, totalEffectiveRaw: 90n * M, slot: 500 };
    await exitA();
    await shareCellShows(/of each payout/);
    expect(document.body.textContent).toContain('11.1%');
  });

  it('⚠️ the wait is not permanent: while fenced the card re-reads, and a basis past the write prints the share', async () => {
    const intervals: { fn: () => void; ms: number }[] = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      intervals.push({ fn, ms: ms ?? 0 });
      return real(() => {}, 1 << 30);
    }) as typeof setInterval);

    await mountHoldingAandB();
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 498 };
    await exitA();
    await shareCellShows(/updating…/);

    // The node catches up.
    s.entries = [B];
    poolState.totalEffective = 90_000_000n;
    s.basis = { mineEffectiveRaw: 10n * M, totalEffectiveRaw: 90n * M, slot: 501 };
    const retry = intervals.filter((i) => i.ms === FENCE_RETRY_MS).at(-1);
    expect(retry).toBeDefined();
    await act(async () => { retry!.fn(); });
    await shareCellShows(/of each payout/);
    expect(document.body.textContent).toContain('11.1%');
  });

  it('the fence belongs to the wallet that wrote: another wallet\'s basis at an older slot is still a share', async () => {
    const view = await mountHoldingAandB();
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 498 };
    await exitA();
    await shareCellShows(/updating…/);

    walletState.key = 'OtherPk11111111111111111111111111111111111';
    s.entries = [() => entry('EntryZ', 0, 30n * M)];
    s.basis = { mineEffectiveRaw: 30n * M, totalEffectiveRaw: 100n * M, slot: 100 };
    view.rerender(<LighthousePoolLive bungalow={BUNGALOW} />);
    await shareCellShows(/of each payout/);
    expect(document.body.textContent).toContain('30%');
  });
});
