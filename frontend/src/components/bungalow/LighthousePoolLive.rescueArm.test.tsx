// THE PRINCIPAL RESCUE'S TWO-STEP CONFIRM IS ARMED AGAINST ONE WALLET'S READ.
//
// "Take principal without rewards" sends `unstakeAndCloseForfeitingRewards`: the
// principal comes back and the accrued rewards are GIVEN UP. Its confirm was keyed by
// entry nonce alone, and nonces restart at 0 for every wallet — so arming wallet A's
// entry #0 and switching to wallet B rendered B's entry #0 ALREADY ARMED, and one click
// forfeited B's rewards with no confirmation. The ladder card had the same bug and
// shipped the fix (SolanaLadderPoolLive `armed`); these pin the Lighthouse port.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';
import * as staking from '../../lib/bungalowStaking';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const M = 1_000_000n;

const WALLET_A = 'WalletAaa111111111111111111111111111111111';
const WALLET_B = 'WalletBbb111111111111111111111111111111111';

const w = vi.hoisted(() => ({ key: '' }));

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
  totalStakeRaw: 100n * M,
  totalEffectiveStakeRaw: 100n * M,
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
  useWallet: () => {
    const pk = { toBase58: () => w.key };
    return { publicKey: pk, wallet: { adapter: { publicKey: pk } }, connected: true };
  },
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

// Each wallet holds ONE open, unlocked entry at nonce 0 whose accrual exceeds the
// vault — the state that offers the rescue. Same nonce, different wallets.
// A holds 10, B holds 7, so which wallet's row is on screen is readable from the row.
const entryFor = (wallet: string) => ({
  address: `Entry-${wallet.slice(0, 7)}`, nonce: 0, amountRaw: (wallet === WALLET_B ? 7n : 10n) * M, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: 10n * M,
  pendingRaw: { 0: 10n ** 18n }, accountedRaw: { 0: 0n },
});

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async (_pool: string, wallet: string) => ({ ok: true as const, entries: [entryFor(wallet)] })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => ({ mineEffectiveRaw: 10n * M, totalEffectiveRaw: 100n * M, slot: 400 })),
  readConfirmedSlot: vi.fn(async () => 500),
  unstakeAndCloseForfeitingRewards: vi.fn(async () => ({ ok: true as const, txId: 'TX-RESCUE' })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

/** The per-entry amount lines, in order — tells A's row (10) from B's (7). */
const rowAmounts = () => Array.from(document.querySelectorAll('li span.stat-value')).map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());

const rescue = vi.mocked(staking.unstakeAndCloseForfeitingRewards);
const ARM = 'Take principal without rewards';
const FIRE = 'Forfeit rewards & take principal';

beforeEach(() => { w.key = WALLET_A; rescue.mockClear(); });
afterEach(() => { vi.clearAllMocks(); });

describe('the lighthouse principal rescue confirm', () => {
  it('same wallet: the first click arms, the second fires the rescue for that entry', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const aArm = await screen.findByRole('button', { name: ARM });
    await act(async () => { fireEvent.click(aArm); });
    expect(rescue).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: FIRE })); });
    await waitFor(() => expect(rescue).toHaveBeenCalledTimes(1));
    expect(rescue.mock.calls[0]![0]).toMatchObject({ entryNonce: 0, entry: { address: entryFor(WALLET_A).address } });
  });

  it('⚠️ armed on wallet A, then switched to wallet B: B\'s same-nonce entry is DISARMED', async () => {
    const { rerender } = render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const aArm = await screen.findByRole('button', { name: ARM });
    await act(async () => { fireEvent.click(aArm); });
    expect(rowAmounts()).toEqual(['10 BAYLA']);
    expect(screen.getByRole('button', { name: FIRE })).toBeTruthy(); // A is armed

    w.key = WALLET_B;
    rerender(<LighthousePoolLive bungalow={BUNGALOW} />);
    // B's own entries read has landed — B's row (7 BAYLA) is drawn — before anything is asserted.
    await waitFor(() => expect(rowAmounts()).toEqual(['7 BAYLA']));
    // DISARMED: the arming control is offered, the forfeit button is not.
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
    const bArm = screen.getByRole('button', { name: ARM });

    // The first click on B ARMS — it does not forfeit anything.
    await act(async () => { fireEvent.click(bArm); });
    expect(rescue).not.toHaveBeenCalled();
    // …and the second, now deliberate, fires for B's entry.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: FIRE })); });
    await waitFor(() => expect(rescue).toHaveBeenCalledTimes(1));
    expect(rescue.mock.calls[0]![0]).toMatchObject({ entryNonce: 0, entry: { address: entryFor(WALLET_B).address } });
  });
});
