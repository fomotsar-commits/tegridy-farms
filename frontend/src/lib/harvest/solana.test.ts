// @vitest-environment node
// Harvest on Solana: what the wallet's stakes and locks come to, gated the way each pool
// card gates its own Claim button (LighthousePoolLive, SolanaLadderPoolLive), and each
// claim sent as that card sends it, on its own wallet approval.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WALLET_GUARD_ROOM_BYTES, WRITE_COPY } from '../solana/walletWrite';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import type { PoolView, RewardPoolView, StakeEntryView } from '../bungalowStaking';
import { aprLabel, perDayAtTodaysRate, type LadderPoolView, type LadderPositionView } from '../ladder/program';
import type { LadderWalletView } from '../ladder/read';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { LADDER_CLAIMS_PER_TX } from '../ladder/write';
import { ladderEarning, ladderResult, planLadder, planStreamflow, solanaTogether, streamflowResult, type SolanaClaim } from './solana';

const LADDER_PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const built = vi.hoisted(() => ({ claim: vi.fn(), claimIxs: vi.fn(), ladderClaimAll: vi.fn(), sendOneWrite: vi.fn(), v1: vi.fn() }));
// The cards' own sends reach the network; here they answer what the case says.
vi.mock('../bungalowStaking', async (orig) => ({ ...(await orig<typeof import('../bungalowStaking')>()), claimRewards: built.claim, claimRewardsInstructions: built.claimIxs }));
vi.mock('../ladder/write', async (orig) => ({ ...(await orig<typeof import('../ladder/write')>()), ladderClaimAll: built.ladderClaimAll }));
vi.mock('../solana/walletWrite', async (orig) => ({ ...(await orig<typeof import('../solana/walletWrite')>()), sendOneWrite: built.sendOneWrite }));
vi.mock('../solana/v1Signer', async (orig) => ({ ...(await orig<typeof import('../solana/v1Signer')>()), v1SignerOf: built.v1 }));
// The page's endpoint is the site-relative proxy; a node test needs a whole URL to build a connection on.
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'http://127.0.0.1:8899' }));
beforeEach(() => {
  built.claim.mockReset();
  built.claimIxs.mockReset();
  built.ladderClaimAll.mockReset();
  built.sendOneWrite.mockReset();
  built.v1.mockReset();
  built.v1.mockReturnValue(null);
});
vi.mock('../ladder/program', async (orig) => ({ ...(await orig<typeof import('../ladder/program')>()), ladderProgramId: () => LADDER_PROGRAM }));

const bayla = BUNGALOWS.find((b) => b.id === 'bayla')! as Bungalow & { address: string };
const MINT = bayla.address;
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const POOL = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';
const target = { room: bayla, pool: POOL, retired: false };

const rp = (over: Partial<RewardPoolView> = {}): RewardPoolView => ({
  address: 'RP', mint: MINT, kind: 'fixed', nonce: 0, vault: 'V', decimals: 6, fundedRaw: 1_000_000_000n, permissionless: false,
  rateChangedAtTs: 0, rewardAmountRaw: '0', rewardPeriodSecs: 0, fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0, ...over,
});
const pool = (rewardPools: RewardPoolView[], over: Partial<PoolView> = {}): PoolView => ({
  address: POOL, mint: MINT, decimals: 6, tokenProgram: 'T', minDurationSecs: 0, maxDurationSecs: 0, minWeightScaled: 1n, maxWeightScaled: 1n,
  unstakePeriodSecs: 0, totalStakeRaw: 0n, totalEffectiveStakeRaw: 0n, rewardPools, ...over,
});
const entry = (pendingRaw: Record<number, bigint | null>, over: Partial<StakeEntryView> = {}): StakeEntryView => ({
  address: 'E', nonce: 0, amountRaw: 1_000_000_000n, durationSecs: 0, createdTs: 2_000, closedTs: 0, effectiveAmountRaw: 1_000_000_000n, pendingRaw, ...over,
});

// A ladder pool whose accounts are real keys, so its claims compile into a transaction.
const ladderPool = () => ({
  address: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV', mint: MINT, decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  stakeVault: Keypair.generate().publicKey.toBase58(), rewardVault: Keypair.generate().publicKey.toBase58(),
  minStakeRaw: 0n, totalWeighted: 100n, rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 0n, rewardPerWeightStored: 0n, rpwResidueRaw: 0n,
}) as unknown as LadderPoolView;
const lpos = (nonce: number, owed: bigint) => ({
  address: `P${nonce}`, nonce, amountRaw: 2_000_000n, weight: 10n, rewardPerWeightPaid: 0n, rewardsOwed: owed,
}) as unknown as LadderPositionView;
const ladderWallet = (open: LadderPositionView[]): LadderWalletView => ({
  stats: { address: 'S', nextNonce: open.length, openPositions: open.length, rewardsCarriedRaw: 0n, principalRaw: 0n } as LadderWalletView['stats'],
  slots: open.map((p) => ({ nonce: p.nonce, state: 'open' as const, position: p })), open, truncated: false, shareBasis: null,
});

describe('a claim answer, read as Harvest reads it', () => {
  it('Streamflow: paid, cancelled, or the claim path’s own words', () => {
    expect(streamflowResult({ ok: true, txId: 'sig' })).toEqual({ kind: 'claimed', tx: 'sig' });
    expect(streamflowResult({ ok: false, reason: DECLINED_IN_WALLET })).toEqual({ kind: 'declined' });
    expect(streamflowResult({ ok: false, reason: 'Outcome unknown: …' })).toEqual({ kind: 'unconfirmed', reason: 'Outcome unknown: …' });
  });

  it('ladder: a signature on a failure is kept, so the visitor can look it up', () => {
    expect(ladderResult({ ok: true, signature: 'sig', slot: 1 })).toEqual({ kind: 'claimed', tx: 'sig' });
    expect(ladderResult({ ok: false, reason: DECLINED_IN_WALLET })).toEqual({ kind: 'declined' });
    expect(ladderResult({ ok: false, reason: 'unknown', signature: 'sig' })).toEqual({ kind: 'unconfirmed', reason: 'unknown', tx: 'sig' });
  });
});

describe('planStreamflow', () => {
  it('one claim per open stake and reward pool with something accrued, in the room’s coin', () => {
    const p = planStreamflow(target, pool([rp()]), [entry({ 0: 12_500_000n })]);
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]).toMatchObject({ chain: 'solana', symbol: 'BAYLA', where: 'lighthouse pool', amountRaw: 12_500_000n, decimals: 6, caution: null });
    expect(p.claims[0]!.detail).toBe('on 1,000 BAYLA staked');
    expect(p.held).toEqual([]);
    expect(p.unread).toEqual([]);
  });

  it('nothing accrued, or a closed stake, is nothing', () => {
    expect(planStreamflow(target, pool([rp()]), [entry({ 0: 0n }), entry({ 0: 5n }, { closedTs: 9 })])).toEqual({ claims: [], held: [], unread: [] });
  });

  it('more than the vault holds is held, not sent: it would revert (6012)', () => {
    const p = planStreamflow(target, pool([rp({ fundedRaw: 10n })]), [entry({ 0: 11n })]);
    expect(p.claims).toEqual([]);
    expect(p.held[0]).toMatchObject({ amountRaw: 11n, reason: 'The reward vault cannot cover this yet, so a claim would fail. Nothing is lost: it stays owed.' });
  });

  it('an unread vault is not a gate, as on the card', () => {
    expect(planStreamflow(target, pool([rp({ fundedRaw: null })]), [entry({ 0: 11n })]).claims).toHaveLength(1);
  });

  it('a stake the read did not price is not read, never nothing to claim', () => {
    // A stake marked unread carries a PARTIAL record: the figure it has is not its accrual.
    const p = planStreamflow(target, pool([rp()]), [entry({ 0: 5n }, { pendingUnread: true }), entry({ 0: null }, { nonce: 1 })]);
    expect(p.claims).toEqual([]);
    expect(p.unread).toHaveLength(1);
  });

  it('a reward pool paying another coin is left alone, with no amount named in this coin', () => {
    const p = planStreamflow(target, pool([rp({ mint: OTHER_MINT, nonce: 1 })]), [entry({ 1: 5n })]);
    expect(p.claims).toEqual([]);
    expect(p.held[0]!.amountRaw).toBeNull();
  });

  it('a stake older than the pool’s rate change is still sent, with a warning (a warning is never a gate)', () => {
    const p = planStreamflow(target, pool([rp({ rateChangedAtTs: 5_000 })]), [entry({ 0: 7n }, { createdTs: 1_000 })]);
    expect(p.claims).toHaveLength(1);
    // Refused in its test run it is never sent; sent and refused, its fee is spent: "nothing is claimed" holds either way.
    expect(p.claims[0]!.caution).toBe('This stake was made before the pool changed its reward rate, so this claim may not pay. If it does not, nothing is claimed.');
  });

  it('a pool that does not stake this room’s coin is not this coin’s', () => {
    const p = planStreamflow(target, pool([rp()], { mint: OTHER_MINT }), [entry({ 0: 7n })]);
    expect(p.claims).toEqual([]);
    expect(p.held).toHaveLength(1);
  });

  it('the retired pool says so', () => {
    expect(planStreamflow({ ...target, retired: true }, pool([rp()]), [entry({ 0: 7n })]).claims[0]!.where).toBe('old lighthouse pool');
  });
});

describe('planLadder', () => {
  const LADDER = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';
  // With no rate running, a position's earned is exactly its rewardsOwed (earnedNow).
  const lpool = (over: Partial<LadderPoolView> = {}) => ({
    address: LADDER, mint: MINT, decimals: 6, tokenProgram: 'T', minStakeRaw: 0n, totalWeighted: 100n, rewardRate: 0n,
    periodFinish: 0n, lastUpdateTime: 0n, rewardPerWeightStored: 0n, rpwResidueRaw: 0n, ...over,
  }) as unknown as LadderPoolView;
  const pos = (nonce: number, owed: bigint) => ({
    address: `P${nonce}`, nonce, amountRaw: 2_000_000n, weight: 10n, rewardPerWeightPaid: 0n, rewardsOwed: owed,
  }) as unknown as LadderPositionView;
  const wallet = (open: LadderPositionView[], over: Partial<LadderWalletView> = {}, carried = 0n): LadderWalletView => ({
    stats: { address: 'S', nextNonce: open.length, openPositions: open.length, rewardsCarriedRaw: carried, principalRaw: 0n } as LadderWalletView['stats'],
    slots: open.map((p) => ({ nonce: p.nonce, state: 'open' as const, position: p })),
    open,
    truncated: false,
    shareBasis: null,
    ...over,
  });

  // Owner, 2026-11-24: "you just have to claim once and confirm once".
  it('ONE claim for every position with something earned and the carried rewards', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n), pos(1, 0n), pos(2, 4n)], {}, 3n), 1_000n, 0);
    expect(p.claims.map((c) => [c.amountRaw, c.detail])).toEqual([[12n, 'on 4 BAYLA in 2 locks, and carried from a closed lock']]);
    expect(p.claims.every((c) => c.where === 'lock ladder' && c.caution === null)).toBe(true);
  });

  it('says what it claims on: one lock, several, carried alone', () => {
    const detail = (open: LadderPositionView[], carried = 0n) => planLadder(bayla, lpool(), wallet(open, {}, carried), 1_000n, 0).claims.map((c) => c.detail);
    expect(detail([pos(0, 5n)])).toEqual(['on 2 BAYLA locked']);
    expect(detail([pos(0, 5n)], 3n)).toEqual(['on 2 BAYLA locked, and carried from a closed lock']);
    expect(detail([pos(0, 5n), pos(1, 5n)])).toEqual(['on 4 BAYLA in 2 locks']);
    expect(detail([pos(0, 0n)], 3n)).toEqual(['carried from a closed lock']);
  });

  it('an empty reward vault holds every claim: it would pay nothing', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n)]), 0n, 0);
    expect(p.claims).toEqual([]);
    expect(p.held).toHaveLength(1);
  });

  it('a short vault still sends, and says what it pays', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n), pos(1, 5n)]), 6n, 0);
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]!.amountRaw).toBe(10n);
    expect(p.claims[0]!.caution).toMatch(/holds/);
  });

  it('the vault sentence never names more than the vault holds: 1,284.5 is 1,284, never 1,285', () => {
    const owed = 2_000_000_000n;
    expect(planLadder(bayla, lpool(), wallet([pos(0, owed)]), 1_284_500_000n, 0).claims[0]!.caution).toMatch(/holds 1,284 BAYLA now/);
    expect(planLadder(bayla, lpool(), wallet([pos(0, owed)]), 999_999_999n, 0).claims[0]!.caution).toMatch(/holds 999\.99 BAYLA now/);
    expect(planLadder(bayla, lpool(), wallet([pos(0, owed)]), 999_999n, 0).claims[0]!.caution).toMatch(/holds 0\.999 BAYLA now/);
  });

  it('a partial read claims what it found and names the rest as not read', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n)], { truncated: true }), 1_000n, 0);
    expect(p.claims).toHaveLength(1);
    expect(p.unread).toHaveLength(1);
  });

  it('a wallet that never locked is nothing', () => {
    expect(planLadder(bayla, lpool(), { stats: null, slots: [], open: [], truncated: false, shareBasis: null }, 1_000n, 0))
      .toEqual({ claims: [], held: [], unread: [] });
  });

  it('a ladder that does not stake this room’s coin is not this coin’s', () => {
    const p = planLadder(bayla, lpool({ mint: OTHER_MINT }), wallet([pos(0, 5n)]), 1_000n, 0);
    expect(p.claims).toEqual([]);
    expect(p.held).toHaveLength(1);
  });

  // One approval per transaction (Phantom, ticket #467471), and every lock in that one.
  it('every lock and the carried rewards go as ONE send, on one approval by the connected wallet', async () => {
    const accounts = { tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', stakeVault: Keypair.generate().publicKey.toBase58(), rewardVault: Keypair.generate().publicKey.toBase58() };
    const lp = lpool(accounts);
    const p = planLadder(bayla, lp, wallet([pos(3, 5n), pos(1, 0n), pos(6, 4n)], {}, 2n), 1_000n, 0);
    const signer = { publicKey: Keypair.generate().publicKey } as never;
    built.ladderClaimAll.mockResolvedValue({ ok: true, signature: 'S1', slot: 1 });
    expect(p.claims).toHaveLength(1);
    expect(await p.claims[0]!.send(signer)).toEqual({ kind: 'claimed', tx: 'S1' });
    expect(built.ladderClaimAll).toHaveBeenCalledTimes(1);
    const [ctx, args] = built.ladderClaimAll.mock.calls[0]!;
    expect(ctx).toMatchObject({ invoker: signer, programId: LADDER_PROGRAM, pool: new PublicKey(LADDER), poolAccounts: lp });
    expect(args).toEqual({ positionNonces: [3, 6], carried: true });
    expect(p.claims.every((c) => !('build' in c) && !('refused' in c))).toBe(true);
  });

  it('past what one transaction carries, one more claim per that many, each its own send', async () => {
    const open = [...Array(LADDER_CLAIMS_PER_TX + 2).keys()].map((n) => pos(n, 1n));
    const p = planLadder(bayla, lpool(), wallet(open, {}, 1n), 1_000n, 0);
    expect(p.claims.map((c) => c.amountRaw)).toEqual([BigInt(LADDER_CLAIMS_PER_TX), 3n]);
    expect(new Set(p.claims.map((c) => c.key)).size).toBe(2);
    built.ladderClaimAll.mockResolvedValue({ ok: true, signature: 'S', slot: 1 });
    for (const c of p.claims) await c.send({ publicKey: Keypair.generate().publicKey } as never);
    expect(built.ladderClaimAll.mock.calls.map((call) => call[1])).toEqual([
      { positionNonces: [...Array(LADDER_CLAIMS_PER_TX).keys()], carried: false },
      { positionNonces: [LADDER_CLAIMS_PER_TX, LADDER_CLAIMS_PER_TX + 1], carried: true },
    ]);
  });

  // What the locks earn a day and that as a yearly rate: the ladder card's two figures under
  // "You earn per day" (SolanaLadderPoolLive.tsx), by the card's own rule, or no figure at all.
  describe('what the locks earn a day (owner, 2026-11-14: the bar with "% and daily yield")', () => {
    // A rate running to second 10,000; each lock weighs 10 of the pool's 100.
    const running = (over: Partial<LadderPoolView> = {}) => lpool({ rewardRate: 1_000n, periodFinish: 10_000n, totalWeighted: 100n, ...over });
    const basis = (totalWeighted = 100n, mineWeight = 20n) => ({ shareBasis: { mineWeight, totalWeighted, slot: 5 } });
    const two = () => [pos(0, 5n), pos(1, 0n)];

    it('adds each lock’s own figure, over the stake behind them, in the card’s words', () => {
      const e = ladderEarning(bayla, running(), wallet(two(), basis()), 0)!;
      const each = perDayAtTodaysRate(10n, 100n, running(), 0)!;
      expect(each).toBe(8_640_000n);
      expect(e.perDayRaw).toBe(each * 2n);
      expect(e.principalRaw).toBe(4_000_000n);
      expect(e.apr).toBe(aprLabel(e.perDayRaw, e.principalRaw));
      expect(e).toMatchObject({ chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lock ladder', decimals: 6, fundedToSecs: 10_000 });
    });

    it('is stated with nothing to claim right now, and rides on the plan', () => {
      const p = planLadder(bayla, running(), wallet([pos(0, 0n)], basis(100n, 10n)), 1_000n, 0);
      expect(p.claims).toEqual([]);
      expect(p.earning).toHaveLength(1);
      expect(p.settling).toBeUndefined();
    });

    it('of the two readings of the pool’s total, the larger: the smaller figure, never the flattering one', () => {
      // Others locked since the basis was read: the pool's own read is larger, and wins.
      const fresher = ladderEarning(bayla, running({ totalWeighted: 200n }), wallet(two(), basis(100n)), 0)!;
      expect(fresher.perDayRaw).toBe(perDayAtTodaysRate(10n, 200n, running(), 0)! * 2n);
      // The pool's own read is older and smaller: the basis is larger, and wins.
      const older = ladderEarning(bayla, running({ totalWeighted: 50n }), wallet(two(), basis(100n)), 0)!;
      expect(older.perDayRaw).toBe(perDayAtTodaysRate(10n, 100n, running(), 0)! * 2n);
    });

    it.each([
      ['no share basis was read', () => wallet(two()), running()],
      ['the list of locks is partial', () => wallet(two(), { ...basis(), truncated: true }), running()],
      ['the wallet has more locks than were read', () => {
        const w = wallet(two(), basis());
        return { ...w, stats: { ...w.stats!, openPositions: 3 } };
      }, running()],
      ['your weight is above the pool’s total: the two reads disagree', () => wallet(two(), basis(100n, 20n)), running({ totalWeighted: 15n })],
      ['no reward window was ever scheduled', () => wallet(two(), basis()), lpool({ totalWeighted: 100n })],
      ['the reward window has ended', () => wallet(two(), basis()), running({ periodFinish: 0n })],
      ['the pool stakes another coin', () => wallet(two(), basis()), running({ mint: OTHER_MINT })],
      ['there is no open lock', () => wallet([], basis(100n, 0n)), running()],
    ] as const)('no figure, never a zero, when %s', (_, w, p) => {
      expect(ladderEarning(bayla, p, w() as LadderWalletView, 0)).toBeNull();
    });

    it('a read that may predate the wallet’s own write states no figure, and asks to be read again', () => {
      expect(ladderEarning(bayla, running(), wallet(two(), basis()), 0, true)).toBeNull();
      const p = planLadder(bayla, running(), wallet(two(), basis()), 1_000n, 0, true);
      expect(p.earning).toBeUndefined();
      expect(p.settling).toBe(true);
      // The claims themselves are still offered: a claim is test-run before it is put to the wallet.
      expect(p.claims).toHaveLength(1);
    });
  });
});

// One approval per claim (Phantom, ticket #467471, 2026-11-16). Until 11-17 Claim all put
// several claims on ONE wallet prompt (signAllTransactions); a request carrying two or more
// transactions is one Phantom may block outright. Each claim is now the pool card's own
// claim (claimRewards: tested before the wallet, signed only, sent by us).
describe('planStreamflow: each claim is the pool card’s own, on its own approval', () => {
  it('is the SDK’s claim for that stake and reward pool, sent by the connected wallet', async () => {
    built.claim.mockResolvedValue({ ok: true, txId: 'SIG' });
    const r = rp({ nonce: 2 });
    const pl = pool([r]);
    const c = planStreamflow(target, pl, [entry({ 2: 9n }, { nonce: 4 })]).claims[0]!;
    const signer = { publicKey: Keypair.generate().publicKey } as never;
    expect(await c.send(signer)).toEqual({ kind: 'claimed', tx: 'SIG' });
    expect(built.claim).toHaveBeenCalledTimes(1);
    expect(built.claim).toHaveBeenCalledWith({ invoker: signer, pool: pl, rewardPool: r, entryNonce: 4 });
    expect('build' in c).toBe(false);
  });

  it('a claim its test run refused, or the wallet cancelled, is said as the card says it', async () => {
    const c = planStreamflow(target, pool([rp()]), [entry({ 0: 9n })]).claims[0]!;
    const signer = { publicKey: Keypair.generate().publicKey } as never;
    built.claim.mockResolvedValue({ ok: false, reason: 'This position has passed a hard limit inside the reward program, so it can no longer pay out.', permanent: true });
    expect(await c.send(signer)).toEqual({ kind: 'unconfirmed', reason: 'This position has passed a hard limit inside the reward program, so it can no longer pay out.' });
    built.claim.mockResolvedValue({ ok: false, reason: DECLINED_IN_WALLET });
    expect(await c.send(signer)).toEqual({ kind: 'declined' });
  });
});

// Owner, 2026-11-24: "you just have to claim once and confirm once". Every sure Solana claim
// of a run goes in ONE transaction, one approval; one that may not pay goes alone after.
describe('solanaTogether: the sure claims in one transaction', () => {
  const OWNER = Keypair.generate().publicKey;
  const signer = { publicKey: OWNER } as never;
  const key32 = (a: number, b: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? a : i === 1 ? b : 9)));
  const ix = (seed: number, keys = 3) => new TransactionInstruction({
    programId: key32(seed, 200),
    keys: [...Array(keys).keys()].map((k) => ({ pubkey: key32(seed, k + 1), isSigner: false, isWritable: true })),
    data: Buffer.from([seed]),
  });
  const claim = (key: string, ixs: TransactionInstruction[] | null, caution: string | null = null): SolanaClaim => ({
    key, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'pool', detail: null, amountRaw: 1n, decimals: 6, caution,
    send: vi.fn(),
    instructions: async () => ixs,
  });
  const settled = () => {
    const got: Record<string, unknown> = {};
    return { got, settle: (k: string, r: unknown) => { got[k] = r; } };
  };
  const sent = (signature = 'ONE') => ({ kind: 'sent', signature, outcome: 'confirmed', slot: 5, version: 1 });

  it('one send for every sure claim, the same instructions each would send, and every one shares its answer', async () => {
    built.sendOneWrite.mockResolvedValue(sent());
    const { got, settle } = settled();
    const how = await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', [ix(2), ix(3)])], settle);
    expect(how).toBe('done');
    expect(built.sendOneWrite).toHaveBeenCalledTimes(1);
    const [, wallet, owner, ixs] = built.sendOneWrite.mock.calls[0]!;
    expect(wallet).toBe(signer);
    expect(owner).toBe(OWNER);
    expect(ixs).toEqual([ix(1), ix(2), ix(3)]);
    expect(got).toEqual({ a: { kind: 'claimed', tx: 'ONE' }, b: { kind: 'claimed', tx: 'ONE' } });
  });

  it('a claim that may not pay, or one with nothing to pack, is handed back to go alone', async () => {
    built.sendOneWrite.mockResolvedValue(sent());
    const { got, settle } = settled();
    const risky = claim('r', [ix(4)], 'may not pay');
    const lp: SolanaClaim = { ...claim('lp', null), instructions: undefined };
    const how = await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', [ix(2)]), risky, lp], settle);
    expect(how).toEqual({ alone: [risky, lp] });
    expect(built.sendOneWrite.mock.calls[0]![3]).toEqual([ix(1), ix(2)]);
    expect(Object.keys(got)).toEqual(['a', 'b']);
  });

  it('two equal token-account creates go once; any other repeat is kept', async () => {
    built.sendOneWrite.mockResolvedValue(sent());
    const plan = planLadder(bayla, ladderPool(), ladderWallet([lpos(0, 5n), lpos(1, 5n)]), 1_000n, 0);
    const ladderIxs = (await plan.claims[0]!.instructions!(OWNER))!;
    expect(ladderIxs).toHaveLength(3);
    await solanaTogether(signer)([plan.claims[0]!, claim('again', [...ladderIxs])], settled().settle);
    const ixs = built.sendOneWrite.mock.calls[0]![3] as TransactionInstruction[];
    // [create, claim0, claim1] then [create, claim0, claim1]: the second create dropped, nothing else.
    expect(ixs).toEqual([...ladderIxs, ladderIxs[1], ladderIxs[2]]);
  });

  it('fewer than two to pack, or instructions that could not be built: each goes alone, nothing sent', async () => {
    const { got, settle } = settled();
    expect(await solanaTogether(signer)([claim('a', [ix(1)]), claim('r', [ix(2)], 'may not pay')], settle)).toBe('one-by-one');
    expect(await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', null)], settle)).toBe('one-by-one');
    expect(await solanaTogether({ publicKey: null } as never)([claim('a', [ix(1)]), claim('b', [ix(2)])], settle)).toBe('one-by-one');
    expect(built.sendOneWrite).not.toHaveBeenCalled();
    expect(got).toEqual({});
  });

  it('too large once the wallet adds its guards: each goes alone, nothing sent', async () => {
    const many = [...Array(12).keys()].map((n) => claim(`c${n}`, [ix(n + 1, 4)]));
    expect(await solanaTogether(signer)(many, settled().settle)).toBe('one-by-one');
    expect(built.sendOneWrite).not.toHaveBeenCalled();
    // A wallet that signs version 1 has room for them (4,096 bytes).
    built.v1.mockReturnValue(() => Promise.resolve(new Uint8Array()));
    built.sendOneWrite.mockResolvedValue(sent());
    expect(await solanaTogether(signer)(many, settled().settle)).toBe('done');
  });

  it('a pack that fits Solana but not the wallet’s guards beside it is sent alone, claim by claim', async () => {
    const size = (n: number) => new VersionedTransaction(new TransactionMessage({
      payerKey: OWNER, recentBlockhash: PublicKey.default.toBase58(), instructions: [...Array(n).keys()].map((k) => ix(k + 1, 1)),
    }).compileToV0Message()).serialize().length;
    let n = 2;
    while (size(n + 1) + WALLET_GUARD_ROOM_BYTES <= 1_232) n++;
    // n claims leave the guards room; n + 1 still fit Solana's 1,232, but not with the guards.
    expect(size(n + 1)).toBeLessThanOrEqual(1_232);
    built.sendOneWrite.mockResolvedValue(sent());
    const pack = (k: number) => [...Array(k).keys()].map((i) => claim(`c${i}`, [ix(i + 1, 1)]));
    expect(await solanaTogether(signer)(pack(n), settled().settle)).toBe('done');
    expect(await solanaTogether(signer)(pack(n + 1), settled().settle)).toBe('one-by-one');
    expect(built.sendOneWrite).toHaveBeenCalledTimes(1);
  });

  it('what says the pack itself will not do sends each alone instead; a cancel is a cancel', async () => {
    const two = () => [claim('a', [ix(1)]), claim('b', [ix(2)])];
    for (const [stage, reason] of [['test', 'refused'], ['check', WRITE_COPY.tooLarge], ['sol', 'short'], ['network', 'refused']] as const) {
      built.sendOneWrite.mockResolvedValueOnce({ kind: 'not-sent', stage, reason });
      const { got, settle } = settled();
      expect(await solanaTogether(signer)(two(), settle)).toBe('one-by-one');
      expect(got).toEqual({});
    }
    // The wallet would not sign it (Phantom's "Unexpected error"): each alone, as before.
    built.sendOneWrite.mockResolvedValueOnce({ kind: 'not-sent', stage: 'wallet', reason: 'not signed', declined: false });
    expect(await solanaTogether(signer)(two(), settled().settle)).toBe('one-by-one');
    built.sendOneWrite.mockResolvedValueOnce({ kind: 'not-sent', stage: 'wallet', reason: 'cancelled', declined: true });
    const { got, settle } = settled();
    expect(await solanaTogether(signer)([...two(), claim('r', [ix(3)], 'x')], settle)).toEqual({ alone: [expect.objectContaining({ key: 'r' })] });
    expect(got).toEqual({ a: { kind: 'declined' }, b: { kind: 'declined' } });
  });

  // A passing blip must not turn into one approval per claim: it says so, and Check again packs again.
  it('a network that could not be reached, or a test run that could not finish: nothing sent, said for them all', async () => {
    for (const reason of [WRITE_COPY.unreachable, WRITE_COPY.noAnswer, WRITE_COPY.balanceUnread]) {
      built.sendOneWrite.mockResolvedValueOnce({ kind: 'not-sent', stage: 'check', reason });
      const { got, settle } = settled();
      expect(await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', [ix(2)]), claim('r', [ix(3)], 'x')], settle)).toEqual({ alone: [expect.objectContaining({ key: 'r' })] });
      expect(got).toEqual({ a: { kind: 'unconfirmed', reason }, b: { kind: 'unconfirmed', reason } });
    }
  });

  it('sent: one that reverted, or one whose outcome is unknown, says so with its signature', async () => {
    built.sendOneWrite.mockResolvedValueOnce({ ...sent('R'), outcome: 'reverted' });
    let s = settled();
    await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', [ix(2)])], s.settle);
    expect(s.got.a).toMatchObject({ kind: 'reverted', tx: 'R' });
    built.sendOneWrite.mockResolvedValueOnce({ ...sent('U'), outcome: 'timeout' });
    s = settled();
    await solanaTogether(signer)([claim('a', [ix(1)]), claim('b', [ix(2)])], s.settle);
    expect(s.got.b).toMatchObject({ kind: 'unconfirmed', tx: 'U' });
  });

  it('the plans pack only what carries no caution', async () => {
    built.claimIxs.mockResolvedValue({ ok: true, ixs: [ix(9)] });
    const sf = planStreamflow(target, pool([rp({ rateChangedAtTs: 5_000 })]), [entry({ 0: 7n }, { createdTs: 1_000 }), entry({ 0: 7n }, { nonce: 1, createdTs: 9_000 })]);
    const sure = sf.claims.find((c) => c.caution === null)!;
    const risky = sf.claims.find((c) => c.caution !== null)!;
    expect(risky.instructions).toBeUndefined();
    expect(await sure.instructions!(OWNER)).toEqual([ix(9)]);
    expect(built.claimIxs).toHaveBeenCalledWith(expect.objectContaining({ claimant: OWNER, entryNonce: 1 }));
    built.claimIxs.mockResolvedValue({ ok: false, reason: 'no' });
    expect(await sure.instructions!(OWNER)).toBeNull();
    // A short ladder vault is a caution too: that claim goes alone.
    expect(planLadder(bayla, ladderPool(), ladderWallet([lpos(0, 5n), lpos(1, 5n)]), 6n, 0).claims[0]!.instructions).toBeUndefined();
    expect(planLadder(bayla, ladderPool(), ladderWallet([lpos(0, 5n), lpos(1, 5n)]), 1_000n, 0).claims[0]!.instructions).toBeDefined();
  });
});
