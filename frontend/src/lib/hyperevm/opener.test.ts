// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { HYPEREVM_TOKENS, WHYPE, hyperEvmVenueFrom, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import { coinFrom, copiedName, lookalikeOf, readCoins } from './coins';
import { POOL_OPENER_ABI, listTx, openTx, openerTerms, openingFee, parsePrice, poolAt, sortedPair, startSqrtPrice, usingBigBlocks } from './opener';
import { buildSwapTx, quoteSwap, siteFeeOnInput } from './swap';
import { UNIVERSAL_ROUTER_ABI } from '../evm/universalRouter';
import { readPools, type HyperEvmReader, type ReadCall, type ReadResult } from './pools';

/**
 * Opening a pool from the site: the coin is named by its own contract ("fake USDC" for a copy),
 * the starting price is encoded the way Uniswap's pool reads it whichever way the two coins
 * sort, the transaction pays exactly the opener's fee, and the pools it opened are listed.
 * The chain is a table of answers; the fake addresses are not contracts.
 */
const OPENER = '0x1000000000000000000000000000000000000007' as const;
const BASE = {
  factory: '0x1000000000000000000000000000000000000001',
  positionManager: '0x1000000000000000000000000000000000000002',
  quoterV2: '0x1000000000000000000000000000000000000003',
  universalRouter: '0x1000000000000000000000000000000000000004',
  feeAdapter: '0x1000000000000000000000000000000000000005',
  treasury: '0x1000000000000000000000000000000000000006',
  siteFeeBps: 50,
} as const;
const VENUE: HyperEvmVenue = hyperEvmVenueFrom({ ...BASE, poolOpener: OPENER })!;
const [HYPE, WHYPE_T, USDT0, USDC] = HYPEREVM_TOKENS as [HyperEvmToken, HyperEvmToken, HyperEvmToken, HyperEvmToken];
const LOW = '0x0000000000000000000000000000000000000aaa' as const; // sorts before every listed coin
const HIGH = '0xfffffffffffffffffffffffffffffffffffff001' as const; // sorts after every listed coin
const coin = (address: `0x${string}`, symbol = 'PEPE', decimals = 18): HyperEvmToken => ({ address, symbol, name: symbol, decimals, unlisted: true });

type Answer = (c: ReadCall) => unknown;
/** A reader that answers each call from `answer`; a thrown answer is a failed call. */
function chain(answer: Answer, calls: ReadCall[] = []): HyperEvmReader {
  return {
    simulateContract: async () => ({ result: [] }),
    multicall: async ({ contracts }) => contracts.map((c): ReadResult => {
      calls.push(c);
      try {
        return { status: 'success', result: answer(c) };
      } catch {
        return { status: 'failure' };
      }
    }),
  };
}
const ZERO = '0x0000000000000000000000000000000000000000';
const Q96 = 1n << 96n;

/** token1 per token0 in whole coins, from a pool price. */
function priceOf(sqrt: bigint, t0: HyperEvmToken, t1: HyperEvmToken): number {
  return (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (t0.decimals - t1.decimals);
}

describe('a coin off the list', () => {
  it('shows its own ticker and name, cleaned, and the listed coin when it is one', () => {
    expect(coinFrom(HIGH, 'PEPE', 'Pepe on Hyper', 18)).toEqual({ address: HIGH, symbol: 'PEPE', name: 'Pepe on Hyper', decimals: 18, unlisted: true });
    expect(coinFrom(USDC.address, 'whatever', 'x', 6)).toBe(USDC);
    expect(coinFrom(WHYPE, 'X', 'x', 18)).toBe(WHYPE_T);
  });

  it('reads "fake X" when its ticker or name copies HYPE, USDC or USD₮0 at another address', () => {
    expect(coinFrom(HIGH, 'USDC', 'Real Money', 6)?.symbol).toBe('fake USDC');
    expect(coinFrom(HIGH, 'USDT', 'x', 6)?.symbol).toBe('fake USDT');
    expect(coinFrom(HIGH, 'XYZ', 'Wrapped HYPE', 18)?.symbol).toBe('fake XYZ');
    expect(copiedName(HIGH, ['usdc'])).toBe('USDC');
    expect(copiedName(USDC.address, ['USDC'])).toBeNull();
    expect(copiedName(HIGH, ['PEPE', 'Pepe'])).toBeNull();
  });

  it('is no coin when it gives no ticker or decimals a pool could use', () => {
    expect(coinFrom(HIGH, '', 'name', 18)).toBeNull();
    expect(coinFrom(HIGH, 'OK', 'name', 37)).toBeNull();
    expect(coinFrom(HIGH, 'OK', 'name', 1.5)).toBeNull();
    expect(coinFrom(HIGH, 42, 'name', 18)).toBeNull();
  });

  it('is read in one batch, and a contract that does not answer is null', async () => {
    const calls: ReadCall[] = [];
    const reader = chain((c) => {
      if (c.address === LOW) throw new Error('no code');
      return c.functionName === 'decimals' ? 9 : c.functionName === 'symbol' ? 'DOG' : 'Dog';
    }, calls);
    const m = await readCoins(reader, [HIGH, LOW, USDC.address]);
    expect(m.get(HIGH.toLowerCase())).toEqual({ address: HIGH, symbol: 'DOG', name: 'Dog', decimals: 9, unlisted: true });
    expect(m.get(LOW.toLowerCase())).toBeNull();
    expect(m.get(USDC.address.toLowerCase())).toBe(USDC);
    expect(calls.some((c) => c.address === USDC.address)).toBe(false); // a listed coin is never asked
  });
});

describe('the starting price', () => {
  it('HYPE/USDC at 65.9935 is the price our live HYPE/USDC pool opened at (2026-11-26)', () => {
    const sqrt = startSqrtPrice('65.9935', HYPE, USDC)!;
    const live = 643620956996009200720045n; // read from 0x232426a14736fc4ea1a9ead17a31c20c51869c67
    expect(Math.abs(Number(sqrt - live)) / Number(live)).toBeLessThan(1e-6);
  });

  it('means the same pool price whichever coin is typed first', () => {
    const [t0, t1] = sortedPair(HYPE, USDC);
    expect(t0.address).toBe(WHYPE);
    const a = startSqrtPrice('50', HYPE, USDC)!; // 1 HYPE = 50 USDC
    const b = startSqrtPrice('0.02', USDC, HYPE)!; // 1 USDC = 0.02 HYPE
    expect(priceOf(a, t0, t1)).toBeCloseTo(50, 6);
    expect(priceOf(b, t0, t1)).toBeCloseTo(50, 6);
  });

  it('puts a new coin on the right side: 1 PEPE = 0.001 HYPE, PEPE sorting first and last', () => {
    for (const addr of [LOW, HIGH]) {
      const p = coin(addr);
      const [t0, t1] = sortedPair(p, HYPE);
      const sqrt = startSqrtPrice('0.001', p, HYPE)!;
      const hypePerPepe = t0.address === addr ? priceOf(sqrt, t0, t1) : 1 / priceOf(sqrt, t0, t1);
      expect(hypePerPepe).toBeCloseTo(0.001, 9);
    }
  });

  it('is no price for nothing, zero, words, or a price no pool can hold', () => {
    expect(startSqrtPrice('', HYPE, USDC)).toBeNull();
    expect(startSqrtPrice('0', HYPE, USDC)).toBeNull();
    expect(startSqrtPrice('abc', HYPE, USDC)).toBeNull();
    // Uniswap's ceiling is about 3.4e38 in smallest units: 1e51 USDC per HYPE is 1e39.
    expect(startSqrtPrice('1' + '0'.repeat(51), HYPE, USDC)).toBeNull();
    expect(startSqrtPrice('1' + '0'.repeat(42), HYPE, USDC)).not.toBeNull(); // 1e30: still inside
  });
});

describe('the opening transaction', () => {
  it('calls the opener with the coins sorted and pays exactly its fee', () => {
    const tx = openTx(OPENER, USDC, HYPE, 3000, Q96, 230_000_000_000_000_000n);
    expect(tx.to).toBe(OPENER);
    expect(tx.value).toBe(230_000_000_000_000_000n);
    expect(tx.data.slice(0, 10)).toBe('0xa7c73714'); // open(address,address,uint24,uint160)
    const { args } = decodeFunctionData({ abi: POOL_OPENER_ABI, data: tx.data });
    expect(args).toEqual([WHYPE, USDC.address, 3000, Q96]);
  });

  it('reads the fee from the opener itself', async () => {
    expect(await openingFee(chain((c) => (c.functionName === 'POOL_OPENING_FEE' ? 230_000_000_000_000_000n : 0n)), OPENER)).toBe(230_000_000_000_000_000n);
    expect(await openingFee(chain(() => { throw new Error('x'); }), OPENER)).toBeNull();
  });

  it('tells a new pool from one made but never priced, and from one already open', async () => {
    const P = '0x3000000000000000000000000000000000000003' as const;
    const at = (getPool: string, price: bigint) => poolAt(chain((c) => (c.functionName === 'getPool' ? getPool : [price, 0, 0, 0, 0, 0, true])), VENUE, coin(HIGH), HYPE, 3000);
    expect(await at(ZERO, 0n)).toEqual({ kind: 'none' });
    expect(await at(P, 0n)).toEqual({ kind: 'unpriced', address: P });
    expect(await at(P, Q96)).toEqual({ kind: 'open', address: P });
    expect(await poolAt(chain(() => { throw new Error('x'); }), VENUE, coin(HIGH), HYPE, 3000)).toBeNull();
  });

  it("reads the wallet's big-block setting, and an answer that is not yes or no is unread", async () => {
    expect(await usingBigBlocks(async () => true, HIGH)).toBe(true);
    expect(await usingBigBlocks(async () => false, HIGH)).toBe(false);
    expect(await usingBigBlocks(async () => '0x1', HIGH)).toBeNull();
    expect(await usingBigBlocks(async () => { throw new Error('method not found'); }, HIGH)).toBeNull();
  });
});

describe('the pool list, with pools opened through the opener', () => {
  const LISTED = '0x4000000000000000000000000000000000000001';
  const NEWPOOL = '0x4000000000000000000000000000000000000002';
  const state = (c: ReadCall) => {
    if (c.functionName === 'slot0') return [Q96, 0, 0, 0, 0, 0x66, true];
    if (c.functionName === 'liquidity') return 0n;
    if (c.functionName === 'balanceOf') return 0n;
    throw new Error(`unexpected ${c.functionName}`);
  };
  const answers = (opened: string[]): Answer => (c) => {
    if (c.functionName === 'getPool') {
      const [a, b, fee] = c.args as [string, string, number];
      return a === WHYPE && b === USDC.address && fee === 3000 ? LISTED : ZERO;
    }
    if (c.address === OPENER && c.functionName === 'poolCount') return BigInt(opened.length);
    if (c.address === OPENER && c.functionName === 'pools') return opened[Number((c.args as [bigint])[0])];
    if (c.address === NEWPOOL && c.functionName === 'token0') return WHYPE;
    if (c.address === NEWPOOL && c.functionName === 'token1') return HIGH;
    if (c.address === NEWPOOL && c.functionName === 'fee') return 10000;
    if (c.address === LISTED && c.functionName === 'token0') return WHYPE;
    if (c.address === LISTED && c.functionName === 'token1') return USDC.address;
    if (c.address === LISTED && c.functionName === 'fee') return 3000;
    if (c.address === HIGH) return c.functionName === 'decimals' ? 18 : c.functionName === 'symbol' ? 'USDC' : 'not USDC';
    return state(c);
  };

  it('adds them after our listed pools, once each, with their coin named by its own contract', async () => {
    const r = await readPools(chain(answers([LISTED, NEWPOOL])), VENUE);
    if (!r.ok) throw new Error('unread');
    expect(r.pools.map((p) => p.address)).toEqual([LISTED, NEWPOOL]);
    const opened = r.pools[1]!;
    expect(opened.token0).toBe(WHYPE_T);
    expect(opened.token1).toEqual({ address: HIGH, symbol: 'fake USDC', name: 'not USDC', decimals: 18, unlisted: true });
    expect([opened.fee, opened.tickSpacing, opened.venueShare0]).toEqual([10000, 200, 6]);
  });

  it('is "could not read" if the opener does not answer, never a shorter list', async () => {
    const r = await readPools(chain((c) => {
      if (c.address === OPENER) throw new Error('x');
      return answers([])(c);
    }), VENUE);
    expect(r).toEqual({ ok: false });
  });

  it('without an opener deployed, reads only the listed pools and never asks it', async () => {
    const calls: ReadCall[] = [];
    const r = await readPools(chain(answers([NEWPOOL]), calls), hyperEvmVenueFrom(BASE)!);
    expect(r.ok && r.pools.map((p) => p.address)).toEqual([LISTED]);
    expect(calls.some((c) => c.address === OPENER)).toBe(false);
  });

  it('keeps USD₮0 and the other listed coins as listed, never "fake"', () => {
    expect(coinFrom(USDT0.address, 'USDT0', 'x', 6)).toBe(USDT0);
  });
});

describe('after the review (2026-11-27)', () => {
  it('one coin that does not answer drops only its own pool, never the whole list', async () => {
    const BAD = '0xfffffffffffffffffffffffffffffffffffff0bd' as const;
    const GOODPOOL = '0x4000000000000000000000000000000000000003';
    const BADPOOL = '0x4000000000000000000000000000000000000004';
    const LISTED = '0x4000000000000000000000000000000000000001';
    const reader: HyperEvmReader = {
      simulateContract: async () => ({ result: [] }),
      // A batch holding any call to the bad coin throws, as a gas-burning call can make the whole read fail.
      multicall: async ({ contracts }) => {
        if (contracts.some((c) => c.address.toLowerCase() === BAD)) {
          if (contracts.length > 3) throw new Error('out of gas');
          return contracts.map(() => ({ status: 'failure' as const }));
        }
        return contracts.map((c): ReadResult => {
          const r = (x: unknown): ReadResult => ({ status: 'success', result: x });
          if (c.functionName === 'getPool') {
            const [a, b, fee] = c.args as [string, string, number];
            return r(a === WHYPE && b === USDC.address && fee === 3000 ? LISTED : ZERO);
          }
          if (c.address === OPENER && c.functionName === 'poolCount') return r(2n);
          if (c.address === OPENER && c.functionName === 'pools') return r((c.args as [bigint])[0] === 0n ? GOODPOOL : BADPOOL);
          if (c.functionName === 'token0') return r(c.address === LISTED ? WHYPE : WHYPE);
          if (c.functionName === 'token1') return r(c.address === BADPOOL ? BAD : c.address === LISTED ? USDC.address : HIGH);
          if (c.functionName === 'fee') return r(3000);
          if (c.address === HIGH) return r(c.functionName === 'decimals' ? 18 : 'PEPE');
          if (c.functionName === 'slot0') return r([Q96, 0, 0, 0, 0, 0x66, true]);
          return r(0n);
        });
      },
    };
    const r = await readPools(reader, VENUE);
    if (!r.ok) throw new Error('the whole list was blanked');
    expect(r.pools.map((p) => p.address)).toEqual([LISTED, GOODPOOL]);
  });

  it('a coin that answers its ticker but not balanceOf drops only its pool', async () => {
    const r = await readPools(chain((c) => {
      if (c.functionName === 'balanceOf' && c.address === HIGH) throw new Error('reverts');
      if (c.functionName === 'getPool') return ZERO;
      if (c.address === OPENER && c.functionName === 'poolCount') return 1n;
      if (c.address === OPENER && c.functionName === 'pools') return '0x4000000000000000000000000000000000000002';
      if (c.functionName === 'token0') return WHYPE;
      if (c.functionName === 'token1') return HIGH;
      if (c.functionName === 'fee') return 3000;
      if (c.address === HIGH) return c.functionName === 'decimals' ? 18 : 'PEPE';
      if (c.functionName === 'slot0') return [Q96, 0, 0, 0, 0, 0x66, true];
      return 0n;
    }), VENUE);
    expect(r).toEqual({ ok: true, pools: [] });
  });

  it('shows only opened pools paired with a listed coin', async () => {
    const r = await readPools(chain((c) => {
      if (c.functionName === 'getPool') return ZERO;
      if (c.address === OPENER && c.functionName === 'poolCount') return 1n;
      if (c.address === OPENER && c.functionName === 'pools') return '0x4000000000000000000000000000000000000002';
      if (c.functionName === 'token0') return LOW;
      if (c.functionName === 'token1') return HIGH; // two coins off the list
      if (c.functionName === 'fee') return 3000;
      if (c.functionName === 'decimals') return 18;
      if (c.functionName === 'symbol' || c.functionName === 'name') return 'X';
      if (c.functionName === 'slot0') return [Q96, 0, 0, 0, 0, 0x66, true];
      return 0n;
    }), VENUE);
    expect(r).toEqual({ ok: true, pools: [] });
  });

  it('reads a price exactly, refuses thousands marks, and takes tiny prices against a 6-decimal coin', () => {
    expect(parsePrice('1,000')).toEqual({ ok: false, why: 'grouped' });
    expect(parsePrice('12,345,678.5')).toEqual({ ok: false, why: 'grouped' });
    expect(parsePrice('1.000,5')).toEqual({ ok: false, why: 'grouped' });
    expect(parsePrice('1,5')).toMatchObject({ ok: true, shown: '1.5' });
    expect(parsePrice('0001000')).toMatchObject({ ok: true, num: 1000n, den: 1n, shown: '1000' });
    expect(parsePrice('0.000000000123')).toMatchObject({ ok: true, num: 123n, den: 10n ** 12n, shown: '0.000000000123' });
    expect(parsePrice('-1')).toEqual({ ok: false, why: 'bad' });
    expect(parsePrice('0.0')).toEqual({ ok: false, why: 'bad' });
    // 1 PEPE = 0.000000000123 USDC: below USDC's own 6 decimals, still an exact price.
    const p = coin(HIGH);
    const [t0, t1] = sortedPair(p, USDC);
    const sqrt = startSqrtPrice('0.000000000123', p, USDC)!;
    const usdcPerPepe = t0.address === HIGH ? priceOf(sqrt, t0, t1) : 1 / priceOf(sqrt, t0, t1);
    expect(usdcPerPepe / 1.23e-10).toBeCloseTo(1, 6);
  });

  it('warns on a ticker that merely contains a listed one, and sets a right-to-left ticker apart', () => {
    expect(coinFrom(HIGH, 'USDC.e', 'Bridged', 6)).toMatchObject({ symbol: 'USDC.e', lookalike: 'USDC' });
    expect(coinFrom(HIGH, 'kHYPE', 'Kinetiq Staked HYPE', 18)).toMatchObject({ symbol: 'kHYPE', lookalike: 'HYPE' });
    expect(coinFrom(HIGH, 'PEPE', 'Pepe', 18)?.lookalike).toBeUndefined();
    expect(lookalikeOf(USDC.address, ['USDC.e'])).not.toBe('USDC'); // the real USDC is never its own look-alike
    const rtl = 'שקל'; // three Hebrew letters
    expect(coinFrom(HIGH, rtl, rtl, 18)?.symbol).toBe(`\u2068${rtl}\u2069`);
  });

  it('lists a pool for the fee, and reads the treasury the opener really pays', async () => {
    const P = '0x3000000000000000000000000000000000000003' as const;
    const tx = listTx(OPENER, P, 230_000_000_000_000_000n);
    expect([tx.to, tx.value]).toEqual([OPENER, 230_000_000_000_000_000n]);
    expect(decodeFunctionData({ abi: POOL_OPENER_ABI, data: tx.data })).toMatchObject({ functionName: 'list', args: [P] });
    const terms = await openerTerms(chain((c) => (c.functionName === 'POOL_OPENING_FEE' ? 7n : '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0')), OPENER);
    expect(terms).toEqual({ fee: 7n, treasury: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0' });
  });

  it('buying a coin off the list with USDC: quoted on what reaches the pool, and built fee-from-input', async () => {
    const pepe = coin(HIGH);
    const [t0, t1] = sortedPair(pepe, USDC);
    const pool = { address: '0x4000000000000000000000000000000000000009' as const, token0: t0, token1: t1, fee: 3000, tickSpacing: 60, sqrtPriceX96: Q96, tick: 0, liquidity: 10n ** 18n, reserve0: 0n, reserve1: 0n, venueShare0: 6, venueShare1: 6 };
    const asked: bigint[] = [];
    const quoter: HyperEvmReader = {
      multicall: async () => [],
      simulateContract: async (c: ReadCall) => {
        const [p] = c.args as [{ amountIn: bigint }];
        asked.push(p.amountIn);
        return { result: [p.amountIn * 2n, 0n, 0, 0n] };
      },
    };
    const q = await quoteSwap(quoter, VENUE, [pool], USDC, pepe, 10_000n);
    if (!q.ok) throw new Error('no quote');
    expect(asked).toEqual([9_950n]); // 0.5% left the USDC first
    expect(q.best.siteFee).toEqual({ amount: 50n, token: USDC });
    expect(q.best.out).toBe(19_900n); // nothing taken from the coin coming out
    const tx = buildSwapTx({ venue: VENUE, quote: q.best, minOut: 19_000n, deadline: 1n });
    const { args } = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data });
    expect(args[0]).toBe('0x020600'); // PERMIT2_TRANSFER_FROM, PAY_PORTION, V3_SWAP_EXACT_IN
    expect(tx.value).toBe(0n);
  });

  it('takes the site fee from the coin going in when buying a coin off the list', () => {
    const pepe = coin(HIGH);
    expect(siteFeeOnInput(USDC, pepe)).toBe(true);
    expect(siteFeeOnInput(HYPE, pepe)).toBe(true);
    expect(siteFeeOnInput(pepe, USDC)).toBe(false); // selling it: paid in the USDC coming out
    expect(siteFeeOnInput(USDC, USDT0)).toBe(false);
  });
});
