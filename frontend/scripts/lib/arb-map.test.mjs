import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { MAPPED, candidates, depthUsd, fromJson, poolFromSlice, rankCoins, sidesOf, sliceParams, slices, toJson } from './arb-map.mjs';
import { DEXES, SOL_MINT, USDC_MINT, decodePool } from './arb-chain.mjs';

const SETTINGS = { maxTradeUsd: 1000, minProfitUsd: 0.01, microLamports: 10_000, lighthouseProven: false };
const COIN = bs58.encode(Buffer.from([7, ...Array(31).fill(9)]));
const key = (n) => bs58.encode(Buffer.alloc(32, n));
const tag = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const put = (b, at, mint) => Buffer.from(bs58.decode(mint)).copy(b, at);

/** A whole Raydium CPMM pool account of COIN/SOL: config, vaults, mints, a creator fee owed. */
function cpmmAccount({ owedA = 5n, creatorOn = true } = {}) {
  const b = Buffer.alloc(637);
  tag('PoolState').copy(b, 0);
  put(b, 8, key(1));
  put(b, 72, key(2));
  put(b, 104, key(3));
  put(b, 168, COIN);
  put(b, 200, SOL_MINT);
  b[390] = creatorOn ? 1 : 0;
  b.writeBigUInt64LE(owedA, 341);
  b.writeBigUInt64LE(11n, 397);
  b.writeBigUInt64LE(1_700_000_000n, 373);
  return b;
}

describe('slices', () => {
  it('cover every mapped venue, size and first byte once', () => {
    const all = slices();
    const sizes = Object.values(MAPPED).reduce((n, m) => n + m.sizes.length, 0);
    expect(all).toHaveLength(sizes * 256);
    expect(new Set(all.map((s) => `${s.dex}/${s.size}/${s.byte}`)).size).toBe(all.length);
  });

  it('ask the program for one size, one first byte of the coin, and only the front of each account', () => {
    const [program, opts] = sliceParams('ammV4', 752, 0x7a);
    expect(program).toBe(DEXES.ammV4.program);
    expect(opts.dataSlice).toEqual({ offset: 0, length: 464 });
    expect(opts.filters).toEqual([{ dataSize: 752 }, { memcmp: { offset: 400, bytes: bs58.encode(Buffer.from([0x7a])) } }]);
    // A PumpSwap pool shorter than the prefix is asked for whole, never past its end.
    expect(sliceParams('pumpswap', 243, 0)[1].dataSlice.length).toBe(243);
    expect(() => sliceParams('dlmm', 904, 0)).toThrow(/no slice/);
  });
});

describe('poolFromSlice', () => {
  it('decodes the front of a CPMM account exactly as the whole account decodes', () => {
    const whole = cpmmAccount();
    const front = whole.subarray(0, MAPPED.cpmm.prefix).toString('base64');
    const got = poolFromSlice('cpmm', 637, 'pool', front);
    expect(got).toEqual(decodePool('cpmm', 'pool', whole));
    expect(got.mintA).toBe(COIN);
    expect(got.owedA).toBe(16n); // 5 owed + 11 creator fee
    expect(got.openTime).toBe(1_700_000_000n);
  });

  it('is null for an account of another kind', () => {
    expect(poolFromSlice('cpmm', 637, 'x', Buffer.alloc(413).toString('base64'))).toBeNull();
  });
});

describe('sidesOf and candidates', () => {
  const pool = (address, mintA, mintB, stopped = null) => ({ address, dex: 'cpmm', mintA, mintB, stopped, kind: 'pair', fee: 0.0025 });

  it('name the coin and what it is priced in, whichever side each sits on', () => {
    expect(sidesOf(pool('p', COIN, SOL_MINT))).toEqual({ coin: COIN, quote: SOL_MINT });
    expect(sidesOf(pool('p', USDC_MINT, COIN))).toEqual({ coin: COIN, quote: USDC_MINT });
    expect(sidesOf(pool('p', SOL_MINT, USDC_MINT))).toBeNull();
    expect(sidesOf(pool('p', COIN, key(4)))).toBeNull();
  });

  it('keep only coins with two pools that can trade', () => {
    const other = key(5);
    const by = candidates([pool('a', COIN, SOL_MINT), pool('b', USDC_MINT, COIN), pool('c', other, SOL_MINT), pool('d', other, SOL_MINT, 'trading switched off'), pool('e', SOL_MINT, USDC_MINT)]);
    expect([...by.keys()]).toEqual([COIN]);
    expect(by.get(COIN).map((p) => p.address)).toEqual(['a', 'b']);
  });
});

describe('rankCoins', () => {
  // Two SOL pools of a 6-decimal coin: the dear one prices it 10% higher. SOL $100.
  const cheap = { address: 'cheap', dex: 'cpmm', kind: 'pair', mintA: COIN, mintB: SOL_MINT, fee: 0.0025, stopped: null };
  const dear = { address: 'dear', dex: 'pumpswap', kind: 'pair', mintA: COIN, mintB: SOL_MINT, fee: 0.0025, stopped: null };
  const depths = new Map([
    ['cheap', { a: 1e12, b: 1e11 }],
    ['dear', { a: 1e12, b: 1.1e11 }],
  ]);
  const usd = new Map([[SOL_MINT, 100], [USDC_MINT, 1]]);

  it('finds the buy-cheap-sell-dear trip and sizes the open gap after the fee', () => {
    const rows = rankCoins(new Map([[COIN, [cheap, dear]]]), { decimals: new Map([[COIN, 6]]), depths, usd, settings: SETTINGS, bridge: null });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect([r.buy, r.sell]).toEqual(['cheap', 'dear']);
    expect(r.gapPct).toBeCloseTo(10, 5);
    expect(r.gapNetUsd).toBeGreaterThan(1);
    expect(r.pays).toBe(true);
    expect(r.pools.map((p) => p.depthUsd)).toEqual([2e4, 2.2e4]);
  });

  it('leaves out a coin whose decimals were not read, and orders by what the gap holds', () => {
    const flat = { ...dear, address: 'flat' };
    const d2 = new Map([...depths, ['flat', { a: 1e12, b: 1.001e11 }]]);
    const rows = rankCoins(new Map([[COIN, [cheap, dear]], [key(6), [cheap, flat]], [key(8), [{ ...cheap, mintA: key(8) }, { ...flat, mintA: key(8) }]]]), { decimals: new Map([[COIN, 6], [key(8), 6]]), depths: d2, usd, settings: SETTINGS });
    expect(rows.map((r) => r.mint)).toEqual([COIN, key(8)]);
    expect(rows[1].gapNetUsd).toBeLessThan(rows[0].gapNetUsd);
  });

  it('prices depth from the quote side', () => {
    expect(depthUsd(cheap, depths, usd)).toBe(2e4);
    expect(depthUsd(cheap, new Map(), usd)).toBeNull();
  });
});

describe('toJson / fromJson', () => {
  it('keep 64-bit figures exact, signed ones too', () => {
    const v = { owedA: 2n ** 63n + 1n, extraB: -5n, address: 'x', n: 3 };
    expect(fromJson(toJson(v))).toEqual(v);
  });
});
