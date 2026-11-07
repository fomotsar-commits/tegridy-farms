// @vitest-environment node
//
// Direct trips: our pool against the coin's outside pool, both swaps built by the robot. The
// outside pools are read from mainnet simulations the programs accepted (directLegs.fixture.ts),
// so each venue's price here is the program's own payout; our pools come from the pool list's kit.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { quoteOwnPool } from '../cpswap/read';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { DEFAULT_LIMITS } from './plan';
import { DIRECT_LOOKUP_TABLES, directPlan, readDirectPools, type DirectPool } from './direct';
import { LEG_RUNS } from './directLegs.fixture';
import type { StreamPool } from './streams';

// Raydium's ids live in scripts/lib/raydium-programs.mjs (src/ may not name them; a test may).
const IDS = { cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', ammV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', ammV4Authority: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' };
const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const CHAIN_NOW = Math.floor(Date.now() / 1000);

/** Each fixture pool as the robot's outside-pool list names it: pool, program, and the coin it prices. */
const LISTED: Record<string, StreamPool> = {
  'Raydium AMM v4': { pool: '2wCvQzD9YgWCzMPRxAmfd4vrsiz99ko1QhCwG7sbRztW', program: IDS.ammV4, mint: 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump' },
  'Raydium CPMM': { pool: 'G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh', program: IDS.cpmm, mint: 'ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg' },
  BAYLA: { pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', program: PUMP, mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump' },
  APE: { pool: 'GiV7bAkQ6dipyPd5rFuoQeLLBJCNrRwP57dETVe6ourc', program: PUMP, mint: '2Wkip2U5x93mjaAvoq8zaedweP73GgRtbaQhNcwXpump' },
};
const runOf = (pool: string) => LEG_RUNS.find((r) => r.pool === pool)!;

/** A chain that knows every fixture account, answering getMultipleAccounts as an RPC does. */
const accounts = new Map<string, { owner: string; data: string }>(LEG_RUNS.flatMap((r) => Object.entries(r.accounts as Record<string, { owner: string; data: string }>)));
const rpc = async (method: string, params: unknown[]) => {
  if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
  const keys = params[0] as string[];
  return { context: { slot: 1 }, value: keys.map((k) => { const a = accounts.get(k); return a ? { data: [a.data, 'base64'], owner: a.owner, lamports: 1, executable: false, rentEpoch: 0 } : null; }) };
};

describe('readDirectPools: each outside pool priced as its program paid on mainnet', () => {
  for (const [name, listed] of Object.entries(LISTED)) {
    it(`${name}: 0.01 SOL buys exactly what the program paid`, async () => {
      const [d] = await readDirectPools(rpc, [listed], IDS, CHAIN_NOW, () => 0);
      const r = runOf(listed.pool);
      expect(d?.tokenMint).toBe(listed.mint);
      expect(d!.buy(BigInt(r.amountIn))!.tokens).toBe(BigInt(r.out));
      // The sell prices the same pool the other way: never more SOL back than went in.
      expect(d!.sell(BigInt(r.out))!).toBeLessThan(BigInt(r.amountIn));
    });
  }
  it('reads Raydium pools only when Raydium is allowed (ids given); PumpSwap always', async () => {
    const all = Object.values(LISTED);
    expect((await readDirectPools(rpc, all, IDS, CHAIN_NOW)).map((d) => d.venue).sort()).toEqual(['PumpSwap', 'PumpSwap', 'Raydium AMM v4', 'Raydium CPMM']);
    expect((await readDirectPools(rpc, all, null, CHAIN_NOW)).map((d) => d.venue)).toEqual(['PumpSwap', 'PumpSwap']);
  });
  it('skips a listing whose account another program owns, or that names another coin', async () => {
    expect(await readDirectPools(rpc, [{ ...LISTED.BAYLA!, program: IDS.cpmm }], IDS, CHAIN_NOW)).toEqual([]);
    expect(await readDirectPools(rpc, [{ ...LISTED['Raydium CPMM']!, program: PUMP }], IDS, CHAIN_NOW)).toEqual([]);
    expect(await readDirectPools(rpc, [{ ...LISTED.BAYLA!, mint: LISTED.APE!.mint }], IDS, CHAIN_NOW)).toEqual([]);
  });
  it('trusts the chain, not the listing, for who owns the pool: a PumpSwap layout another program owns is skipped', async () => {
    const impostor = async (method: string, params: unknown[]) => {
      const r = (await rpc(method, params)) as { value: ({ owner: string } | null)[] };
      return { ...r, value: r.value.map((v, i) => ((params[0] as string[])[i] === LISTED.BAYLA!.pool && v ? { ...v, owner: key().toBase58() } : v)) };
    };
    expect(await readDirectPools(impostor, [LISTED.BAYLA!], IDS, CHAIN_NOW)).toEqual([]);
  });
  it('builds both swaps for every venue, with the buyback recipient chosen by `pick`', async () => {
    const owner = new PublicKey('9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz');
    for (const d of await readDirectPools(rpc, Object.values(LISTED), IDS, CHAIN_NOW, () => 0.99)) {
      const r = runOf(d.address);
      expect(d.buyIx(owner, BigInt(r.amountIn), BigInt(r.out))).not.toBeNull();
      expect(d.sellIx(owner, BigInt(r.out), 1n)).not.toBeNull();
    }
    const [pump] = await readDirectPools(rpc, [LISTED.BAYLA!], null, CHAIN_NOW, () => 0.99);
    const keys = pump!.buyIx(owner, 10_000_000n, 1n)!.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain('5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD');
  });
  it('compiles with a lookup table: a PumpSwap trip does not fit one transaction without one', () => {
    expect(DIRECT_LOOKUP_TABLES.length).toBeGreaterThan(0);
    for (const t of DIRECT_LOOKUP_TABLES) expect(new PublicKey(t).toBase58()).toBe(t);
  });
});

describe('directPlan: the best trip between our pool and the outside pool', () => {
  const NOW = 10_000_000;
  const SOL = 10n ** 9n;
  const usd = new Map([[SOL_QUOTE.mint, 200]]);
  const mint = key();
  const ours = buildPool({ mint, address: key(), quoteReserve: 50n * SOL, tokenReserve: 10n ** 9n });
  const view = viewOf(ours, { sol: 50n * SOL, tok: 10n ** 9n });
  const wide = { ...DEFAULT_LIMITS, maxTradeUsd: 10_000, lighthouseProven: true };
  const lots = 100n * SOL;

  /** An outside pool on x·y = k, 0.25% off what goes in, rounded as the programs round; `takes` of each buy's SOL is spent. */
  const outside = (sol: bigint, tok: bigint, takes = 1000n): DirectPool => {
    const out = (rin: bigint, rout: bigint, x: bigint) => {
      const xin = x - (x * 25n + 9_999n) / 10_000n;
      return (rout * xin) / (rin + xin);
    };
    return {
      address: key().toBase58(), venue: 'PumpSwap', tokenMint: mint.toBase58(),
      buy: (x) => {
        const tokens = out(sol, tok, x);
        return tokens > 0n ? { tokens, spent: (x * takes) / 1000n } : null;
      },
      sell: (t) => out(tok, sol, t),
      buyIx: () => null,
      sellIx: () => null,
    };
  };
  const ourOut = (from: string, x: bigint) => quoteOwnPool(view.snapshot, view.config!, from, x, NOW)!.outAmount;

  it('buys in our pool and sells outside when the coin is dearer outside, at the size that makes the most', () => {
    const d = outside(50n * SOL, 9n * 10n ** 8n);
    const p = directPlan(view, d, NOW, usd, wide, lots)!;
    expect(p.buyIn).toBe('ours');
    expect(p.tokens).toBe(ourOut(SOL_QUOTE.mint, p.coinIn));
    expect(p.coinOut).toBe(d.sell(p.tokens));
    expect(p.profit).toBe(p.coinOut - p.coinIn);
    const made = (x: bigint) => d.sell(ourOut(SOL_QUOTE.mint, x))! - x;
    expect(made((p.coinIn * 9n) / 10n)).toBeLessThan(p.profit);
    expect(made((p.coinIn * 11n) / 10n)).toBeLessThan(p.profit);
    expect(p.minProfit).toBe(69_000n);
  });
  it('buys outside and sells in our pool when the coin is cheaper outside', () => {
    const d = outside(50n * SOL, 11n * 10n ** 8n);
    const p = directPlan(view, d, NOW, usd, wide, lots)!;
    expect(p.buyIn).toBe('outside');
    expect(p.tokens).toBe(d.buy(p.coinIn)!.tokens);
    expect(p.coinOut).toBe(ourOut(mint.toBase58(), p.tokens));
    expect(p.profit).toBe(p.coinOut - p.coinIn);
  });
  it('counts what a buy really takes (a PumpSwap buy can take less than offered), not what was offered, and sizes by it', () => {
    const d = outside(50n * SOL, 11n * 10n ** 8n, 990n);
    const p = directPlan(view, d, NOW, usd, wide, lots)!;
    expect(p.spent).toBe((p.coinIn * 990n) / 1000n);
    expect(p.profit).toBe(p.coinOut - p.spent);
    // No other size makes more, counted the same way.
    const made = (x: bigint) => ourOut(mint.toBase58(), d.buy(x)!.tokens) - d.buy(x)!.spent;
    for (let pct = 80n; pct <= 120n; pct++) expect(made((p.coinIn * pct) / 100n)).toBeLessThanOrEqual(p.profit);
  });
  it('finds no trip when the prices agree within the two fees', () => {
    expect(directPlan(view, outside(50n * SOL, 10n ** 9n), NOW, usd, wide, lots)).toBeNull();
    expect(directPlan(view, outside(50n * SOL, 1_005_000_000n), NOW, usd, wide, lots)).toBeNull();
  });
  it('never spends more than the keeper holds, or than a trip may be', () => {
    const d = outside(50n * SOL, 9n * 10n ** 8n);
    expect(directPlan(view, d, NOW, usd, wide, SOL / 10n)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
    expect(directPlan(view, d, NOW, usd, { ...wide, maxTradeUsd: 20 }, lots)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
    expect(directPlan(view, d, NOW, usd, wide, 0n)).toBeNull();
  });
  it('trades only our SOL pool of the same coin', () => {
    const d = outside(50n * SOL, 9n * 10n ** 8n);
    const usdcPool = viewOf(buildPool({ mint, address: key(), quoteReserve: 50n * 10n ** 6n, tokenReserve: 10n ** 9n, quote: USDC_QUOTE }), { sol: 50n * 10n ** 6n, tok: 10n ** 9n });
    expect(directPlan(usdcPool, d, NOW, new Map([...usd, [USDC_QUOTE.mint, 1]]), wide, lots)).toBeNull();
    expect(directPlan(view, { ...d, tokenMint: key().toBase58() }, NOW, usd, wide, lots)).toBeNull();
  });
});
