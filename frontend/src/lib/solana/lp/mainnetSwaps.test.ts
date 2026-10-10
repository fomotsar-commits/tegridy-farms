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
import { PublicKey } from '@solana/web3.js';
import { decodePoolState } from '../cpswap/program';
import { isqrt } from './liquidityMath';
import { poolViewFrom, type PoolView } from './poolFinder';
import { lastTrade, poolPastText, readPoolPast } from './poolPast';
import { BAYLA_MINT } from './tokenSafety';
import { parseTx, tokenDelta, type ParsedTx, type SigEntry } from './txHistory';
import { LAUNCH, PROGRAM, buildPool, fakeRpcWithHistory, observationBytes } from './testkit.fixture';
import { ledgerText, ledgerUnits, readLedger, type LedgerRead } from './ledger';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mainnet-history', name), 'utf8'));
interface Row { signature: string; tx: unknown }

const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const LP_MINT = 'BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e';
const WSOL_VAULT = '4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN';
const BAYLA_VAULT = '8YBj4RCdDKKs4MG6Ck9A3TSciRRocASr12ie7EsxLTe';
const OPENER_SHARE = 'DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm';
const PROG = PROGRAM.toBase58();

// The pool at slot 455093758 (unchanged at 455105163, when the files were read): the SOL
// vault's balance, the venue's uncollected cut inside it, and what the shares are valued
// against. Rc = 25,648,407,921 - 801,600.
const SOL_VAULT = 25_648_407_921n;
const VENUE_CUT = 801_600n;
const Rc = 25_647_606_321n;
const Rt = 5_414_845_326_496n;
const S = 372_631_821_673n;
const OPEN_TIME = 1_791_055_084n;
const THIRD_SWAP = 1_791_514_249;

const SIGS = fixture('pool.baylaSol.2026-10-10.signatures.json') as SigEntry[];
const ROWS = fixture('pool.baylaSol.2026-10-10.transactions.json') as Row[];
const SHARE_SIGS = fixture('opener.lp.DKxZsj.2026-10-10.signatures.json') as SigEntry[];
const rpc = () => fakeRpcWithHistory({}, { [POOL]: SIGS, [OPENER_SHARE]: SHARE_SIGS }, Object.fromEntries(ROWS.map((r) => [r.signature, r.tx])));

/** The real pool at those balances, judged by the finder's own `poolViewFrom` (the reserve is the vault less the fees owed). */
function livePool(): PoolView {
  const b = buildPool({ mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S, protocolFeesSol: VENUE_CUT, openTime: OPEN_TIME });
  const address = b.address.toBase58();
  const acc = (a: string) => ({ address: a, owner: b.accounts[a]!.owner, data: b.accounts[a]!.data, lamports: 1 });
  const pool = decodePoolState(address, b.accounts[address]!.data)!;
  const entry = poolViewFrom({
    address,
    pool: acc(address),
    vault0: acc(pool.token0Vault),
    vault1: acc(pool.token1Vault),
    config: acc(pool.ammConfig),
    // The record as the chain holds it: written by a swap, newest slot 2, last update the third swap.
    observation: { address: b.observation.toBase58(), owner: PROG, data: observationBytes({ pool: b.address, index: 2, lastUpdate: BigInt(THIRD_SWAP) }), lamports: 1 },
    opts: { programId: PROGRAM, launchProgramId: LAUNCH },
  });
  if (entry.kind !== 'pool') throw new Error(`the finder did not read the pool: ${entry.kind}`);
  return entry.view;
}

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

  it('prints every unit on expand, and four decimals cut (never rounded up) on the card', async () => {
    const view = livePool();
    const r = okRead(await read());
    const exact = ledgerUnits(view, 'exact');
    expect(ledgerText.putIn(r.figures, exact)).toBe('5.603960397 SOL and 1,231,466.144058 BAYLA, in 1 opening and 3 deposits, since 2026-10-03 19:18 UTC');
    expect(ledgerText.worthNow(r.figures, exact)).toBe('5.717756621 SOL and 1,207,160.127729 BAYLA');
    expect(ledgerText.growth(r.figures, exact)).toBe('+0.000961245 SOL: how much more your shares are worth than a fee-free pool would have made them, from trades and anything else sent to this pool. Fees stay in the pool; there is nothing to claim.');
    expect(ledgerText.versusHolding(r.figures, exact)).toBe('-0.001330082 SOL at this pool’s price now. Holding what you put in would be worth 11.436843324 SOL; what you hold now plus what you took out is worth 11.435513242 SOL.');
    expect(ledgerText.priceEffect(r.figures, exact)).toBe('-0.002291314 SOL: what the price moving since you put in did to a pool position compared with holding (what people call impermanent loss).');
    expect(ledgerText.locked(r.figures, exact)).toBe('0.000000013 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
    // A trade has reached the pool, so the growth line needs no note about where it came from.
    expect(ledgerText.growthNote(r.figures, lastTrade(view))).toBeNull();
    expect(ledgerText.window(r, 5)).toBe('From 4 transactions of your share account, back to 2026-10-03 19:18 UTC, read 5 s ago. Exact to a few of the smallest units, which rounding cannot tell from zero.');
    const about = ledgerUnits(view, 'about');
    expect(ledgerText.putIn(r.figures, about)).toBe('5.6039 SOL and 1,231,466.144 BAYLA, in 1 opening and 3 deposits, since 2026-10-03 19:18 UTC');
    expect(ledgerText.worthNow(r.figures, about)).toBe('5.7177 SOL and 1,207,160.1277 BAYLA');
    expect(ledgerText.growth(r.figures, about)).toMatch(/^\+0\.0009 SOL: /);
    expect(ledgerText.versusHolding(r.figures, about)).toMatch(/^-0\.0013 SOL at this pool’s price now\. Holding what you put in would be worth 11\.4368 SOL; what you hold now plus what you took out is worth 11\.4355 SOL\.$/);
    expect(ledgerText.priceEffect(r.figures, about)).toMatch(/^-0\.0022 SOL: /);
  });
});

describe('the pool past over the same history, a page at a time', () => {
  // Counted from the investigation's own record of the 34 (another script, another encoding), newest first.
  it('the newest 20: 3 swaps, 17 deposits from 13 wallets, 0.501 SOL traded in; a full page, so older ones are said not read', async () => {
    const view = livePool();
    const r = await readPoolPast(rpc(), view, PROG, {});
    expect(r).toEqual({
      kind: 'ok', count: 20, swaps: 3, deposits: 17, withdrawals: 0, openings: 0, wallets: 13, other: 0,
      volumeIn: { token: 0n, coin: 501_000_000n }, from: 1791232139, to: 1791579804, complete: false, reachedOpening: false,
    });
    expect(poolPastText(r, view)).toBe('Last 20 transactions on this pool, 2026-10-05 20:28 UTC to 2026-10-09 21:03 UTC: 3 swaps, 17 deposits from 13 wallets, 0 withdrawals, 0 other. Traded in: 0.501 SOL and 0 BAYLA. Fees are this tier’s rate on that volume; the rate can change, so no total is shown. Older transactions were not read.');
  });

  it('the 14 before them reach the opening: 13 deposits from 8 wallets and no swap. Two wallets are on both pages, so the pages’ wallet counts do not add to the 19', async () => {
    const r = await readPoolPast(rpc(), livePool(), PROG, { before: SIGS[19]!.signature });
    expect(r).toEqual({
      kind: 'ok', count: 14, swaps: 0, deposits: 13, withdrawals: 0, openings: 1, wallets: 8, other: 0,
      volumeIn: { token: 0n, coin: 0n }, from: 1791055083, to: 1791228705, complete: true, reachedOpening: true,
    });
    // The whole history's wallets, straight from the rows: every deposit's first signer.
    const depositors = new Set(ROWS.map((row) => parseTx(row.signature, row.tx)).filter((t) => tokenDelta(t, WSOL_VAULT) > 0n && tokenDelta(t, BAYLA_VAULT) > 0n && t.slot !== 453025316).map((t) => t.signers[0]));
    expect(depositors.size).toBe(19);
  });
});
