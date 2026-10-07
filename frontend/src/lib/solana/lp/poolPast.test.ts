// @vitest-environment node
//
// A pool's last trade, from the record the program itself writes (oracle.rs): a field,
// never a guess from fee counters, and never the word "active".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { IX_DEPOSIT, IX_INITIALIZE, IX_SWAP_BASE_INPUT, IX_WITHDRAW, decodePoolState } from '../cpswap/program';
import { FORECAST_WORDS } from './format';
import { tokenSymbol } from './identity';
import { decodeObservationState } from './ownPrice';
import { poolViewFrom, type PoolView, type ReadPoolsOptions } from './poolFinder';
import { noteResponse } from './rpcBudget';
import { BAYLA_MINT } from './tokenSafety';
import { parseTx, type ParsedTx, type SigEntry } from './txHistory';
import {
  NO_TRADE_YET, POOL_PAST_BUTTON, POOL_PAST_READ_MORE, classifyPoolTx, lastTrade, lastTradeText, poolPastText, poolPastTotals, readPoolPast, type PoolTx,
} from './poolPast';
import { LAUNCH, PROGRAM, buildPool, fakeRpcWithHistory, key, observationBytes, txJson, viewOf, type TxIxSpec } from './testkit.fixture';

const opts: ReadPoolsOptions = { programId: PROGRAM, launchProgramId: LAUNCH };
const pool = key();

/** A view whose price record is `bytes`, decoded the way the finder decodes it. */
function viewWith(bytes: Uint8Array): PoolView {
  const b = buildPool({ mint: key(), configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
  const obs = decodeObservationState(bytes);
  if (!obs) throw new Error('the test bytes do not decode as a price record');
  return viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'ok', obs } });
}

describe('lastTrade', () => {
  it('a ring the program never wrote to is none, whatever its index says', () => {
    // index 1: a decoder reading the wrong byte for `initialized` would see a 1 here.
    expect(lastTrade(viewWith(observationBytes({ pool, initialized: false, index: 1 })))).toEqual({ kind: 'none' });
  });

  it('an initialized ring is at its last update time', () => {
    const t = 1_791_055_083n; // 2026-10-03T19:18:03Z, the venue's first pool opening
    expect(lastTrade(viewWith(observationBytes({ pool, index: 3, lastUpdate: t, obs: [[3, t - 7n, 1n, 1n]] })))).toEqual({ kind: 'at', time: t });
  });

  it('a ring with no last update time uses the newest slot time', () => {
    const slotTime = 1_700_000_000n;
    expect(lastTrade(viewWith(observationBytes({ pool, index: 5, lastUpdate: 0n, obs: [[5, slotTime, 1n, 1n], [4, slotTime - 60n, 1n, 1n]] })))).toEqual({ kind: 'at', time: slotTime });
  });

  // The program writes both times from the Clock, so a ring that is initialized yet carries
  // no time at all is not one it wrote: unread, never "Last trade: 1970-01-01 00:00:00 UTC".
  it('an initialized ring with no time anywhere is unread, not a 1970 date', () => {
    const t = lastTrade(viewWith(observationBytes({ pool, initialized: true, index: 0, lastUpdate: 0n })));
    expect(t).toEqual({ kind: 'unread', detail: 'its price record carries no time' });
    expect(lastTradeText(t)).not.toMatch(/1970/);
  });

  it('a record the finder could not read is unread with the finder’s reason, and one never read says so', () => {
    const b = buildPool({ mint: key(), configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    expect(lastTrade(viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'unread', detail: 'its price record account is missing' } }))).toEqual({
      kind: 'unread',
      detail: 'its price record account is missing',
    });
    expect(lastTrade(viewOf(b, { sol: 10n ** 9n, tok: 10n ** 12n, history: { kind: 'not-read' } }))).toEqual({ kind: 'unread', detail: 'not read yet' });
  });

  // Through the finder, for a pool that is NOT the launch pool: the record is read for
  // every pool, and a record that names another pool is never this pool's trade record.
  it('reads an ordinary pool’s record through the finder, and a record belonging to another pool is unread', () => {
    const mint = key();
    const standard = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const launch = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const acc = (b: typeof standard, a: string) => ({ address: a, owner: b.accounts[a]!.owner, data: b.accounts[a]!.data, lamports: 1 });
    const entryFor = (b: typeof standard, recordOf: typeof standard, initialized: boolean) => {
      const d = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
      return poolViewFrom({
        address: b.address.toBase58(),
        pool: acc(b, b.address.toBase58()),
        vault0: acc(b, d.token0Vault),
        vault1: acc(b, d.token1Vault),
        config: acc(b, d.ammConfig),
        observation: { address: b.observation.toBase58(), owner: PROGRAM.toBase58(), data: observationBytes({ pool: recordOf.address, initialized, lastUpdate: initialized ? 1_700_000_000n : 0n }), lamports: 1 },
        opts,
      });
    };
    const own = entryFor(standard, standard, false);
    expect(own.kind === 'pool' && own.view.origin).toBe('standard');
    expect(own.kind === 'pool' && lastTrade(own.view)).toEqual({ kind: 'none' });

    const traded = entryFor(standard, standard, true);
    expect(traded.kind === 'pool' && lastTrade(traded.view)).toEqual({ kind: 'at', time: 1_700_000_000n });

    const borrowed = entryFor(standard, launch, true);
    expect(borrowed.kind === 'pool' && lastTrade(borrowed.view)).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/another pool/) });
  });
});

describe('lastTradeText', () => {
  const lines = [
    lastTradeText({ kind: 'none' }),
    lastTradeText({ kind: 'at', time: 1_791_055_083n }),
    lastTradeText({ kind: 'unread', detail: 'its price record account is missing' }),
  ];

  it('says the three things, verbatim, with the time in UTC', () => {
    expect(lines).toEqual([
      'No trade has reached this pool yet.',
      'Last trade: 2026-10-03 19:18:03 UTC',
      'Its trade record could not be read (its price record account is missing).',
    ]);
    expect(NO_TRADE_YET).toBe('No trade has reached this pool yet.');
  });

  // A dust swap for 0.005 SOL makes a dead pool's record read "minutes ago"; the time is
  // the fact, so the word "active" is never printed. No em dash, no forecast word.
  it('never calls a pool active, and carries no em dash or forecast word', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/active/i);
      expect(line).not.toContain('—');
      expect(line).not.toMatch(FORECAST_WORDS);
    }
  });
});

// ── the pool's last 20 transactions, on a press (DESIGN 2.B1) ────────────────────────

const PROG = PROGRAM.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const k = () => key().toBase58();
const sig = (tag: string) => `${tag}y`.padEnd(88, '2');
const entryOf = (signature: string, over: Partial<SigEntry> = {}): SigEntry => ({ signature, slot: 200, blockTime: 1_791_070_000, err: null, confirmationStatus: 'finalized', ...over });
function u64le(v: bigint): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...b];
}
const ixData = (disc: Uint8Array, ...args: bigint[]) => Uint8Array.from([...disc, ...args.flatMap(u64le)]);
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mainnet-history', name), 'utf8'));

/** A T/SOL pool at the given reserves. */
function poolAt(r: { Rc: bigint; Rt: bigint; S: bigint }): PoolView {
  const b = buildPool({ mint: key(), configIndex: 1, quoteReserve: r.Rc, tokenReserve: r.Rt, lpSupply: r.S });
  return viewOf(b, { sol: r.Rc, tok: r.Rt });
}

describe('classifyPoolTx: a pool’s transactions by what they did', () => {
  const view = poolAt({ Rc: 11_000_000_000n, Rt: 1_100_000_000_000n, S: 110_000_000_000n });
  const p = view.snapshot.pool;
  const coinVault = view.quoteIsToken0 ? p.token0Vault : p.token1Vault;
  const tokenVault = view.quoteIsToken0 ? p.token1Vault : p.token0Vault;
  const coinMint = view.quoteIsToken0 ? p.token0Mint : p.token1Mint;
  const tokenMint = view.quoteIsToken0 ? p.token1Mint : p.token0Mint;
  const classify = (tx: ParsedTx | null, over: Partial<SigEntry> = {}) => classifyPoolTx(entryOf(tx?.signature ?? sig('none'), over), tx, view, PROG);

  /** A swap of the coin in, as the node reports it: both vaults move, the trader's token account rises, the trader's wrapped-SOL account is on neither side. */
  function swapTx(o: { coinIn: bigint; tokenOut: bigint; arg?: bigint; pool?: string; inner?: boolean; twice?: boolean; noBalances?: boolean; err?: unknown; signature?: string }): ParsedTx {
    const [trader, traderTok, traderCoin, auth, router] = [k(), k(), k(), k(), k()];
    const pool = o.pool ?? view.address;
    const step: TxIxSpec = { program: PROG, accounts: [trader, auth, p.ammConfig, pool, traderCoin, traderTok, coinVault, tokenVault, TOKEN, TOKEN, coinMint, tokenMint, p.observationKey], data: ixData(IX_SWAP_BASE_INPUT, o.arg ?? o.coinIn, 1n) };
    const steps = o.twice ? [step, step] : [step];
    const balances = o.noBalances ? [] : [
      { account: coinVault, mint: coinMint, owner: auth, pre: 11_000_000_000n, post: 11_000_000_000n + o.coinIn },
      { account: tokenVault, mint: tokenMint, owner: auth, pre: 1_100_000_000_000n, post: 1_100_000_000_000n - o.tokenOut },
      { account: traderTok, mint: tokenMint, owner: trader, pre: null, post: o.tokenOut },
    ];
    const raw = txJson({
      keys: [trader, auth, p.ammConfig, pool, traderCoin, traderTok, coinVault, tokenVault, TOKEN, coinMint, tokenMint, p.observationKey, PROG, router],
      instructions: o.inner ? [{ program: router, accounts: [trader], data: Uint8Array.from([1]) }] : steps,
      inner: o.inner ? [{ index: 0, instructions: steps }] : undefined,
      balances,
      err: o.err,
      slot: 200,
      blockTime: 1_791_070_000,
    });
    return parseTx(o.signature ?? sig('swap'), raw);
  }

  /** A deposit, withdrawal or opening step on the pool with its vault and share moves. */
  function cpTx(kind: 'deposit' | 'withdrawal' | 'opening', o: { owner: string; lp: bigint; coin: bigint; token: bigint; signer?: string; signature?: string }): ParsedTx {
    const [lpAcc, auth, t0, t1] = [k(), k(), k(), k()];
    const sign = kind === 'withdrawal' ? -1n : 1n;
    const accounts = kind === 'opening'
      ? [o.owner, p.ammConfig, auth, view.address, p.token0Mint, p.token1Mint, p.lpMint, t0, t1, lpAcc, p.token0Vault, p.token1Vault, k(), p.observationKey, TOKEN, TOKEN, TOKEN_2022, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111']
      : [o.owner, auth, view.address, lpAcc, t0, t1, p.token0Vault, p.token1Vault, TOKEN, TOKEN_2022, p.token0Mint, p.token1Mint, p.lpMint];
    const disc = kind === 'deposit' ? IX_DEPOSIT : kind === 'withdrawal' ? IX_WITHDRAW : IX_INITIALIZE;
    const d0 = sign * (view.quoteIsToken0 ? o.coin : o.token);
    const d1 = sign * (view.quoteIsToken0 ? o.token : o.coin);
    const raw = txJson({
      keys: [...new Set([o.signer ?? o.owner, ...accounts, PROG])],
      instructions: [{ program: PROG, accounts, data: ixData(disc, o.lp, 1n << 62n, 1n << 62n) }],
      balances: [
        { account: lpAcc, mint: p.lpMint, owner: o.owner, pre: 5n, post: 5n + sign * o.lp },
        { account: p.token0Vault, mint: p.token0Mint, owner: auth, pre: 10n ** 12n, post: 10n ** 12n + d0 },
        { account: p.token1Vault, mint: p.token1Mint, owner: auth, pre: 10n ** 12n, post: 10n ** 12n + d1 },
      ],
      slot: 200,
      blockTime: 1_791_070_000,
    });
    return parseTx(o.signature ?? sig(kind), raw);
  }

  it('a swap: one cp-swap step naming the pool, one vault up and the other down; the input is the rising vault’s delta, and the trader’s wrapped-SOL account is on neither side (8.12)', () => {
    const tx = swapTx({ coinIn: 1_000_000_000n, tokenOut: 90_825_688_073n });
    expect(classify(tx)).toEqual({ kind: 'swap', signature: tx.signature, slot: 200, blockTime: 1_791_070_000, final: true, inSide: 'coin', inAmount: 1_000_000_000n });
    expect(classify(tx, { confirmationStatus: 'confirmed' })).toMatchObject({ kind: 'swap', final: false });
  });

  it('a swap through a router, as an inner step, counts', () => {
    expect(classify(swapTx({ coinIn: 1_000_000_000n, tokenOut: 90_825_688_073n, inner: true }))).toMatchObject({ kind: 'swap', inSide: 'coin', inAmount: 1_000_000_000n });
  });

  it('the input is the vault’s delta, never the argument: a dust swap of 600 units whose argument says 123 is a swap of 600', () => {
    expect(classify(swapTx({ coinIn: 600n, tokenOut: 54_000n, arg: 123n }))).toMatchObject({ kind: 'swap', inSide: 'coin', inAmount: 600n });
  });

  it('a deposit is a deposit, not other; an opening an opening; a withdrawal a withdrawal; each with the wallet that signed', () => {
    const owner = k();
    expect(classify(cpTx('deposit', { owner, lp: 10n, coin: 1n, token: 100n, signature: sig('dep') }))).toEqual({ kind: 'deposit', signature: sig('dep'), slot: 200, blockTime: 1_791_070_000, final: true, signer: owner });
    expect(classify(cpTx('opening', { owner, lp: 10n, coin: 1n, token: 100n }))).toMatchObject({ kind: 'opening', signer: owner });
    expect(classify(cpTx('withdrawal', { owner, lp: 5n, coin: 1n, token: 50n }))).toMatchObject({ kind: 'withdrawal', signer: owner });
    // The wallet in the owner slot did not sign: not its deposit.
    expect(classify(cpTx('deposit', { owner, lp: 10n, coin: 1n, token: 100n, signer: k() })).kind).toBe('other');
  });

  it('a swap on another pool is other; two steps are mixed; a failed one is failed; no record is unread; no balances is unread', () => {
    expect(classify(swapTx({ coinIn: 1n, tokenOut: 1n, pool: k() })).kind).toBe('other');
    expect(classify(swapTx({ coinIn: 1n, tokenOut: 1n, twice: true })).kind).toBe('mixed');
    expect(classify(swapTx({ coinIn: 1n, tokenOut: 1n, err: { InstructionError: [0, { Custom: 6001 }] } })).kind).toBe('failed');
    expect(classify(null)).toEqual({ kind: 'unread', signature: sig('none'), blockTime: 1_791_070_000, detail: 'the node has no record of it' });
    expect(classify(swapTx({ coinIn: 1n, tokenOut: 1n, noBalances: true })).kind).toBe('unread');
  });
});

describe('readPoolPast on the venue’s eight mainnet transactions (fixtures)', () => {
  const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
  interface Row { signature: string; tx: unknown }
  /** The real pool at the reserves after the eight transactions; its price record never initialized. */
  function livePool(): PoolView {
    const b = buildPool({ mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: 4_832_878_899n, tokenReserve: 1_062_021_556_414n, lpSupply: 71_642_316_872n });
    const obs = decodeObservationState(observationBytes({ pool: b.address, initialized: false }));
    if (!obs) throw new Error('the price record bytes do not decode');
    return viewOf(b, { sol: 4_832_878_899n, tok: 1_062_021_556_414n, history: { kind: 'ok', obs } });
  }
  const rpc = () => {
    const rows = fixture('pool.baylaSol.transactions.json') as Row[];
    return fakeRpcWithHistory({}, { [POOL]: fixture('pool.baylaSol.signatures.json') as SigEntry[] }, Object.fromEntries(rows.map((r) => [r.signature, r.tx])));
  };

  it('0 swaps, 7 deposits from 6 wallets, 0 withdrawals, 1 opening, 0 other; nothing traded in; complete, back to the opening', async () => {
    const view = livePool();
    expect(view.address).toBe(POOL);
    expect(await readPoolPast(rpc(), view, PROG, {})).toEqual({
      kind: 'ok', count: 8, swaps: 0, deposits: 7, withdrawals: 0, openings: 1, wallets: 6, other: 0,
      volumeIn: { token: 0n, coin: 0n }, from: 1791055083, to: 1791137472, complete: true, reachedOpening: true,
    });
  });

  it('the sentence, verbatim: the opening counted apart, no fee total, no forecast word, no em dash', async () => {
    const view = livePool();
    const text = poolPastText(await readPoolPast(rpc(), view, PROG, {}), view);
    expect(text).toBe('All 8 transactions since this pool opened on 2026-10-03 19:18 UTC: 0 swaps, 7 deposits from 6 wallets, 0 withdrawals, 1 opening, 0 other. Traded in: 0 SOL and 0 BAYLA. Fees are this tier’s rate on that volume; the rate can change, so no total is shown.');
    // No sum of fees at today's rate: the word never stands beside a number.
    expect(text).not.toMatch(/\bfees?\b[^.]*\d/i);
    expect(text).not.toMatch(FORECAST_WORDS);
    expect(text).not.toContain('—');
    expect(POOL_PAST_BUTTON).toBe('Read this pool’s last 20 transactions');
  });
});

describe('poolPastTotals and poolPastText', () => {
  const view = poolAt({ Rc: 11_000_000_000n, Rt: 1_100_000_000_000n, S: 110_000_000_000n });
  const sym = tokenSymbol(view.tokenMint);
  const swapAt = (i: number): PoolTx => ({ kind: 'swap', signature: sig(`s${i}`), slot: 1000 + i, blockTime: 1_791_000_000 + i * 3_000, final: true, inSide: i % 2 ? 'coin' : 'token', inAmount: 1_000_000_000n });

  it('a full page with more behind is not complete: the sentence names the span, both sides traded in, and says older ones were not read', () => {
    const items = Array.from({ length: 20 }, (_, i) => swapAt(19 - i));
    const r = poolPastTotals(items, true);
    expect(r).toEqual({ kind: 'ok', count: 20, swaps: 20, deposits: 0, withdrawals: 0, openings: 0, wallets: 0, other: 0, volumeIn: { token: 10_000_000_000n, coin: 10_000_000_000n }, from: 1_791_000_000, to: 1_791_057_000, complete: false, reachedOpening: false });
    expect(poolPastText(r, view)).toBe(`Last 20 transactions on this pool, 2026-10-03 04:00 UTC to 2026-10-03 19:50 UTC: 20 swaps, 0 deposits from 0 wallets, 0 withdrawals, 0 other. Traded in: 10 SOL and 10,000 ${sym}. Fees are this tier’s rate on that volume; the rate can change, so no total is shown. Older transactions were not read.`);
  });

  it('deposits count each wallet once; mixed and failed fold into other; an opening is counted apart and reaches the opening', () => {
    const [a, b] = [k(), k()];
    const dep = (signer: string, i: number): PoolTx => ({ kind: 'deposit', signature: sig(`d${i}`), slot: i, blockTime: 1_791_000_000 + i, final: true, signer });
    const items: PoolTx[] = [
      dep(a, 5),
      { kind: 'mixed', signature: sig('m'), slot: 4, blockTime: 1_791_000_004, final: true },
      dep(b, 3),
      { kind: 'failed', signature: sig('f'), slot: 2, blockTime: 1_791_000_002, final: true },
      dep(a, 1),
      { kind: 'opening', signature: sig('o'), slot: 0, blockTime: 1_791_000_000, final: true, signer: a },
    ];
    const r = poolPastTotals(items, false);
    expect(r).toMatchObject({ kind: 'ok', count: 6, swaps: 0, deposits: 3, wallets: 2, withdrawals: 0, openings: 1, other: 2, reachedOpening: true, complete: true, from: 1_791_000_000, to: 1_791_000_005 });
    expect(poolPastText(r, view)).toMatch(/^All 6 transactions since this pool opened on 2026-10-03 04:00 UTC: 0 swaps, 3 deposits from 2 wallets, 0 withdrawals, 1 opening, 2 other\. /);
  });

  it('an unread entry makes the page partial, with no totals; unread and paused have their sentences', () => {
    const r = poolPastTotals([swapAt(1), { kind: 'unread', signature: sig('u'), blockTime: null, detail: 'x' }], false);
    expect(r).toEqual({ kind: 'partial', unreadCount: 1 });
    expect(poolPastText(r, view)).toBe('1 of the 20 could not be read, so no totals are shown. Read again.');
    expect(poolPastText({ kind: 'unread', detail: 'the chain did not answer in 20 seconds' }, view)).toBe('This pool’s history could not be read (the chain did not answer in 20 seconds).');
    expect(poolPastText({ kind: 'paused' }, view)).toMatch(/paused/);
    expect(POOL_PAST_READ_MORE).toBe('Read 20 more');
  });

  it('readPoolPast: the budget gate first, before any call; a transport failure is unread with the reason', async () => {
    const budget = (remaining: string) => noteResponse(new Response(null, { headers: { 'X-RateLimit-Remaining': remaining } }));
    budget('59');
    const calls: [string, unknown[]][] = [];
    expect(await readPoolPast(fakeRpcWithHistory({}, { [view.address]: [] }, {}, { calls }), view, PROG, {})).toEqual({ kind: 'paused' });
    expect(calls).toEqual([]);
    budget('300');
    expect(await readPoolPast(fakeRpcWithHistory({}, { [view.address]: [] }, {}, { fail: new Set(['getSignaturesForAddress']) }), view, PROG, {})).toEqual({ kind: 'unread', detail: 'getSignaturesForAddress: HTTP 502' });
    expect(await readPoolPast(fakeRpcWithHistory({}, { [view.address]: [] }, {}), view, PROG, {})).toMatchObject({ kind: 'ok', count: 0, complete: true, from: null, to: null });
  });
});
