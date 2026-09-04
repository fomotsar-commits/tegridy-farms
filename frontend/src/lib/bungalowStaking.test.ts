import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Streamflow SDK is dynamically imported by the adapter — mock both
// packages at the module boundary so these tests pin OUR seam (mapping,
// defensive reads, nonce selection, argument shapes, error wrapping)
// against a canned client, never their network code. The live program gets
// its mandatory dust-wallet live-fire on pool day (runbook §6d).

const getStakePool = vi.fn();
const searchRewardPools = vi.fn();
const searchStakeEntries = vi.fn();
const unstakeAndClaim = vi.fn();
const claimRewards = vi.fn();
const getTokenAccountBalance = vi.fn();
const getAccountInfo = vi.fn();
const getParsedAccountInfo = vi.fn();
const getParsedTokenAccountsByOwner = vi.fn();
const searchRewardEntries = vi.fn();
const calcRewards = vi.fn();
const prepareStakeInstructions = vi.fn();
const prepareCreateRewardEntryInstructions = vi.fn();
const execute = vi.fn();

vi.mock('@streamflow/staking', () => ({
  SolanaStakingClient: class {
    connection = { getTokenAccountBalance, getAccountInfo, getParsedAccountInfo, getParsedTokenAccountsByOwner };
    getStakePool = getStakePool;
    searchRewardPools = searchRewardPools;
    searchStakeEntries = searchStakeEntries;
    searchRewardEntries = searchRewardEntries;
    unstakeAndClaim = unstakeAndClaim;
    claimRewards = claimRewards;
    prepareStakeInstructions = prepareStakeInstructions;
    prepareCreateRewardEntryInstructions = prepareCreateRewardEntryInstructions;
    execute = execute;
    getCurrentProgramId = vi.fn(() => 'StakePoolProgramId');
  },
  deriveStakeMintPDA: vi.fn(() => 'StakeMintPda'),
  calcRewards,
}));
vi.mock('@streamflow/common', () => ({ ICluster: { Mainnet: 'mainnet' } }));
vi.mock('@solana/web3.js', () => ({
  PublicKey: class { v: string; constructor(v: string) { this.v = v; } toBase58() { return this.v; } },
}));
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddressSync: vi.fn(() => 'ReceiptAta'),
  createAssociatedTokenAccountIdempotentInstruction: vi.fn(() => ({ __ix: 'create-receipt-ata' })),
}));

// The ladder/weight/rate display helpers are exercised in
// bungalowStakingRates.test.ts against the real SDK — this file pins the
// adapter seam (reads, writes, failure mapping) and the exit-safety predicate.
import {
  readPool,
  readEntries,
  nextVacantNonce,
  stake,
  WEIGHT_SCALE,
  type PoolView,
  type StakeEntryView,
} from './bungalowStaking';

const bn = (v: string | number) => ({ toString: () => String(v) });
const POOL = 'PooLAddr111111111111111111111111111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readPool', () => {
  it('maps pool + reward pools, reads vault balances, and DETECTS the token program', async () => {
    getStakePool.mockResolvedValue({
      mint: 'MintAddr', minDuration: bn(86400), maxDuration: bn(86400 * 30), totalStake: bn('5000000'),
      minWeight: bn('1000000000'), maxWeight: bn('2000000000'), unstakePeriod: bn(0),
      // The chain stores this scaled by 1e9 — readPool normalises it back to
      // raw stake units so every consumer works in one unit system.
      totalEffectiveStake: bn('7500000000000000'),
    });
    searchRewardPools.mockResolvedValue([
      { publicKey: 'Rp1', account: { mint: 'MintAddr', nonce: bn(0), vault: 'Vault1', rewardAmount: bn('3000'), rewardPeriod: bn(86400), permissionless: true } },
    ]);
    getTokenAccountBalance.mockResolvedValue({ value: { amount: '0' } });
    getParsedAccountInfo.mockResolvedValue({ value: { data: { parsed: { info: { decimals: 6 } } } } });
    // BAYLA lesson (mainnet 2026-08-26): the mint owner is Token-2022, and
    // assuming legacy dies with IncorrectProgramId — detection is mandatory.
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } });

    const r = await readPool(POOL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pool.minDurationSecs).toBe(86400);
    expect(r.pool.totalStakeRaw).toBe(5_000_000n);
    expect(r.pool.tokenProgram).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    expect(r.pool.rewardPools).toHaveLength(1);
    // FUNDING-LAST: an empty vault is a real 0n, not null/unknown.
    expect(r.pool.rewardPools[0]!.fundedRaw).toBe(0n);
    expect(getTokenAccountBalance).toHaveBeenCalledWith('Vault1');
    // Decimals are READ, never assumed — they scale every human number and the
    // reward rate itself (which is quoted per raw unit).
    expect(r.pool.decimals).toBe(6);
    expect(r.pool.rewardPools[0]!.decimals).toBe(6);
    expect(r.pool.rewardPools[0]!.permissionless).toBe(true);
    expect(r.pool.minWeightScaled).toBe(1_000_000_000n);
    expect(r.pool.maxWeightScaled).toBe(2_000_000_000n);
    expect(r.pool.totalEffectiveStakeRaw).toBe(7_500_000n);
  });

  it('reports an unreadable vault as null (outage), never as zero', async () => {
    getStakePool.mockResolvedValue({ mint: 'M', minDuration: bn(1), maxDuration: bn(2), totalStake: bn(0), minWeight: bn('1000000000'), maxWeight: bn('1000000000'), unstakePeriod: bn(0), totalEffectiveStake: bn(0) });
    searchRewardPools.mockResolvedValue([
      { publicKey: 'Rp1', account: { mint: 'M', nonce: bn(0), vault: 'V', rewardAmount: bn(1), rewardPeriod: bn(1) } },
    ]);
    getTokenAccountBalance.mockRejectedValue(new Error('rpc down'));
    const r = await readPool(POOL);
    expect(r.ok && r.pool.rewardPools[0]!.fundedRaw).toBe(null);
  });

  it('wraps a dead RPC as a failure, never throws', async () => {
    getStakePool.mockRejectedValue(new Error('boom'));
    const r = await readPool(POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outage, not a zero/);
  });
});

describe('readEntries + nextVacantNonce', () => {
  it('maps entries and picks the lowest nonce no entry occupies, open OR closed', async () => {
    searchStakeEntries.mockResolvedValue([
      { publicKey: 'E0', account: { nonce: bn(0), amount: bn('100'), duration: bn(86400), createdTs: bn(1_700_000_000), closedTs: bn(0), effectiveAmount: bn('150') } },
      { publicKey: 'E1', account: { nonce: bn(1), amount: bn('200'), duration: bn(86400), createdTs: bn(1_700_000_100), closedTs: bn(1_700_000_500) } },
    ]);
    searchRewardPools.mockResolvedValue([{ publicKey: 'Rp1', account: { nonce: bn(0) } }]);
    searchRewardEntries.mockResolvedValue([{ publicKey: 'Re1', account: {} }]);
    calcRewards.mockReturnValue(bn('42'));
    const r = await readEntries(POOL, 'Payer');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.effectiveAmountRaw).toBe(150n);
    // Pending comes from the SDK's own calcRewards, and ONLY open entries are
    // priced (a closed entry accrues nothing more).
    expect(r.entries[0]!.pendingRaw[0]).toBe(42n);
    expect(r.entries[1]!.pendingRaw).toEqual({});
    // AUDIT (2026-09-01): this used to assert 1, on the belief that closing an
    // entry frees its nonce. It does not — the entry is still an ACCOUNT (that
    // is why `closedTs` is readable at all), and the entry PDA is derived from
    // (stakePool, authority, nonce), so re-using nonce 1 would try to
    // initialise an address already in use and the stake would revert. nonce 0
    // is open and nonce 1 is closed, so BOTH are taken and the next free slot
    // is 2.
    expect(nextVacantNonce(r.entries)).toBe(2);
  });

  it('returns null when all 256 slots are open', () => {
    const entries: StakeEntryView[] = Array.from({ length: 256 }, (_, nonce) => ({
      address: `E${nonce}`, nonce, amountRaw: 1n, durationSecs: 1, createdTs: 1, closedTs: 0,
      effectiveAmountRaw: 1n, pendingRaw: {},
    }));
    expect(nextVacantNonce(entries)).toBe(null);
  });
});

describe('stake', () => {
  const pool: PoolView = {
    address: POOL, mint: 'MintAddr', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    minDurationSecs: 86400, maxDurationSecs: 86400 * 30,
    minWeightScaled: WEIGHT_SCALE, maxWeightScaled: WEIGHT_SCALE, unstakePeriodSecs: 0,
    totalStakeRaw: 0n, totalEffectiveStakeRaw: 0n,
    rewardPools: [{ address: 'Rp1', mint: 'MintAddr', kind: 'fixed' as const, nonce: 3, vault: 'V1', decimals: 6, fundedRaw: 0n, permissionless: true, rewardAmountRaw: '1', rewardPeriodSecs: 86400, fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0 }],
  };

  const invoker = { publicKey: { toBase58: () => 'StakerPk' } } as never;

  it('bundles receipt-ATA + stake + reward entries into ONE executed transaction', async () => {
    prepareStakeInstructions.mockResolvedValue({ ixs: [{ __ix: 'stake' }] });
    prepareCreateRewardEntryInstructions.mockResolvedValue({ ixs: [{ __ix: 'reward-entry' }] });
    execute.mockResolvedValue({ txId: 'SIG' });
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
    const r = await stake({ invoker, pool, amountRaw: 123n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.txId).toBe('SIG');
    // The devnet-proven ordering: ATA create FIRST (first-time stakers die
    // with AccountNotInitialized without it), then stake, then reward entry.
    const [ixs, ext] = execute.mock.calls[0]!;
    expect(ixs.map((i: { __ix: string }) => i.__ix)).toEqual(['create-receipt-ata', 'stake', 'reward-entry']);
    expect(ext.invoker).toBe(invoker);
    const [stakeArgs] = prepareStakeInstructions.mock.calls[0]!;
    expect(stakeArgs.stakePool).toBe(POOL);
    expect(stakeArgs.stakePoolMint).toBe('MintAddr');
    expect(stakeArgs.nonce).toBe(0);
    expect(stakeArgs.amount.toString()).toBe('123');
    expect(stakeArgs.duration.toString()).toBe('86400');
    // The BAYLA Token-2022 lesson: the pool's detected program rides every write.
    expect(stakeArgs.tokenProgramId).toBe(pool.tokenProgram);
    const [entryArgs] = prepareCreateRewardEntryInstructions.mock.calls[0]!;
    expect(entryArgs.rewardPoolNonce).toBe(3);
    expect(entryArgs.depositNonce).toBe(0);
    expect(entryArgs.stakePoolMint).toBe('MintAddr');
    expect(entryArgs.tokenProgramId).toBe(pool.tokenProgram);
  });

  it('maps a wallet rejection to the human refusal line', async () => {
    prepareStakeInstructions.mockResolvedValue({ ixs: [] });
    prepareCreateRewardEntryInstructions.mockResolvedValue({ ixs: [] });
    execute.mockRejectedValue(new Error('User rejected the request'));
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('You declined the signature — nothing moved.');
  });

  it('NEVER claims "nothing moved" for a post-broadcast confirmation timeout — outcome unknown + signature', async () => {
    prepareStakeInstructions.mockResolvedValue({ ixs: [] });
    prepareCreateRewardEntryInstructions.mockResolvedValue({ ixs: [] });
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
    // web3's TransactionExpiredTimeoutError shape: fired AFTER broadcast,
    // carries the signature. Asserting "nothing moved" here invited a
    // duplicate stake (a second real lock) — the recorded submit-path lesson.
    execute.mockRejectedValue(Object.assign(
      new Error('Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.'),
      { signature: 'S1gnatuRE111' },
    ));
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('Outcome unknown');
      expect(r.reason).toContain('S1gnatuRE111');
      expect(r.reason).not.toContain('nothing moved');
    }
  });

  it('maps Streamflow 6012 (vault cannot cover payout) to the proven dry-vault explanation', async () => {
    prepareStakeInstructions.mockResolvedValue({ ixs: [] });
    prepareCreateRewardEntryInstructions.mockResolvedValue({ ixs: [] });
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
    execute.mockRejectedValue(new Error('Raw transaction Xyz failed ({"err":{"InstructionError":[2,{"Custom":6012}]}})'));
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('vault');
      expect(r.reason).toContain('topped up');
    }
  });
});

describe('payingNowRate — the stat must never contradict the banner beside it', () => {
  it('pays 0 in EVERY dry state, including the two a `funded > 0n` gate misses', async () => {
    const { payingNowRate } = await import('./bungalowStaking');
    // The shipped defect: dust and sub-day runway are non-zero `funded`, so the
    // old gate printed the full configured APR in green directly above a banner
    // saying paying-now is 0%. vaultDry is the banner's own predicate.
    expect(payingNowRate(0.219, 0n, true), 'empty vault').toBe(0);
    expect(payingNowRate(0.219, 1n, true), 'DUST vault — the contradiction').toBe(0);
    expect(payingNowRate(0.219, 500_000n, true), 'sub-day runway — the contradiction').toBe(0);
  });

  it('pays the configured rate only when the vault can actually back it', async () => {
    const { payingNowRate } = await import('./bungalowStaking');
    expect(payingNowRate(0.219, 5_000_000_000n, false)).toBe(0.219);
  });

  it('an UNREADABLE vault is an outage, never a paying zero', async () => {
    const { payingNowRate } = await import('./bungalowStaking');
    // vaultIsMateriallyEmpty returns false on an unreadable vault, so without
    // the null guard an outage would render as the full configured rate.
    expect(payingNowRate(0.219, null, false)).toBe(0);
  });
});

describe('vaultIsMateriallyEmpty — the exit-safety predicate (built on vaultRunwaySecs)', () => {
  // 6/6 decimals, 0.003/period, daily periods, 1,000 tokens effectively
  // staked → burn = 3 tokens/day = 3_000_000 raw/day.
  const mkPool = (totalEffectiveStakeRaw: bigint) => ({
    address: 'P', mint: 'M', decimals: 6, tokenProgram: 'T',
    minDurationSecs: 86400, maxDurationSecs: 86400 * 365,
    minWeightScaled: WEIGHT_SCALE, maxWeightScaled: WEIGHT_SCALE, unstakePeriodSecs: 0,
    totalStakeRaw: totalEffectiveStakeRaw, totalEffectiveStakeRaw,
    rewardPools: [],
  });
  const mkRp = (fundedRaw: bigint | null) => ({
    address: 'Rp', mint: 'M', kind: 'fixed' as const, nonce: 0, vault: 'V', decimals: 6,
    permissionless: true,
    fundedRaw, rewardAmountRaw: '3000000', rewardPeriodSecs: 86400,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
  });

  it('dust cannot clear the empty banner, and <1 day of burn is still empty', async () => {
    const { vaultIsMateriallyEmpty } = await import('./bungalowStaking');
    const staked = mkPool(1_000_000_000n);
    const unstaked = mkPool(0n);
    expect(vaultIsMateriallyEmpty(unstaked, mkRp(0n))).toBe(true);
    // The 1-raw-unit grief: a stranger funding dust used to hide the warning.
    expect(vaultIsMateriallyEmpty(unstaked, mkRp(1n))).toBe(true);
    expect(vaultIsMateriallyEmpty(unstaked, mkRp(999_999n))).toBe(true);
    // ≥1 whole token with zero burn (nothing staked): runway unstatable → not "empty".
    expect(vaultIsMateriallyEmpty(unstaked, mkRp(2_000_000n))).toBe(false);
    // 2 tokens against 3-token/day burn = 0.67 days of runway → still empty.
    expect(vaultIsMateriallyEmpty(staked, mkRp(2_000_000n))).toBe(true);
    // 4 tokens = 1.33 days → past the floor.
    expect(vaultIsMateriallyEmpty(staked, mkRp(4_000_000n))).toBe(false);
    // Unreadable vault is an OUTAGE, not a verdict.
    expect(vaultIsMateriallyEmpty(staked, mkRp(null))).toBe(false);
  });
});
