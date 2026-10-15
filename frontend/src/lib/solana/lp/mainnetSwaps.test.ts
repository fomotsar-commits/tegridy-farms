// @vitest-environment node
//
// The venue's BAYLA/SOL pool after its first three swaps (__fixtures__/mainnet-history, the
// 2026-10-10 files; see its README): the recorded history replayed to the pool's own
// balances, then the opener's position through the ledger and the pool's two pages through
// the pool past. Every expected figure is worked by hand here from the rule in words, never
// from ledger.ts or poolPast.ts; the steps stand in the comments.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isqrt } from './liquidityMath';
import { OPEN_TIME, POOL, Rc, Rt, S, SOL_VAULT, THIRD_SWAP, VENUE_CUT, livePool } from './mainnetPool.fixture';
import type { PoolView } from './poolFinder';
import { tradesExplain } from './poolGrowth';
import { lastTrade, olderPageProblem, pagePast, poolPastText, readPoolPastPage } from './poolPast';
import { parseTx, tokenDelta, type ParsedTx, type SigEntry } from './txHistory';
import { PROGRAM, fakeRpcWithHistory } from './testkit.fixture';
import { ledgerText, ledgerUnits, readLedger, type LedgerRead } from './ledger';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mainnet-history', name), 'utf8'));
interface Row { signature: string; tx: unknown }

const LP_MINT = 'BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e';
const WSOL_VAULT = '4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN';
const BAYLA_VAULT = '8YBj4RCdDKKs4MG6Ck9A3TSciRRocASr12ie7EsxLTe';
const OPENER_SHARE = 'DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm';
const PROG = PROGRAM.toBase58();

// The pool's balances at slot 455093758, and the pool itself through the finder's own
// read, are mainnetPool.fixture.ts (the pool card's growth test reads the same pool).
const SIGS = fixture('pool.baylaSol.2026-10-10.signatures.json') as SigEntry[];
const ROWS = fixture('pool.baylaSol.2026-10-10.transactions.json') as Row[];
const SHARE_SIGS = fixture('opener.lp.DKxZsj.2026-10-10.signatures.json') as SigEntry[];
const rpc = () => fakeRpcWithHistory({}, { [POOL]: SIGS, [OPENER_SHARE]: SHARE_SIGS }, Object.fromEntries(ROWS.map((r) => [r.signature, r.tx])));

const okRead = (r: LedgerRead) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r;
};

describe('the recorded history is the pool it is read against', () => {
  const txs = ROWS.map((r) => parseTx(r.signature, r.tx));
  const total = (f: (t: ParsedTx) => bigint) => txs.reduce((a, t) => a + f(t), 0n);

  it('34 transactions, newest first, every one finalized and succeeded; the opener’s four are among them', () => {
    expect(SIGS).toHaveLength(34);
    expect(ROWS.map((r) => r.signature)).toEqual(SIGS.map((s) => s.signature));
    expect(SIGS.every((s) => s.confirmationStatus === 'finalized' && s.err === null)).toBe(true);
    expect(txs.every((t) => t.err === null)).toBe(true);
    expect(SHARE_SIGS).toHaveLength(4);
    expect(SHARE_SIGS.every((s) => SIGS.some((p) => p.signature === s.signature))).toBe(true);
  });

  it('the vaults’ moves add up to the balances, and the shares minted plus the 100 locked to the supply', () => {
    expect(total((t) => tokenDelta(t, WSOL_VAULT))).toBe(SOL_VAULT);
    expect(total((t) => tokenDelta(t, BAYLA_VAULT))).toBe(Rt);
    const shares = (side: ParsedTx['pre']) => side.filter((b) => b.mint === LP_MINT).reduce((a, b) => a + b.amount, 0n);
    expect(total((t) => shares(t.post) - shares(t.pre)) + 100n).toBe(S);
  });

  it('three swaps, wrapped SOL in; the fee rule on them gives the venue’s cut the pool state carries', () => {
    // fees.rs: the trade fee rounds up, the venue's cut of it rounds down; tier 1 is 10,000 and 160,000 per million.
    // 10,000,000 in: fee 100,000, cut 16,000. 369,000,000: 3,690,000 and 590,400. 122,000,000: 1,220,000 and 195,200.
    const swaps = txs.filter((t) => tokenDelta(t, WSOL_VAULT) > 0n && tokenDelta(t, BAYLA_VAULT) < 0n).map((t) => tokenDelta(t, WSOL_VAULT));
    expect(swaps).toEqual([122_000_000n, 369_000_000n, 10_000_000n]);
    const fees = swaps.map((a) => (a * 10_000n + 999_999n) / 1_000_000n);
    const cuts = fees.map((f) => (f * 160_000n) / 1_000_000n);
    expect(fees.reduce((a, f) => a + f, 0n)).toBe(5_010_000n);
    expect(cuts.reduce((a, c) => a + c, 0n)).toBe(VENUE_CUT);
    // What stayed in the pool for its shares: 5,010,000 - 801,600.
    expect(5_010_000n - VENUE_CUT).toBe(4_208_400n);
    expect(SOL_VAULT - VENUE_CUT).toBe(Rc);
  });

  it('the kit derives the real pool; the finder reads its reserve net of the venue’s cut; a share is backed by 0.0084065% more than at opening', () => {
    const view = livePool();
    expect(view.address).toBe(POOL);
    expect(view.origin).toBe('standard');
    expect(view.snapshot.pool.lpMint).toBe(LP_MINT);
    expect([view.snapshot.pool.token0Vault, view.snapshot.pool.token1Vault]).toEqual([WSOL_VAULT, BAYLA_VAULT]);
    expect([view.snapshot.vault0Amount, view.quoteReserve, view.tokenReserve, view.snapshot.pool.lpSupply]).toEqual([SOL_VAULT, Rc, Rt, S]);
    expect(view.snapshot.pool.openTime).toBe(OPEN_TIME);
    expect(lastTrade(view)).toEqual({ kind: 'at', time: BigInt(THIRD_SWAP) });
    // isqrt(Rc * Rt) = 372,663,147,122 against 372,631,821,673 shares: 1.000084065415 each, to twelve places.
    expect(isqrt(Rc * Rt)).toBe(372_663_147_122n);
    expect((isqrt(Rc * Rt) * 10n ** 12n) / S).toBe(1_000_084_065_415n);
  });
});

describe('the opener after three swaps: 83,072,784,230 shares, 22.29% of the pool', () => {
  // By hand, floors as the program rounds. L = 14,823,941,988 + 14,677,170,375 + 44,031,511,124 + 9,540,160,743 = 83,072,784,230.
  // C_in = 1,000,000,000 + 990,099,010 + 2,970,297,030 + 643,564,357 = 5,603,960,397.
  // T_in = 219,749,259,037 + 217,573,523,666 + 652,720,570,983 + 141,422,790,372 = 1,231,466,144,058.
  // Worth: b_c = floor(L * Rc / S) = 5,717,756,621; b_t = floor(L * Rt / S) = 1,207,160,127,729.
  // val(t, c) = c + floor(t * Rc / Rt): floor(b_t * Rc / Rt) = 5,717,756,621, so V_pos = 11,435,513,242;
  // floor(T_in * Rc / Rt) = 5,832,882,927, so V_hold = 11,436,843,324. N = V_pos - V_hold = -1,330,082.
  // B = 14,823,941,988 (the opening's shares) + 14,677,170,380 + 44,031,511,141 + 9,540,160,750 (each deposit's isqrt(t * c)) = 83,072,784,259.
  // V_nf = 2 * isqrt(B * B * Rc * Rt) / Rt = 11,434,551,997, so G = V_pos - V_nf = +961,245. V_lock = 2 * isqrt(100 * 100 * Rc * Rt) / Rt = 13.
  // I = N - G + V_lock = -1,330,082 - 961,245 + 13 = -2,291,314. eps = 2 * ceil(Rc / Rt) + 6 = 8: all three are far over the bound.
  const share = { lpAccount: OPENER_SHARE, lpMint: LP_MINT, owner: 'Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd', lpAmount: 83_072_784_230n };
  const read = () => readLedger(rpc(), share, livePool(), PROG, {});

  it('reconciles (Case A) over the opening and three deposits, and reproduces every figure to the lamport', async () => {
    const r = okRead(await read());
    expect(r.case).toBe('A');
    expect(r.entries.map((e) => e.kind)).toEqual(['deposit', 'deposit', 'deposit', 'opening']);
    expect(r.entries[3]).toMatchObject({ kind: 'opening', slot: 453025316, blockTime: 1791055083, final: true, lp: 14_823_941_988n, coin: 1_000_000_000n, token: 219_749_259_037n, lpBefore: 0n });
    expect(r.entries[2]).toMatchObject({ kind: 'deposit', slot: 453333235, blockTime: 1791137472, final: true, lp: 14_677_170_375n, coin: 990_099_010n, token: 217_573_523_666n, lpBefore: 14_823_941_988n });
    expect(r.entries[1]).toMatchObject({ kind: 'deposit', slot: 453362576, blockTime: 1791145355, final: true, lp: 44_031_511_124n, coin: 2_970_297_030n, token: 652_720_570_983n, lpBefore: 29_501_112_363n });
    expect(r.entries[0]).toMatchObject({ kind: 'deposit', slot: 453371713, blockTime: 1791147802, final: true, lp: 9_540_160_743n, coin: 643_564_357n, token: 141_422_790_372n, lpBefore: 73_532_623_487n });
    expect(r.figures.putIn).toEqual({ token: 1_231_466_144_058n, coin: 5_603_960_397n, count: 3 });
    expect(r.figures.takenOut).toBeNull();
    expect(r.figures.worthNow).toEqual({ token: 1_207_160_127_729n, coin: 5_717_756_621n });
    expect(r.figures.holdWorth).toBe(11_436_843_324n);
    expect(r.figures.nowAndOutWorth).toBe(11_435_513_242n);
    expect(r.figures.growth).toEqual({ kind: 'amount', coin: 961_245n });
    expect(r.figures.versusHolding).toEqual({ kind: 'amount', coin: -1_330_082n });
    expect(r.figures.priceEffect).toEqual({ kind: 'amount', coin: -2_291_314n });
    expect(r.figures.locked).toBe(13n);
    expect(r.figures.since).toBe(1791055083);
    expect(r.figures.provenShares).toBe(83_072_784_230n);
    expect(r.figures.otherShares).toBeNull();
    expect(r.window).toEqual({ count: 4, oldest: 1791055083, more: false });
  });

  it('prints every unit: the figure beside its label, one short sentence under it', async () => {
    const view = livePool();
    const r = okRead(await read());
    const exact = ledgerUnits(view);
    expect(ledgerText.putIn(r.figures, exact)).toEqual({ figure: '5.603960397 SOL and 1,231,466.144058 BAYLA', note: 'In 1 opening and 3 deposits, since 2026-10-03 19:18 UTC.' });
    // A trade has reached the pool: the growth is the opener's part of the fees, said with what else would count.
    expect(ledgerText.growth(r.figures, exact, lastTrade(view))).toEqual({
      figure: '+0.000961245 SOL',
      note: 'Your part of this pool’s trading fees. Tokens sent straight into the pool count too.',
    });
    // Behind holding by more than the fees earned: the price moved, and the line says that is what cost it.
    expect(ledgerText.versusHolding(r.figures, exact)).toEqual({
      figure: '-0.001330082 SOL',
      note: 'Compared with keeping both tokens in your wallet. So far the price move has cost more than the fees earned.',
    });
    expect(ledgerText.priceEffect(r.figures, exact)).toEqual({ figure: '-0.002291314 SOL', note: 'What the price move alone did. Often called impermanent loss.' });
    expect(ledgerText.locked(r.figures, exact)).toBe('0.000000013 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
    expect(ledgerText.window(r)).toBe('From the 4 transactions on your shares in this pool since 2026-10-03 19:18 UTC.');
  });

  it('the pace under Fees earned, at the chain time of the read: 0.0084% of the position in 6.3 days', async () => {
    // 961,245 over 11,435,513,242 (V_pos) is 0.00840579%, cut to 0.0084%. From the opening (1791055083) to
    // 2026-10-10 02:31:00 UTC (1791599460) is 544,377 s = 6.3006 days. x 31,536,000 / 544,377 = 0.48695%, cut to 0.48%.
    const view = livePool();
    const r = okRead(await read());
    // The venue's uncollected 801,600 lamports show trades paid the LPs 4,208,400: that accounts for the pool's growth.
    expect(tradesExplain(view)).toBe(true);
    expect(ledgerText.pace(r.figures, lastTrade(view), 1_791_599_460n, tradesExplain(view))).toBe('0.0084% of this position in 6.3 days. At that pace, about 0.48% a year. Past trades, not a forecast.');
  });

  it('1 SOL sent straight to the pool’s vault, no trade: the row’s figure rises and says tokens sent in count, and there is no pace at all', async () => {
    // The reviewer's case. The vault and the reserve are 1 SOL larger; the fee counter, the record and the history are as they were.
    const live = livePool();
    const sent = 1_000_000_000n;
    expect(live.quoteIsToken0).toBe(true);
    const view: PoolView = { ...live, quoteReserve: live.quoteReserve + sent, snapshot: { ...live.snapshot, vault0Amount: live.snapshot.vault0Amount + sent, reserve0: live.snapshot.reserve0 + sent } };
    const r = okRead(await readLedger(rpc(), share, view, PROG, {}));
    const growth = ledgerText.growth(r.figures, ledgerUnits(view), lastTrade(view));
    // Nearly a quarter of the SOL sent in belongs to the 22.29% the opener holds: far more than the 961,245 lamports of fees.
    expect(r.figures.growth.kind === 'amount' && r.figures.growth.coin > 200_000_000n).toBe(true);
    expect(growth.note).toBe('Your part of this pool’s trading fees. Tokens sent straight into the pool count too.');
    expect(tradesExplain(view)).toBe(false);
    expect(ledgerText.pace(r.figures, lastTrade(view), 1_791_599_460n, tradesExplain(view))).toBeNull();
  });
});

describe('the pool past over the same history, a page at a time', () => {
  // Counted from the investigation's own record of the 34 (another script, another encoding), newest first.
  it('the newest 20: 3 swaps, 17 deposits from 13 wallets, 0.501 SOL traded in; a full page, so older ones are said not read', async () => {
    const view = livePool();
    const r = pagePast(await readPoolPastPage(rpc(), view, PROG, {}));
    expect(r).toEqual({
      kind: 'ok', count: 20, swaps: 3, deposits: 17, withdrawals: 0, openings: 0, wallets: 13, other: 0,
      volumeIn: { token: 0n, coin: 501_000_000n }, from: 1791232139, to: 1791579804, complete: false, reachedOpening: false,
    });
    // A count of zero is left out, and so is the side nothing was traded into.
    expect(poolPastText(r, view)).toBe('Last 20 transactions on this pool, 2026-10-05 20:28 UTC to 2026-10-09 21:03 UTC: 3 swaps, 17 deposits from 13 wallets. Traded in: 0.501 SOL. Each trade paid this tier’s fee at the time. Older transactions were not read.');
  });

  it('the 14 before them reach the opening: 13 deposits from 8 wallets and no swap. Two wallets are on both pages, so the pages’ wallet counts do not add to the 19', async () => {
    const r = pagePast(await readPoolPastPage(rpc(), livePool(), PROG, { before: SIGS[19]!.signature }));
    expect(r).toEqual({
      kind: 'ok', count: 14, swaps: 0, deposits: 13, withdrawals: 0, openings: 1, wallets: 8, other: 0,
      volumeIn: { token: 0n, coin: 0n }, from: 1791055083, to: 1791228705, complete: true, reachedOpening: true,
    });
    // The whole history's wallets, straight from the rows: every deposit's first signer.
    const depositors = new Set(ROWS.map((row) => parseTx(row.signature, row.tx)).filter((t) => tokenDelta(t, WSOL_VAULT) > 0n && tokenDelta(t, BAYLA_VAULT) > 0n && t.slot !== 453025316).map((t) => t.signers[0]));
    expect(depositors.size).toBe(19);
  });

  it('Read 20 more: the two pages’ entries joined and totalled again are the whole history, 30 deposits from 19 wallets, and say so', async () => {
    // What the pool card does: it keeps the first page's entries, reads the page before the oldest of them, and totals both.
    const view = livePool();
    const first = await readPoolPastPage(rpc(), view, PROG, {});
    if (first.kind !== 'page') throw new Error(first.kind);
    expect([first.items.length, first.more]).toEqual([20, true]);
    const older = await readPoolPastPage(rpc(), view, PROG, { before: first.items[19]!.signature });
    if (older.kind !== 'page') throw new Error(older.kind);
    expect([older.items.length, older.more]).toEqual([14, false]);
    expect(olderPageProblem(older)).toBeNull();
    const all = pagePast({ kind: 'page', items: [...first.items, ...older.items], more: older.more });
    // 1 opening, 30 deposits, 3 swaps, 0 withdrawals: the investigation's own count of the 34.
    expect(all).toEqual({
      kind: 'ok', count: 34, swaps: 3, deposits: 30, withdrawals: 0, openings: 1, wallets: 19, other: 0,
      volumeIn: { token: 0n, coin: 501_000_000n }, from: 1791055083, to: 1791579804, complete: true, reachedOpening: true,
    });
    expect(poolPastText(all, view)).toBe('All 34 transactions since this pool opened on 2026-10-03 19:18 UTC: 3 swaps, 30 deposits from 19 wallets, 1 opening. Traded in: 0.501 SOL. Each trade paid this tier’s fee at the time.');
  });
});
