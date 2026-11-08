// @vitest-environment node
//
// The outside pools the robot listens to: a listing's deepest few per coin, kept only once the
// chain says one of the six exchanges owns each; and what counts as a trade that landed.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { STREAM_POOLS_MAX, STREAM_POOLS_PER_COIN, listedPools, streamPools, tradeLanded } from './streams';

const addr = () => Keypair.generate().publicKey.toBase58();
const SOL = 'So11111111111111111111111111111111111111112';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const pair = (base: string, quote: string, usd: number, over: Record<string, unknown> = {}) => ({
  chainId: 'solana',
  dexId: 'pumpswap',
  pairAddress: addr(),
  baseToken: { address: base, symbol: 'X' },
  quoteToken: { address: quote, symbol: 'SOL' },
  liquidity: { usd },
  ...over,
});

describe('listedPools', () => {
  const coin = addr();
  const other = addr();
  const coins = new Set([coin, other]);

  it('is the pools of the robot’s coins on Solana, deepest first', () => {
    const deep = pair(coin, SOL, 900);
    const shallow = pair(SOL, coin, 10);
    const notOurs = pair(addr(), SOL, 5_000);
    const elsewhere = pair(coin, SOL, 9_000, { chainId: 'base' });
    expect(listedPools([shallow, notOurs, elsewhere, deep], coins)).toEqual([
      { pool: deep.pairAddress, mint: coin },
      { pool: shallow.pairAddress, mint: coin },
    ]);
  });

  it('keeps at most the deepest few per coin, and each pool once', () => {
    const rows = [1, 2, 3, 4, 5].map((usd) => pair(coin, SOL, usd));
    const twice = { ...pair(other, SOL, 0.5), pairAddress: rows[4]!.pairAddress };
    const got = listedPools([...rows, twice], coins);
    expect(got.filter((p) => p.mint === coin).map((p) => p.pool)).toEqual([rows[4]!, rows[3]!, rows[2]!].map((r) => r.pairAddress));
    expect(got.filter((p) => p.mint === coin)).toHaveLength(STREAM_POOLS_PER_COIN);
    expect(new Set(got.map((p) => p.pool)).size).toBe(got.length);
  });

  it('keeps at most STREAM_POOLS_MAX in all', () => {
    const many = Array.from({ length: 40 }, () => addr());
    const rows = many.flatMap((m) => [pair(m, SOL, 3), pair(m, SOL, 2)]);
    expect(listedPools(rows, new Set(many))).toHaveLength(STREAM_POOLS_MAX);
  });

  it('reads nothing from a listing that is not one, or a row that names no pool address', () => {
    expect(listedPools({ pairs: [] }, coins)).toEqual([]);
    expect(listedPools([null, 'x', pair(coin, SOL, 1, { pairAddress: 'not-an-address' })], coins)).toEqual([]);
  });
});

describe('streamPools', () => {
  it('keeps only the pools the chain says one of the exchanges owns', () => {
    const coin = addr();
    const [a, b, c] = [addr(), addr(), addr()];
    const owners = new Map<string, string | null>([
      [a, PUMPSWAP],
      [b, '11111111111111111111111111111111'],
      [c, null],
    ]);
    const listed = [a, b, c, addr()].map((pool) => ({ pool, mint: coin }));
    expect(streamPools(listed, owners, [PUMPSWAP, ORCA])).toEqual([{ pool: a, program: PUMPSWAP, mint: coin }]);
  });
});

describe('tradeLanded', () => {
  const ran = [`Program ${ORCA} invoke [1]`, 'Program log: Instruction: Swap', `Program ${ORCA} success`];

  it('is a trade with no error in which the pool’s exchange ran', () => {
    expect(tradeLanded({ signature: 's', err: null, logs: ran }, ORCA)).toBe(true);
    // Run inside an aggregator's route: still that exchange, one level down.
    expect(tradeLanded({ err: null, logs: ['Program JUP invoke [1]', `Program ${ORCA} invoke [2]`] }, ORCA)).toBe(true);
  });

  it('is not a trade that failed, nor one in which the exchange never ran', () => {
    expect(tradeLanded({ err: { InstructionError: [2, { Custom: 6001 }] }, logs: ran }, ORCA)).toBe(false);
    expect(tradeLanded({ err: null, logs: [`Program ${PUMPSWAP} invoke [1]`, `Program log: ${ORCA}`] }, ORCA)).toBe(false);
    expect(tradeLanded({ logs: ran }, ORCA)).toBe(false);
    expect(tradeLanded({ err: null }, ORCA)).toBe(false);
    expect(tradeLanded(null, ORCA)).toBe(false);
  });
});
