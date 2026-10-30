// NO CONFIGURED APR OVER AN EMPTY VAULT, ON ANY DOOR (island, answer seventeen item 3;
// the owner, 2026-10-03: "only the APR over an empty vault goes"). The pool card used
// to print the program's configured rate as a tile, on every lock button, in the
// paused notice and in a "what it would earn once funded" box, all while the vault
// that has to pay it held nothing. The funded pool below is the positive control:
// the same card, the same pool, with a vault, still quotes its rate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;

const vault = vi.hoisted(() => ({ fundedRaw: 0n }));
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
  totalStakeRaw: 1_000_000_000n,
  totalEffectiveStakeRaw: 1_000_000_000n,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'fixed' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: vault.fundedRaw, permissionless: true,
    rewardAmountRaw: '1000', rewardPeriodSecs: 86_400,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
    rateChangedAtTs: 1_788_241_201,
  }],
});

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
const STAKER = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: STAKER, wallet: { adapter: { publicKey: STAKER } }, connected: true }),
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [] })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000_000n })),
}));

// The room's torches read the island; here only where they stand is under test.
vi.mock('../RoomTorches', () => ({
  RoomTorches: ({ roomId }: { roomId: string }) => <div data-testid="room-torches-stub">{roomId}</div>,
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const ROOM = {
  id: 'bobo', name: 'BOBO', symbol: 'BOBO', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

/** The card's figures, the lock buttons, and the box under them once an amount is typed. */
async function drawWithAnAmount() {
  render(<LighthousePoolLive bungalow={ROOM} />);
  const figures = await screen.findByRole('region', { name: 'The lighthouse pool figures' });
  // The lock buttons are radios, labelled from the pool read.
  await screen.findAllByRole('radio');
  const amount = document.querySelector('input');
  expect(amount, 'no amount field on the card').toBeTruthy();
  fireEvent.change(amount!, { target: { value: '100' } });
  return figures;
}

beforeEach(() => { vault.fundedRaw = 0n; });

describe('an empty reward vault', () => {
  it('prints no configured rate anywhere on the card', async () => {
    const figures = await drawWithAnAmount();
    await screen.findByText(/staking is paused until the reward vault is funded/i);
    expect(within(figures).queryByText('Configured')).toBeNull();
    expect(document.body.textContent).not.toMatch(/tops out at/i);
    expect(document.body.textContent).not.toMatch(/once funded|at the configured/i);
    for (const lock of screen.getAllByRole('radio')) {
      expect(lock.textContent ?? '').not.toMatch(/%/);
    }
  });

  it("puts the room's torches above the notice, and keeps the notice (owner, 2026-10-15)", async () => {
    await drawWithAnAmount();
    const notice = await screen.findByText(/staking is paused until the reward vault is funded/i);
    const torches = screen.getByTestId('room-torches-stub');
    expect(torches).toHaveTextContent('bobo');
    expect(torches.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('a funded vault (the control)', () => {
  it('still quotes the configured rate on the card and on the lock buttons', async () => {
    vault.fundedRaw = 10_000_000_000_000n;
    const figures = await drawWithAnAmount();
    expect(within(figures).getByText('Configured')).toBeTruthy();
    expect(screen.getAllByRole('radio').some((b) => /%/.test(b.textContent ?? ''))).toBe(true);
    expect(await screen.findByText(/at the configured/i)).toBeTruthy();
    // A pool that pays keeps its form first: no torches inside its card.
    expect(screen.queryByTestId('room-torches-stub')).toBeNull();
  });
});
