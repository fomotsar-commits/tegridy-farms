// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { BAYLA_MINT, WSOL_MINT } from '../lp/tokenSafety';
import { getSqrtPriceAtTick } from '../clmm/math';
import { POOL_STATE_OFFSETS, deriveAmmConfig, deriveObservation, derivePool, deriveTickArray, deriveVault, sortMints } from '../clmm/program';
import { quoteSwap } from '../clmm/quote';
import { encodeAmmConfig, encodePool, encodeTickArray } from '../clmm/encode.fixture';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { encodeMint, encodeMint2022, encodeTokenAccountWith } from '../../launcher/solana/write/testkit.fixture';
import { mergeOwnStates, quoteRangePools, readRangeRoutePools } from './rangePools';

/**
 * The swap route's range pools: nothing is read while they are hidden, a pool is quoted as
 * the program walks it, and a pool that did not read is an error, never "no pool".
 */

const PROG = Keypair.generate().publicKey;
const { token0: M0, token1: M1 } = sortMints(new PublicKey(BAYLA_MINT), new PublicKey(WSOL_MINT));
const CONFIG = deriveAmmConfig(PROG, 0);
const POOL = derivePool(PROG, CONFIG, M0, M1);
/** A second tier with its own pool for the pair, read whole. */
const CONFIG1 = deriveAmmConfig(PROG, 1);
const POOL1 = derivePool(PROG, CONFIG1, M0, M1);
const TICK = 600;
const SQRT = getSqrtPriceAtTick(TICK) + 7n;
const L = 10n ** 13n;
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';

/** Five positions from 1200 down to each of five bands below: a long sell walks six bands. */
const DEEP = [-7_200, -14_400, -21_600, -28_800, -36_000];

/** Token-2022's TransferFeeConfig extension (type 1, 108 bytes): a fee on every transfer, which the builder refuses. */
const TRANSFER_FEE: [number, number] = [1, 108];

function chain(o: { band?: boolean; pool?: boolean; deep?: boolean; transferFee?: boolean; frozenVault?: 0 | 1; vaultMissing?: boolean; secondPool?: boolean; dynamicFee?: boolean } = {}) {
  const accts = new Map<string, { owner: string; data: Uint8Array }>();
  const calls: string[][] = [];
  // The two mints (BAYLA a Token-2022 coin, SOL a classic one) and the pool's two vaults.
  for (const [i, m] of [M0, M1].entries()) {
    const bayla = m.toBase58() === BAYLA_MINT;
    const program = (bayla ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58();
    accts.set(m.toBase58(), { owner: program, data: bayla ? encodeMint2022(o.transferFee ? [TRANSFER_FEE] : [], { decimals: 6 }) : encodeMint({ decimals: 9 }) });
    if (o.vaultMissing && i === 1) continue;
    const state = o.frozenVault === i ? (2 as const) : (1 as const);
    accts.set(deriveVault(PROG, POOL, m).toBase58(), { owner: program, data: encodeTokenAccountWith(m, POOL, 10n ** 12n, { state }) });
  }
  accts.set(CONFIG.toBase58(), { owner: PROG.toBase58(), data: encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0, tickSpacing: 120 }) });
  if (o.pool !== false) {
    const data = encodePool({
      ammConfig: CONFIG, mint0: M0, mint1: M1, vault0: deriveVault(PROG, POOL, M0), vault1: deriveVault(PROG, POOL, M1), observation: deriveObservation(PROG, POOL),
      decimals0: 6, decimals1: 9, tickSpacing: 120, liquidity: o.deep ? L * 5n : L, sqrtPriceX64: SQRT, tickCurrent: TICK,
      bitmapBits: o.deep ? [512, ...DEEP.map((d) => 512 + d / 7_200)] : [512],
    });
    // A dynamic fee: its control byte set, so the pool's dynamic-fee record is not all zero.
    if (o.dynamicFee) data[POOL_STATE_OFFSETS.dynamicFeeInfo + 6] = 1;
    accts.set(POOL.toBase58(), { owner: PROG.toBase58(), data });
  }
  if (o.deep) {
    accts.set(deriveTickArray(PROG, POOL, 0).toBase58(), { owner: PROG.toBase58(), data: encodeTickArray(POOL, 0, 120, [{ tick: 1200, liquidityNet: -L * 5n, liquidityGross: L * 5n }]) });
    for (const d of DEEP) accts.set(deriveTickArray(PROG, POOL, d).toBase58(), { owner: PROG.toBase58(), data: encodeTickArray(POOL, d, 120, [{ tick: d, liquidityNet: L, liquidityGross: L }]) });
  } else if (o.band !== false) {
    accts.set(deriveTickArray(PROG, POOL, 0).toBase58(), {
      owner: PROG.toBase58(),
      data: encodeTickArray(POOL, 0, 120, [
        { tick: 0, liquidityNet: L, liquidityGross: L },
        { tick: 1200, liquidityNet: -L, liquidityGross: L },
      ]),
    });
  }
  if (o.secondPool) {
    accts.set(CONFIG1.toBase58(), { owner: PROG.toBase58(), data: encodeAmmConfig({ index: 1, tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0, tickSpacing: 120 }) });
    accts.set(POOL1.toBase58(), {
      owner: PROG.toBase58(),
      data: encodePool({
        ammConfig: CONFIG1, mint0: M0, mint1: M1, vault0: deriveVault(PROG, POOL1, M0), vault1: deriveVault(PROG, POOL1, M1), observation: deriveObservation(PROG, POOL1),
        decimals0: 6, decimals1: 9, tickSpacing: 120, liquidity: L, sqrtPriceX64: SQRT, tickCurrent: TICK, bitmapBits: [512],
      }),
    });
    for (const m of [M0, M1]) {
      const program = (m.toBase58() === BAYLA_MINT ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58();
      accts.set(deriveVault(PROG, POOL1, m).toBase58(), { owner: program, data: encodeTokenAccountWith(m, POOL1, 10n ** 12n) });
    }
    accts.set(deriveTickArray(PROG, POOL1, 0).toBase58(), {
      owner: PROG.toBase58(),
      data: encodeTickArray(POOL1, 0, 120, [
        { tick: 0, liquidityNet: L, liquidityGross: L },
        { tick: 1200, liquidityNet: -L, liquidityGross: L },
      ]),
    });
  }
  const clock = new Uint8Array(40);
  new DataView(clock.buffer).setBigInt64(32, 1_800_000_000n, true);
  accts.set(CLOCK, { owner: 'Sysvar1111111111111111111111111111111111111', data: clock });
  const rpc: SolanaRpc = async (method, params) => {
    if (method !== 'getMultipleAccounts') throw new Error(`the proxy refuses ${method}`);
    const keys = params[0] as string[];
    calls.push(keys);
    return { value: keys.map((k) => { const a = accts.get(k); return a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner, lamports: 1 } : null; }) };
  };
  return { rpc, calls, accts };
}

describe('reading range pools for a swap', () => {
  it('reads nothing at all while range pools are hidden', async () => {
    const c = chain();
    expect(await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: false })).toEqual({ kind: 'not-searched' });
    expect(c.calls).toEqual([]);
  });

  it('reads nothing for a pair this site does not pair', async () => {
    const c = chain();
    const r = await readRangeRoutePools(c.rpc, Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), { programId: PROG, visible: true });
    expect(r).toEqual({ kind: 'not-searched' });
    expect(c.calls).toEqual([]);
  });

  it('finds the pool, its bands and the clock, and quotes it exactly as the program walks it', async () => {
    const c = chain();
    const read = await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.pools.map((p) => p.range.pool.address)).toEqual([POOL.toBase58()]);
    expect(read.chainNow).toBe(1_800_000_000n);
    const q = quoteRangePools(read, WSOL_MINT, 1_000_000n);
    expect(q.state).toBe('quoted');
    const p = read.pools[0]!;
    const want = quoteSwap({ pool: p.range.pool, config: p.range.config, band: (s) => p.bands.get(s), extension: null, zeroForOne: WSOL_MINT === M0.toBase58(), isBaseInput: true, amount: 1_000_000n, sqrtPriceLimitX64: 0n, blockTimestamp: 1_800_000_000 });
    if (want.kind !== 'ok') throw new Error('quote');
    expect(q.candidates[0]).toMatchObject({ venue: 'own-pool', poolAddress: POOL.toBase58(), outAmount: want.amountOut });
    expect(q.candidates[0]!.priceImpact).toBeGreaterThan(0);
  });

  it('a trade larger than the bands read gives no candidate, and says the pool cannot take it', async () => {
    const c = chain();
    const read = await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    expect(quoteRangePools(read, WSOL_MINT, 10n ** 18n)).toEqual({ state: 'unquotable', candidates: [] });
  });

  it('a trade that walks more bands than one swap carries gives no candidate, though every band it needs was read', async () => {
    const c = chain({ deep: true });
    const read = await readRangeRoutePools(c.rpc, M0.toBase58(), M1.toBase58(), { programId: PROG, visible: true });
    if (read.kind !== 'ok') throw new Error(read.kind);
    const p = read.pools[0]!;
    expect([...p.bands.keys()].sort((a, b) => a - b)).toEqual([...DEEP].reverse().concat(0));
    // The smallest sell of token 0 that walks all six bands, found on the bands read.
    const walk = (amount: bigint) => quoteSwap({ pool: p.range.pool, config: p.range.config, band: (s) => p.bands.get(s), extension: null, zeroForOne: true, isBaseInput: true, amount, sqrtPriceLimitX64: 0n, blockTimestamp: 1_800_000_000 });
    // From a trade that fills inside the first bands, "past five bands" flips once as the
    // amount grows: the first amount past it walks into the sixth.
    const past5 = (amount: bigint) => { const w = walk(amount); return !(w.kind === 'ok' && w.bands.length <= 5); };
    let lo = 10n ** 12n;
    expect(past5(lo)).toBe(false);
    let hi = lo;
    while (!past5(hi)) hi *= 2n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (past5(mid)) hi = mid;
      else lo = mid + 1n;
    }
    const q = walk(lo);
    expect(q.kind === 'ok' && q.bands.length).toBe(6);
    expect(quoteRangePools(read, M0.toBase58(), lo)).toEqual({ state: 'unquotable', candidates: [] });
    // One band fewer is a quote.
    expect(quoteRangePools(read, M0.toBase58(), lo / 2n).state).toBe('quoted');
  });

  it('a band the pool marks that does not read makes the answer an error, never "no pool"', async () => {
    const c = chain({ band: false });
    const read = await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    expect(quoteRangePools(read, WSOL_MINT, 1_000_000n).state).toBe('error');
  });

  it('a pool whose token takes a fee on transfers, or whose vault is frozen, is no candidate: unquotable, never priced beside Jupiter', async () => {
    for (const o of [{ transferFee: true }, { frozenVault: 0 as const }, { frozenVault: 1 as const }]) {
      const read = await readRangeRoutePools(chain(o).rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
      expect(quoteRangePools(read, WSOL_MINT, 1_000_000n), JSON.stringify(o)).toEqual({ state: 'unquotable', candidates: [] });
    }
    // The mints and vaults are read with the clock, in one call.
    const c = chain();
    await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    expect(c.calls.some((k) => k[0] === CLOCK && k.includes(deriveVault(PROG, POOL, M0).toBase58()) && k.includes(M1.toBase58()))).toBe(true);
  });

  it('a pool with a dynamic fee is no candidate: it charges more than the tier’s rate the form and review state', async () => {
    const read = await readRangeRoutePools(chain({ dynamicFee: true }).rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.pools[0]!.range.pool.dynamicFeeInfo).not.toBeNull();
    expect(quoteRangePools(read, WSOL_MINT, 1_000_000n)).toEqual({ state: 'unquotable', candidates: [] });
  });

  it('a vault that does not read makes the answer an error, never "no pool" and never a quote', async () => {
    const read = await readRangeRoutePools(chain({ vaultMissing: true }).rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    expect(quoteRangePools(read, WSOL_MINT, 1_000_000n)).toEqual({ state: 'error', candidates: [] });
    // That pool alone is unread: another pool of the pair, read whole, still quotes.
    const both = await readRangeRoutePools(chain({ vaultMissing: true, secondPool: true }).rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    if (both.kind !== 'ok') throw new Error(both.kind);
    expect([both.unread, both.pools.map((p) => p.range.pool.address)]).toEqual([1, [POOL1.toBase58()]]);
    expect(quoteRangePools(both, WSOL_MINT, 1_000_000n).candidates.map((c) => c.poolAddress)).toEqual([POOL1.toBase58()]);
  });

  it('price impact is what the trade gets less than the pool’s price before it, the pool fee included', async () => {
    const read = await readRangeRoutePools(chain().rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    // A trade too small to move the price still pays the 1% fee: about 1%, not about nothing.
    const tiny = quoteRangePools(read, WSOL_MINT, 1_000_000n).candidates[0]!;
    const impact = tiny.quote.priceImpact;
    expect(impact).toBeGreaterThan(0.0099);
    expect(impact).toBeLessThan(0.0102);
    expect(tiny.priceImpact).toBe(impact);
    // At the pool's price before the trade, what the trade got is (1 - impact) of it.
    const s = Number(SQRT) / 2 ** 64;
    const zeroForOne = WSOL_MINT === M0.toBase58();
    const spot = zeroForOne ? 1_000_000 * s * s : 1_000_000 / (s * s);
    expect(Number(tiny.outAmount) / spot).toBeCloseTo(1 - impact, 9);
  });

  it('a pair with no range pool on any tier is absent', async () => {
    const c = chain({ pool: false, band: false });
    const read = await readRangeRoutePools(c.rpc, WSOL_MINT, BAYLA_MINT, { programId: PROG, visible: true });
    expect(quoteRangePools(read, WSOL_MINT, 1_000_000n).state).toBe('absent');
  });
});

describe('two answers about our pools, as one', () => {
  it('any quote wins; then pending; then an error; then one that cannot trade; a range answer of none changes nothing', () => {
    expect(mergeOwnStates('absent', 'quoted')).toBe('quoted');
    expect(mergeOwnStates('error', 'quoted')).toBe('quoted');
    expect(mergeOwnStates('quoted', 'error')).toBe('quoted');
    expect(mergeOwnStates('absent', 'pending')).toBe('pending');
    expect(mergeOwnStates('absent', 'error')).toBe('error');
    expect(mergeOwnStates('absent', 'unquotable')).toBe('unquotable');
    expect(mergeOwnStates('absent', 'absent')).toBe('absent');
    for (const s of ['absent', 'error', 'quoted', 'unquotable', 'pending', 'not-searched'] as const) {
      expect(mergeOwnStates(s, null)).toBe(s);
      expect(mergeOwnStates(s, 'not-searched')).toBe(s);
    }
  });
});
