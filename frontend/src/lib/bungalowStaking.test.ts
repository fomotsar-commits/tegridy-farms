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
const unstakeAndClose = vi.fn();
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
const getMultipleAccountsInfo = vi.fn();
// The DYNAMIC reward program's half of searchAllRewardPoolsChecked. Absent from the canned
// client before 2026-09-21, so that half always failed here, silently.
// readShareBasis reads through the ...AndContext variant so it can carry the call's slot.
// It delegates to the bare mock above, so each case sets the accounts one way.
const ctxSlot = { value: 777 as number | undefined };
const getMultipleAccountsInfoAndContext = vi.fn(async (...a: unknown[]) => ({
  context: ctxSlot.value === undefined ? {} : { slot: ctxSlot.value },
  value: await getMultipleAccountsInfo(...a),
}));
const dynamicRewardPoolAll = vi.fn(async () => [] as unknown[]);
const getRewardProgram = vi.fn(() => ({ account: { rewardPool: { all: dynamicRewardPoolAll } } }));
// Anchor's coder, faked: an account's `data` names which struct it is, and decoding it
// as any other struct throws — as a discriminator mismatch does for real.
const stakePoolProgram = {
  programId: { toBase58: () => 'StakePoolProgramId' },
  coder: { accounts: { decode: (name: string, data: { kind: string; fields: unknown }) => {
    if (data?.kind !== name) throw new Error(`not a ${name}`);
    return data.fields;
  } } },
};

vi.mock('@streamflow/staking', () => ({
  SolanaStakingClient: class {
    connection = { getTokenAccountBalance, getAccountInfo, getParsedAccountInfo, getParsedTokenAccountsByOwner, getMultipleAccountsInfo, getMultipleAccountsInfoAndContext };
    programs = { stakePoolProgram };
    getStakePool = getStakePool;
    searchRewardPools = searchRewardPools;
    searchStakeEntries = searchStakeEntries;
    searchRewardEntries = searchRewardEntries;
    unstakeAndClaim = unstakeAndClaim;
    unstakeAndClose = unstakeAndClose;
    claimRewards = claimRewards;
    prepareStakeInstructions = prepareStakeInstructions;
    prepareCreateRewardEntryInstructions = prepareCreateRewardEntryInstructions;
    execute = execute;
    getCurrentProgramId = vi.fn(() => 'StakePoolProgramId');
    getRewardProgram = getRewardProgram;
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
  readShareBasis,
  nextVacantNonce,
  splitAccruedByRisk,
  stake,
  unstakeAndCloseForfeitingRewards,
  WEIGHT_SCALE,
  type PoolView,
  type RewardPoolView,
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

  // ⚠️ A PARTIAL REWARD-POOL LIST IS AN OUTAGE. unstakeAndClaim builds one claim per
  // listed reward pool and then closes the entry, and a closed entry's rewards can never
  // be claimed again. A list missing a pool because its search half failed would exit
  // without claiming it.
  it.each([
    ['the fixed half', () => searchRewardPools.mockRejectedValueOnce(new Error('429'))],
    ['the dynamic half', () => dynamicRewardPoolAll.mockRejectedValueOnce(new Error('429'))],
  ])('fails the read when %s of the reward-pool search failed', async (_half, fail) => {
    getStakePool.mockResolvedValue({ mint: 'M', minDuration: bn(1), maxDuration: bn(2), totalStake: bn(0), minWeight: bn('1000000000'), maxWeight: bn('1000000000'), unstakePeriod: bn(0), totalEffectiveStake: bn(0) });
    searchRewardPools.mockResolvedValue([
      { publicKey: 'Rp1', account: { mint: 'M', nonce: bn(0), vault: 'V', rewardAmount: bn(1), rewardPeriod: bn(1) } },
    ]);
    getTokenAccountBalance.mockResolvedValue({ value: { amount: '5' } });
    fail();
    const r = await readPool(POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outage, not a zero/);
  });

  it('both halves answering with no reward pool is still a read, not an outage', async () => {
    getStakePool.mockResolvedValue({ mint: 'M', minDuration: bn(1), maxDuration: bn(2), totalStake: bn(0), minWeight: bn('1000000000'), maxWeight: bn('1000000000'), unstakePeriod: bn(0), totalEffectiveStake: bn(0) });
    searchRewardPools.mockResolvedValue([]);
    const r = await readPool(POOL);
    expect(r.ok && r.pool.rewardPools).toEqual([]);
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

// AN UNPRICED ACCRUAL IS UNKNOWN, NEVER ZERO. readEntries prices at most 8 open entries,
// and a reward-pool search half can fail silently; an open entry left unpriced used to
// come back with an empty `pendingRaw`, which every sum reads as zero — a partial total
// printed as complete. It is now marked `pendingUnread`, and the sum refuses it.
describe('readEntries — an open entry whose accrual was not priced says so', () => {
  const open = (n: number) => ({
    publicKey: `E${n}`,
    account: { nonce: bn(n), amount: bn('100'), duration: bn(1), createdTs: bn(1_700_000_000 + n), closedTs: bn(0), effectiveAmount: bn('100') },
  });
  const closed = { publicKey: 'EC', account: { nonce: bn(50), amount: bn('1'), duration: bn(1), createdTs: bn(1), closedTs: bn(5) } };

  it('⚠️ past the pricing cap, the 9th open entry is pendingUnread, and the header sum is null — not a partial total', async () => {
    searchStakeEntries.mockResolvedValue(Array.from({ length: 9 }, (_, i) => open(i)));
    searchRewardPools.mockResolvedValue([{ publicKey: 'Rp1', account: { nonce: bn(0) } }]);
    searchRewardEntries.mockResolvedValue([{ publicKey: 'Re1', account: {} }]);
    calcRewards.mockReturnValue(bn('42'));
    const r = await readEntries(POOL, 'Payer');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.filter((e) => e.pendingUnread)).toHaveLength(1);
    expect(r.entries.filter((e) => !e.pendingUnread).every((e) => e.pendingRaw[0] === 42n)).toBe(true);
    expect(splitAccruedByRisk(r.entries, []).claimableRaw).toBeNull();
  });

  it('⚠️ a reward-pool search half that FAILED leaves every open entry pendingUnread (the closed one is not)', async () => {
    searchStakeEntries.mockResolvedValue([open(0), closed]);
    searchRewardPools.mockResolvedValue([]);
    dynamicRewardPoolAll.mockRejectedValueOnce(new Error('rpc down'));
    const r = await readEntries(POOL, 'Payer');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.find((e) => e.address === 'E0')!.pendingUnread).toBe(true);
    expect(r.entries.find((e) => e.address === 'EC')!.pendingUnread).toBeUndefined();
    expect(splitAccruedByRisk(r.entries, []).claimableRaw).toBeNull();
  });

  it('both halves answered and no reward pool exists: a real zero, not unread', async () => {
    searchStakeEntries.mockResolvedValue([open(0)]);
    searchRewardPools.mockResolvedValue([]);
    const r = await readEntries(POOL, 'Payer');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]!.pendingUnread).toBeUndefined();
    expect(splitAccruedByRisk(r.entries, []).claimableRaw).toBe(0n);
  });
});

describe('stake', () => {
  const pool: PoolView = {
    address: POOL, mint: 'MintAddr', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    minDurationSecs: 86400, maxDurationSecs: 86400 * 30,
    minWeightScaled: WEIGHT_SCALE, maxWeightScaled: WEIGHT_SCALE, unstakePeriodSecs: 0,
    totalStakeRaw: 0n, totalEffectiveStakeRaw: 0n,
    rewardPools: [{ address: 'Rp1', mint: 'MintAddr', kind: 'fixed' as const, nonce: 3, vault: 'V1', decimals: 6, fundedRaw: 0n, permissionless: true, rewardAmountRaw: '1', rewardPeriodSecs: 86400, fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0, rateChangedAtTs: 0 }],
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
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0, rateChangedAtTs: 0,
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

/**
 * THE RESCUE MUST CLAIM WHAT IT CAN BEFORE IT CLOSES.
 *
 * `unstakeAndClose` closes the reward entry on EVERY pool it is handed, not just
 * the one past the u64 ceiling. With a single broken classic pool that costs
 * nothing. The day a working dynamic pool is attached — the stated plan — closing
 * blind would forfeit a live, claimable balance with no compensation and no
 * warning. `claimablePoolsBefore` shipped as the fix with NO CALL SITE; this
 * pins the wiring, not the helper.
 */
describe('unstakeAndCloseForfeitingRewards', () => {
  const rp = (nonce: number, kind: 'fixed' | 'dynamic'): RewardPoolView => ({
    address: `Rp${nonce}`, mint: 'MintAddr', kind, nonce, vault: `V${nonce}`, decimals: 6,
    fundedRaw: 1_000n, permissionless: true, rewardAmountRaw: '1', rewardPeriodSecs: 86400,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
    // LOAD-BEARING. The classic pool's rate moved at ts 2000 and the entry
    // fixtures below open at ts 1000, so those entries really are ones the
    // change broke. With this at 0 the predicate never fires and these tests
    // cannot tell whether a payability filter has crept back in — which is
    // exactly what mutation testing caught them failing to notice.
    rateChangedAtTs: kind === 'fixed' ? 2_000 : null,
  });
  const poolWith = (pools: RewardPoolView[]): PoolView => ({
    address: POOL, mint: 'MintAddr', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    minDurationSecs: 86400, maxDurationSecs: 86400 * 30,
    minWeightScaled: WEIGHT_SCALE, maxWeightScaled: WEIGHT_SCALE, unstakePeriodSecs: 0,
    totalStakeRaw: 0n, totalEffectiveStakeRaw: 0n, rewardPools: pools,
  });
  const invoker = { publicKey: { toBase58: () => 'StakerPk' } } as never;

  // The classic pool's rate was changed AFTER this entry opened, so its claim is
  // expected to revert - and it is STILL attempted. A predicate that is right on
  // every position measured does not get to skip the attempt; the fee is the
  // cheap failure and the silent forfeit is not.
  const BROKEN_CLASSIC_LIVE_DYNAMIC = {
    createdTs: 1_000,
    pendingRaw: { 0: 4_000n, 1: 9_000n },
  };

  it('attempts EVERY pool holding a balance before it closes — including the one over the constant', async () => {
    claimRewards.mockResolvedValue({ txId: 'CLAIM_SIG' });
    unstakeAndClose.mockResolvedValue({ txId: 'CLOSE_SIG' });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(true);
    // BOTH pools are claimed. This assertion read `1` on trunk — the classic
    // pool was dropped unclaimed because its counter was over the constant, and
    // that predicate matches a live position holding five figures of claimable
    // BAYLA. Nothing here may decide a pool cannot pay; the program decides.
    expect(claimRewards).toHaveBeenCalledTimes(2);
    expect(claimRewards.mock.calls.map((c) => c[0].rewardPoolNonce)).toEqual([0, 1]);
    expect(claimRewards.mock.calls[0]![0].depositNonce).toBe(7);
    // ORDER IS THE POINT. Closing first destroys the balance the claim saves.
    expect(claimRewards.mock.invocationCallOrder[0]!)
      .toBeLessThan(unstakeAndClose.mock.invocationCallOrder[0]!);
    expect(unstakeAndClose).toHaveBeenCalledTimes(1);
  });

  it('ABORTS rather than forfeiting when the claim fails', async () => {
    claimRewards.mockRejectedValue(new Error('vault dry'));
    unstakeAndClose.mockResolvedValue({ txId: 'CLOSE_SIG' });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(false);
    // The close must NOT have happened: burning a claimable balance to save a
    // retry is the trade this change exists to refuse.
    expect(unstakeAndClose).not.toHaveBeenCalled();
    if (!r.ok) expect(r.reason).toMatch(/could not be claimed first/);
  });

  it('when the chain itself says 6000, the rescue accepts that and frees the principal', async () => {
    // The ONLY evidence that closes a door. Not the counter — the program.
    claimRewards.mockRejectedValue(new Error('Error Code: ArithmeticError. Error Number: 6000.'));
    unstakeAndClose.mockResolvedValue({ txId: 'CLOSE_SIG' });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    // Attempted, refused by the program, then closed — the principal is not
    // held hostage to rewards that provably cannot be collected.
    expect(claimRewards).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(unstakeAndClose).toHaveBeenCalledTimes(1);
  });

  it('⚠️ a wallet switched mid-rescue closes nothing: the claims were chosen for the first account', async () => {
    // The SDK reads invoker.publicKey on every call, and an adapter swaps it in place
    // when the extension changes account, so later steps would act on the new one.
    let key = 'StakerA';
    const switching = { get publicKey() { return { toBase58: () => key }; } } as never;
    claimRewards.mockImplementation(async () => { key = 'StakerB'; return { txId: 'CLAIM_SIG' }; });
    unstakeAndClose.mockResolvedValue({ txId: 'CLOSE_SIG' });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker: switching,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(false);
    expect(claimRewards).toHaveBeenCalledTimes(1);
    expect(unstakeAndClose).not.toHaveBeenCalled();
    if (!r.ok) expect(r.reason).toMatch(/wallet changed/i);
  });

  it('a NON-permanent failure still aborts — a dry vault is not a death certificate', async () => {
    claimRewards.mockRejectedValue(new Error('Error Code: RewardPoolDrained. Error Number: 6013.'));
    unstakeAndClose.mockResolvedValue({ txId: 'CLOSE_SIG' });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(r.ok).toBe(false);
    expect(unstakeAndClose).not.toHaveBeenCalled();
  });
});

// THE SAME-SLOT SHARE BASIS. The lighthouse share used to divide the entries read by a
// separately read pool; these pin that the basis comes from ONE call, drops what closed
// in between from BOTH sides, and refuses (null) rather than guessing on anything odd.
describe('readShareBasis — the entries and the pool, from one call', () => {
  const OWNER_OK = { toBase58: () => 'StakePoolProgramId' };
  const poolAcc = (totalEffectiveScaled: bigint) => ({
    owner: OWNER_OK, data: { kind: 'StakePool', fields: { totalEffectiveStake: bn(totalEffectiveScaled.toString()) } },
  });
  const entryAcc = (effective: number, closedTs = 0, stakePool = POOL) => ({
    owner: OWNER_OK,
    data: { kind: 'StakeEntry', fields: { stakePool: { toBase58: () => stakePool }, closedTs: bn(closedTs), effectiveAmount: bn(effective) } },
  });

  beforeEach(() => { getMultipleAccountsInfo.mockReset(); ctxSlot.value = 777; });

  it('reads the entries AND the pool in a single getMultipleAccountsInfo call', async () => {
    getMultipleAccountsInfo.mockResolvedValue([entryAcc(20_000_000), poolAcc(110_000_000n * WEIGHT_SCALE)]);
    const r = await readShareBasis(POOL, ['E1']);
    expect(r).toEqual({ mineEffectiveRaw: 20_000_000n, totalEffectiveRaw: 110_000_000n, slot: 777 });
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    const keys = getMultipleAccountsInfo.mock.calls[0]![0] as { toBase58(): string }[];
    expect(keys.map((k) => k.toBase58())).toEqual(['E1', POOL]);
  });

  it('an entry closed or drained since the entries read is out of both sides', async () => {
    getMultipleAccountsInfo.mockResolvedValue([entryAcc(20_000_000), entryAcc(30_000_000, 1_700_000_000), null, poolAcc(90_000_000n * WEIGHT_SCALE)]);
    expect(await readShareBasis(POOL, ['E1', 'E2', 'E3'])).toEqual({ mineEffectiveRaw: 20_000_000n, totalEffectiveRaw: 90_000_000n, slot: 777 });
  });

  it('refuses on a missing pool, a foreign owner, an entry of another pool, or an undecodable account', async () => {
    getMultipleAccountsInfo.mockResolvedValueOnce([entryAcc(1), null]);
    expect(await readShareBasis(POOL, ['E1'])).toBeNull();
    getMultipleAccountsInfo.mockResolvedValueOnce([{ ...entryAcc(1), owner: { toBase58: () => 'Stranger' } }, poolAcc(10n * WEIGHT_SCALE)]);
    expect(await readShareBasis(POOL, ['E1'])).toBeNull();
    getMultipleAccountsInfo.mockResolvedValueOnce([entryAcc(1, 0, 'OtherPool'), poolAcc(10n * WEIGHT_SCALE)]);
    expect(await readShareBasis(POOL, ['E1'])).toBeNull();
    getMultipleAccountsInfo.mockResolvedValueOnce([{ owner: OWNER_OK, data: { kind: 'Garbage', fields: {} } }, poolAcc(10n * WEIGHT_SCALE)]);
    expect(await readShareBasis(POOL, ['E1'])).toBeNull();
    getMultipleAccountsInfo.mockRejectedValueOnce(new Error('rpc down'));
    expect(await readShareBasis(POOL, ['E1'])).toBeNull();
  });

  // THE WRITE-SLOT FENCE needs the basis's own slot: the card compares it with the slot
  // your write confirmed at. A response that carries none is null — never a guess —
  // and the card fails closed on it.
  it('⚠️ carries the one call’s context.slot, and null when the response has none', async () => {
    getMultipleAccountsInfo.mockResolvedValue([entryAcc(10_000_000), poolAcc(90_000_000n * WEIGHT_SCALE)]);
    ctxSlot.value = 498;
    expect((await readShareBasis(POOL, ['E1']))?.slot).toBe(498);
    ctxSlot.value = undefined;
    const r = await readShareBasis(POOL, ['E1']);
    expect(r).not.toBeNull();
    expect(r!.slot).toBeNull();
    expect(getMultipleAccountsInfoAndContext).toHaveBeenCalled();
  });

  it('no entries, or more than one call can carry, is no basis', async () => {
    expect(await readShareBasis(POOL, [])).toBeNull();
    expect(await readShareBasis(POOL, Array.from({ length: 100 }, (_, i) => `E${i}`))).toBeNull();
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
});
