// @vitest-environment node
//
// The list of every pool, shown before a token is picked: the index names addresses, the
// browser reads and checks each one, and an index that did not answer is never "no pools".
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LITTLE_MONEY_TEXT, QUIET_SECS, listPools, poolTags } from './poolList';
import { readPoolIndex } from './poolIndex';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeRpc, key, observationBytes, viewOf, type FakeAccount } from './testkit.fixture';
import { BAYLA_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import { decodeObservationState } from './ownPrice';
import type { PoolView } from './poolFinder';
import { BAYLA_MINT } from './tokenSafety';
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
});
