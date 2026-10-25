// Harvest on Solana: what the wallet's stakes and locks come to, gated the way each pool
// card gates its own Claim button (LighthousePoolLive, SolanaLadderPoolLive).
import { describe, it, expect } from 'vitest';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import type { PoolView, RewardPoolView, StakeEntryView } from '../bungalowStaking';
import type { LadderPoolView, LadderPositionView } from '../ladder/program';
import type { LadderWalletView } from '../ladder/read';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { ladderResult, planLadder, planStreamflow, streamflowResult } from './solana';

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
    expect(p.held[0]).toMatchObject({ amountRaw: 11n });
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
    expect(p.claims[0]!.caution).toMatch(/may not pay/);
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
});
