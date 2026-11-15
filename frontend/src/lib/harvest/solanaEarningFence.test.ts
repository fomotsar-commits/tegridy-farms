// @vitest-environment node
// Harvest states what a wallet's locks earn a day from the same share the ladder's card shows,
// so the card's own rule fences it (lib/ladder/writeFence.ts): after the wallet's confirmed
// write, a read whose slot is behind that write is a consistent picture of the PAST, and after
// an exit it over-reads. Read through the whole path here, as the Earn page reads it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const MINT = '7hmVkPXmDDTMzFNt5fUEoU4hJ8yLEcHc3iNLSvqxpump';
const POOL = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';
const OWNER = '9WAugU3gEpYMy1VQpjjCX7Dqo7PJAwhGfXmhNmpS2Fcz';
const OTHER = 'CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT';
/** The slot the wallet's locks and the pool's total were read at together. */
const BASIS_SLOT = 100;

vi.mock('../bungalows', async (orig) => ({
  ...(await orig<typeof import('../bungalows')>()),
  ladderRooms: () => [{ id: 'bayla', symbol: 'BAYLA', address: MINT, ladderPool: POOL }],
}));
vi.mock('../wallet/walletRows', async (orig) => ({
  ...(await orig<typeof import('../wallet/walletRows')>()),
  solanaStakePools: () => [],
}));
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'https://rpc.invalid' }));
vi.mock('../ladder/program', async (orig) => ({
  ...(await orig<typeof import('../ladder/program')>()),
  isLadderConfigured: () => true,
  ladderProgramId: () => new PublicKey('EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ'),
}));
vi.mock('../ladder/read', () => {
  const position = { address: 'P0', nonce: 0, amountRaw: 2_000_000n, weight: 10n, rewardPerWeightPaid: 0n, rewardsOwed: 5n };
  return {
    // A rate running far past the test's clock; this wallet weighs 10 of the pool's 100.
    readLadderPool: async () => ({
      ok: true,
      value: {
        address: POOL, mint: MINT, decimals: 6, tokenProgram: 'T', minStakeRaw: 0n, totalWeighted: 100n, rewardRate: 1_000n,
        periodFinish: 2_000_000_000n, lastUpdateTime: 1_800_000_000n, rewardPerWeightStored: 0n, rpwResidueRaw: 0n,
      },
    }),
    readLadderWallet: async () => ({
      ok: true,
      value: {
        stats: { address: 'S', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 0n, principalRaw: 2_000_000n },
        slots: [{ nonce: 0, state: 'open', position }],
        open: [position],
        truncated: false,
        shareBasis: { mineWeight: 10n, totalWeighted: 100n, slot: BASIS_SLOT },
      },
    }),
    readVaultBalances: async () => ({ stakeRaw: 1_000_000n, rewardRaw: 1_000_000n }),
  };
});

import { readSolanaHarvest } from './solana';
import { lastWriteFence, noteWriteFence, resetWriteFenceForTests } from '../ladder/writeFence';

const NOW = 1_800_000_000;

beforeEach(() => resetWriteFenceForTests());

describe('Harvest’s daily figure, behind the wallet’s own write', () => {
  it('with no write on this page load it is stated', async () => {
    expect(lastWriteFence()).toBeNull();
    const plan = await readSolanaHarvest(OWNER, NOW);
    expect(plan.earning).toHaveLength(1);
    expect(plan.earning![0]).toMatchObject({ roomId: 'bayla', symbol: 'BAYLA', where: 'lock ladder', perDayRaw: 8_640_000n, principalRaw: 2_000_000n });
    expect(plan.settling).toBeUndefined();
  });

  it('a read older than the write states no figure, and is asked again', async () => {
    noteWriteFence({ key: OWNER, slot: BASIS_SLOT + 1 });
    const plan = await readSolanaHarvest(OWNER, NOW);
    expect(plan.earning).toBeUndefined();
    expect(plan.settling).toBe(true);
    // The claim itself is still offered: it is test-run before it is put to the wallet.
    expect(plan.claims).toHaveLength(1);
  });

  it('a write whose slot is not known yet fences it too: closed until it is known', async () => {
    noteWriteFence({ key: OWNER, slot: null });
    const plan = await readSolanaHarvest(OWNER, NOW);
    expect(plan.earning).toBeUndefined();
    expect(plan.settling).toBe(true);
  });

  it('a read at or past the write’s slot is a figure again', async () => {
    noteWriteFence({ key: OWNER, slot: BASIS_SLOT });
    expect((await readSolanaHarvest(OWNER, NOW)).earning).toHaveLength(1);
  });

  it('another wallet’s write fences nothing of this one', async () => {
    noteWriteFence({ key: OTHER, slot: BASIS_SLOT + 1_000 });
    const plan = await readSolanaHarvest(OWNER, NOW);
    expect(plan.earning).toHaveLength(1);
    expect(plan.settling).toBeUndefined();
  });
});
