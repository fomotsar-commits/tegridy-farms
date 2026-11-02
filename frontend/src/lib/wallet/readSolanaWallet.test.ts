// The dashboard's Solana reads (owner, 2026-10-22: "positions on the website and what the wallet
// holds"). What these hold: a figure is shown only when a read returned it. Every failure is an
// unread leg, never a zero and never an empty list that reads as "you hold nothing".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../launcher/solana/curve/rpc';
import type { Bungalow } from '../bungalows';

const ladder = vi.hoisted(() => ({ pool: null as unknown, wallet: null as unknown }));
const stakes = vi.hoisted(() => ({ entries: null as unknown, pool: null as unknown }));
const lp = vi.hoisted(() => ({ read: null as unknown, readers: true }));
// A coin's own ticker, as its check reads it (readTokenSafety); a mint left out is a check that did not come back.
const tickers = vi.hoisted(() => ({ of: {} as Record<string, string>, fail: false }));
const LADDER_POOL = vi.hoisted(() => 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV');

vi.mock('../ladder/read', () => ({
  readLadderPool: async () => ladder.pool,
  readLadderWallet: async () => ladder.wallet,
}));
vi.mock('../ladder/program', async (orig) => ({
  ...(await orig<typeof import('../ladder/program')>()),
  isLadderConfigured: () => true,
  ladderProgramId: () => new PublicKey('EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ'),
}));
vi.mock('../bungalowStaking', async (orig) => ({
  ...(await orig<typeof import('../bungalowStaking')>()),
  readEntries: async () => stakes.entries,
  readPool: async () => stakes.pool,
}));
const checksOf = vi.hoisted(() => async (mints: string[]) => {
  if (tickers.fail) throw new Error('the token check did not answer');
  return new Map(mints.map((mint) => [mint, tickers.of[mint]
    ? { kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], facts: { decimals: 6 }, name: null, symbol: tickers.of[mint], metadataSource: 'metaplex' }
    : { kind: 'unread', mint, detail: 'outage' }]));
});
vi.mock('../../components/solana/lp/readers', () => ({
  browserLpReaders: () => (lp.readers ? { positions: async () => lp.read, safety: checksOf } : null),
}));
vi.mock('../solana/lp/tokenSafety', async (orig) => ({
  ...(await orig<typeof import('../solana/lp/tokenSafety')>()),
  readTokenSafety: (_rpc: unknown, mints: string[]) => checksOf(mints),
}));
vi.mock('../jupiter', async (orig) => ({
  ...(await orig<typeof import('../jupiter')>()),
  getUsdPrices: vi.fn(),
}));
vi.mock('../bungalows', async (orig) => {
  const m = await orig<typeof import('../bungalows')>();
  return { ...m, BUNGALOWS: m.BUNGALOWS.map((b) => (b.id === 'bayla' ? { ...b, ladderPool: LADDER_POOL } : b)) };
});

import { __resetBoardPricesForTests, boardPrices, readSolanaHoldings, readSolanaLadder, readSolanaOtherCoins, readSolanaPoolShares, readSolanaStakes } from './readSolanaWallet';
import { BUNGALOWS } from '../bungalows';
import { getUsdPrices } from '../jupiter';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from '../solana/lp/tokenSafety';
import { OFF_ISLAND_COINS } from './offIslandCoins';

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const OWNER = key(9).toBase58();
const COIN_A = key(1);
const COIN_B = key(2);
const STRANGER = key(3);
const coins = [
  { id: 'a', symbol: 'AAA', chain: 'solana', address: COIN_A.toBase58(), live: true },
  { id: 'b', symbol: 'BBB', chain: 'solana', address: COIN_B.toBase58(), live: true },
] as unknown as Bungalow[];

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function tokenAccount(mint: PublicKey, amount: bigint, program: string) {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(new PublicKey(OWNER).toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return { pubkey: key(Number(amount % 200n) + 40).toBase58(), account: { data: [b64(d), 'base64'], owner: program, lamports: 2_039_280 } };
}

function mintAccount(decimals: number) {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return { data: [b64(d), 'base64'], owner: TOKEN_PROGRAM, lamports: 1_461_600 };
}

function fakeRpc(o: {
  lamports?: number;
  classic?: ReturnType<typeof tokenAccount>[];
  t22?: ReturnType<typeof tokenAccount>[];
  mints?: Record<string, ReturnType<typeof mintAccount> | null>;
  fail?: string[];
}): SolanaRpc {
  return async (method, params) => {
    const p = params as unknown[];
    if (method === 'getTokenAccountsByOwner') {
      const program = (p[1] as { programId: string }).programId;
      if (o.fail?.includes(`${method}:${program}`)) throw new Error('the RPC proxy did not answer');
      return { value: program === TOKEN_PROGRAM ? o.classic ?? [] : o.t22 ?? [] };
    }
    if (o.fail?.includes(method)) throw new Error('the RPC proxy did not answer');
    if (method === 'getBalance') return { value: o.lamports ?? 0 };
    if (method === 'getMultipleAccounts') return { value: (p[0] as string[]).map((m) => o.mints?.[m] ?? null) };
    throw new Error(`unexpected ${method}`);
  };
}

describe('readSolanaHoldings', () => {
  it('sums an island coin across both token programs, reads its decimals off the mint, and prices it', async () => {
    const leg = await readSolanaHoldings(OWNER, {
      coins,
      rpc: fakeRpc({
        lamports: 1_500_000_000,
        classic: [tokenAccount(COIN_A, 1_000_000n, TOKEN_PROGRAM), tokenAccount(STRANGER, 99n, TOKEN_PROGRAM), tokenAccount(COIN_B, 0n, TOKEN_PROGRAM)],
        t22: [tokenAccount(COIN_A, 2_500_000n, TOKEN_2022_PROGRAM)],
        mints: { [COIN_A.toBase58()]: mintAccount(6) },
      }),
      prices: async () => ({ [WSOL_MINT]: 200, [COIN_A.toBase58()]: 0.5 }),
    });
    expect(leg.status).toBe('ok');
    if (leg.status !== 'ok') return;
    expect(leg.rows.map((r) => [r.symbol, r.amount, r.usd])).toEqual([
      ['SOL', '1.5', 300],
      ['AAA', '3.5', 1.75],
    ]);
    // A coin the island does not list, and a coin held at zero, are not rows.
    expect(leg.rows.find((r) => r.symbol === 'BBB')).toBeUndefined();
    expect(leg.rows.find((r) => r.roomId === 'a')?.to).toBe('/a');
  });

  it.each([
    ['the SOL balance', { fail: ['getBalance'] }],
    ['the classic token list', { fail: [`getTokenAccountsByOwner:${TOKEN_PROGRAM}`] }],
    ['the Token-2022 list', { fail: [`getTokenAccountsByOwner:${TOKEN_2022_PROGRAM}`] }],
  ])('is not read, never empty, when %s fails', async (_, o) => {
    const leg = await readSolanaHoldings(OWNER, {
      coins,
      rpc: fakeRpc({ lamports: 5, classic: [tokenAccount(COIN_A, 7n, TOKEN_PROGRAM)], mints: { [COIN_A.toBase58()]: mintAccount(6) }, ...o }),
      prices: async () => ({}),
    });
    expect(leg.status).toBe('unread');
  });

  it('is not read when a held coin’s mint cannot be read: no amount is printed at a guessed decimals', async () => {
    const leg = await readSolanaHoldings(OWNER, {
      coins,
      rpc: fakeRpc({ classic: [tokenAccount(COIN_A, 7n, TOKEN_PROGRAM)], mints: {} }),
      prices: async () => ({}),
    });
    expect(leg.status).toBe('unread');
  });

  it('keeps the amounts and drops only the USD when the price call fails', async () => {
    const leg = await readSolanaHoldings(OWNER, {
      coins,
      rpc: fakeRpc({ lamports: 1_000_000_000, classic: [tokenAccount(COIN_A, 2_000_000n, TOKEN_PROGRAM)], mints: { [COIN_A.toBase58()]: mintAccount(6) } }),
      prices: async () => { throw new Error('price/v3 503'); },
    });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.symbol, r.amount, r.usd])).toEqual([['SOL', '1', null], ['AAA', '2', null]]);
  });

  // Owner, 2026-11-01: the BIG BRAIN the wallet held was missing from the board.
  const OTHER = key(4).toBase58();
  const offIsland = [{ chain: 'solana' as const, address: OTHER, art: { src: '/art/x.jpg' } }];

  it('lists a coin with no room that offIslandCoins.ts names, by its own ticker, at its read decimals, with its address for its picture', async () => {
    tickers.of = { [OTHER]: 'BIG BRAIN' };
    tickers.fail = false;
    const leg = await readSolanaHoldings(OWNER, {
      coins,
      offIsland,
      rpc: fakeRpc({ classic: [tokenAccount(key(4), 1_445_293_000_000n, TOKEN_PROGRAM), tokenAccount(STRANGER, 5n, TOKEN_PROGRAM)] }),
      prices: async () => ({ [OTHER]: 0.00002 }),
    });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.symbol, r.amount, r.roomId, r.mint, r.to])).toEqual([['BIG BRAIN', '1,445,293', null, OTHER, null]]);
    expect(leg.status === 'ok' && leg.rows[0]!.usd).toBeCloseTo(28.90586, 6);
  });

  it('is not read when a held coin with no room cannot be checked: no amount at a guessed decimals', async () => {
    tickers.of = {};
    const leg = await readSolanaHoldings(OWNER, { coins, offIsland, rpc: fakeRpc({ classic: [tokenAccount(key(4), 7n, TOKEN_PROGRAM)] }), prices: async () => ({}) });
    expect(leg.status).toBe('unread');
  });
});

describe('readSolanaLadder', () => {
  const pool = { ok: true, value: { decimals: 6, totalWeighted: 10n ** 18n, rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 0n, rewardPerWeightStored: 0n, rpwResidueRaw: 0n, minStakeRaw: 0n } };
  beforeEach(() => {
    ladder.pool = pool;
  });

  it('passes a failed wallet read on as not read', async () => {
    ladder.wallet = { ok: false, unreadable: true, reason: 'your position could not be read: 429' };
    expect(await readSolanaLadder(OWNER)).toEqual({ status: 'unread', detail: 'your position could not be read: 429' });
  });

  it('is not read when the scan was cut short or a slot did not answer: a partial list is never the list', async () => {
    ladder.wallet = { ok: true, value: { stats: {}, slots: [], open: [], truncated: true } };
    expect((await readSolanaLadder(OWNER)).status).toBe('unread');
    ladder.wallet = { ok: true, value: { stats: {}, slots: [{ nonce: 0, state: 'unreadable', reason: 'x' }], open: [], truncated: false } };
    expect((await readSolanaLadder(OWNER)).status).toBe('unread');
  });

  it('a wallet that never staked has no lock rows, and that is a read', async () => {
    ladder.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };
    expect(await readSolanaLadder(OWNER)).toEqual({ status: 'ok', rows: [] });
  });

  it('lists an open lock: amount, unlock, its multiplier and what it has earned', async () => {
    // Midday UTC, so the date reads the same in every time zone the test runs in.
    const lockEnd = BigInt(Math.floor(Date.UTC(2030, 0, 15, 12) / 1000));
    ladder.wallet = {
      ok: true,
      value: {
        stats: {},
        slots: [{ nonce: 0, state: 'open' }],
        truncated: false,
        open: [{ address: key(50).toBase58(), amountRaw: 10_000_000_000n, weight: 40_000_000_000n, lockEnd, rewardPerWeightPaid: 0n, rewardsOwed: 1_230_000n }],
      },
    };
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    const leg = await readSolanaLadder(OWNER, { prices: async () => ({ [bayla.address!]: 0.002 }) });
    expect(leg.status).toBe('ok');
    if (leg.status !== 'ok') return;
    expect(leg.rows[0]).toMatchObject({ title: `${bayla.symbol} lock`, to: '/earn/bayla', roomId: 'bayla' });
    expect(leg.rows[0]!.facts).toEqual([`10,000 ${bayla.symbol}`, 'unlocks 15 Jan 2030', '4.00×', `earned 1.23 ${bayla.symbol}`]);
    // Its worth is the locked coins at the read price; what it has earned is not in it.
    expect(leg.rows[0]!.usd).toBeCloseTo(20, 9);
  });

  it('keeps the lock and leaves its worth out when the price does not come back', async () => {
    ladder.wallet = {
      ok: true,
      value: { stats: {}, slots: [], truncated: false, open: [{ address: 'x', amountRaw: 1_000_000n, weight: 1_000_000n, lockEnd: 0n, rewardPerWeightPaid: 0n, rewardsOwed: 0n }] },
    };
    const leg = await readSolanaLadder(OWNER, { prices: async () => { throw new Error('price/v3 429'); } });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.facts[0], r.usd])).toEqual([['1 BAYLA', null]]);
  });

  it('is not read when the wallet has locks but the pool could not be read: earned needs the pool', async () => {
    ladder.pool = { ok: false, unreadable: true, reason: 'the pool could not be read' };
    ladder.wallet = { ok: true, value: { stats: {}, slots: [], truncated: false, open: [{ address: 'x', amountRaw: 1n, weight: 1n, lockEnd: 0n, rewardPerWeightPaid: 0n, rewardsOwed: 0n }] } };
    expect((await readSolanaLadder(OWNER)).status).toBe('unread');
  });
});

describe('readSolanaStakes', () => {
  const target = { room: BUNGALOWS.find((b) => b.id === 'bobo')!, pool: 'PoolStake111', retired: false };

  it('passes a failed entries read on as not read', async () => {
    stakes.entries = { ok: false, reason: 'The pool could not be read right now. That is an outage, not a zero.' };
    expect((await readSolanaStakes(OWNER, target)).status).toBe('unread');
  });

  it('lists open stakes at the decimals the pool reads on chain, and leaves closed ones out', async () => {
    stakes.entries = {
      ok: true,
      entries: [
        { address: 's1', amountRaw: 5_000_000_000n, createdTs: Date.UTC(2029, 0, 1, 12) / 1000, durationSecs: 86_400 * 30, closedTs: 0 },
        { address: 's2', amountRaw: 9n, createdTs: 0, durationSecs: 0, closedTs: 123 },
      ],
    };
    stakes.pool = { ok: true, pool: { decimals: 6 } };
    const leg = await readSolanaStakes(OWNER, target, { prices: async () => ({ [target.room.address!]: 0.01 }) });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, ...r.facts, r.usd])).toEqual([['BOBO stake', '5,000 BOBO', 'unlocks 31 Jan 2029', 50]]);
  });

  it('is not read when the wallet has stakes but the pool’s decimals could not be read', async () => {
    stakes.entries = { ok: true, entries: [{ address: 's1', amountRaw: 5n, createdTs: 0, durationSecs: 0, closedTs: 0 }] };
    stakes.pool = { ok: false, reason: 'outage' };
    expect((await readSolanaStakes(OWNER, target)).status).toBe('unread');
  });
});

describe('readSolanaPoolShares', () => {
  beforeEach(() => {
    lp.readers = true;
    tickers.of = {};
    tickers.fail = false;
  });

  it('passes an unread positions read on as not read', async () => {
    lp.read = { kind: 'unread', detail: 'getTokenAccountsByOwner failed' };
    expect(await readSolanaPoolShares(OWNER)).toEqual({ status: 'unread', detail: 'getTokenAccountsByOwner failed' });
  });

  it('is not read when the wallet holds more shares than could be placed: never a short list as the list', async () => {
    lp.read = { kind: 'ok', positions: [], chainNow: null, totalShares: 2 };
    expect((await readSolanaPoolShares(OWNER)).status).toBe('unread');
  });

  const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
  const share = (lpAccount: string) => ({
    lpAccount,
    tooSmall: false,
    value: { token0: 1_200_000_000n, token1: 40_000_000_000n, sharePct: 2.3149 },
    pool: { kind: 'pool', view: { address: 'P1', tokenMint: bayla.address, quoteIsToken0: true, quote: { mint: WSOL_MINT, symbol: 'SOL', decimals: 9 }, snapshot: { pool: { mint0Decimals: 9, mint1Decimals: 6 } } } },
  });

  it('lists a share: the pair, its share of the pool, what it pays out now, and both sides’ worth', async () => {
    lp.read = { kind: 'ok', chainNow: null, totalShares: 1, positions: [share('acc1')] };
    const prices = vi.fn(async () => ({ [bayla.address!]: 0.002, [WSOL_MINT]: 200 }));
    const leg = await readSolanaPoolShares(OWNER, { prices });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, r.roomId, ...r.facts])).toEqual([
      [`${bayla.symbol} / SOL pool`, 'bayla', '2.31% of the pool', `40,000 ${bayla.symbol} + 1.2 SOL`],
    ]);
    // 40,000 BAYLA at $0.002 plus 1.2 SOL at $200.
    expect(leg.status === 'ok' && leg.rows[0]!.usd).toBeCloseTo(80 + 240, 9);
    expect(prices).toHaveBeenCalledOnce();
  });

  it('a share in a coin the island does not list, quoted in one it does, belongs to the quote coin’s room', async () => {
    const stranger = key(60).toBase58();
    const quoted = share('acc2');
    quoted.pool.view = { ...quoted.pool.view, tokenMint: stranger, quoteIsToken0: false, quote: { mint: bayla.address!, symbol: 'BAYLA', decimals: 6 } };
    lp.read = { kind: 'ok', chainNow: null, totalShares: 1, positions: [quoted] };
    const leg = await readSolanaPoolShares(OWNER, { prices: async () => ({}) });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, r.roomId])).toEqual([[`${stranger.slice(0, 4)}…${stranger.slice(-4)} / BAYLA pool`, 'bayla']]);
  });

  // Owner, 2026-11-01: the BIG BRAIN pool read "J9zj… / SOL pool" on a bare green square.
  it('names a coin with no room by its own ticker, says its whole address, and carries it for the picture', async () => {
    const stranger = key(61).toBase58();
    const own = share('acc3');
    own.pool.view = { ...own.pool.view, tokenMint: stranger };
    tickers.of = { [stranger]: 'BIG BRAIN' };
    lp.read = { kind: 'ok', chainNow: null, totalShares: 1, positions: [own] };
    const leg = await readSolanaPoolShares(OWNER, { prices: async () => ({}) });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, r.roomId, r.mint, ...r.facts])).toEqual([
      ['BIG BRAIN / SOL pool', null, stranger, '2.31% of the pool', '40,000 BIG BRAIN + 1.2 SOL', stranger],
    ]);
  });

  it('a copy of an island coin reads "fake", and a check that does not come back leaves the short address, never fails the leg', async () => {
    const copy = key(62).toBase58();
    const unread = key(63).toBase58();
    const a = share('acc4');
    a.pool.view = { ...a.pool.view, tokenMint: copy };
    const b = share('acc5');
    b.pool.view = { ...b.pool.view, tokenMint: unread };
    tickers.of = { [copy]: 'BAYLA' };
    lp.read = { kind: 'ok', chainNow: null, totalShares: 2, positions: [a, b] };
    let leg = await readSolanaPoolShares(OWNER, { prices: async () => ({}) });
    expect(leg.status === 'ok' && leg.rows.map((r) => r.title)).toEqual(['fake BAYLA / SOL pool', `${unread.slice(0, 4)}…${unread.slice(-4)} / SOL pool`]);
    tickers.fail = true;
    leg = await readSolanaPoolShares(OWNER, { prices: async () => ({}) });
    expect(leg.status === 'ok' && leg.rows.map((r) => r.title)).toEqual([`${copy.slice(0, 4)}…${copy.slice(-4)} / SOL pool`, `${unread.slice(0, 4)}…${unread.slice(-4)} / SOL pool`]);
  });

  it('prints no worth for a share with one side unpriced: half of it would read as all of it', async () => {
    lp.read = { kind: 'ok', chainNow: null, totalShares: 1, positions: [share('acc1')] };
    const leg = await readSolanaPoolShares(OWNER, { prices: async () => ({ [WSOL_MINT]: 200 }) });
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.facts[1], r.usd])).toEqual([[`40,000 ${bayla.symbol} + 1.2 SOL`, null]]);
  });

  it('a share too small to withdraw, or whose pool could not be read, has no worth and asks for no price', async () => {
    lp.read = {
      kind: 'ok',
      chainNow: null,
      totalShares: 2,
      positions: [{ ...share('small'), tooSmall: true, value: null }, { lpAccount: 'gone', tooSmall: false, value: null, pool: { kind: 'unread' } }],
    };
    const prices = vi.fn(async () => ({}));
    const leg = await readSolanaPoolShares(OWNER, { prices });
    expect(leg.status === 'ok' && leg.rows.map((r) => r.usd)).toEqual([null, null]);
    expect(prices).not.toHaveBeenCalled();
  });
});

describe('boardPrices', () => {
  const price = vi.mocked(getUsdPrices);
  const BAYLA_MINT = BUNGALOWS.find((b) => b.id === 'bayla')!.address!;
  beforeEach(() => {
    __resetBoardPricesForTests();
    price.mockReset();
  });

  it('every leg of a board read shares one call: SOL, USDC and the island coins, at the proxy’s shared read', async () => {
    price.mockResolvedValue({ [WSOL_MINT]: 200 });
    await Promise.all([boardPrices([WSOL_MINT]), boardPrices([USDC_MINT]), boardPrices([BAYLA_MINT])]);
    expect(price).toHaveBeenCalledOnce();
    const [ids, , opts] = price.mock.calls[0]!;
    expect(ids).toEqual(expect.arrayContaining([WSOL_MINT, USDC_MINT, BAYLA_MINT]));
    expect(opts).toEqual({ shared: true });
  });

  it('a coin with no room the board lists (offIslandCoins.ts) is in that one call, not a call of its own', async () => {
    price.mockResolvedValue({ [WSOL_MINT]: 200 });
    await boardPrices([OFF_ISLAND_COINS[0]!.address]);
    expect(price).toHaveBeenCalledOnce();
    expect(price.mock.calls[0]![0]).toContain(OFF_ISLAND_COINS[0]!.address);
  });

  it('asks for a coin off the list on its own, never at the shared read', async () => {
    price.mockResolvedValueOnce({ [WSOL_MINT]: 200 }).mockResolvedValueOnce({ Stranger: 3 });
    expect(await boardPrices([WSOL_MINT, 'Stranger'])).toEqual({ [WSOL_MINT]: 200, Stranger: 3 });
    expect(price.mock.calls[1]).toEqual([['Stranger']]);
  });

  it('does not hold a failed read: the next leg asks again', async () => {
    price.mockRejectedValueOnce(new Error('price/v3 503')).mockResolvedValueOnce({ [WSOL_MINT]: 200 });
    await expect(boardPrices([WSOL_MINT])).rejects.toThrow('503');
    expect(await boardPrices([WSOL_MINT])).toEqual({ [WSOL_MINT]: 200 });
    expect(price).toHaveBeenCalledTimes(2);
  });

  it('reads again once its 30 s are up', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      price.mockResolvedValue({});
      await boardPrices([WSOL_MINT]);
      now.mockReturnValue(1_000_000 + 30_001);
      await boardPrices([WSOL_MINT]);
      expect(price).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});

// Owner, 2026-11-01: "it should show all the tokens in the persons wallet above 1$ not just island tokens".
describe('readSolanaOtherCoins', () => {
  const DUST = key(4);
  const NO_PRICE = key(5);
  const NO_CHECK = key(6);
  beforeEach(() => { tickers.of = {}; tickers.fail = false; });
  const wallet = () => fakeRpc({
    classic: [
      tokenAccount(COIN_A, 1_000_000n, TOKEN_PROGRAM), // an island coin: the holdings leg lists it
      tokenAccount(STRANGER, 3_000_000n, TOKEN_PROGRAM), // 3 at $2: listed
      tokenAccount(DUST, 1_000_000n, TOKEN_PROGRAM), // 1 at $0.50: under $1
      tokenAccount(NO_PRICE, 9_000_000n, TOKEN_PROGRAM), // no market price: never listed
      tokenAccount(NO_CHECK, 9_000_000n, TOKEN_PROGRAM), // its mint not read: cannot be sized
    ],
  });

  it('lists every other coin worth $1 or more, named by its own ticker, largest first', async () => {
    tickers.of = { [STRANGER.toBase58()]: 'WIF', [DUST.toBase58()]: 'DUST', [NO_PRICE.toBase58()]: 'NOPE' };
    const asked: string[][] = [];
    const leg = await readSolanaOtherCoins(OWNER, {
      coins, offIsland: [], rpc: wallet(),
      prices: async (m) => { asked.push(m); return { [STRANGER.toBase58()]: 2, [DUST.toBase58()]: 0.5 }; },
    });
    expect(leg).toEqual({ status: 'ok', rows: [{ key: `sol:${STRANGER.toBase58()}`, symbol: 'WIF', chain: 'solana', amount: '3', usd: 6, roomId: null, mint: STRANGER.toBase58(), to: null }] });
    // The island coin is not priced again here, nor a coin whose mint was not read.
    expect(asked.flat().sort()).toEqual([STRANGER, DUST, NO_PRICE].map((k) => k.toBase58()).sort());
  });

  it('is not read when the prices cannot be read: never "nothing else"', async () => {
    tickers.of = { [STRANGER.toBase58()]: 'WIF' };
    const leg = await readSolanaOtherCoins(OWNER, { coins, offIsland: [], rpc: wallet(), prices: async () => { throw new Error('Price fetch failed (429)'); } });
    expect(leg).toEqual({ status: 'unread', detail: 'Price fetch failed (429)' });
  });

  it('is not read when no coin’s mint could be read', async () => {
    tickers.fail = true;
    const leg = await readSolanaOtherCoins(OWNER, { coins, offIsland: [], rpc: wallet(), prices: async () => ({}) });
    expect(leg.status).toBe('unread');
  });

  it('is an empty list, read, for a wallet holding nothing but island coins', async () => {
    const leg = await readSolanaOtherCoins(OWNER, { coins, offIsland: [], rpc: fakeRpc({ classic: [tokenAccount(COIN_A, 5n, TOKEN_PROGRAM)] }), prices: async () => ({}) });
    expect(leg).toEqual({ status: 'ok', rows: [] });
  });

  it('is not read when the wallet’s coins cannot be read', async () => {
    const leg = await readSolanaOtherCoins(OWNER, { coins, offIsland: [], rpc: fakeRpc({ fail: [`getTokenAccountsByOwner:${TOKEN_PROGRAM}`] }), prices: async () => ({}) });
    expect(leg.status).toBe('unread');
  });
});
