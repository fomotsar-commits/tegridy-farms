// AN ACCRUAL THAT WAS NOT READ IS NOT AN ACCRUAL OF ZERO.
//
// readEntries prices only the first 8 open entries, and a reward-pool search that fails
// (either program's half) leaves pools unpriced. Those entries came back with an EMPTY
// `pendingRaw`, and both the header sum (splitAccruedByRisk) and the per-entry gate read
// an empty record as zero: the card printed "0 accrued" as a complete total and disabled
// the entry's claim as "Nothing accrued yet." — a partial read rendered as complete, and
// an unread figure rendered as zero. The ladder card has never done either (its
// `walletPartial`). An unpriced entry is now marked `pendingUnread` and reads unknown.
import { describe, it, expect, vi } from 'vitest';
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

// Its accrual was NOT priced by the read.
const UNPRICED = {
  address: 'Entry9', nonce: 9, amountRaw: 10_000_000n, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: 10_000_000n,
  pendingRaw: {}, accountedRaw: {}, pendingUnread: true as const,
};

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [UNPRICED] })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => ({ mineEffectiveRaw: 10_000_000n, totalEffectiveRaw: 100_000_000n, slot: 1 })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

describe('an unpriced accrual reads unknown, never zero', () => {
  it('⚠️ the header does not print "0 accrued" for an entry whose accrual was not read', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    let header: HTMLElement | undefined;
    await waitFor(() => {
      header = screen.queryAllByText(/accrued/).find((el) => /staked/.test(el.textContent ?? ''));
      expect(header).toBeDefined();
    });
    expect(header!.textContent).not.toMatch(/(^|[^0-9.,])0 accrued/);
    expect(header!.textContent).toMatch(/– accrued/);
  });

  it('⚠️ its claim is not disabled as "Nothing accrued yet." — trying is how you ask', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const claim = await screen.findByRole('button', { name: 'Claim rewards' });
    expect((claim as HTMLButtonElement).disabled).toBe(false);
    expect(claim.getAttribute('title') ?? '').not.toMatch(/Nothing accrued yet/);
  });
});
