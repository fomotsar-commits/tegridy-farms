// @vitest-environment node
// Harvest on Solana: what the wallet's stakes and locks come to, gated the way each pool
// card gates its own Claim button (LighthousePoolLive, SolanaLadderPoolLive), and each
// claim sent as that card sends it, on its own wallet approval.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import type { PoolView, RewardPoolView, StakeEntryView } from '../bungalowStaking';
import { aprLabel, perDayAtTodaysRate, type LadderPoolView, type LadderPositionView } from '../ladder/program';
import type { LadderWalletView } from '../ladder/read';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { ladderEarning, ladderResult, planLadder, planStreamflow, streamflowResult } from './solana';

const LADDER_PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const built = vi.hoisted(() => ({ claim: vi.fn(), ladderClaim: vi.fn(), ladderClaimCarried: vi.fn() }));
// The cards' own sends reach the network; here they answer what the case says.
vi.mock('../bungalowStaking', async (orig) => ({ ...(await orig<typeof import('../bungalowStaking')>()), claimRewards: built.claim }));
vi.mock('../ladder/write', async (orig) => ({ ...(await orig<typeof import('../ladder/write')>()), ladderClaim: built.ladderClaim, ladderClaimCarried: built.ladderClaimCarried }));
// The page's endpoint is the site-relative proxy; a node test needs a whole URL to build a connection on.
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'http://127.0.0.1:8899' }));
beforeEach(() => {
  built.claim.mockReset();
  built.ladderClaim.mockReset();
  built.ladderClaimCarried.mockReset();
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

  it('one claim per position with something earned, and one for carried rewards', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n), pos(1, 0n)], {}, 3n), 1_000n, 0);
    expect(p.claims.map((c) => [c.amountRaw, c.detail])).toEqual([[5n, 'on 2 BAYLA locked'], [3n, 'carried from a closed lock']]);
    expect(p.claims.every((c) => c.where === 'lock ladder' && c.caution === null)).toBe(true);
  });

  it('an empty reward vault holds every claim: it would pay nothing', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n)]), 0n, 0);
    expect(p.claims).toEqual([]);
    expect(p.held).toHaveLength(1);
  });

  it('a short vault still sends, and says what it pays', () => {
    const p = planLadder(bayla, lpool(), wallet([pos(0, 5n), pos(1, 5n)]), 6n, 0);
    expect(p.claims).toHaveLength(2);
    expect(p.claims[0]!.caution).toMatch(/holds/);
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

  // One approval per claim (Phantom, ticket #467471): each claim is its door's own send.
  it('each claim is its own door, sent on its own approval by the connected wallet', async () => {
    const accounts = { tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', stakeVault: Keypair.generate().publicKey.toBase58(), rewardVault: Keypair.generate().publicKey.toBase58() };
    const lp = lpool(accounts);
    const p = planLadder(bayla, lp, wallet([pos(3, 5n)], {}, 2n), 1_000n, 0);
    const signer = { publicKey: Keypair.generate().publicKey } as never;
    built.ladderClaim.mockResolvedValue({ ok: true, signature: 'S1', slot: 1 });
    built.ladderClaimCarried.mockResolvedValue({ ok: true, signature: 'S2', slot: 1 });
    expect(await p.claims[0]!.send(signer)).toEqual({ kind: 'claimed', tx: 'S1' });
    expect(await p.claims[1]!.send(signer)).toEqual({ kind: 'claimed', tx: 'S2' });
    const [ctx, args] = built.ladderClaim.mock.calls[0]!;
    expect(ctx).toMatchObject({ invoker: signer, programId: LADDER_PROGRAM, pool: new PublicKey(LADDER), poolAccounts: lp });
    expect(args).toEqual({ positionNonce: 3 });
    expect(built.ladderClaimCarried).toHaveBeenCalledTimes(1);
    expect(p.claims.every((c) => !('build' in c) && !('refused' in c))).toBe(true);
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
