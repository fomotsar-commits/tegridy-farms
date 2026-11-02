// @vitest-environment node
//
// The list of every pool, shown before a token is picked: the index names addresses, the
// browser reads and checks each one, and an index that did not answer is never "no pools".
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ARB_FLOOR_USD,
  LITTLE_MONEY_TEXT,
  PRICE_IDS_MAX,
  QUIET_SECS,
  arbitrage,
  byWorth,
  listPools,
  marketGap,
  pairSwapLink,
  poolRankUsd,
  poolWorthUsd,
  priceGap,
  rankArbitrage,
  readMarketPrices,
  poolTags,
  rowTokenFee,
  swapLink,
  unsizedPools,
  type PoolList,
} from './poolList';
import { poolFeesOf } from './liquidityMath';
import type { TransferFee } from './transferFee';
import { quoteOwnPool } from '../cpswap/read';
import { readPoolIndex } from './poolIndex';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeRpc, key, observationBytes, viewOf, type FakeAccount } from './testkit.fixture';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import { PRICE_TOLERANCE } from './poolHealth';
import { decodeObservationState } from './ownPrice';
import type { PoolView } from './poolFinder';
import { BAYLA_MINT, TOKEN_2022_PROGRAM, USDC_MINT, WSOL_MINT, type MintFacts, type SafetyVerdict, type TokenSafety } from './tokenSafety';
import { metadataPda } from '../../launcher/solana/write/metaplex';

/** A fetch for `/api/pools?all=1` answering `pools`; `calls` collects each URL asked. */
function allIndex(pools: string[], o: { status?: number; program?: string; truncated?: boolean; all?: unknown; calls?: string[] } = {}): typeof fetch {
  return (async (url: string) => {
    o.calls?.push(url);
    if (o.status) return new Response('{}', { status: o.status });
    return new Response(JSON.stringify({ all: 'all' in o ? o.all : true, program: o.program ?? PROGRAM.toBase58(), pools, truncated: o.truncated ?? false }), { status: 200 });
  }) as unknown as typeof fetch;
}
const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });
const at = () => Keypair.generate().publicKey;

describe('listPools', () => {
  it('reads every address the index names and lists the pools SOL first, then USDC, then BAYLA, the deepest of each first', async () => {
    const solShallow = buildPool({ mint: key(), address: at(), quoteReserve: 2n * 10n ** 9n, tokenReserve: 10n ** 9n });
    const solDeep = buildPool({ mint: key(), address: at(), quoteReserve: 9n * 10n ** 9n, tokenReserve: 10n ** 9n });
    // Far more units than either SOL pool, and still after them: coins are never compared.
    const usdc = buildPool({ mint: key(), quote: USDC_QUOTE, address: at(), quoteReserve: 10n ** 15n, tokenReserve: 10n ** 9n });
    const bayla = buildPool({ mint: key(), quote: BAYLA_QUOTE, address: at(), quoteReserve: 5n, tokenReserve: 5n });
    const gone = at().toBase58();
    const accounts: Record<string, FakeAccount> = { ...solShallow.accounts, ...solDeep.accounts, ...usdc.accounts, ...bayla.accounts, [CLOCK]: clockAccount(7n) };
    const calls: string[] = [];
    // The index's own order is not trusted: it is read again here.
    const names = [bayla, usdc, solShallow, solDeep].map((b) => b.address.toBase58());
    const r = await listPools(fakeRpc(accounts), opts(allIndex([...names, gone], { calls, truncated: true })));
    expect(calls).toEqual(['/api/pools?all=1']);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((v) => v.address)).toEqual([solDeep, solShallow, usdc, bayla].map((b) => b.address.toBase58()));
    // An address with no account is the index being wrong, not a pool that failed to read.
    expect(r.list.unread).toBe(0);
    expect(r.list.truncated).toBe(true);
  });

  it('counts a pool it could not read, and never lists it as a pool', async () => {
    const ok = buildPool({ mint: key(), address: at(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    const broken = buildPool({ mint: key(), address: at(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    const accounts: Record<string, FakeAccount> = { ...ok.accounts, ...broken.accounts, [CLOCK]: clockAccount(7n) };
    // Its vaults are not there: the pool decodes, but cannot be read whole.
    const pool = broken.accounts[broken.address.toBase58()]!;
    for (const [k, a] of Object.entries(broken.accounts)) if (a !== pool && a.data.length === 165) delete accounts[k];
    const r = await listPools(fakeRpc(accounts), opts(allIndex([ok.address.toBase58(), broken.address.toBase58()])));
    expect(r.kind === 'ok' && [r.list.pools.map((v) => v.address), r.list.unread]).toEqual([[ok.address.toBase58()], 1]);
  });

  it('an index that did not answer is unread, never an empty list, and the chain is not asked', async () => {
    const calls: [string, unknown[]][] = [];
    for (const f of [allIndex([], { status: 502 }), allIndex([], { program: key().toBase58() }), allIndex([], { all: undefined })]) {
      const r = await listPools(fakeRpc({}, { calls }), opts(f));
      expect(r.kind).toBe('unread');
    }
    expect(calls).toHaveLength(0);
  });

  it('an index that answered with no pools is an empty list, read without asking the chain', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(allIndex([])));
    expect(r).toEqual({ kind: 'ok', list: { pools: [], unread: 0, truncated: false, chainNow: null, safety: new Map() } });
    expect(calls).toHaveLength(0);
  });

  it('carries the chain clock it read with the pools, for the row tags; null when the clock did not decode', async () => {
    const b = buildPool({ mint: key(), address: at(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    const read = await listPools(fakeRpc({ ...b.accounts, [CLOCK]: clockAccount(1_234n) }), opts(allIndex([b.address.toBase58()])));
    expect(read.kind === 'ok' && read.list.chainNow).toBe(1_234n);
    const noClock = await listPools(fakeRpc(b.accounts), opts(allIndex([b.address.toBase58()])));
    expect(noClock.kind === 'ok' && noClock.list.chainNow).toBeNull();
  });

  it('reads the check of every listed coin the site does not name itself, in one batch, for its ticker', async () => {
    const coin = key();
    const other = buildPool({ mint: coin, address: at(), quoteReserve: 2n * 10n ** 9n, tokenReserve: 10n ** 9n });
    const ours = buildPool({ mint: new PublicKey(BAYLA_MINT), address: at(), quoteReserve: 9n * 10n ** 9n, tokenReserve: 10n ** 9n });
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({ ...other.accounts, ...ours.accounts, [CLOCK]: clockAccount(7n) }, { calls }), opts(allIndex([other.address, ours.address].map(String))));
    const mint = coin.toBase58();
    // The last call asks for that coin and its name record, and nothing for BAYLA.
    expect(calls.at(-1)).toEqual(['getMultipleAccounts', [[mint, metadataPda(coin).toBase58()], { encoding: 'base64' }]]);
    expect(r.kind === 'ok' && [...r.list.safety.keys()]).toEqual([mint]);
  });

  it('a check that could not be read leaves the list standing', async () => {
    const coin = key();
    const b = buildPool({ mint: coin, address: at(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    const rpc = fakeRpc({ ...b.accounts, [CLOCK]: clockAccount(7n) });
    // The pools and their vaults read; the call that asks for the coin itself fails.
    const flaky: typeof rpc = async (method, params) => {
      if (method === 'getMultipleAccounts' && (params as [string[]])[0].includes(coin.toBase58())) throw new Error('HTTP 429');
      return rpc(method, params);
    };
    const r = await listPools(flaky, opts(allIndex([b.address.toBase58()])));
    expect(r.kind === 'ok' && r.list.pools).toHaveLength(1);
    expect(r.kind === 'ok' && r.list.safety.get(coin.toBase58())?.kind).toBe('unread');
  });

  it('a chain that did not answer is unread', async () => {
    const b = buildPool({ mint: key(), address: at(), quoteReserve: 1n, tokenReserve: 1n });
    const r = await listPools(fakeRpc(b.accounts, { fail: new Set(['getMultipleAccounts']) }), opts(allIndex([b.address.toBase58()])));
    expect(r.kind).toBe('unread');
  });
});

describe('readPoolIndex({ all: true })', () => {
  it('asks ?all=1 and accepts only an answer to that question', async () => {
    const a = at().toBase58();
    expect(await readPoolIndex({ all: true }, PROGRAM.toBase58(), allIndex([a]))).toEqual({ kind: 'ok', pools: [a], truncated: false });
    // An answer about one token is not an answer about every pool.
    const aboutOne = (async () => new Response(JSON.stringify({ mint: a, program: PROGRAM.toBase58(), pools: [a], truncated: false }))) as unknown as typeof fetch;
    expect((await readPoolIndex({ all: true }, PROGRAM.toBase58(), aboutOne)).kind).toBe('unread');
  });
});

describe('poolTags: warnings on a row, from what the list already read', () => {
  const NOW = 10_000_000n;
  const DAY = 24n * 3600n;
  /** The pool's own trade record: its last trade at `last`, or never traded when null. */
  const record = (pool: PublicKey, last: bigint | null): PoolView['history'] => ({
    kind: 'ok',
    obs: decodeObservationState(observationBytes({ pool, initialized: last !== null, lastUpdate: last ?? 0n }))!,
  });
  /** A pool with plenty in it, every switch on, open, and traded a day ago, unless told otherwise. */
  function row(o: { mint?: PublicKey; quote?: QuoteCoin; reserve?: bigint; status?: number; openTime?: bigint; frozen?: boolean; last?: bigint | null; history?: PoolView['history'] } = {}): PoolView {
    const reserve = o.reserve ?? 50n * 10n ** 9n;
    const b = buildPool({ mint: o.mint ?? key(), quote: o.quote, address: at(), quoteReserve: reserve, tokenReserve: 10n ** 9n, status: o.status, openTime: o.openTime });
    return viewOf(b, { sol: reserve, tok: 10n ** 9n, frozen: o.frozen, history: o.history ?? record(b.address, o.last === undefined ? NOW - DAY : o.last) });
  }
  const texts = (v: PoolView, now: bigint | null = NOW) => poolTags(v, now).map((t) => t.text);

  it('a pool with nothing to warn about gets no tag at all (never a reassuring one)', () => {
    expect(poolTags(row(), NOW)).toEqual([]);
  });

  it('the pool’s own switches: Trading off, Adding off, Removing off, each from its own bit', () => {
    expect(texts(row({ status: 4 }))).toEqual(['Trading off']);
    expect(texts(row({ status: 1 }))).toEqual(['Adding off']);
    expect(texts(row({ status: 2 }))).toEqual(['Removing off']);
    expect(poolTags(row({ status: 7 }), NOW)).toEqual([
      { text: 'Trading off', tone: 'bad' },
      { text: 'Adding off', tone: 'bad' },
      { text: 'Removing off', tone: 'bad' },
    ]);
  });

  it('a frozen vault is Frozen', () => {
    expect(poolTags(row({ frozen: true }), NOW)).toEqual([{ text: 'Frozen', tone: 'bad' }]);
  });

  it('an open time still ahead by the chain clock is Trading not open yet; with no clock read, nothing is said', () => {
    expect(poolTags(row({ openTime: NOW + 1n }), NOW)).toEqual([{ text: 'Trading not open yet', tone: 'warn' }]);
    expect(texts(row({ openTime: NOW }))).toEqual([]);
    expect(texts(row({ openTime: NOW + 1n }), null)).toEqual([]);
    // Trading switched off already says the worse thing.
    expect(texts(row({ status: 4, openTime: NOW + 1n }))).toEqual(['Trading off']);
  });

  it(`Little money in pool: ${LITTLE_MONEY_TEXT} on the coin side, and never for a pool priced in BAYLA`, () => {
    expect(LITTLE_MONEY_TEXT).toBe('under 1 SOL or 100 USDC');
    expect(poolTags(row({ reserve: 10n ** 9n - 1n }), NOW)).toEqual([{ text: 'Little money in pool', tone: 'warn' }]);
    expect(texts(row({ reserve: 10n ** 9n }))).toEqual([]);
    expect(texts(row({ quote: USDC_QUOTE, reserve: 100n * 10n ** 6n - 1n }))).toEqual(['Little money in pool']);
    expect(texts(row({ quote: USDC_QUOTE, reserve: 100n * 10n ** 6n }))).toEqual([]);
    expect(texts(row({ quote: BAYLA_QUOTE, reserve: 1n }))).toEqual([]);
    // BAYLA / SOL is priced in SOL: measured like any SOL pool, as the fine print says.
    const baylaSol = row({ mint: new PublicKey(BAYLA_QUOTE.mint), reserve: 10n ** 9n - 1n });
    expect(baylaSol.quote.symbol).toBe('SOL');
    expect(texts(baylaSol)).toEqual(['Little money in pool']);
    // An empty coin side is little money too: the row already says it has no price.
    expect(texts(row({ reserve: 0n }))).toEqual(['Little money in pool']);
  });

  it('No trades yet and No trades in 7 days come from the pool’s own record, read; unread says nothing', () => {
    expect(poolTags(row({ last: null }), NOW)).toEqual([{ text: 'No trades yet', tone: 'warn' }]);
    // A record that says "never traded" needs no clock.
    expect(texts(row({ last: null }), null)).toEqual(['No trades yet']);
    expect(poolTags(row({ last: NOW - QUIET_SECS }), NOW)).toEqual([{ text: 'No trades in 7 days', tone: 'warn' }]);
    expect(texts(row({ last: NOW - QUIET_SECS + 1n }))).toEqual([]);
    // How long ago needs the clock: without it, nothing.
    expect(texts(row({ last: 1n }), null)).toEqual([]);
    // A record not read, or not usable, gives no tag, never "traded" and never "quiet".
    expect(texts(row({ history: { kind: 'unread', detail: 'its price record account is missing' } }))).toEqual([]);
    expect(texts(row({ history: { kind: 'not-read' } }))).toEqual([]);
  });

  it('a price gap is a red tag after the switches and before the quieter warnings, naming no figure', () => {
    expect(poolTags(row({ status: 4, last: null }), NOW, 0.05)).toEqual([
      { text: 'Trading off', tone: 'bad' },
      { text: 'Price over 3% above Jupiter', tone: 'bad' },
      { text: 'No trades yet', tone: 'warn' },
    ]);
    expect(poolTags(row(), NOW, -0.42)).toEqual([{ text: 'Price over 3% below Jupiter', tone: 'bad' }]);
  });
});

describe('marketGap: a row’s price against Jupiter’s, by the card’s own 3% rule', () => {
  // 50 SOL and 1,000 tokens: 0.05 SOL a token. At $200 a SOL that is $10 a token.
  function row(o: { quote?: QuoteCoin; reserve?: bigint } = {}): PoolView {
    const reserve = o.reserve ?? 50n * 10n ** 9n;
    return viewOf(buildPool({ mint: key(), quote: o.quote, address: at(), quoteReserve: reserve, tokenReserve: 10n ** 9n }), { sol: reserve, tok: 10n ** 9n });
  }
  const usd = (v: PoolView, token: number, more: Record<string, number> = { [WSOL_MINT]: 200 }) => new Map(Object.entries({ ...more, [v.tokenMint]: token }));

  it('more than 3% apart gives the gap, pool over market less one; 3% or under gives nothing', () => {
    const v = row();
    expect(marketGap(v, usd(v, 10))).toBeNull();
    expect(marketGap(v, usd(v, 10 / 1.029))).toBeNull();
    expect(marketGap(v, usd(v, 10 / 0.971))).toBeNull();
    expect(marketGap(v, usd(v, 10 / 1.031))).toBeCloseTo(0.031, 9);
    expect(marketGap(v, usd(v, 10 / 0.95))).toBeCloseTo(-0.05, 9);
  });

  it('a pool priced in USDC is held against the token’s price in USDC, not in SOL', () => {
    const v = row({ quote: USDC_QUOTE, reserve: 50n * 10n ** 6n });
    // 0.05 USDC a token. In SOL terms ($200) it would look 4,000x off.
    expect(marketGap(v, usd(v, 0.05, { [WSOL_MINT]: 200, [USDC_MINT]: 1 }))).toBeNull();
    expect(marketGap(v, usd(v, 0.04, { [WSOL_MINT]: 200, [USDC_MINT]: 1 }))).toBeCloseTo(0.25, 9);
  });

  it('no price for the token, its pairing coin, or the pool itself: no gap, never a pass', () => {
    const v = row();
    expect(marketGap(v, new Map([[WSOL_MINT, 200]]))).toBeNull();
    expect(marketGap(v, new Map([[v.tokenMint, 1]]))).toBeNull();
    const empty = row({ reserve: 0n });
    expect(marketGap(empty, usd(empty, 1))).toBeNull();
  });

  it('priceGap is the same gap with no tolerance: a 2% or a 0.5% gap is a figure, and the same nothing when a price is missing', () => {
    const v = row();
    expect(priceGap(v, usd(v, 10))).toBeCloseTo(0, 9);
    expect(priceGap(v, usd(v, 10 / 1.02))).toBeCloseTo(0.02, 9);
    expect(priceGap(v, usd(v, 10 / 0.995))).toBeCloseTo(-0.005, 9);
    expect(priceGap(v, usd(v, 10 / 1.031))).toBeCloseTo(0.031, 9);
    expect(priceGap(v, new Map([[WSOL_MINT, 200]]))).toBeNull();
    expect(priceGap(v, new Map([[v.tokenMint, 1]]))).toBeNull();
    const empty = row({ reserve: 0n });
    expect(priceGap(empty, usd(empty, 1))).toBeNull();
  });
});

describe('poolWorthUsd: what a pool holds in dollars, both sides at Jupiter’s prices', () => {
  // 50 SOL and 1,000 tokens (6 decimals): $200 a SOL and $10 a token is $10,000 + $10,000.
  const v = viewOf(buildPool({ mint: key(), address: at(), quoteReserve: 50n * 10n ** 9n, tokenReserve: 10n ** 9n }), { sol: 50n * 10n ** 9n, tok: 10n ** 9n });
  it('adds the coin side and the token side, each at its own price and decimals', () => {
    expect(poolWorthUsd(v, new Map([[WSOL_MINT, 200], [v.tokenMint, 10]]))).toBeCloseTo(20_000, 6);
    expect(poolWorthUsd(v, new Map([[WSOL_MINT, 200], [v.tokenMint, 1]]))).toBeCloseTo(11_000, 6);
  });
  it('a pool priced in USDC counts its USDC at USDC’s price, in USDC’s decimals', () => {
    const u = viewOf(buildPool({ mint: key(), quote: USDC_QUOTE, address: at(), quoteReserve: 50n * 10n ** 6n, tokenReserve: 10n ** 9n }), { sol: 50n * 10n ** 6n, tok: 10n ** 9n });
    expect(poolWorthUsd(u, new Map([[USDC_MINT, 1], [u.tokenMint, 0.05]]))).toBeCloseTo(100, 6);
  });
  it('either side without a price: no figure, never $0 or one side alone', () => {
    expect(poolWorthUsd(v, new Map([[WSOL_MINT, 200]]))).toBeNull();
    expect(poolWorthUsd(v, new Map([[v.tokenMint, 10]]))).toBeNull();
    expect(poolWorthUsd(v, new Map())).toBeNull();
  });
});

describe('byWorth: All pools, the most money in first', () => {
  const SOL = 10n ** 9n;
  const SIX = 10n ** 6n;
  const pool = (quote: QuoteCoin, coin: bigint, tok: bigint) => viewOf(buildPool({ mint: key(), quote, address: at(), quoteReserve: coin, tokenReserve: tok }), { sol: coin, tok });
  /** $100 a SOL, $1 a USDC, $3 a BAYLA, and $1 for each of `tokens`. */
  const prices = (...tokens: PoolView[]) => new Map<string, number>([[WSOL_MINT, 100], [USDC_MINT, 1], [BAYLA_MINT, 3], ...tokens.map((v) => [v.tokenMint, 1] as [string, number])]);

  it('ranks by the dollars each pool holds, whatever coin it is priced in, and by exactly the dollars its row shows', () => {
    const inSol = pool(SOL_QUOTE, 10n * SOL, 1_000n * SIX); // $1,000 + $1,000
    const inBayla = pool(BAYLA_QUOTE, 1_000n * SIX, 3_000n * SIX); // $3,000 + $3,000
    const inUsdc = pool(USDC_QUOTE, 5_000n * SIX, 5_000n * SIX); // $5,000 + $5,000
    const usd = prices(inSol, inBayla, inUsdc);
    expect(byWorth([inSol, inBayla, inUsdc], usd)).toEqual([inUsdc, inBayla, inSol]);
    for (const v of [inSol, inBayla, inUsdc]) expect(poolRankUsd(v, usd)).toBe(poolWorthUsd(v, usd));
  });

  it('a row near the edge of the 3% rule, with no price tag, still ranks by exactly the dollars it shows', () => {
    // 1 token = 0.01 SOL ($1) here against Jupiter's $1.03: 2.9% cheaper here, so the token side is the bigger one.
    const v = pool(SOL_QUOTE, 10n * SOL, 1_000n * SIX);
    const usd = new Map([[WSOL_MINT, 100], [v.tokenMint, 1.03]]);
    expect(marketGap(v, usd)).toBeNull();
    expect(poolRankUsd(v, usd)).toBe(poolWorthUsd(v, usd));
  });

  it('a pinch of SOL beside a billion printed tokens ranks by its SOL, never by the billion', () => {
    const printed = pool(SOL_QUOTE, SOL / 100n, 1_000_000_000n * SIX); // $1 of SOL, and $1,000,000,000 of tokens at Jupiter's $1
    const honest = pool(SOL_QUOTE, 10n * SOL, 1_000n * SIX);
    const usd = prices(printed, honest);
    expect(poolWorthUsd(printed, usd)).toBeGreaterThan(1e9);
    expect(poolRankUsd(printed, usd)).toBeCloseTo(1 + 1 / (1 - PRICE_TOLERANCE), 6);
    expect(byWorth([printed, honest], usd)).toEqual([honest, printed]);
  });

  it('a token Jupiter does not price counts at the pool’s own price; a pool whose coin has no price goes last, in the order read', () => {
    const unpricedToken = pool(SOL_QUOTE, 20n * SOL, 1_000n * SIX); // 20 SOL: $4,000 at the pool's own price
    const inSol = pool(SOL_QUOTE, 10n * SOL, 1_000n * SIX); // $2,000
    const a = pool(BAYLA_QUOTE, 1_000n * SIX, 1_000n * SIX);
    const b = pool(BAYLA_QUOTE, 9_000n * SIX, 1_000n * SIX);
    const usd = new Map([[WSOL_MINT, 100], [inSol.tokenMint, 1], [a.tokenMint, 1], [b.tokenMint, 1]]);
    expect(poolWorthUsd(unpricedToken, usd)).toBeNull();
    expect(poolRankUsd(unpricedToken, usd)).toBe(4_000);
    expect(poolRankUsd(a, usd)).toBeNull();
    expect(byWorth([a, inSol, b, unpricedToken], usd)).toEqual([unpricedToken, inSol, a, b]);
  });
});

describe('arbitrage: what one trade could take from a row’s gap, by the pool’s own maths', () => {
  const NOW = 10_000_000n;
  // 50 SOL and 1,000 tokens (6 decimals), the test tier's 1% fee with 16% of it the venue's. $200 a SOL.
  function row(o: { status?: number; openTime?: bigint } = {}): PoolView {
    const b = buildPool({ mint: key(), address: at(), quoteReserve: 50n * 10n ** 9n, tokenReserve: 10n ** 9n, status: o.status, openTime: o.openTime });
    return viewOf(b, { sol: 50n * 10n ** 9n, tok: 10n ** 9n });
  }
  const usd = (v: PoolView, token: number) => new Map([[WSOL_MINT, 200], [v.tokenMint, token]]);
  const SOL_UNIT = 200 / 1e9;
  /** The USD made by putting `amountIn` of `inputMint` through the pool, priced at Jupiter's. */
  function made(v: PoolView, inputMint: string, amountIn: bigint, tokenUsd: number): { usd: number; q: NonNullable<ReturnType<typeof quoteOwnPool>> } {
    const q = quoteOwnPool(v.snapshot, v.config!, inputMint, amountIn, Number(NOW))!;
    const tokUnit = tokenUsd / 1e6;
    const buy = inputMint === WSOL_MINT;
    return { usd: Number(q.outAmount) * (buy ? tokUnit : SOL_UNIT) - Number(amountIn) * (buy ? SOL_UNIT : tokUnit), q };
  }

  for (const [side, tokenUsd] of [['buy', 10 / 0.9], ['sell', 10 / 1.1]] as const) {
    it(`token ${side === 'buy' ? 'cheap' : 'dear'} here: the trade ${side}s it, and is the size that makes the most`, () => {
      const v = row();
      const a = arbitrage(v, usd(v, tokenUsd), NOW)!;
      expect(a.side).toBe(side);
      const inputMint = side === 'buy' ? WSOL_MINT : v.tokenMint;
      const inUnit = side === 'buy' ? SOL_UNIT : tokenUsd / 1e6;
      // The trade in the trader's own units: what goes in, which way round, and what comes out.
      expect([a.inputMint, a.outputMint]).toEqual(side === 'buy' ? [WSOL_MINT, v.tokenMint] : [v.tokenMint, WSOL_MINT]);
      const amountIn = a.amountIn;
      expect(Number(amountIn) * inUnit).toBeCloseTo(a.tradeUsd, 9);
      const best = made(v, inputMint, amountIn, tokenUsd);
      expect(a.outAmount).toBe(best.q.outAmount);
      expect(a.outUsd).toBeCloseTo(Number(best.q.outAmount) * (side === 'buy' ? tokenUsd / 1e6 : SOL_UNIT), 9);
      expect(a.profitUsd).toBeCloseTo(best.usd, 9);
      expect(a.profitUsd).toBeGreaterThan(0);
      expect(a.priceImpact).toBe(best.q.priceImpact);
      // The gap it rests on: the token 10% cheap here buys, 10% dear here sells.
      expect(a.gap).toBeCloseTo(side === 'buy' ? -0.1 : 0.1, 9);
      // Smaller or larger, the same trade makes less.
      expect(made(v, inputMint, (amountIn * 8n) / 10n, tokenUsd).usd).toBeLessThan(a.profitUsd);
      expect(made(v, inputMint, (amountIn * 12n) / 10n, tokenUsd).usd).toBeLessThan(a.profitUsd);
      // Afterwards the pool's price sits the fee away from Jupiter's: the next bit no longer pays.
      const { newInputVaultAmount: inAfter, newOutputVaultAmount: outAfter } = best.q.result;
      const sol = side === 'buy' ? inAfter : outAfter;
      const tok = side === 'buy' ? outAfter : inAfter;
      const after = (Number(sol) / 1e9) / (Number(tok) / 1e6) / (tokenUsd / 200);
      expect(after).toBeCloseTo(side === 'buy' ? 0.99 : 1 / 0.99, 3);
      // The price after, as the board prints it: the LPs' part of the fee stays in the input side's
      // reserve (the maths takes the whole fee off; only the venue's parts are kept apart), so the
      // board's price is a hair off the fee-stripped one, on the side the trade paid into.
      const { tradeFee, protocolFee, fundFee } = best.q.result;
      const lpKept = tradeFee - protocolFee - fundFee;
      expect(lpKept).toBeGreaterThan(0n);
      const [solKept, tokKept] = side === 'buy' ? [sol + lpKept, tok] : [sol, tok + lpKept];
      expect(a.afterPerToken).toBeCloseTo((Number(solKept) / 1e9) / (Number(tokKept) / 1e6), 12);
      expect(a.afterPerToken).not.toBeCloseTo((Number(sol) / 1e9) / (Number(tok) / 1e6), 9);
      // The fee: 1% of the trade, 84% of it to the LPs and 16% to the venue; this pool charges no creator fee.
      expect(a.lpFeeUsd + a.venueFeeUsd).toBeCloseTo(a.tradeUsd * 0.01, 4);
      expect(a.venueFeeUsd).toBeCloseTo(a.tradeUsd * 0.0016, 4);
      expect(a.creatorFeeUsd).toBe(0);
      expect(a.transferFeeUsd).toBe(0);
    });
  }

  // 2% of every transfer of the token, with no cap: out of the pool buying, of what the trader sends selling.
  const TAX: TransferFee = { epoch: 0n, maximumFee: (1n << 64n) - 1n, basisPoints: 200 };
  for (const [side, tokenUsd] of [['buy', 10 / 0.9], ['sell', 10 / 1.1]] as const) {
    it(`a token with a transfer fee (${side}): the fee is counted, said, and the size still makes the most`, () => {
      const v = row();
      const plain = arbitrage(v, usd(v, tokenUsd), NOW)!;
      const a = arbitrage(v, usd(v, tokenUsd), NOW, TAX)!;
      expect(a.side).toBe(side);
      const inputMint = side === 'buy' ? WSOL_MINT : v.tokenMint;
      const tokUnit = tokenUsd / 1e6;
      const [inUnit, outUnit] = side === 'buy' ? [SOL_UNIT, tokUnit] : [tokUnit, SOL_UNIT];
      const taxed = (n: bigint) => {
        const q = quoteOwnPool(v.snapshot, v.config!, inputMint, n, Number(NOW), poolFeesOf(v.quoteIsToken0, TAX))!;
        return { usd: Number(q.outAmount) * outUnit - Number(n) * inUnit, q };
      };
      const amountIn = a.amountIn;
      expect(Number(amountIn) * inUnit).toBeCloseTo(a.tradeUsd, 9);
      const best = taxed(amountIn);
      expect(a.outAmount).toBe(best.q.outAmount);
      expect(a.profitUsd).toBeCloseTo(best.usd, 9);
      expect(taxed((amountIn * 8n) / 10n).usd).toBeLessThan(a.profitUsd);
      expect(taxed((amountIn * 12n) / 10n).usd).toBeLessThan(a.profitUsd);
      // 2% of the token side: what leaves the pool buying, what the trader sends selling.
      const kept = side === 'buy' ? best.q.result.outputAmount : amountIn;
      expect(a.transferFeeUsd).toBeCloseTo(Number(kept) * 0.02 * tokUnit, 4);
      expect(a.profitUsd).toBeLessThan(plain.profitUsd);
    });
  }

  it('nothing to take: a gap inside the fee, a pool that cannot trade now, or anything not read', () => {
    const v = row();
    expect(arbitrage(v, usd(v, 10 / 0.995), NOW)).toBeNull();
    expect(arbitrage(v, usd(v, 10 / 1.005), NOW)).toBeNull();
    const off = row({ status: 4 });
    expect(arbitrage(off, usd(off, 20), NOW)).toBeNull();
    const later = row({ openTime: NOW + 1n });
    expect(arbitrage(later, usd(later, 20), NOW)).toBeNull();
    expect(arbitrage(v, usd(v, 20), null)).toBeNull();
    expect(arbitrage({ ...v, config: null }, usd(v, 20), NOW)).toBeNull();
    expect(arbitrage(v, new Map([[v.tokenMint, 20]]), NOW)).toBeNull();
    expect(arbitrage(v, new Map([[WSOL_MINT, 200]]), NOW)).toBeNull();
    // A 3% transfer fee on top of the 1% pool fee: a 2% gap no longer pays.
    expect(arbitrage(v, usd(v, 10 / 0.98), NOW)).not.toBeNull();
    expect(arbitrage(v, usd(v, 10 / 0.98), NOW, { ...TAX, basisPoints: 300 })).toBeNull();
  });

  it('a pool with a frozen vault gets no figure, whatever its gap: nothing can be traded in it', () => {
    const v = row();
    expect(arbitrage(v, usd(v, 20), NOW)).not.toBeNull();
    expect(arbitrage({ ...v, vaultsFrozen: true }, usd(v, 20), NOW)).toBeNull();
  });

  it(`under $${ARB_FLOOR_USD} of profit nothing is listed: a tiny pool with an 11% gap is noise, the same pool a thousand times over is a trade`, () => {
    // 0.01 SOL and 1 token: $1 a side at $100 a SOL. The token 11% dear here, past the 1% fee, makes well under a cent.
    const tiny = viewOf(buildPool({ mint: key(), address: at(), quoteReserve: 10n ** 7n, tokenReserve: 10n ** 6n }), { sol: 10n ** 7n, tok: 10n ** 6n });
    const prices = (p: PoolView) => new Map([[WSOL_MINT, 100], [p.tokenMint, 1 / 1.11]]);
    expect(arbitrage(tiny, prices(tiny), NOW)).toBeNull();
    const big = viewOf(buildPool({ mint: key(), address: at(), quoteReserve: 10n ** 10n, tokenReserve: 10n ** 9n }), { sol: 10n ** 10n, tok: 10n ** 9n });
    const a = arbitrage(big, prices(big), NOW);
    expect(a).not.toBeNull();
    expect(a!.profitUsd).toBeGreaterThanOrEqual(ARB_FLOOR_USD);
  });

  describe('rankArbitrage: every paying gap on the list, most profitable first', () => {
    const list = (pools: PoolView[], safety: TokenSafety[] = [], chainNow: bigint | null = NOW): PoolList => ({
      pools,
      unread: 0,
      truncated: false,
      chainNow,
      safety: new Map(safety.map((s) => [s.mint, s])),
    });
    const prices = (entries: [PoolView, number][], more: Record<string, number> = { [WSOL_MINT]: 200, [USDC_MINT]: 1 }) =>
      new Map([...Object.entries(more), ...entries.map(([p, t]): [string, number] => [p.tokenMint, t])]);

    it('ranks by profit across coins and pools, with the trade each carries; a pool inside its fee is not listed', () => {
      const small = row();
      // 5,000 USDC and 1,000 tokens at $5: the token 20% cheap here makes far more than the SOL pool's 10%.
      const b = buildPool({ mint: key(), quote: USDC_QUOTE, address: at(), quoteReserve: 5_000n * 10n ** 6n, tokenReserve: 10n ** 9n });
      const bigUsdc = viewOf(b, { sol: 5_000n * 10n ** 6n, tok: 10n ** 9n });
      const quiet = row();
      const ranked = rankArbitrage(list([small, quiet, bigUsdc]), prices([[small, 10 / 0.9], [bigUsdc, 5 / 0.8], [quiet, 10]]));
      expect(ranked.map((o) => o.view.address)).toEqual([bigUsdc.address, small.address]);
      expect(ranked[0]!.arb.side).toBe('buy');
      expect(ranked[0]!.arb.inputMint).toBe(USDC_MINT);
      expect(ranked[0]!.arb.profitUsd).toBeGreaterThan(ranked[1]!.arb.profitUsd);
      expect(ranked[1]!.arb).toEqual(arbitrage(small, prices([[small, 10 / 0.9]]), NOW));
      expect(ranked[1]!.safety).toBeNull();
    });

    it('two pools making the same: the lower address first, every read alike', () => {
      const a = row();
      const b = row();
      const ranked = rankArbitrage(list([b, a]), prices([[a, 10 / 0.9], [b, 10 / 0.9]]));
      expect(ranked.map((o) => o.view.address)).toEqual([a.address, b.address].sort());
    });

    it('a token this site blocks, one whose transfer fee was not read, and a frozen pool are not listed; a check that was read is carried', () => {
      const ok = row();
      const blocked = row();
      const frozen = { ...row(), vaultsFrozen: true };
      const unreadFee = row();
      const pool = unreadFee.quoteIsToken0 ? { ...unreadFee.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...unreadFee.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
      const t2022: PoolView = { ...unreadFee, snapshot: { ...unreadFee.snapshot, pool } };
      const check = (mint: string, verdict: SafetyVerdict): TokenSafety =>
        ({ kind: 'read', mint, verdict, blocks: [], warnings: [], facts: null, name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex' }) as TokenSafety;
      const p = prices([[ok, 10 / 0.9], [blocked, 10 / 0.9], [frozen, 10 / 0.9], [t2022, 10 / 0.9]]);
      const ranked = rankArbitrage(list([ok, blocked, frozen, t2022], [check(ok.tokenMint, 'warn'), check(blocked.tokenMint, 'blocked'), { kind: 'unread', mint: t2022.tokenMint, detail: 'HTTP 429' }]), p);
      expect(ranked.map((o) => o.view.address)).toEqual([ok.address]);
      expect(ranked[0]!.safety).toEqual(check(ok.tokenMint, 'warn'));
      // The chain's clock not read: nothing can be sized, so nothing is listed.
      expect(rankArbitrage(list([ok], [], null), p)).toEqual([]);
    });
  });

  it('swapLink: the swap page on the trade, the amount written as the form takes it; pairSwapLink: the pair alone, paying with the pool’s coin', () => {
    const v = row();
    expect(swapLink({ inputMint: WSOL_MINT, outputMint: v.tokenMint, amountIn: 204_110_000n }, 9)).toBe(`/solana?in=${WSOL_MINT}&out=${v.tokenMint}&amt=0.20411`);
    expect(swapLink({ inputMint: v.tokenMint, outputMint: WSOL_MINT, amountIn: 21_046_400n }, 6)).toBe(`/solana?in=${v.tokenMint}&out=${WSOL_MINT}&amt=21.0464`);
    // A whole amount carries no point, and one under a whole unit keeps its leading zero: both pass the page's own rule.
    expect(swapLink({ inputMint: v.tokenMint, outputMint: WSOL_MINT, amountIn: 21_000_000n }, 6)).toMatch(/&amt=21$/);
    expect(swapLink({ inputMint: WSOL_MINT, outputMint: v.tokenMint, amountIn: 5n }, 9)).toMatch(/&amt=0\.000000005$/);
    for (const link of [swapLink({ inputMint: WSOL_MINT, outputMint: v.tokenMint, amountIn: 5n }, 9), swapLink({ inputMint: v.tokenMint, outputMint: WSOL_MINT, amountIn: 21_000_000n }, 6)]) {
      const amt = new URLSearchParams(link.slice(link.indexOf('?'))).get('amt')!;
      expect(amt).toMatch(/^(?:\d*\.)?\d+$/);
      expect(amt).toMatch(/[1-9]/);
    }
    expect(pairSwapLink(v)).toBe(`/solana?in=${WSOL_MINT}&out=${v.tokenMint}`);
    const u = viewOf(buildPool({ mint: key(), quote: USDC_QUOTE, address: at(), quoteReserve: 10n ** 6n, tokenReserve: 10n ** 6n }), { sol: 10n ** 6n, tok: 10n ** 6n });
    expect(pairSwapLink(u)).toBe(`/solana?in=${USDC_MINT}&out=${u.tokenMint}`);
  });

  it('rowTokenFee: none on a classic token; on a Token-2022 token, the fee its read found, or unread', () => {
    const v = row();
    const pool = v.quoteIsToken0 ? { ...v.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...v.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
    const t: PoolView = { ...v, snapshot: { ...v.snapshot, pool } };
    const facts = (transferFee: MintFacts['transferFee']): MintFacts => ({
      program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true,
      extensions: [], metadataPointer: null, tokenMetadata: null, transferFee,
    });
    const read = (f: MintFacts | null): TokenSafety => ({ kind: 'read', mint: t.tokenMint, verdict: 'ok', blocks: [], warnings: [], facts: f, name: null, symbol: null, metadataSource: 'none' });
    // A classic token cannot carry a fee: no read is needed.
    expect(rowTokenFee(v, null)).toBeNull();
    expect(rowTokenFee(t, null)).toBe('unread');
    expect(rowTokenFee(t, { kind: 'unread', mint: t.tokenMint, detail: 'HTTP 429' })).toBe('unread');
    expect(rowTokenFee(t, read(null))).toBe('unread');
    expect(rowTokenFee(t, read(facts(null)))).toBeNull();
    // A change pending, the page reading no epoch: the larger of the two settings.
    const older = { epoch: 0n, maximumFee: 10n ** 6n, basisPoints: 100 };
    const newer = { epoch: 900n, maximumFee: 10n ** 6n, basisPoints: 300 };
    expect(rowTokenFee(t, read(facts({ configAuthority: null, withdrawAuthority: null, withheldAmount: 0n, older, newer })))).toEqual(newer);
  });

  it('rowTokenFee: a pairing coin on the token side (BAYLA, a Token-2022 mint the list reads no check for) carries no fee, never unread', () => {
    // BAYLA / SOL as mainnet holds it: BAYLA on the token side, under Token-2022, and no check read for a coin the site names.
    const b = buildPool({ mint: new PublicKey(BAYLA_MINT), address: at(), quoteReserve: 50n * 10n ** 9n, tokenReserve: 10n ** 9n });
    const v = viewOf(b, { sol: 50n * 10n ** 9n, tok: 10n ** 9n });
    const pool = v.quoteIsToken0 ? { ...v.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...v.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
    const bayla: PoolView = { ...v, snapshot: { ...v.snapshot, pool } };
    expect(bayla.tokenMint).toBe(BAYLA_MINT);
    expect(rowTokenFee(bayla, null)).toBeNull();
    // And so the venue's own pool is sized like any other.
    expect(arbitrage(bayla, new Map([[WSOL_MINT, 200], [BAYLA_MINT, 10 / 1.1]]), NOW)).not.toBeNull();
    expect(rankArbitrage({ pools: [bayla], unread: 0, truncated: false, chainNow: NOW, safety: new Map() }, new Map([[WSOL_MINT, 200], [BAYLA_MINT, 10 / 1.1]]))).toHaveLength(1);
  });

  it('unsizedPools: the clock not read, pools not read, and token checks not read, each counted, a blocked token not', () => {
    const ok = row();
    const t2022 = row();
    const pool = t2022.quoteIsToken0 ? { ...t2022.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...t2022.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
    const unreadCheck: PoolView = { ...t2022, snapshot: { ...t2022.snapshot, pool } };
    const blockedPool = row();
    const blocked: TokenSafety = { kind: 'read', mint: blockedPool.tokenMint, verdict: 'blocked', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
    const list = (chainNow: bigint | null, unread: number): PoolList => ({ pools: [ok, unreadCheck, blockedPool], unread, truncated: false, chainNow, safety: new Map([[blockedPool.tokenMint, blocked]]) });
    expect(unsizedPools(list(NOW, 0))).toEqual({ clock: false, unreadPools: 0, unreadChecks: 1 });
    expect(unsizedPools(list(null, 2))).toEqual({ clock: true, unreadPools: 2, unreadChecks: 1 });
    expect(unsizedPools({ pools: [ok], unread: 0, truncated: false, chainNow: NOW, safety: new Map() })).toEqual({ clock: false, unreadPools: 0, unreadChecks: 0 });
  });
});

describe('readMarketPrices: one Jupiter read for the whole list', () => {
  const pool = (quote?: QuoteCoin) => viewOf(buildPool({ mint: key(), quote, address: at(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n }), { sol: 10n ** 9n, tok: 10n ** 9n });

  it('asks once for every token and pairing coin, sorted, and keeps only usable prices of coins it asked for', async () => {
    const pools = [pool(), pool(USDC_QUOTE), pool()];
    const asked: string[][] = [];
    const r = await readMarketPrices(pools, async (mints) => {
      asked.push(mints);
      return { [pools[0]!.tokenMint]: 2, [pools[1]!.tokenMint]: 0, [pools[2]!.tokenMint]: Number.NaN, [WSOL_MINT]: 200, [USDC_MINT]: 1, [BAYLA_MINT]: 5 };
    });
    expect(asked).toEqual([[...new Set([...pools.map((v) => v.tokenMint), WSOL_MINT, USDC_MINT])].sort()]);
    expect(r).toEqual({ kind: 'ok', usd: new Map([[pools[0]!.tokenMint, 2], [WSOL_MINT, 200], [USDC_MINT, 1]]) });
  });

  it('more coins than one read takes: one read after another, never two at once', async () => {
    const pools = Array.from({ length: PRICE_IDS_MAX }, () => pool());
    const sizes: number[] = [];
    let inFlight = 0;
    let most = 0;
    const r = await readMarketPrices(pools, async (mints) => {
      most = Math.max(most, ++inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      sizes.push(mints.length);
      return Object.fromEntries(mints.map((m) => [m, 1]));
    });
    expect(sizes).toEqual([PRICE_IDS_MAX, 1]);
    expect(most).toBe(1);
    expect(r.kind === 'ok' && r.usd.size).toBe(PRICE_IDS_MAX + 1);
  });

  it('a read that fails, even the second of two, is unread: never a list where every price agrees', async () => {
    expect(await readMarketPrices([pool()], async () => { throw new Error('Price fetch failed (502)'); })).toEqual({ kind: 'unread' });
    const pools = Array.from({ length: PRICE_IDS_MAX }, () => pool());
    let n = 0;
    expect(await readMarketPrices(pools, async (mints) => {
      if (++n === 2) throw new Error('Price fetch failed (429)');
      return Object.fromEntries(mints.map((m) => [m, 1]));
    })).toEqual({ kind: 'unread' });
  });

  it('no pools: nothing asked', async () => {
    let calls = 0;
    expect(await readMarketPrices([], async () => { calls++; return {}; })).toEqual({ kind: 'ok', usd: new Map() });
    expect(calls).toBe(0);
  });
});
