// @vitest-environment node
// Harvest on Solana: what the wallet's stakes and locks come to, gated the way each pool
// card gates its own Claim button (LighthousePoolLive, SolanaLadderPoolLive), and several
// claims on one wallet prompt, each its own transaction.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@scure/base';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import { claimRefusal, type PoolView, type RewardPoolView, type StakeEntryView } from '../bungalowStaking';
import type { LadderPoolView, LadderPositionView } from '../ladder/program';
import type { LadderWalletView } from '../ladder/read';
import { ladderClaimCarriedIxs, ladderClaimIxs, refusalReason } from '../ladder/write';
import { reloadHeld } from '../reloadHold';
import { DECLINED_IN_WALLET } from '../solana/swap/walletCopy';
import { notSignedCopy } from '../solana/walletThrow';
import type { ClaimResult } from './types';
import { ladderResult, planLadder, planStreamflow, sendClaimsTogether, signsAll, streamflowResult, type SolanaClaim, type SignsAll } from './solana';

const LADDER_PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const built = vi.hoisted(() => ({ claim: vi.fn() }));
// The SDK's prepare path is the network's; here it answers what the case says.
vi.mock('../bungalowStaking', async (orig) => ({ ...(await orig<typeof import('../bungalowStaking')>()), claimRewardsInstructions: built.claim }));
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

  it('each claim builds the instructions its door sends, and reads a refusal as that door does', async () => {
    const accounts = { tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', stakeVault: Keypair.generate().publicKey.toBase58(), rewardVault: Keypair.generate().publicKey.toBase58() };
    const lp = lpool(accounts);
    const p = planLadder(bayla, lp, wallet([pos(3, 5n)], {}, 2n), 1_000n, 0);
    const owner = Keypair.generate().publicKey;
    const at = { programId: LADDER_PROGRAM, pool: new PublicKey(LADDER), poolAccounts: lp };
    expect(await p.claims[0]!.build(owner)).toEqual(ladderClaimIxs(at, owner, { positionNonce: 3 }));
    expect(await p.claims[1]!.build(owner)).toEqual(ladderClaimCarriedIxs(at, owner));
    expect(p.claims.every((c) => c.refused === refusalReason)).toBe(true);
  });
});

describe('planStreamflow: a claim built for the one prompt', () => {
  beforeEach(() => built.claim.mockReset());

  it('is the SDK’s own claim for that stake and reward pool, and reads a refusal as claimRewards does', async () => {
    const ixs = [{ ix: 1 }];
    built.claim.mockResolvedValue({ ok: true, ixs });
    const r = rp({ nonce: 2 });
    const pl = pool([r]);
    const c = planStreamflow(target, pl, [entry({ 2: 9n }, { nonce: 4 })]).claims[0]!;
    const owner = Keypair.generate().publicKey;
    expect(await c.build(owner)).toBe(ixs);
    expect(built.claim).toHaveBeenCalledWith({ claimant: owner, pool: pl, rewardPool: r, entryNonce: 4 });
    expect(c.refused).toBe(claimRefusal);
  });

  it('a build the SDK could not make throws its reason, so the claim is not sent', async () => {
    built.claim.mockResolvedValue({ ok: false, reason: 'The claim did not go through. Your rewards are untouched. (rpc down)' });
    const c = planStreamflow(target, pool([rp()]), [entry({ 0: 9n })]).claims[0]!;
    await expect(c.build(Keypair.generate().publicKey)).rejects.toThrow('(rpc down)');
  });
});

describe('sendClaimsTogether: several claims, ONE wallet prompt, one transaction each', () => {
  const owner = Keypair.generate();
  const PROGRAM = Keypair.generate().publicKey;
  const FRESH = Keypair.generate().publicKey.toBase58();

  // A claim whose one instruction carries `n`, so each transaction is known by it.
  const claimOf = (n: number, over: Partial<SolanaClaim> = {}): SolanaClaim => ({
    key: `c${n}`, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lighthouse pool', detail: null, amountRaw: 1n, decimals: 6, caution: null,
    send: vi.fn(async (): Promise<ClaimResult> => ({ kind: 'claimed', tx: 'ALONE' })),
    build: async (o) => [new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: o, isSigner: true, isWritable: true }], data: Buffer.from([n]) })],
    refused: (logs) => `refused: ${logs.join(' | ')}`,
    ...over,
  });
  const tagOf = (tx: VersionedTransaction) => tx.message.compiledInstructions[0]!.data[0]!;
  const sigOf = (tx: VersionedTransaction) => base58.encode(tx.signatures[0]!);

  /** Our RPC: a test run, a blockhash, a send and a status, each as the case says. */
  function rpc(o: { refuse?: number[]; testRunDown?: boolean; noBlockhash?: boolean; ending?: Record<number, 'reverted' | 'pending'> } = {}) {
    const ran: number[] = [];
    const sent = new Map<string, number>();
    const conn = {
      simulateTransaction: vi.fn(async (tx: VersionedTransaction, _config?: object) => {
        ran.push(tagOf(tx));
        if (o.testRunDown) throw new Error('429 Too Many Requests');
        const no = o.refuse?.includes(tagOf(tx));
        return { context: { slot: 1 }, value: { err: no ? { InstructionError: [0, { Custom: 6012 }] } : null, logs: no ? [`log ${tagOf(tx)}`] : [] } };
      }),
      getLatestBlockhash: vi.fn(async () => {
        if (o.noBlockhash) throw new Error('fetch failed');
        return { blockhash: FRESH, lastValidBlockHeight: 9 };
      }),
      sendRawTransaction: vi.fn(async (raw: Uint8Array, _options?: object) => {
        const tx = VersionedTransaction.deserialize(raw);
        sent.set(sigOf(tx), tagOf(tx));
        return sigOf(tx);
      }),
      getSignatureStatuses: vi.fn(async ([sig]: string[]) => {
        const end = o.ending?.[sent.get(sig!)!];
        if (end === 'pending') return { context: { slot: 1 }, value: [null] };
        return { context: { slot: 1 }, value: [{ slot: 5, confirmations: 1, err: end === 'reverted' ? { InstructionError: [0, { Custom: 1 }] } : null, confirmationStatus: 'confirmed' }] };
      }),
    };
    return { conn, ran, sent };
  }

  const signs = async (txs: VersionedTransaction[]) => {
    for (const t of txs) t.sign([owner]);
    return txs;
  };
  function walletOf(sign: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]> = signs) {
    const prompts: VersionedTransaction[][] = [];
    const held: boolean[] = [];
    const w: SignsAll = {
      publicKey: owner.publicKey,
      signAllTransactions: async (txs) => {
        prompts.push([...txs]);
        held.push(reloadHeld());
        return sign(txs);
      },
    };
    return { w, prompts, held };
  }

  async function run(claims: SolanaClaim[], w: SignsAll, conn: ReturnType<typeof rpc>['conn'], confirmMs = 5_000) {
    const got = new Map<string, ClaimResult>();
    await sendClaimsTogether(claims, w, (k, r) => got.set(k, r), conn as never, confirmMs);
    return got;
  }

  it('three claims: one prompt, three transactions on one fresh blockhash, each test-run first, each sent and claimed on its own', async () => {
    const r = rpc();
    const wallet = walletOf();
    const claims = [claimOf(1), claimOf(2), claimOf(3)];
    const got = await run(claims, wallet.w, r.conn);
    expect(wallet.prompts).toHaveLength(1);
    expect(wallet.prompts[0]!.map(tagOf)).toEqual([1, 2, 3]);
    for (const tx of wallet.prompts[0]!) {
      expect(tx.message.recentBlockhash).toBe(FRESH);
      expect(tx.message.staticAccountKeys[0]!.equals(owner.publicKey)).toBe(true);
    }
    expect(r.ran).toEqual([1, 2, 3]);
    expect(r.conn.simulateTransaction.mock.calls[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
    // The first send runs the network's own check.
    expect(r.conn.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false });
    expect([...r.sent.values()].sort()).toEqual([1, 2, 3]);
    for (const tx of wallet.prompts[0]!) expect(got.get(`c${tagOf(tx)}`)).toEqual({ kind: 'claimed', tx: sigOf(tx) });
    for (const c of claims) expect(c.send).not.toHaveBeenCalled();
  });

  it('a claim its test run refuses is said in its pool’s words and never put to the wallet; the rest go', async () => {
    const r = rpc({ refuse: [2] });
    const wallet = walletOf();
    const got = await run([claimOf(1), claimOf(2), claimOf(3)], wallet.w, r.conn);
    expect(wallet.prompts[0]!.map(tagOf)).toEqual([1, 3]);
    expect(got.get('c2')).toEqual({ kind: 'unconfirmed', reason: 'refused: log 2' });
    expect(got.get('c1')).toMatchObject({ kind: 'claimed' });
    expect(got.get('c3')).toMatchObject({ kind: 'claimed' });
    expect([...r.sent.values()].sort()).toEqual([1, 3]);
  });

  it('a claim that cannot be built is not sent, and takes no other with it', async () => {
    const r = rpc();
    const wallet = walletOf();
    const broken = claimOf(2, { build: async () => { throw new Error('rpc down'); } });
    const got = await run([claimOf(1), broken], wallet.w, r.conn);
    expect(got.get('c2')).toMatchObject({ kind: 'unconfirmed', reason: expect.stringMatching(/could not be built just now \(rpc down\), so nothing was sent/) });
    expect(wallet.prompts[0]!.map(tagOf)).toEqual([1]);
    expect(got.get('c1')).toMatchObject({ kind: 'claimed' });
  });

  it('a test run that did not answer is no verdict: the claim still goes, and its first send is checked by the network', async () => {
    const r = rpc({ testRunDown: true });
    const wallet = walletOf();
    const got = await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(wallet.prompts[0]!.map(tagOf)).toEqual([1, 2]);
    expect(got.get('c1')).toMatchObject({ kind: 'claimed' });
    expect(r.conn.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false });
  });

  it('every claim refused, or no fresh blockhash: the wallet is never asked', async () => {
    const r = rpc({ refuse: [1, 2] });
    const wallet = walletOf();
    await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(wallet.prompts).toHaveLength(0);

    const down = rpc({ noBlockhash: true });
    const got = await run([claimOf(1), claimOf(2)], wallet.w, down.conn);
    expect(wallet.prompts).toHaveLength(0);
    expect(got.get('c1')).toEqual({ kind: 'unconfirmed', reason: 'The Solana network could not be reached just now, so nothing was sent.' });
    expect(down.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a cancel in the wallet: every claim cancelled, nothing sent', async () => {
    const r = rpc();
    const wallet = walletOf(async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    const got = await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(got.get('c1')).toEqual({ kind: 'declined' });
    expect(got.get('c2')).toEqual({ kind: 'declined' });
    expect(r.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a wallet that would not sign: its reason, nothing sent, never a stop or a "failed"', async () => {
    const r = rpc();
    const wallet = walletOf(async () => {
      throw new Error('Wallet is locked');
    });
    const got = await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(got.get('c1')).toEqual({ kind: 'unconfirmed', reason: notSignedCopy('Wallet is locked') });
    expect(r.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a transaction the wallet returned unsigned, or did not return, is not sent; the signed one is', async () => {
    const r = rpc();
    const wallet = walletOf(async (txs) => {
      txs[1]!.sign([owner]);
      return [txs[0]!, txs[1]!];
    });
    const got = await run([claimOf(1), claimOf(2), claimOf(3)], wallet.w, r.conn);
    expect(got.get('c1')).toEqual({ kind: 'unconfirmed', reason: 'Your wallet did not sign it, so nothing was sent for it.' });
    expect(got.get('c3')).toEqual({ kind: 'unconfirmed', reason: 'Your wallet did not sign it, so nothing was sent for it.' });
    expect(got.get('c2')).toMatchObject({ kind: 'claimed' });
    expect([...r.sent.values()]).toEqual([2]);
  });

  it('a transaction the wallet signed for a different fee payer is not sent', async () => {
    const r = rpc();
    const other = Keypair.generate();
    const wallet = walletOf(async (txs) =>
      txs.map((t) => {
        const instructions = [new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([tagOf(t)]) })];
        const theirs = new VersionedTransaction(new TransactionMessage({ payerKey: other.publicKey, recentBlockhash: FRESH, instructions }).compileToV0Message());
        theirs.sign([other]);
        return theirs;
      }),
    );
    const got = await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(got.get('c1')).toEqual({ kind: 'unconfirmed', reason: 'Your wallet did not sign it, so nothing was sent for it.' });
    expect(r.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('reverted on chain is refused with its signature; not confirmed is unknown, carries its signature, and stops the run', async () => {
    const r = rpc({ ending: { 1: 'reverted', 2: 'pending' } });
    const wallet = walletOf();
    const got = await run([claimOf(1), claimOf(2), claimOf(3)], wallet.w, r.conn, 0);
    const [t1, t2] = wallet.prompts[0]!;
    expect(got.get('c1')).toEqual({ kind: 'reverted', reason: 'Refused on chain: nothing was claimed, and only the network fee was spent.', tx: sigOf(t1!) });
    expect(got.get('c2')).toMatchObject({ kind: 'unconfirmed', tx: sigOf(t2!), stop: true });
    expect((got.get('c2') as { reason: string }).reason).toMatch(/may still land/);
    expect(got.get('c3')).toMatchObject({ kind: 'claimed' });
  });

  it('holds the page from reloading itself from the prompt until every claim is answered, then lets go', async () => {
    const r = rpc();
    const wallet = walletOf();
    await run([claimOf(1), claimOf(2)], wallet.w, r.conn);
    expect(wallet.held).toEqual([true]);
    expect(reloadHeld()).toBe(false);
  });

  it('only a wallet that signs several at once is offered the one prompt', () => {
    expect(signsAll({ publicKey: owner.publicKey, signAllTransactions: async (t: unknown) => t })).not.toBeNull();
    expect(signsAll({ publicKey: owner.publicKey, signTransaction: async (t: unknown) => t })).toBeNull();
    expect(signsAll(null)).toBeNull();
  });
});
