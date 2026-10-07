// @vitest-environment node
//
// A position's ledger from its share account's own transactions. Every expected figure
// here was worked by hand from the rule in words (DESIGN 2.B1; economics 8.1 to 8.9),
// never from ledger.ts: the steps stand in the comments beside each number.
import { describe, it, expect } from 'vitest';
import { IX_DEPOSIT, IX_INITIALIZE, IX_SWAP_BASE_INPUT, IX_WITHDRAW } from '../cpswap/program';
import { FORECAST_WORDS } from './format';
import { isqrt } from './liquidityMath';
import type { PoolView } from './poolFinder';
import { noteResponse } from './rpcBudget';
import { parseTx, type ParsedTx, type SigEntry } from './txHistory';
import { PROGRAM, buildPool, fakeRpcWithHistory, key, txJson, viewOf, type TxIxSpec } from './testkit.fixture';
import {
  LEDGER_COPY, classifyLedgerTx, eps, figure, ledgerFigures, ledgerText, ledgerUnits, readLedger,
  type LedgerEntry, type LedgerRead, type Share,
} from './ledger';

const PROG = PROGRAM.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const k = () => key().toBase58();
/** The token T of economics 8.1 to 8.6: 6 decimals, paired with SOL on tier 1. */
const T = key();
/** A signature unique to its tag (the cache is module state). */
const sig = (tag: string) => `${tag}x`.padEnd(88, '1');
const entryOf = (signature: string, over: Partial<SigEntry> = {}): SigEntry => ({ signature, slot: 100, blockTime: 1_791_066_624, err: null, confirmationStatus: 'finalized', ...over });

/** The pool at the reserves a case names: `Rc` lamports, `Rt` token units, `S` shares. */
function poolAt(r: { Rc: bigint; Rt: bigint; S: bigint }): PoolView {
  const b = buildPool({ mint: T, configIndex: 1, quoteReserve: r.Rc, tokenReserve: r.Rt, lpSupply: r.S });
  return viewOf(b, { sol: r.Rc, tok: r.Rt });
}

function u64le(v: bigint): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...b];
}
const ixData = (disc: Uint8Array, ...args: bigint[]) => Uint8Array.from([...disc, ...args.flatMap(u64le)]);

const AT = { slot: 100, blockTime: 1_791_066_624, final: true };
const deposit = (o: { lp: bigint; token: bigint; coin: bigint; lpBefore?: bigint; blockTime?: number | null }): LedgerEntry =>
  ({ kind: 'deposit', ...AT, signature: sig(`dep${o.lp}`), blockTime: o.blockTime === undefined ? AT.blockTime : o.blockTime, lp: o.lp, token: o.token, coin: o.coin, lpBefore: o.lpBefore ?? 0n });
const withdrawal = (o: { lp: bigint; token: bigint; coin: bigint; lpBefore: bigint }): LedgerEntry =>
  ({ kind: 'withdrawal', ...AT, signature: sig(`wd${o.lp}`), lp: o.lp, token: o.token, coin: o.coin, lpBefore: o.lpBefore });
const opening = (o: { lp: bigint; token: bigint; coin: bigint }): LedgerEntry =>
  ({ kind: 'opening', ...AT, signature: sig('open'), lp: o.lp, token: o.token, coin: o.coin, lpBefore: 0n });
const plain = (kind: 'other' | 'mixed' | 'failed', blockTime: number | null = AT.blockTime): LedgerEntry => ({ kind, ...AT, blockTime, signature: sig(kind) });

/** The post-swap pool of economics 8.1: a 10-share deposit on a 10 SOL / 1,000,000 T pool, then 1 SOL swapped in. */
const AFTER_SWAP = { Rc: 11_998_400_000n, Rt: 1_009_174_311_927n, S: 110_000_000_000n };
const DEPOSIT_81 = { lp: 10_000_000_000n, token: 100_000_000_000n, coin: 1_000_000_000n };

interface Balance { account: string; mint: string; owner?: string; pre: bigint | null; post: bigint | null }

interface CpSpec {
  kind: 'deposit' | 'withdrawal' | 'opening';
  owner: string;
  lpAccount: string;
  move: { coin: bigint; token: bigint; lp: bigint; lpBefore: bigint };
  signature?: string;
  slot?: number;
  blockTime?: number;
  /** The attacker cases bend one thing each. */
  signer?: string;
  slot0?: string;
  slotPool?: string;
  slotLp?: string;
  lpArg?: bigint;
  lpDelta?: bigint;
  disc?: Uint8Array;
  lpMint?: string;
  noBalances?: boolean;
  err?: unknown;
  inner?: TxIxSpec[];
  extraBalances?: Balance[];
}

/**
 * One cp-swap step on `view`'s pool with the balances it leaves, as the node reports
 * them: the share account, both vaults and the owner's token account move; the owner's
 * wrapped-SOL account is on neither side (opened and closed inside the transaction).
 */
function cpRaw(view: PoolView, o: CpSpec): unknown {
  const p = view.snapshot.pool;
  const coinIs0 = view.quoteIsToken0;
  const signed = (side: 'coin' | 'token') => (o.kind === 'withdrawal' ? -o.move[side] : o.move[side]);
  const d0 = coinIs0 ? signed('coin') : signed('token');
  const d1 = coinIs0 ? signed('token') : signed('coin');
  const signer = o.signer ?? o.owner;
  const [auth, ownerT0, ownerT1, feeAcc] = [k(), k(), k(), k()];
  const lpMint = o.lpMint ?? p.lpMint;
  const pool = view.address;
  const accounts = o.kind === 'opening'
    ? [o.slot0 ?? o.owner, p.ammConfig, auth, o.slotPool ?? pool, p.token0Mint, p.token1Mint, lpMint, ownerT0, ownerT1, o.slotLp ?? o.lpAccount, p.token0Vault, p.token1Vault, feeAcc, p.observationKey, TOKEN, TOKEN, TOKEN_2022, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111']
    : [o.slot0 ?? o.owner, auth, o.slotPool ?? pool, o.slotLp ?? o.lpAccount, ownerT0, ownerT1, p.token0Vault, p.token1Vault, TOKEN, TOKEN_2022, p.token0Mint, p.token1Mint, lpMint];
  const disc = o.disc ?? (o.kind === 'deposit' ? IX_DEPOSIT : o.kind === 'withdrawal' ? IX_WITHDRAW : IX_INITIALIZE);
  const args = o.kind === 'opening' ? [o.move.coin, o.move.token, 0n] : [o.lpArg ?? o.move.lp, 1n << 62n, 1n << 62n];
  const lpDelta = o.lpDelta ?? (o.kind === 'withdrawal' ? -o.move.lp : o.move.lp);
  const innerIxs = o.inner ?? [];
  const extra = o.extraBalances ?? [];
  const keys = [...new Set([signer, ...accounts, o.owner, o.lpAccount, pool, PROG, ...innerIxs.flatMap((ix) => [ix.program, ...ix.accounts]), ...extra.map((b) => b.account)])];
  const opened = o.kind === 'opening';
  const [base0, base1] = [7_000_000_000_000n, 9_000_000_000_000n];
  const balances: Balance[] = o.noBalances ? [] : [
    { account: o.lpAccount, mint: lpMint, owner: o.owner, pre: o.move.lpBefore === 0n ? null : o.move.lpBefore, post: o.move.lpBefore + lpDelta },
    { account: p.token0Vault, mint: p.token0Mint, owner: auth, pre: opened ? null : base0, post: (opened ? 0n : base0) + d0 },
    { account: p.token1Vault, mint: p.token1Mint, owner: auth, pre: opened ? null : base1, post: (opened ? 0n : base1) + d1 },
    { account: coinIs0 ? ownerT1 : ownerT0, mint: coinIs0 ? p.token1Mint : p.token0Mint, owner: o.owner, pre: 5_000_000_000_000n, post: 5_000_000_000_000n - (coinIs0 ? d1 : d0) },
    ...extra,
  ];
  return txJson({
    keys,
    instructions: [{ program: PROG, accounts, data: ixData(disc, ...args) }],
    inner: innerIxs.length ? [{ index: 0, instructions: innerIxs }] : undefined,
    balances,
    err: o.err,
    slot: o.slot ?? 100,
    blockTime: o.blockTime ?? 1_791_066_624,
  });
}
const cpTx = (view: PoolView, o: CpSpec): ParsedTx => parseTx(o.signature ?? sig('tx'), cpRaw(view, o));

const shareOf = (owner: string, lpAccount: string, view: PoolView, lpAmount: bigint): Share => ({ owner, lpAccount, lpMint: view.snapshot.pool.lpMint, lpAmount });

const okRead = (r: LedgerRead) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r;
};

describe('ledgerFigures: the figures, worked by hand', () => {
  // Economics 8.1. After the swap: Rt = 1,009,174,311,927, Rc = 11,998,400,000, S = 110e9.
  // Worth of 10e9 shares (floors): b_t = floor(10e9 * Rt / S) = 91,743,119,266; b_c = floor(10e9 * Rc / S) = 1,090,763,636.
  // val(t, c) = c + floor(t * Rc / Rt): V_pos = 1,090,763,636 + 1,090,763,636 = 2,181,527,272.
  // V_hold = 1e9 + floor(1e11 * Rc / Rt) = 1e9 + 1,188,932,363 = 2,188,932,363. N = V_pos - V_hold = -7,405,091.
  // B = isqrt(1e11 * 1e9) = 10,000,000,000. V_nf = 2 * isqrt(B * B * Rc * Rt) / Rt = 2,180,763,502.
  // G = V_pos - V_nf = 763,770. I = N - G = -8,168,861. eps = 2 * ceil(Rc / Rt) + 6 = 8.
  it('8.1: one deposit and one 1 SOL trade: growth 763,770, price effect -8,168,861, versus holding -7,405,091', () => {
    // As the chain holds it: the coin vault carries the 1,600,000 lamports of protocol fee the swap booked; the reserve does not.
    const bare = poolAt(AFTER_SWAP);
    const s = bare.snapshot;
    const view: PoolView = { ...bare, snapshot: bare.quoteIsToken0 ? { ...s, vault0Amount: s.vault0Amount + 1_600_000n } : { ...s, vault1Amount: s.vault1Amount + 1_600_000n } };
    const r = okRead(ledgerFigures([deposit(DEPOSIT_81)], view, 10_000_000_000n));
    expect(r.case).toBe('A');
    expect(r.figures.worthNow).toEqual({ token: 91_743_119_266n, coin: 1_090_763_636n });
    expect(r.figures.holdWorth).toBe(2_188_932_363n);
    expect(r.figures.nowAndOutWorth).toBe(2_181_527_272n);
    expect(r.figures.growth).toEqual({ kind: 'amount', coin: 763_770n });
    expect(r.figures.priceEffect).toEqual({ kind: 'amount', coin: -8_168_861n });
    expect(r.figures.versusHolding).toEqual({ kind: 'amount', coin: -7_405_091n });
    expect(r.figures.putIn).toEqual({ token: 100_000_000_000n, coin: 1_000_000_000n, count: 1 });
    expect(r.figures.takenOut).toBeNull();
    expect(r.figures.locked).toBeNull();
    expect(r.figures.since).toBe(1_791_066_624);
    expect(r.figures.provenShares).toBe(10_000_000_000n);
    expect(r.figures.otherShares).toBeNull();
    expect(r.window).toEqual({ count: 1, oldest: 1_791_066_624, more: false });
  });

  // Economics 8.2. A second LP deposits 3,333,333,333 shares at ratio (33,333,333,330 T, 333,333,334 lamports),
  // no swap: Rt = 1,133,333,333,330, Rc = 11,333,333,334, S = 113,333,333,333. Our 10e9 shares:
  // b_t = floor(10e9 * Rt / S) = 100,000,000,000 exactly, b_c = 1,000,000,000 exactly, so
  // V_pos = V_hold = 1e9 + floor(1e11 * Rc / Rt) = 2,000,000,000 and V_nf = 2 * isqrt(1e20 * Rc * Rt) / Rt = 2,000,000,000.
  it('8.2: zero trades: all three lines are none yet, exactly', () => {
    const view = poolAt({ Rc: 11_333_333_334n, Rt: 1_133_333_333_330n, S: 113_333_333_333n });
    const r = okRead(ledgerFigures([deposit(DEPOSIT_81)], view, 10_000_000_000n));
    expect(r.figures.worthNow).toEqual({ token: 100_000_000_000n, coin: 1_000_000_000n });
    expect(r.figures.holdWorth).toBe(2_000_000_000n);
    expect(r.figures.nowAndOutWorth).toBe(2_000_000_000n);
    expect([r.figures.growth, r.figures.priceEffect, r.figures.versusHolding]).toEqual([{ kind: 'none-yet' }, { kind: 'none-yet' }, { kind: 'none-yet' }]);
  });

  // Economics 8.3, auditor F3: eps = 2 * ceil(Rc / Rt) + 6; on 8.1's reserves ceil(11,998,400,000 / 1,009,174,311,927) = 1, eps = 8.
  it('8.3: the rounding bound is 8 on those reserves; 7 reads none yet, 9 prints, on both sides of zero', () => {
    expect(eps(poolAt(AFTER_SWAP))).toBe(8n);
    expect(figure(7n, 8n)).toEqual({ kind: 'none-yet' });
    expect(figure(-8n, 8n)).toEqual({ kind: 'none-yet' });
    expect(figure(0n, 8n)).toEqual({ kind: 'none-yet' });
    expect(figure(9n, 8n)).toEqual({ kind: 'amount', coin: 9n });
    expect(figure(-9n, 8n)).toEqual({ kind: 'amount', coin: -9n });
    // A USDC pool of 2 USDC to 1 T: ceil(2,000,000 / 1,000,000) = 2, eps = 10.
    expect(eps(poolAt({ Rc: 2_000_000n, Rt: 1_000_000n, S: 1_000_000n }))).toBe(10n);
  });

  // Economics 8.5. Opening with t_0 = 5e9 (5,000 T), c_0 = 1e9: liquidity isqrt(5e18) = 2,236,067,977, the
  // opener's shares L_0 = 2,236,067,877, S = 2,236,067,977, Rt = 5e9, Rc = 1e9. No trade.
  // b_t = floor(L_0 * Rt / S) = 4,999,999,776, b_c = 999,999,955; V_pos = 999,999,955 + floor(4,999,999,776 / 5) = 1,999,999,910.
  // V_hold = 1e9 + 1e9 = 2,000,000,000; N = -90. B = L_0 (the locked 100 are paid for, not held):
  // V_nf = 2 * isqrt(L_0^2 * Rc * Rt) / Rt = 1,999,999,910, G = 0. V_lock = 2 * isqrt(100^2 * Rc * Rt) / Rt = 89.
  // I = N - G + V_lock = -1. So N = G + I - V_lock holds exactly: -90 = 0 - 1 - 89.
  it('8.5: the opener: basis is the shares minted, growth none yet, the lock is worth 89, and N = G + I - V_lock', () => {
    const L0 = 2_236_067_877n;
    expect(isqrt(5_000_000_000n * 1_000_000_000n) - 100n).toBe(L0);
    const view = poolAt({ Rc: 1_000_000_000n, Rt: 5_000_000_000n, S: 2_236_067_977n });
    const r = okRead(ledgerFigures([opening({ lp: L0, token: 5_000_000_000n, coin: 1_000_000_000n })], view, L0));
    expect(r.figures.growth).toEqual({ kind: 'none-yet' });
    expect(r.figures.priceEffect).toEqual({ kind: 'none-yet' });
    expect(r.figures.locked).toBe(89n);
    expect(r.figures.versusHolding).toEqual({ kind: 'amount', coin: -90n });
    // The identity with G and I both under the bound: |N + V_lock| is within rounding.
    expect(-90n + 89n).toBe(-1n);
    expect(r.figures.putIn).toEqual({ token: 5_000_000_000n, coin: 1_000_000_000n, count: 0 });
  });

  // Economics 8.6. From 8.1's post-swap state, withdraw 5e9 shares: payout t' = floor(5e9 * Rt / S) = 45,871,559,633,
  // c' = floor(5e9 * Rc / S) = 545,381,818. Reserves after: Rt = 963,302,752,294, Rc = 11,453,018,182, S = 105e9.
  // Basis split: held 10e9 with B = 10e9, removed floor(B * 5e9 / 10e9) = 5e9; f = isqrt(t' * c') - 5e9 = 1,751,152; B = 5e9.
  // Remaining 5e9 shares: b_t = 45,871,559,633, b_c = 545,381,818; V_pos = 545,381,818 + floor(b_t * Rc / Rt) = 1,090,763,636.
  // V_out = val(t', c') = 1,090,763,636. V_hold = 1e9 + floor(1e11 * Rc / Rt) = 2,188,932,363. N = -7,405,091 (the withdrawal was at ratio).
  // V_nf = 2 * isqrt(B^2 * Rc * Rt) / Rt = 1,090,381,751, so V_pos - V_nf = 381,885; G_r = 2 * isqrt(f^2 * Rc * Rt) / Rt = 381,884.
  // G = 763,769 (one unit under 8.1's, from the floor in the basis split). I = N - G = -8,168,860.
  it('8.6: a 50% withdrawal: realised 381,884 plus unrealised 381,885 = 763,769; versus holding unchanged', () => {
    const view = poolAt({ Rc: 11_453_018_182n, Rt: 963_302_752_294n, S: 105_000_000_000n });
    const entries = [withdrawal({ lp: 5_000_000_000n, token: 45_871_559_633n, coin: 545_381_818n, lpBefore: 10_000_000_000n }), deposit(DEPOSIT_81)];
    const r = okRead(ledgerFigures(entries, view, 5_000_000_000n));
    expect(r.case).toBe('A');
    expect(r.figures.takenOut).toEqual({ token: 45_871_559_633n, coin: 545_381_818n, count: 1 });
    expect(r.figures.worthNow).toEqual({ token: 45_871_559_633n, coin: 545_381_818n });
    expect(r.figures.nowAndOutWorth).toBe(2_181_527_272n);
    expect(r.figures.growth).toEqual({ kind: 'amount', coin: 763_769n });
    expect(r.figures.versusHolding).toEqual({ kind: 'amount', coin: -7_405_091n });
    expect(r.figures.priceEffect).toEqual({ kind: 'amount', coin: -8_168_860n });
  });

  // Economics 8.7, auditor F6. A transfer in is `other`: the figures stand on the proven 10e9 shares (8.1's), and
  // the 1e9 that arrived another way are valued apart: floor(1e9 * Rt / S) = 9,174,311,926 T, floor(1e9 * Rc / S) = 109,076,363 lamports.
  it('8.7: a transfer in is Case B: figures on the proven shares, the rest named with its worth', () => {
    const view = poolAt(AFTER_SWAP);
    const r = okRead(ledgerFigures([plain('other'), deposit(DEPOSIT_81)], view, 11_000_000_000n));
    expect(r.case).toBe('B');
    expect(r.figures.provenShares).toBe(10_000_000_000n);
    expect(r.figures.otherShares).toEqual({ lp: 1_000_000_000n, worth: { token: 9_174_311_926n, coin: 109_076_363n } });
    expect(r.figures.growth).toEqual({ kind: 'amount', coin: 763_770n });
    expect(r.figures.worthNow).toEqual({ token: 91_743_119_266n, coin: 1_090_763_636n });
    expect(r.figures.putIn.count).toBe(1);
  });

  it('a transfer in BEFORE the first deposit, with the whole history on the page, is Case B too (the run starts at the oldest entry read)', () => {
    const view = poolAt(AFTER_SWAP);
    const r = okRead(ledgerFigures([deposit({ ...DEPOSIT_81, lpBefore: 1_000_000_000n }), plain('other')], view, 11_000_000_000n, false));
    expect(r.case).toBe('B');
    expect(r.figures.otherShares?.lp).toBe(1_000_000_000n);
    // With more history behind the page, the same two entries cannot place the run's start.
    expect(ledgerFigures([deposit({ ...DEPOSIT_81, lpBefore: 1_000_000_000n }), plain('other')], view, 11_000_000_000n, true)).toMatchObject({ kind: 'worth-only', why: 'run-start-not-read' });
  });

  it('8.8: a mixed transaction in the run leaves worth only, saying which', () => {
    const view = poolAt(AFTER_SWAP);
    const r = ledgerFigures([plain('mixed'), deposit(DEPOSIT_81)], view, 10_000_000_000n);
    expect(r).toMatchObject({ kind: 'worth-only', why: 'mixed-entry' });
    if (r.kind === 'worth-only') expect(r.entries).toHaveLength(2);
    // Older than the run's start, a mixed transaction is somebody else's history.
    expect(ledgerFigures([deposit(DEPOSIT_81), plain('mixed')], view, 10_000_000_000n).kind).toBe('ok');
  });

  it('8.9: no entry with a zero balance before it and more behind: run-start-not-read, naming the oldest read; the start inside the window: figures', () => {
    const view = poolAt(AFTER_SWAP);
    const older = ledgerFigures([deposit({ ...DEPOSIT_81, lpBefore: 5_000_000_000n, blockTime: 1_791_000_000 })], view, 15_000_000_000n, true);
    expect(older).toMatchObject({ kind: 'worth-only', why: 'run-start-not-read', window: { count: 1, oldest: 1_791_000_000, more: true } });
    const inside = ledgerFigures([deposit({ lp: 5_000_000_000n, token: 50_000_000_000n, coin: 500_000_000n, lpBefore: 5_000_000_000n }), deposit({ lp: 5_000_000_000n, token: 50_000_000_000n, coin: 500_000_000n })], view, 10_000_000_000n, true);
    expect(inside.kind).toBe('ok');
    expect(okRead(inside).figures.putIn).toEqual({ token: 100_000_000_000n, coin: 1_000_000_000n, count: 2 });
    expect(ledgerFigures([], view, 10_000_000_000n)).toMatchObject({ kind: 'worth-only', why: 'run-start-not-read' });
  });

  it('an unread entry in the run leaves worth only; one older than the run does not', () => {
    const view = poolAt(AFTER_SWAP);
    const unread: LedgerEntry = { kind: 'unread', signature: sig('unr'), blockTime: null, detail: 'the node has no record of it' };
    expect(ledgerFigures([unread, deposit(DEPOSIT_81)], view, 10_000_000_000n)).toMatchObject({ kind: 'worth-only', why: 'unread-entry' });
    expect(ledgerFigures([deposit(DEPOSIT_81), unread], view, 10_000_000_000n).kind).toBe('ok');
  });

  it('shares that left without a withdrawal, or a withdrawal while the books do not balance: worth only', () => {
    const view = poolAt(AFTER_SWAP);
    expect(ledgerFigures([deposit(DEPOSIT_81)], view, 9_000_000_000n)).toMatchObject({ kind: 'worth-only', why: 'shares-left' });
    const unbalanced = [withdrawal({ lp: 5_000_000_000n, token: 45_871_559_633n, coin: 545_381_818n, lpBefore: 12_000_000_000n }), deposit(DEPOSIT_81)];
    expect(ledgerFigures(unbalanced, view, 7_000_000_000n)).toMatchObject({ kind: 'worth-only', why: 'withdrawal-unbalanced' });
  });
});

describe('classifyLedgerTx: the entry rule', () => {
  const view = poolAt(AFTER_SWAP);
  const owner = k();
  const lpAccount = k();
  const share = shareOf(owner, lpAccount, view, 10_000_000_000n);
  const move = { ...DEPOSIT_81, lpBefore: 0n };
  const classify = (tx: ParsedTx | null, over: Partial<SigEntry> = {}) => classifyLedgerTx(entryOf(tx?.signature ?? sig('null'), over), tx, share, view, PROG);

  it('a deposit: proven by discriminator, slots, signer and the two-way share proof; amounts from the vaults, the wrapped-SOL leg on neither side', () => {
    const tx = cpTx(view, { kind: 'deposit', owner, lpAccount, move });
    expect(classify(tx)).toEqual({ kind: 'deposit', signature: tx.signature, slot: 100, blockTime: 1_791_066_624, final: true, lp: 10_000_000_000n, token: 100_000_000_000n, coin: 1_000_000_000n, lpBefore: 0n });
    expect(classify(tx, { confirmationStatus: 'confirmed' })).toMatchObject({ kind: 'deposit', final: false });
    const second = cpTx(view, { kind: 'deposit', owner, lpAccount, move: { ...move, lpBefore: 4n } });
    expect(classify(second)).toMatchObject({ kind: 'deposit', lpBefore: 4n });
  });

  it('a withdrawal: both vaults down, the amounts as magnitudes, the shares held before', () => {
    const tx = cpTx(view, { kind: 'withdrawal', owner, lpAccount, move: { lp: 5_000_000_000n, token: 45_871_559_633n, coin: 545_381_818n, lpBefore: 10_000_000_000n } });
    expect(classify(tx)).toMatchObject({ kind: 'withdrawal', lp: 5_000_000_000n, token: 45_871_559_633n, coin: 545_381_818n, lpBefore: 10_000_000_000n });
  });

  it('an opening: the shares minted are isqrt of the two vault deltas less the 100 locked', () => {
    const tx = cpTx(view, { kind: 'opening', owner, lpAccount, move: { coin: 1_000_000_000n, token: 5_000_000_000n, lp: 2_236_067_877n, lpBefore: 0n } });
    expect(classify(tx)).toMatchObject({ kind: 'opening', lp: 2_236_067_877n, token: 5_000_000_000n, coin: 1_000_000_000n, lpBefore: 0n });
    expect(classify(cpTx(view, { kind: 'opening', owner, lpAccount, move: { coin: 1_000_000_000n, token: 5_000_000_000n, lp: 2_236_067_977n, lpBefore: 0n } })).kind).toBe('other');
  });

  it('a failed transaction is failed; no record is unread; no balance for the share account is unread', () => {
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, err: { InstructionError: [0, { Custom: 6001 }] } })).kind).toBe('failed');
    expect(classify(null)).toEqual({ kind: 'unread', signature: sig('null'), blockTime: 1_791_066_624, detail: 'the node has no record of it' });
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, noBalances: true }))).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/balance/) });
  });

  it('8.8: two cp-swap steps naming the pool are mixed, whatever the signs say', () => {
    const p = view.snapshot.pool;
    const swap = (inVault: string, outVault: string): TxIxSpec => ({ program: PROG, accounts: [owner, k(), p.ammConfig, view.address, k(), k(), inVault, outVault], data: ixData(IX_SWAP_BASE_INPUT, 1_000_000_000n, 1n) });
    const tx = cpTx(view, { kind: 'deposit', owner, lpAccount, move, inner: [swap(p.token0Vault, p.token1Vault), swap(p.token1Vault, p.token0Vault)] });
    expect(classify(tx).kind).toBe('mixed');
  });

  it('8.7: a transaction with no cp-swap step naming the pool is other, even when the share account rose', () => {
    const [from, mint] = [k(), view.snapshot.pool.lpMint];
    const raw = txJson({
      keys: [from, lpAccount, TOKEN],
      instructions: [{ program: TOKEN, accounts: [from, lpAccount, from], data: Uint8Array.from([3, ...u64le(1_000_000_000n)]) }],
      balances: [{ account: lpAccount, mint, owner, pre: 10_000_000_000n, post: 11_000_000_000n }, { account: from, mint, owner: from, pre: 1_000_000_000n, post: 0n }],
      slot: 100,
      blockTime: 1_791_066_624,
    });
    expect(classify(parseTx(sig('transfer'), raw))).toEqual({ kind: 'other', signature: sig('transfer'), slot: 100, blockTime: 1_791_066_624, final: true });
  });

  it('F5: a stranger’s deposit bundled with a transfer into this account is other: the owner slot and the signer are his', () => {
    const stranger = k();
    // His deposit, in his slots, with our account rising by one unit in the same transaction.
    const bundled = cpTx(view, { kind: 'deposit', owner: stranger, lpAccount: k(), move, extraBalances: [{ account: lpAccount, mint: view.snapshot.pool.lpMint, owner, pre: 10_000_000_000n, post: 10_000_000_001n }] });
    expect(classify(bundled).kind).toBe('other');
    // Our wallet in the owner slot and our account in the share slot, but a stranger signed: other.
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, signer: stranger })).kind).toBe('other');
  });

  it('a fee sweep moves both vaults in one cp-swap step: other, by the discriminator alone', () => {
    const sweep = Uint8Array.from([136, 136, 252, 221, 194, 29, 161, 34]);
    const tx = cpTx(view, { kind: 'withdrawal', owner, lpAccount, move: { lp: 0n, token: 1_000_000n, coin: 20_000n, lpBefore: 10_000_000_000n }, disc: sweep, lpArg: 0n, lpDelta: 0n });
    expect(classify(tx).kind).toBe('other');
  });

  it('the two-way proof: a share delta one unit off the instruction’s amount is other; so is a wrong sign, slot or mint', () => {
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, lpArg: 10_000_000_001n })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, lpDelta: 9_999_999_999n })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'withdrawal', owner, lpAccount, move: { ...move, lpBefore: 10_000_000_000n }, disc: IX_DEPOSIT, lpDelta: 10_000_000_000n })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, slotPool: k() })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, slotLp: k() })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, slot0: k() })).kind).toBe('other');
    expect(classify(cpTx(view, { kind: 'deposit', owner, lpAccount, move, lpMint: k() })).kind).toBe('other');
  });
});

describe('readLedger', () => {
  const view = poolAt(AFTER_SWAP);
  const owner = k();
  const lpAccount = k();
  const share = shareOf(owner, lpAccount, view, 10_000_000_000n);
  const budget = (remaining: string) => noteResponse(new Response(null, { headers: { 'X-RateLimit-Remaining': remaining } }));

  it('refuses to start under the budget floor, before any call', async () => {
    budget('59');
    const calls: [string, unknown[]][] = [];
    expect(await readLedger(fakeRpcWithHistory({}, { [lpAccount]: [] }, {}, { calls }), share, view, PROG, {})).toEqual({ kind: 'paused' });
    expect(calls).toEqual([]);
    budget('300');
  });

  it('one signature page and one transaction round; a finalized transaction is not read again, a confirmed one is', async () => {
    budget('300');
    const fin = cpRaw(view, { kind: 'deposit', owner, lpAccount, move: { ...DEPOSIT_81, lpBefore: 0n } });
    const conf = cpRaw(view, { kind: 'deposit', owner, lpAccount, move: { lp: 1n, token: 11n, coin: 1n, lpBefore: 10_000_000_000n }, slot: 101, blockTime: 1_791_066_700 });
    const calls: [string, unknown[]][] = [];
    const rpc = fakeRpcWithHistory({}, { [lpAccount]: [entryOf(sig('rlconf'), { slot: 101, confirmationStatus: 'confirmed' }), entryOf(sig('rlfin'))] }, { [sig('rlconf')]: conf, [sig('rlfin')]: fin }, { calls });
    const first = okRead(await readLedger(rpc, { ...share, lpAmount: 10_000_000_001n }, view, PROG, {}));
    expect(first.entries.map((e) => e.kind)).toEqual(['deposit', 'deposit']);
    expect(first.entries[0]).toMatchObject({ final: false, lp: 1n });
    expect(first.case).toBe('A');
    expect(calls.map(([m]) => m)).toEqual(['getSignaturesForAddress', 'getTransaction', 'getTransaction']);
    calls.length = 0;
    await readLedger(rpc, { ...share, lpAmount: 10_000_000_001n }, view, PROG, {});
    expect(calls.map(([m, p]) => [m, m === 'getTransaction' ? (p as [string])[0] : ''])).toEqual([['getSignaturesForAddress', ''], ['getTransaction', sig('rlconf')]]);
  });

  it('a transport failure is unread with the reason, never an empty ledger', async () => {
    budget('300');
    const rpc = fakeRpcWithHistory({}, { [lpAccount]: [] }, {}, { fail: new Set(['getSignaturesForAddress']) });
    expect(await readLedger(rpc, share, view, PROG, {})).toEqual({ kind: 'unread', detail: 'getSignaturesForAddress: HTTP 502' });
  });
});

describe('ledgerText: the sentences, verbatim', () => {
  const view = poolAt(AFTER_SWAP);
  const about = ledgerUnits(view, 'about');
  const exact = ledgerUnits(view, 'exact');
  const r81 = okRead(ledgerFigures([deposit(DEPOSIT_81)], view, 10_000_000_000n));
  const sym = about.token(0n).replace(/^0 /, '');

  it('8.1’s three lines in the pool’s coin, four decimals, signed', () => {
    expect(ledgerText.putIn(r81.figures, about)).toBe(`1 SOL and 100,000 ${sym}, in 1 deposit, since 2026-10-03 22:30 UTC`);
    expect(ledgerText.worthNow(r81.figures, about)).toBe(`1.0907 SOL and 91,743.1192 ${sym}`);
    expect(ledgerText.versusHolding(r81.figures, about)).toBe('-0.0074 SOL at this pool’s price now. Holding what you put in would be worth 2.1889 SOL; what you hold now plus what you took out is worth 2.1815 SOL.');
    expect(ledgerText.growth(r81.figures, about)).toBe('+0.0007 SOL: how much more your shares are worth than a fee-free pool would have made them, from trades and anything else sent to this pool. Fees stay in the pool; there is nothing to claim.');
    expect(ledgerText.priceEffect(r81.figures, about)).toBe('-0.0081 SOL: what the price moving since you put in did to a pool position compared with holding (what people call impermanent loss).');
    expect(ledgerText.growthNote(r81.figures, { kind: 'at', time: 1_791_066_700n })).toBeNull();
    expect(ledgerText.growthNote(r81.figures, { kind: 'none' })).toBe('No trade has reached this pool, so this growth came from tokens sent to the pool outside a trade.');
  });

  it('a line under the bound reads none yet and never a sign; above it but under 0.0001 of the coin, the direction in words', () => {
    const none = { ...r81.figures, growth: { kind: 'none-yet' as const }, versusHolding: { kind: 'none-yet' as const }, priceEffect: { kind: 'none-yet' as const } };
    expect([ledgerText.growth(none, about), ledgerText.versusHolding(none, about), ledgerText.priceEffect(none, about)]).toEqual(['none yet', 'none yet', 'none yet']);
    expect(ledgerText.growthNote(none, { kind: 'none' })).toBe('No trade has reached this pool since you entered, so there is nothing from trades yet.');
    expect(ledgerText.growthNote(none, { kind: 'at', time: 1n })).toBeNull();
    expect(about.signed(9n)).toBe('under 0.0001 SOL more');
    expect(about.signed(-9n)).toBe('under 0.0001 SOL less');
    expect(exact.signed(9n)).toBe('+0.000000009 SOL');
    expect(exact.signed(-9n)).toBe('-0.000000009 SOL');
    expect(about.signed(-7_405_091n)).toBe('-0.0074 SOL');
  });

  it('the opener’s put-in line counts the opening apart, and the lock has its own line', () => {
    const L0 = 2_236_067_877n;
    const v = poolAt({ Rc: 1_000_000_000n, Rt: 5_000_000_000n, S: 2_236_067_977n });
    const u = ledgerUnits(v, 'exact');
    const r = okRead(ledgerFigures([deposit({ lp: 1n, token: 3n, coin: 1n, lpBefore: L0 }), opening({ lp: L0, token: 5_000_000_000n, coin: 1_000_000_000n })], v, L0 + 1n));
    expect(ledgerText.putIn(r.figures, u)).toMatch(/^1\.000000001 SOL and 5,000\.000003 \S+, in 1 opening and 1 deposit, since 2026-10-03 22:30 UTC$/);
    expect(ledgerText.locked(r.figures, u)).toBe('0.000000089 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
    const alone = okRead(ledgerFigures([opening({ lp: L0, token: 5_000_000_000n, coin: 1_000_000_000n })], v, L0));
    expect(ledgerText.putIn(alone.figures, u)).toMatch(/, in 1 opening, since /);
    expect(ledgerText.locked(r81.figures, u)).toBeNull();
  });

  it('taken out, the window, Case B and each Case C sentence', () => {
    const w = okRead(ledgerFigures([withdrawal({ lp: 5_000_000_000n, token: 45_871_559_633n, coin: 545_381_818n, lpBefore: 10_000_000_000n }), deposit(DEPOSIT_81)], poolAt({ Rc: 11_453_018_182n, Rt: 963_302_752_294n, S: 105_000_000_000n }), 5_000_000_000n));
    expect(ledgerText.takenOut(w.figures, about)).toBe(`0.5453 SOL and 45,871.5596 ${sym}, in 1 withdrawal`);
    expect(ledgerText.takenOut(r81.figures, about)).toBeNull();
    expect(ledgerText.window(r81, 12)).toBe('From 1 transaction of your share account, back to 2026-10-03 22:30 UTC, read 12 s ago. Exact to a few of the smallest units, which rounding cannot tell from zero.');
    expect(ledgerText.window({ ...r81, window: { count: 20, oldest: 1_791_000_000, more: true } }, 3)).toBe('From 20 transactions of your share account, back to 2026-10-03 04:00 UTC, read 3 s ago. Exact to a few of the smallest units, which rounding cannot tell from zero. The last 20 transactions on this share account were read; older ones were not.');
    const b = okRead(ledgerFigures([plain('other'), deposit(DEPOSIT_81)], view, 11_000_000_000n));
    expect(ledgerText.otherShares(b.figures, about)).toBe(`1 share arrived another way (sent to this account, or older than the transactions read): worth 0.109 SOL and 9,174.3119 ${sym} now, not counted above.`);
    expect(ledgerText.otherShares(r81.figures, about)).toBeNull();
    type WorthOnly = Extract<LedgerRead, { kind: 'worth-only' }>;
    const worthOnly = (why: WorthOnly['why'], entries: LedgerEntry[]): WorthOnly => ({ kind: 'worth-only', why, entries, window: { count: entries.length, oldest: 1_791_000_000, more: true } });
    expect(ledgerText.worthOnly(worthOnly('shares-left', []))).toBe(LEDGER_COPY.sharesLeft);
    expect(ledgerText.worthOnly(worthOnly('withdrawal-unbalanced', []))).toBe(LEDGER_COPY.withdrawalUnbalanced);
    expect(ledgerText.worthOnly(worthOnly('run-start-not-read', [deposit(DEPOSIT_81)]))).toBe('Your history in this pool goes back further than the 1 transaction this page reads (the oldest read is from 2026-10-03 04:00 UTC), so what you put in could not be fully read.');
    expect(ledgerText.worthOnly(worthOnly('unread-entry', [{ kind: 'unread', signature: sig('u'), blockTime: 1_791_066_624, detail: 'x' }, deposit(DEPOSIT_81)]))).toBe('One of your transactions in this pool (2026-10-03 22:30 UTC) could not be read.');
    expect(ledgerText.worthOnly(worthOnly('mixed-entry', [plain('mixed', 1_791_066_624), deposit(DEPOSIT_81)]))).toBe('A transaction on 2026-10-03 22:30 UTC changed this pool in more than one way at once, which this page cannot read as one deposit or withdrawal.');
    expect(ledgerText.unread('the chain did not answer in 20 seconds')).toBe('Your share account’s history could not be read (the chain did not answer in 20 seconds).');
    expect(ledgerText.paused()).toMatch(/paused/);
  });

  it('no sentence carries a forecast word, an em dash, or the word fees as a label for growth', () => {
    const lines = [
      ledgerText.putIn(r81.figures, about), ledgerText.worthNow(r81.figures, about), ledgerText.versusHolding(r81.figures, about), ledgerText.growth(r81.figures, about), ledgerText.priceEffect(r81.figures, about),
      ledgerText.window(r81, 1), ledgerText.unread('x'), ledgerText.paused(), LEDGER_COPY.button, LEDGER_COPY.readMore, LEDGER_COPY.olderNotRead, LEDGER_COPY.notFinal, LEDGER_COPY.sharesLeft, LEDGER_COPY.withdrawalUnbalanced,
      ledgerText.growthNote({ ...r81.figures, growth: { kind: 'none-yet' } }, { kind: 'none' }) ?? '', ledgerText.growthNote(r81.figures, { kind: 'none' }) ?? '',
    ];
    for (const line of lines) {
      expect(line).not.toMatch(FORECAST_WORDS);
      expect(line).not.toContain('—');
      expect(line).not.toMatch(/fees (earned|so far)/i);
    }
    expect(LEDGER_COPY.button).toBe('Work out what this position earned');
  });
});
