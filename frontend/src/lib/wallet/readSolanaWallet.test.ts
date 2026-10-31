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
vi.mock('../../components/solana/lp/readers', () => ({
  browserLpReaders: () => (lp.readers ? { positions: async () => lp.read } : null),
}));
vi.mock('../bungalows', async (orig) => {
  const m = await orig<typeof import('../bungalows')>();
  return { ...m, BUNGALOWS: m.BUNGALOWS.map((b) => (b.id === 'bayla' ? { ...b, ladderPool: LADDER_POOL } : b)) };
});

import { readSolanaHoldings, readSolanaLadder, readSolanaPoolShares, readSolanaStakes } from './readSolanaWallet';
import { BUNGALOWS } from '../bungalows';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '../solana/lp/tokenSafety';

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
});

describe('readSolanaLadder', () => {
  const room = (id = 'bayla') => {
    const b = BUNGALOWS.find((x) => x.id === id)!;
    return { ...b, ladderPool: b.ladderPool ?? LADDER_POOL };
  };
  const pool = { ok: true, value: { decimals: 6, totalWeighted: 10n ** 18n, rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 0n, rewardPerWeightStored: 0n, rpwResidueRaw: 0n, minStakeRaw: 0n } };
  beforeEach(() => {
    ladder.pool = pool;
  });

  it('passes a failed wallet read on as not read', async () => {
    ladder.wallet = { ok: false, unreadable: true, reason: 'your position could not be read: 429' };
    expect(await readSolanaLadder(OWNER, room())).toEqual({ status: 'unread', detail: 'your position could not be read: 429' });
  });

  it('is not read when the scan was cut short or a slot did not answer: a partial list is never the list', async () => {
    ladder.wallet = { ok: true, value: { stats: {}, slots: [], open: [], truncated: true } };
    expect((await readSolanaLadder(OWNER, room())).status).toBe('unread');
    ladder.wallet = { ok: true, value: { stats: {}, slots: [{ nonce: 0, state: 'unreadable', reason: 'x' }], open: [], truncated: false } };
    expect((await readSolanaLadder(OWNER, room())).status).toBe('unread');
  });

  it('a wallet that never staked has no lock rows, and that is a read', async () => {
    ladder.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };
    expect(await readSolanaLadder(OWNER, room())).toEqual({ status: 'ok', rows: [] });
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
    const leg = await readSolanaLadder(OWNER, room());
    expect(leg.status).toBe('ok');
    if (leg.status !== 'ok') return;
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    expect(leg.rows[0]).toMatchObject({ title: `${bayla.symbol} lock`, to: '/earn/bayla', roomId: 'bayla' });
    expect(leg.rows[0]!.facts).toEqual([`10,000 ${bayla.symbol}`, 'unlocks 15 Jan 2030', '4.00×', `earned 1.23 ${bayla.symbol}`]);
  });

  it("names the room it was asked for: another room's locks carry that room's coin and page", async () => {
    ladder.wallet = {
      ok: true,
      value: {
        stats: {},
        slots: [{ nonce: 0, state: 'open' }],
        truncated: false,
        open: [{ address: key(51).toBase58(), amountRaw: 5_000_000n, weight: 2_000_000n, lockEnd: 0n, rewardPerWeightPaid: 0n, rewardsOwed: 0n }],
      },
    };
    const leg = await readSolanaLadder(OWNER, room('bobo'));
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, r.roomId, r.to, r.facts[0]])).toEqual([['BOBO lock', 'bobo', '/earn/bobo', '5 BOBO']]);
  });

  it('is not read when the wallet has locks but the pool could not be read: earned needs the pool', async () => {
    ladder.pool = { ok: false, unreadable: true, reason: 'the pool could not be read' };
    ladder.wallet = { ok: true, value: { stats: {}, slots: [], truncated: false, open: [{ address: 'x', amountRaw: 1n, weight: 1n, lockEnd: 0n, rewardPerWeightPaid: 0n, rewardsOwed: 0n }] } };
    expect((await readSolanaLadder(OWNER, room())).status).toBe('unread');
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
    const leg = await readSolanaStakes(OWNER, target);
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, ...r.facts])).toEqual([['BOBO stake', '5,000 BOBO', 'unlocks 31 Jan 2029']]);
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
  });

  it('passes an unread positions read on as not read', async () => {
    lp.read = { kind: 'unread', detail: 'getTokenAccountsByOwner failed' };
    expect(await readSolanaPoolShares(OWNER)).toEqual({ status: 'unread', detail: 'getTokenAccountsByOwner failed' });
  });

  it('is not read when the wallet holds more shares than could be placed: never a short list as the list', async () => {
    lp.read = { kind: 'ok', positions: [], chainNow: null, totalShares: 2 };
    expect((await readSolanaPoolShares(OWNER)).status).toBe('unread');
  });

  it('lists a share: the pair, its share of the pool, and what it pays out now', async () => {
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    lp.read = {
      kind: 'ok',
      chainNow: null,
      totalShares: 1,
      positions: [{
        lpAccount: 'acc1',
        tooSmall: false,
        value: { token0: 1_200_000_000n, token1: 40_000_000_000n, sharePct: 2.3149 },
        pool: { kind: 'pool', view: { address: 'P1', tokenMint: bayla.address, quoteIsToken0: true, quote: { symbol: 'SOL', decimals: 9 }, snapshot: { pool: { mint0Decimals: 9, mint1Decimals: 6 } } } },
      }],
    };
    const leg = await readSolanaPoolShares(OWNER);
    expect(leg.status === 'ok' && leg.rows.map((r) => [r.title, r.roomId, ...r.facts])).toEqual([
      [`${bayla.symbol} / SOL pool`, 'bayla', '2.31% of the pool', `40,000 ${bayla.symbol} + 1.2 SOL`],
    ]);
  });
});
