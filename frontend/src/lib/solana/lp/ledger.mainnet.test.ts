// @vitest-environment node
//
// The venue's real history (MAINNET_FACTS; __fixtures__/mainnet-history) through the ledger,
// at the reserves after the eight transactions: Rc = 4,832,878,899 lamports, Rt =
// 1,062,021,556,414 BAYLA units, S = 71,642,316,872 shares (no fee is owed, so the vault
// balances are the reserves). Every expected figure is worked by hand here from the rule in
// words, never from ledger.ts; the steps stand in the comments.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { isqrt } from './liquidityMath';
import { decodeObservationState } from './ownPrice';
import type { PoolView } from './poolFinder';
import { lastTrade } from './poolPast';
import { BAYLA_MINT } from './tokenSafety';
import type { SigEntry } from './txHistory';
import { PROGRAM, buildPool, fakeRpcWithHistory, observationBytes, viewOf } from './testkit.fixture';
import { ledgerText, ledgerUnits, readLedger, type LedgerRead } from './ledger';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mainnet-history', name), 'utf8'));
interface Row { signature: string; tx: unknown }

const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const LP_MINT = 'BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e';
const WSOL_VAULT = '4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN';
const BAYLA_VAULT = '8YBj4RCdDKKs4MG6Ck9A3TSciRRocASr12ie7EsxLTe';
const Rc = 4_832_878_899n;
const Rt = 1_062_021_556_414n;
const S = 71_642_316_872n;

/** The real pool at the replayed reserves: the kit derives the venue's own addresses from BAYLA's mint on tier 1. */
function livePool(): PoolView {
  const b = buildPool({ mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S });
  // No swap has ever reached the pool, so its price record is not initialized (MAINNET_FACTS).
  const obs = decodeObservationState(observationBytes({ pool: b.address, initialized: false }));
  if (!obs) throw new Error('the price record bytes do not decode');
  return viewOf(b, { sol: Rc, tok: Rt, history: { kind: 'ok', obs } });
}

function rpcFor(lpAccount: string, sigs: string, txs: string) {
  const rows = fixture(txs) as Row[];
  return fakeRpcWithHistory({}, { [lpAccount]: fixture(sigs) as SigEntry[] }, Object.fromEntries(rows.map((r) => [r.signature, r.tx])));
}

const okRead = (r: LedgerRead) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r;
};

const NO_TRADE_YET = 'No trade has reached this pool yet, so there are no fees yet.';

describe('the venue’s BAYLA/SOL pool, as the kit builds it', () => {
  it('derives the real pool, vaults and share mint from BAYLA’s mint on tier 1; SOL is token 0; no trade yet', () => {
    const view = livePool();
    expect(view.address).toBe(POOL);
    expect(view.snapshot.pool.lpMint).toBe(LP_MINT);
    expect([view.snapshot.pool.token0Vault, view.snapshot.pool.token1Vault]).toEqual([WSOL_VAULT, BAYLA_VAULT]);
    expect(view.quoteIsToken0).toBe(true);
    expect([view.quoteReserve, view.tokenReserve, view.snapshot.pool.lpSupply]).toEqual([Rc, Rt, S]);
    expect(lastTrade(view)).toEqual({ kind: 'none' });
  });
});

describe('the owner’s position (row 3): 14,677,170 shares for 990,099 lamports and 217,573,519 BAYLA', () => {
  // By hand. Worth (floors): b_c = floor(14,677,170 * 4,832,878,899 / 71,642,316,872) = 990,098;
  // b_t = floor(14,677,170 * 1,062,021,556,414 / 71,642,316,872) = 217,573,518.
  // val(t, c) = c + floor(t * Rc / Rt): floor(217,573,518 * Rc / Rt) = 990,098, so V_pos = 1,980,196;
  // floor(217,573,519 * Rc / Rt) = 990,098, so V_hold = 990,099 + 990,098 = 1,980,197. N = V_pos - V_hold = -1.
  // Basis B = isqrt(217,573,519 * 990,099) = 14,677,170 (the shares minted, to the unit).
  // V_nf = 2 * isqrt(B * B * Rc * Rt) / Rt = 1,980,197. G = V_pos - V_nf = -1. I = N - G = 0.
  // eps = 2 * ceil(Rc / Rt) + 6 = 2 * 1 + 6 = 8: all three lines are under the bound.
  const share = { lpAccount: 'D2CYpjwm38TbHfwdLFw9Eh9hcxoUAMXJdWn33e7YEb93', lpMint: LP_MINT, owner: '6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY', lpAmount: 14_677_170n };
  const read = () => readLedger(rpcFor(share.lpAccount, 'owner.lp.D2CYpj.signatures.json', 'owner.lp.D2CYpj.transactions.json'), share, livePool(), PROGRAM.toBase58(), {});

  it('reconciles (Case A) and reproduces every figure to the base unit', async () => {
    const r = okRead(await read());
    expect(r.case).toBe('A');
    expect(r.entries).toEqual([{
      kind: 'deposit',
      signature: '4Jg1XVqkF1gr4h74FaPqeocqD5mGUtBibP8RHQTLBp1cYfpCJrc2mykXxkCM5zbcvS2JGy21zDD82vfiYn7fAUz9',
      slot: 453068345,
      blockTime: 1791066624,
      final: true,
      lp: 14_677_170n,
      token: 217_573_519n,
      coin: 990_099n,
      lpBefore: 0n,
    }]);
    expect(r.figures.putIn).toEqual({ token: 217_573_519n, coin: 990_099n, count: 1 });
    expect(r.figures.takenOut).toBeNull();
    expect(r.figures.worthNow).toEqual({ token: 217_573_518n, coin: 990_098n });
    expect(r.figures.holdWorth).toBe(1_980_197n);
    expect(r.figures.nowAndOutWorth).toBe(1_980_196n);
    expect(r.figures.versusHolding).toEqual({ kind: 'none-yet' });
    expect(r.figures.growth).toEqual({ kind: 'none-yet' });
    expect(r.figures.priceEffect).toEqual({ kind: 'none-yet' });
    expect(r.figures.locked).toBeNull();
    expect(r.figures.since).toBe(1791066624);
    expect(r.figures.provenShares).toBe(14_677_170n);
    expect(r.figures.otherShares).toBeNull();
    expect(r.window).toEqual({ count: 1, oldest: 1791066624, more: false });
  });

  it('prints put in and worth now exactly, none yet on all three lines, and the no-trade sentence', async () => {
    const view = livePool();
    const r = okRead(await read());
    const u = ledgerUnits(view, 'exact');
    expect(ledgerText.putIn(r.figures, u)).toBe('0.000990099 SOL and 217.573519 BAYLA, in 1 deposit, since 2026-10-03 22:30 UTC');
    expect(ledgerText.worthNow(r.figures, u)).toBe('0.000990098 SOL and 217.573518 BAYLA');
    expect(ledgerText.versusHolding(r.figures, u)).toEqual({ figure: 'none yet', note: null });
    expect(ledgerText.growth(r.figures, u, lastTrade(view))).toEqual({ figure: 'none yet', note: NO_TRADE_YET });
    expect(ledgerText.priceEffect(r.figures, u)).toEqual({ figure: 'none yet', note: null });
    expect(ledgerText.pace(r.figures, lastTrade(view), 1_791_600_000n)).toBeNull();
    expect(ledgerText.locked(r.figures, u)).toBeNull();
    expect(ledgerText.window(r, 5)).toBe('From 1 transaction of your share account, back to 2026-10-03 22:30 UTC, read 5 s ago. Exact to a few of the smallest units, which rounding cannot tell from zero.');
    // Never a signed figure under the bound: no "-0.0000 SOL" for N = -1.
    for (const line of [ledgerText.versusHolding(r.figures, u), ledgerText.growth(r.figures, u, lastTrade(view)), ledgerText.priceEffect(r.figures, u)]) expect(line.figure).not.toMatch(/[-+\d]/);
  });
});

describe('the opener (rows 1 and 8): the opening and one deposit, 29,501,112,363 shares', () => {
  // By hand. The opening minted isqrt(1e9 * 219,749,259,037) - 100 = 14,823,941,988 (the two-way proof); the deposit 14,677,170,375.
  // T_in = 219,749,259,037 + 217,573,523,666 = 437,322,782,703; C_in = 1,000,000,000 + 990,099,010 = 1,990,099,010.
  // Worth of 29,501,112,363 shares: b_t = floor(L * Rt / S) = 437,322,781,222; b_c = floor(L * Rc / S) = 1,990,099,003.
  // floor(b_t * Rc / Rt) = 1,990,099,003, so V_pos = 3,980,198,006; floor(T_in * Rc / Rt) = 1,990,099,010, so V_hold = 3,980,198,020. N = -14.
  // B = 14,823,941,988 (the opening's shares; the 100 locked are paid for, not held) + isqrt(217,573,523,666 * 990,099,010) = 14,823,941,988 + 14,677,170,380 = 29,501,112,368.
  // V_nf = 2 * isqrt(B * B * Rc * Rt) / Rt = 3,980,198,006, so G = 0. V_lock = 2 * isqrt(100 * 100 * Rc * Rt) / Rt = 13.
  // I = N - G + V_lock = -1. The opener stands 14 lamports behind holding: the pool's own lock (13) and one unit of rounding; no gain, no trade.
  const share = { lpAccount: 'DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm', lpMint: LP_MINT, owner: 'Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd', lpAmount: 29_501_112_363n };
  const read = () => readLedger(rpcFor(share.lpAccount, 'opener.lp.DKxZsj.signatures.json', 'opener.lp.DKxZsj.transactions.json'), share, livePool(), PROGRAM.toBase58(), {});

  it('reconciles (Case A) with the opening proven by the two-way rule; growth and price effect none yet; the lock is 13 lamports; no gain', async () => {
    expect(isqrt(1_000_000_000n * 219_749_259_037n) - 100n).toBe(14_823_941_988n);
    const r = okRead(await read());
    expect(r.case).toBe('A');
    expect(r.entries.map((e) => e.kind)).toEqual(['deposit', 'opening']);
    expect(r.entries[1]).toMatchObject({ kind: 'opening', slot: 453025316, blockTime: 1791055083, final: true, lp: 14_823_941_988n, coin: 1_000_000_000n, token: 219_749_259_037n, lpBefore: 0n });
    expect(r.entries[0]).toMatchObject({ kind: 'deposit', slot: 453333235, blockTime: 1791137472, final: true, lp: 14_677_170_375n, coin: 990_099_010n, token: 217_573_523_666n, lpBefore: 14_823_941_988n });
    expect(r.figures.putIn).toEqual({ token: 437_322_782_703n, coin: 1_990_099_010n, count: 1 });
    expect(r.figures.worthNow).toEqual({ token: 437_322_781_222n, coin: 1_990_099_003n });
    expect(r.figures.holdWorth).toBe(3_980_198_020n);
    expect(r.figures.nowAndOutWorth).toBe(3_980_198_006n);
    expect(r.figures.growth).toEqual({ kind: 'none-yet' });
    expect(r.figures.priceEffect).toEqual({ kind: 'none-yet' });
    expect(r.figures.locked).toBe(13n);
    expect(r.figures.versusHolding).toEqual({ kind: 'amount', coin: -14n });
    expect(r.figures.since).toBe(1791055083);
    expect(r.window).toEqual({ count: 2, oldest: 1791055083, more: false });
  });

  it('prints the opening apart, the lock on its own line, the no-trade sentence, and no gain', async () => {
    const view = livePool();
    const r = okRead(await read());
    const u = ledgerUnits(view, 'exact');
    expect(ledgerText.putIn(r.figures, u)).toBe('1.99009901 SOL and 437,322.782703 BAYLA, in 1 opening and 1 deposit, since 2026-10-03 19:18 UTC');
    expect(ledgerText.worthNow(r.figures, u)).toBe('1.990099003 SOL and 437,322.781222 BAYLA');
    expect(ledgerText.growth(r.figures, u, lastTrade(view))).toEqual({ figure: 'none yet', note: NO_TRADE_YET });
    expect(ledgerText.priceEffect(r.figures, u)).toEqual({ figure: 'none yet', note: null });
    expect(ledgerText.locked(r.figures, u)).toBe('0.000000013 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
    // 14 behind holding with no trade and no price move: the line says what is compared and blames nothing.
    expect(ledgerText.versusHolding(r.figures, u)).toEqual({ figure: '-0.000000014 SOL', note: 'Compared with keeping the two tokens in your wallet, at this pool’s price now.' });
  });
});
