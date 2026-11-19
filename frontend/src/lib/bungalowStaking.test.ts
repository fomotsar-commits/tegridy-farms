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
const prepareClaimRewardsInstructions = vi.fn();
const getTokenAccountBalance = vi.fn();
const getAccountInfo = vi.fn();
const getParsedAccountInfo = vi.fn();
const getParsedTokenAccountsByOwner = vi.fn();
const searchRewardEntries = vi.fn();
const calcRewards = vi.fn();
const prepareStakeInstructions = vi.fn();
const prepareCreateRewardEntryInstructions = vi.fn();
// The SDK only BUILDS writes now; these two build the exits.
const prepareUnstakeAndClaimInstructions = vi.fn(async (..._a: unknown[]) => ({ ixs: [{ __ix: 'unstake-and-claim' }] }));
const prepareUnstakeAndCloseInstructions = vi.fn(async (..._a: unknown[]) => ({ ixs: [{ __ix: 'unstake-and-close' }] }));
const execute = vi.fn();
// Every write goes through the shared send (lib/solana/walletWrite.ts, tested on its own
// with the ladder): this file pins what each write hands it and how it reads the ending.
type WriteEndLike =
  | { kind: 'not-sent'; stage: 'test' | 'check' | 'sol' | 'wallet' | 'network'; reason: string; logs: string[]; declined?: boolean }
  | { kind: 'sent'; signature: string; outcome: 'confirmed' | 'reverted' | 'unknown'; slot: number | null; version: 0 };
const sentEnd = (signature = 'SIG'): WriteEndLike => ({ kind: 'sent', signature, outcome: 'confirmed', slot: 1, version: 0 });
const notSentAt = (stage: 'check' | 'sol' | 'wallet', reason: string) => ({ kind: 'not-sent' as const, stage, reason, logs: [] as string[] });
const sendOneWrite = vi.fn(async (..._a: unknown[]): Promise<WriteEndLike> => sentEnd());
vi.mock('./solana/walletWrite', () => ({ sendOneWrite: (...a: unknown[]) => sendOneWrite(...a) }));
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
    prepareClaimRewardsInstructions = prepareClaimRewardsInstructions;
    prepareStakeInstructions = prepareStakeInstructions;
    prepareCreateRewardEntryInstructions = prepareCreateRewardEntryInstructions;
    prepareUnstakeAndClaimInstructions = prepareUnstakeAndClaimInstructions;
    prepareUnstakeAndCloseInstructions = prepareUnstakeAndCloseInstructions;
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
  Connection: class { url: string; constructor(url: string) { this.url = url; } },
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
import { DECLINED_IN_WALLET } from './solana/swap/walletCopy';
import { notSignedCopy } from './solana/walletThrow';

const bn = (v: string | number) => ({ toString: () => String(v) });
const POOL = 'PooLAddr111111111111111111111111111111111111';

const REWARD_PROGRAM = 'RWRDdfRbi3339VgKxTAXg4cjyniF7cbhNbMxZWiSKmj';
const DYNAMIC_REWARD_PROGRAM = 'RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez';
const STAKE_PROGRAM = 'STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH';
/**
 * A program's custom error as the SDK throws it from its test run: web3's SendTransactionError
 * (its logs on `transactionLogs`), wrapped in Streamflow's ContractError (`cause`).
 */
const programSays = (program: string, code: number) => {
  const sim = Object.assign(new Error(`Simulation failed. Message: failed to simulate transaction: {"InstructionError":[2,{"Custom":${code}}]}.`), {
    transactionLogs: [
      `Program ${program} invoke [1]`,
      'Program log: Instruction: ClaimRewards',
      `Program log: AnchorError occurred. Error Number: ${code}.`,
      `Program ${program} consumed 9000 of 200000 compute units`,
      `Program ${program} failed: custom program error: 0x${code.toString(16)}`,
    ],
  });
  return Object.assign(new Error(sim.message, { cause: sim }), { name: 'ContractError' });
};
/** A program's custom error as a test run's logs carry it. */
const logsOf = (program: string, code: number) => (programSays(program, code).cause as { transactionLogs: string[] }).transactionLogs;
/** The shared send's ending when the final test run refused it. */
const testSays = (program: string, code: number) => ({ kind: 'not-sent' as const, stage: 'test' as const, reason: 'unused: the write says it from the logs', logs: logsOf(program, code) });

beforeEach(() => {
  vi.clearAllMocks();
  sendOneWrite.mockReset().mockImplementation(async () => sentEnd());
  prepareClaimRewardsInstructions.mockReset().mockResolvedValue({ ixs: [{ __ix: 'claim' }] });
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

  // A dashboard load reads every Streamflow pool for the wallet, and most hold none of its
  // stakes: the two reward-pool searches were two calls a pool that priced nothing.
  it.each([
    ['no stake here', []],
    ['only closed stakes here', [closed]],
  ])('with %s, the reward pools are never searched, and the read is whole', async (_case, found) => {
    searchStakeEntries.mockResolvedValue(found);
    const r = await readEntries(POOL, 'Payer');
    expect(r.ok && r.entries.map((e) => [e.address, e.pendingUnread])).toEqual(found.map((e) => [e.publicKey, undefined]));
    expect(searchRewardPools).not.toHaveBeenCalled();
    expect(dynamicRewardPoolAll).not.toHaveBeenCalled();
    expect(searchRewardEntries).not.toHaveBeenCalled();
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
  const ready = () => {
    prepareStakeInstructions.mockResolvedValue({ ixs: [{ __ix: 'stake' }] });
    prepareCreateRewardEntryInstructions.mockResolvedValue({ ixs: [{ __ix: 'reward-entry' }] });
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
  };

  it('bundles receipt-ATA + stake + reward entries into ONE transaction, sent by the shared send', async () => {
    ready();
    const r = await stake({ invoker, pool, amountRaw: 123n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.txId).toBe('SIG');
    // The devnet-proven ordering: ATA create FIRST (first-time stakers die
    // with AccountNotInitialized without it), then stake, then reward entry.
    expect(sendOneWrite).toHaveBeenCalledTimes(1);
    const [, wallet, owner, ixs] = sendOneWrite.mock.calls[0]!;
    expect((ixs as { __ix: string }[]).map((i: { __ix: string }) => i.__ix)).toEqual(['create-receipt-ata', 'stake', 'reward-entry']);
    // The staker's own wallet signs, for its own key.
    expect(wallet).toBe(invoker);
    expect(owner).toBe((invoker as { publicKey: unknown }).publicKey);
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
    // The SDK only builds now: its own execute (sign first, test after) is never used.
    expect(execute).not.toHaveBeenCalled();
  });

  // Phantom, ticket #467471: the wallet is asked only after a test run passed and the SOL
  // was checked. Everything that stops before it says so in the shared send's own words.
  it.each([
    ['a decline in the wallet', notSentAt('wallet', DECLINED_IN_WALLET)],
    ['a wallet that did not sign', notSentAt('wallet', notSignedCopy('Wallet is locked'))],
    ['a test run that could not finish', notSentAt('check', 'The test run before your wallet could not finish just now, so your wallet was not asked. Nothing was sent. Try again in a moment.')],
    ['a wallet short of SOL', notSentAt('sol', 'Not enough SOL: this needs about 0.003 SOL in your wallet for the network fee and account rent, and it holds 0.001 SOL. Your wallet was not asked. Nothing was sent.')],
  ])('%s is said in the shared send’s words, untouched', async (_, end) => {
    ready();
    sendOneWrite.mockResolvedValueOnce(end);
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(!r.ok && r.reason).toBe(end.reason);
  });

  it('NEVER claims "nothing moved" for a send the chain did not answer — outcome unknown + signature', async () => {
    ready();
    sendOneWrite.mockResolvedValueOnce({ kind: 'sent', signature: 'S1gnatuRE111', outcome: 'unknown', slot: null, version: 0 });
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('Outcome unknown');
      expect(r.reason).toContain('S1gnatuRE111');
      expect(r.reason).not.toMatch(/nothing moved/i);
    }
  });

  it('a send that landed and reverted carries its signature, and costs only the fee', async () => {
    ready();
    sendOneWrite.mockResolvedValueOnce({ kind: 'sent', signature: 'S1g', outcome: 'reverted', slot: null, version: 0 });
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(!r.ok && r.reason).toMatch(/reverted\. Nothing moved, apart from the network fee\. Signature: S1g$/);
  });

  it('maps Streamflow 6012 (vault cannot cover payout), from its test run, to the proven dry-vault explanation', async () => {
    ready();
    sendOneWrite.mockResolvedValueOnce(testSays(REWARD_PROGRAM, 6012));
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('vault');
      expect(r.reason).toContain('topped up');
    }
  });

  it('a test run short of SOL says so, though the program named no code', async () => {
    ready();
    sendOneWrite.mockResolvedValueOnce({ kind: 'not-sent', stage: 'test', reason: 'unused', logs: ['Transfer: insufficient lamports 10, need 2039280'] });
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(!r.ok && r.reason).toMatch(/^Not enough SOL/);
  });

  it('a build that throws is the write’s own fallback, and nothing is sent', async () => {
    prepareStakeInstructions.mockRejectedValue(new Error('rpc down'));
    getAccountInfo.mockResolvedValue({ owner: { toBase58: () => 'ReceiptProgram' } });
    const r = await stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] });
    expect(!r.ok && r.reason).toBe('The stake did not go through. Nothing moved. (rpc down)');
    expect(sendOneWrite).not.toHaveBeenCalled();
  });

  // Money review 2026-10-14 (m-5): once logs came back, the failing program and its code
  // decide, never the words.
  const unstakeSays = async (end: WriteEndLike) => {
    const lib = await import('./bungalowStaking');
    sendOneWrite.mockResolvedValueOnce(end);
    const r = await lib.unstakeAndClaim({ invoker, pool, entryNonce: 0 });
    return r.ok ? '' : r.reason;
  };

  it('the unstake is the SDK’s grouped flow, built by it and sent by the shared send', async () => {
    const lib = await import('./bungalowStaking');
    const r = await lib.unstakeAndClaim({ invoker, pool, entryNonce: 4 });
    expect(r).toEqual({ ok: true, txId: 'SIG' });
    expect(prepareUnstakeAndClaimInstructions.mock.calls[0]![0]).toMatchObject({ stakePool: POOL, nonce: 4, tokenProgramId: pool.tokenProgram });
    expect(sendOneWrite.mock.calls[0]![3]).toEqual([{ __ix: 'unstake-and-claim' }]);
    expect(unstakeAndClaim).not.toHaveBeenCalled();
  });

  it('with logs, a STAKE-program 6013 (LockedStake) is never a drained vault', async () => {
    const reason = await unstakeSays(testSays(STAKE_PROGRAM, 6013));
    expect(reason).not.toMatch(/reward vault cannot cover/);
    expect(reason).toMatch(/^The unstake did not go through/);
  });

  it('with logs, a drained vault is read from its own program: classic 6012, dynamic 6013; a compute count is not a code', async () => {
    expect(await unstakeSays(testSays(REWARD_PROGRAM, 6012))).toMatch(/cannot cover the accrued rewards/);
    expect(await unstakeSays(testSays(DYNAMIC_REWARD_PROGRAM, 6013))).toMatch(/This one DOES clear/);
    const counted = testSays(DYNAMIC_REWARD_PROGRAM, 6001);
    counted.logs = [...counted.logs, `Program ${DYNAMIC_REWARD_PROGRAM} consumed 6012 of 200000 compute units`];
    expect(await unstakeSays(counted)).not.toMatch(/reward vault cannot cover/);
  });

  it('a refusal at our own first send is read from its logs the same way', async () => {
    const said = await unstakeSays({ kind: 'not-sent', stage: 'network', reason: 'unused', logs: logsOf(REWARD_PROGRAM, 6012) });
    expect(said).toMatch(/cannot cover the accrued rewards/);
  });

  // The claim strip and the full card print these verbatim, and venue copy has no em dash.
  it('no failure a write can return carries an em dash', async () => {
    const lib = await import('./bungalowStaking');
    ready();
    const ends: WriteEndLike[] = [
      notSentAt('wallet', DECLINED_IN_WALLET),
      testSays(REWARD_PROGRAM, 6012),
      testSays(REWARD_PROGRAM, 6000),
      testSays(DYNAMIC_REWARD_PROGRAM, 6013),
      { kind: 'sent', signature: 'S1g', outcome: 'unknown', slot: null, version: 0 },
      { kind: 'sent', signature: 'S1g', outcome: 'reverted', slot: null, version: 0 },
      { kind: 'not-sent', stage: 'test', reason: 'unused', logs: ['something else'] },
    ];
    const writes = [
      () => stake({ invoker, pool, amountRaw: 1n, durationSecs: 86400, entries: [] }),
      () => lib.unstakeAndClaim({ invoker, pool, entryNonce: 0 }),
      () => lib.claimRewards({ invoker, pool, rewardPool: pool.rewardPools[0]!, entryNonce: 0 }),
      // Its claim fails first, so this is the rescue's own stop line.
      () => unstakeAndCloseForfeitingRewards({ invoker, pool, entryNonce: 0, entry: { createdTs: 1, pendingRaw: { 3: 5n } } }),
    ];
    const reasons: string[] = [];
    for (const end of ends) {
      for (const w of writes) {
        sendOneWrite.mockReset().mockResolvedValue(end);
        const r = await w();
        if (!r.ok) reasons.push(r.reason);
      }
    }
    expect(reasons.length).toBeGreaterThanOrEqual(ends.length * (writes.length - 1));
    for (const reason of reasons) expect(reason).not.toContain('—');
  });

  // Every bungalow's pool reaches this line, and most of them do not stake BAYLA.
  it('a claim the reward program refuses for good (6000, by its test run) names no coin, and is permanent', async () => {
    const lib = await import('./bungalowStaking');
    sendOneWrite.mockResolvedValueOnce(testSays(REWARD_PROGRAM, 6000));
    const r = await lib.claimRewards({ invoker, pool, rewardPool: pool.rewardPools[0]!, entryNonce: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.permanent).toBe(true);
    expect(r.reason).toContain('Your stake is safe');
    expect(r.reason).not.toMatch(/BAYLA/);
  });
});

// Phantom, ticket #467471: "some reward claims fail simulation with an arithmetic
// overflow/underflow". That is Streamflow's 6000 on a classic entry made before its pool's
// rate change. Until 2026-11-17 the SDK had the wallet sign the claim FIRST and test-ran it
// after, so the wallet was asked to sign a claim that could never pay.
describe('claimRewards: built by the SDK, tested before the wallet, one approval', () => {
  const pool: PoolView = {
    address: POOL, mint: 'MintAddr', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    minDurationSecs: 0, maxDurationSecs: 0, minWeightScaled: WEIGHT_SCALE, maxWeightScaled: WEIGHT_SCALE, unstakePeriodSecs: 0,
    totalStakeRaw: 0n, totalEffectiveStakeRaw: 0n,
    rewardPools: [{ address: 'Rp1', mint: 'MintAddr', kind: 'dynamic' as const, nonce: 3, vault: 'V1', decimals: 6, fundedRaw: 0n, permissionless: true, rewardAmountRaw: '1', rewardPeriodSecs: 86400, fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0, rateChangedAtTs: 0 }],
  };
  const claimant = { toBase58: () => 'StakerPk' } as never;
  const invoker = { publicKey: claimant } as never;

  it('asks the SDK’s prepare path for that stake and reward pool, and hands its instructions to the shared send', async () => {
    const lib = await import('./bungalowStaking');
    const r = await lib.claimRewards({ invoker, pool, rewardPool: pool.rewardPools[0]!, entryNonce: 7 });
    expect(r).toEqual({ ok: true, txId: 'SIG' });
    expect(prepareClaimRewardsInstructions.mock.calls[0]![0]).toEqual({
      stakePool: POOL, stakePoolMint: 'MintAddr', rewardPoolNonce: 3, depositNonce: 7, rewardMint: 'MintAddr', rewardPoolType: 'dynamic', tokenProgramId: pool.tokenProgram,
    });
    expect(prepareClaimRewardsInstructions.mock.calls[0]![1].invoker.publicKey).toBe(claimant);
    expect(sendOneWrite.mock.calls[0]![3]).toEqual([{ __ix: 'claim' }]);
    expect(claimRewards).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('a build that throws is a reason, never a throw, and nothing is sent', async () => {
    const lib = await import('./bungalowStaking');
    prepareClaimRewardsInstructions.mockRejectedValue(new Error('rpc down'));
    const r = await lib.claimRewards({ invoker, pool, rewardPool: pool.rewardPools[0]!, entryNonce: 0 });
    expect(r).toEqual({ ok: false, reason: 'The claim did not go through. Your rewards are untouched. (rpc down)' });
    expect(sendOneWrite).not.toHaveBeenCalled();
  });

  it('the shared send’s own refusal words are the claim’s: 6012 and 6000 by their program', async () => {
    const lib = await import('./bungalowStaking');
    await lib.claimRewards({ invoker, pool, rewardPool: pool.rewardPools[0]!, entryNonce: 0 });
    const refused = (sendOneWrite.mock.calls[0]![4] as { refused: unknown }).refused as (run: { ok: false; err: unknown; logs: string[] }, where: 'test' | 'send') => string;
    const run = (program: string, code: number) => ({ ok: false as const, err: null, logs: logsOf(program, code) });
    expect(refused(run(REWARD_PROGRAM, 6012), 'test')).toMatch(/cannot cover the accrued rewards/);
    expect(refused(run(REWARD_PROGRAM, 6000), 'test')).toMatch(/can no longer pay out/);
    expect(refused(run(DYNAMIC_REWARD_PROGRAM, 6013), 'test')).toMatch(/This one DOES clear/);
    // 6000 from the stake program is not the reward program's overflow.
    expect(refused(run(STAKE_PROGRAM, 6000), 'test')).toMatch(/^The claim did not go through\. Your rewards are untouched\./);
    expect(refused({ ok: false, err: null, logs: [] }, 'send')).toMatch(/^The claim did not go through\. Your rewards are untouched\./);
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

  /** Each claim's ending in turn (`claim(n)`), and the close's. The shared send tells them apart by what it was handed. */
  const answer = (claim: (n: number) => WriteEndLike, close: WriteEndLike = sentEnd('CLOSE_SIG')) => {
    let n = 0;
    sendOneWrite.mockImplementation(async (_c: unknown, _w: unknown, _o: unknown, ixs: { __ix: string }[]) => (ixs[0]!.__ix === 'claim' ? claim(n++) : close));
  };
  const callsOf = (tag: string) => sendOneWrite.mock.calls.filter((c) => (c[3] as { __ix: string }[])[0]!.__ix === tag);
  const orderOf = (tag: string) => sendOneWrite.mock.invocationCallOrder.filter((_, i) => (sendOneWrite.mock.calls[i]![3] as { __ix: string }[])[0]!.__ix === tag);

  // The classic pool's rate was changed AFTER this entry opened, so its claim is
  // expected to be refused - and it is STILL attempted. A predicate that is right on
  // every position measured does not get to skip the attempt. Since 2026-11-17 the
  // attempt is the claim's test run, so a refusal costs nothing and never reaches the wallet.
  const BROKEN_CLASSIC_LIVE_DYNAMIC = {
    createdTs: 1_000,
    pendingRaw: { 0: 4_000n, 1: 9_000n },
  };

  it('attempts EVERY pool holding a balance before it closes — including the one over the constant', async () => {
    answer(() => sentEnd('CLAIM_SIG'));
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(true);
    // BOTH pools are claimed. Nothing here may decide a pool cannot pay; the program decides.
    expect(callsOf('claim')).toHaveLength(2);
    expect(prepareClaimRewardsInstructions.mock.calls.map((c) => c[0].rewardPoolNonce)).toEqual([0, 1]);
    expect(prepareClaimRewardsInstructions.mock.calls[0]![0].depositNonce).toBe(7);
    // ORDER IS THE POINT. Closing first destroys the balance the claim saves.
    expect(Math.max(...orderOf('claim'))).toBeLessThan(orderOf('unstake-and-close')[0]!);
    expect(callsOf('unstake-and-close')).toHaveLength(1);
    expect(unstakeAndClose).not.toHaveBeenCalled();
  });

  it('ABORTS rather than forfeiting when the claim fails', async () => {
    answer(() => notSentAt('check', 'The test run before your wallet could not finish just now, so your wallet was not asked. Nothing was sent. Try again in a moment.'));
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(false);
    // The close must NOT have happened: burning a claimable balance to save a
    // retry is the trade this change exists to refuse.
    expect(callsOf('unstake-and-close')).toHaveLength(0);
    if (!r.ok) expect(r.reason).toMatch(/could not be claimed first/);
  });

  it('when the claim’s test run says 6000, the rescue accepts that and frees the principal', async () => {
    // The ONLY evidence that closes a door. Not the counter — the program, by the runtime's
    // own log line in the claim's test run, before any wallet was asked.
    answer(() => testSays(REWARD_PROGRAM, 6000));
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(callsOf('claim')).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(callsOf('unstake-and-close')).toHaveLength(1);
  });

  it('a 6000 still reads as 6000 when the logs carry a compute count of 6012 (money review 2026-10-14, m-5)', async () => {
    const said = testSays(REWARD_PROGRAM, 6000);
    said.logs = [`Program ${REWARD_PROGRAM} consumed 6012 of 200000 compute units`, ...said.logs];
    answer(() => said);
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(r.ok).toBe(true);
    expect(callsOf('unstake-and-close')).toHaveLength(1);
  });

  it('⚠️ a wallet switched mid-rescue closes nothing: the claims were chosen for the first account', async () => {
    // An adapter swaps invoker.publicKey in place when the extension changes account, so
    // later steps would act on the new one.
    let key = 'StakerA';
    const switching = { get publicKey() { return { toBase58: () => key }; } } as never;
    answer(() => { key = 'StakerB'; return sentEnd('CLAIM_SIG'); });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker: switching,
      pool: poolWith([rp(0, 'fixed'), rp(1, 'dynamic')]),
      entryNonce: 7,
      entry: BROKEN_CLASSIC_LIVE_DYNAMIC,
    });
    expect(r.ok).toBe(false);
    expect(callsOf('claim')).toHaveLength(1);
    expect(callsOf('unstake-and-close')).toHaveLength(0);
    if (!r.ok) expect(r.reason).toMatch(/wallet changed/i);
  });

  it('⚠️ with ONE pool to claim, the check before the close is what stops it', async () => {
    let key = 'StakerA';
    const switching = { get publicKey() { return { toBase58: () => key }; } } as never;
    answer(() => { key = 'StakerB'; return sentEnd('CLAIM_SIG'); });
    const r = await unstakeAndCloseForfeitingRewards({
      invoker: switching,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(callsOf('claim')).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(callsOf('unstake-and-close')).toHaveLength(0);
    if (!r.ok) expect(r.reason).toMatch(/wallet changed/i);
  });

  it.each([
    ['a test run that could not finish', notSentAt('check', 'The test run before your wallet could not finish just now.')],
    ['the reward program’s words alone, with no runtime line', { kind: 'not-sent' as const, stage: 'test' as const, reason: 'unused', logs: ['Program log: Error Code: ArithmeticError. Error Number: 6000.'] }],
    ['6000 from the STAKE program (InvalidDuration there), by its log line', testSays(STAKE_PROGRAM, 6000)],
    ['another code from the reward program', testSays(REWARD_PROGRAM, 6001)],
    ['a wallet that declined', notSentAt('wallet', DECLINED_IN_WALLET)],
  ])('%s never lets the rescue close the entry', async (_name, end) => {
    answer(() => end);
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(r.ok).toBe(false);
    expect(callsOf('unstake-and-close')).toHaveLength(0);
    if (!r.ok) expect(r.reason).toMatch(/could not be claimed first/);
  });

  it('a NON-permanent failure still aborts — a dry vault is not a death certificate', async () => {
    answer(() => testSays(DYNAMIC_REWARD_PROGRAM, 6013));
    const r = await unstakeAndCloseForfeitingRewards({
      invoker,
      pool: poolWith([rp(0, 'fixed')]),
      entryNonce: 7,
      entry: { createdTs: 1_000, pendingRaw: { 0: 4_000n } },
    });
    expect(r.ok).toBe(false);
    expect(callsOf('unstake-and-close')).toHaveLength(0);
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
