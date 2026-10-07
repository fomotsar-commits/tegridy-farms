// @vitest-environment node
//
// The venue's pool list trusts the index for addresses only: every pool is read on chain,
// an index that did not answer is "unread", never "no pools", and pools are grouped by
// coin (SOL, USDC, BAYLA) and deepest first within a coin, never ranked across coins.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { listPools } from './poolList';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from './quotes';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeRpc, key, type FakeAccount } from './testkit.fixture';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

/**
 * The server's `?all=1` answer (api/_lib/pool-index.js): `all: true` echoed as a boolean,
 * the program, the addresses and `truncated`. `echo` swaps the echo for something else.
 */
function venueIndex(pools: string[], o: { status?: number; program?: string; truncated?: boolean; echo?: unknown; calls?: string[] } = {}): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url, 'http://x');
    o.calls?.push(u.search);
    if (o.status) return new Response('{}', { status: o.status });
    const body = { all: 'echo' in o ? o.echo : true, program: o.program ?? PROGRAM.toBase58(), pools, truncated: o.truncated ?? false, readAt: '2026-10-06T00:00:00.000Z' };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('listPools', () => {
  it('asks the index once for every pool, reads each on chain, and groups by coin then deepest first within a coin', async () => {
    const solShallow = buildPool({ mint: key(), configIndex: 1, quoteReserve: 1_000_000_000n, tokenReserve: 1n });
    const solDeep = buildPool({ mint: key(), configIndex: 1, address: Keypair.generate().publicKey, quoteReserve: 5_000_000_000n, tokenReserve: 1_000_000_000n });
    // 10 USDC is more coin units than 1 SOL and more dollars than nothing read here says: it still lists after every SOL pool.
    const usdc = buildPool({ mint: key(), configIndex: 1, quote: USDC_QUOTE, quoteReserve: 10_000_000n, tokenReserve: 1n });
    const bayla = buildPool({ mint: key(), configIndex: 1, quote: BAYLA_QUOTE, quoteReserve: 999_000_000_000n, tokenReserve: 1n });
    const accounts: Record<string, FakeAccount> = { ...solShallow.accounts, ...solDeep.accounts, ...usdc.accounts, ...bayla.accounts, [CLOCK]: clockAccount(1_000n) };
    const calls: string[] = [];
    const named = [bayla, usdc, solShallow, solDeep].map((p) => p.address.toBase58());
    const r = await listPools(fakeRpc(accounts), opts(venueIndex(named, { calls })));
    expect(calls).toEqual(['?all=1']);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([solDeep, solShallow, usdc, bayla].map((p) => p.address.toBase58()));
    expect(r.list.pools.map((p) => p.quote.symbol)).toEqual(['SOL', 'SOL', 'USDC', 'BAYLA']);
    expect(r.list.pools.map((p) => p.origin)).toEqual(['other', 'standard', 'standard', 'standard']);
    expect(r.list).toMatchObject({ unread: 0, otherPairs: 0, truncated: false, chainNow: 1_000n });
  });

  it('two pools of one coin: the deeper side of THAT coin first, ties by address', async () => {
    const a = buildPool({ mint: key(), configIndex: 1, quote: USDC_QUOTE, quoteReserve: 7_000_000n, tokenReserve: 1n });
    const b = buildPool({ mint: key(), configIndex: 1, quote: USDC_QUOTE, quoteReserve: 9_000_000n, tokenReserve: 1n });
    const accounts: Record<string, FakeAccount> = { ...a.accounts, ...b.accounts, [CLOCK]: clockAccount(5n) };
    const r = await listPools(fakeRpc(accounts), opts(venueIndex([a.address.toBase58(), b.address.toBase58()])));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([b.address.toBase58(), a.address.toBase58()]);
  });

  it('an index that did not answer is unread, and the chain is not asked', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(venueIndex([], { status: 502 })));
    expect(r).toMatchObject({ kind: 'unread' });
    expect(calls).toEqual([]);
  });

  it('an index that did not echo the venue question (`all: true`) is unread', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(venueIndex([], { echo: '1' })));
    expect(r).toEqual({ kind: 'unread', detail: 'the pool index answered a different question' });
    expect(calls).toEqual([]);
  });

  it('an index for another pool program is unread', async () => {
    const r = await listPools(fakeRpc({}), opts(venueIndex([], { program: key().toBase58() })));
    expect(r).toMatchObject({ kind: 'unread' });
  });

  it('an empty index is an empty list, with its truncation flag, and the chain is not asked', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(venueIndex([], { truncated: true })));
    expect(r).toEqual({ kind: 'ok', list: { pools: [], unread: 0, otherPairs: 0, truncated: true, chainNow: null } });
    expect(calls).toEqual([]);
  });

  it('a pool pairing two tokens with no pairing coin is counted as another pair, not listed', async () => {
    const real = buildPool({ mint: key(), configIndex: 1, quoteReserve: 5_000n, tokenReserve: 5n });
    // Neither side a coin this site reads: built around a made-up "coin" at a random mint.
    const other = buildPool({ mint: key(), configIndex: 1, quote: { ...SOL_QUOTE, mint: key().toBase58(), native: false }, quoteReserve: 5_000n, tokenReserve: 5n });
    const accounts: Record<string, FakeAccount> = { ...real.accounts, ...other.accounts, [CLOCK]: clockAccount(7n) };
    const r = await listPools(fakeRpc(accounts), opts(venueIndex([other.address.toBase58(), real.address.toBase58()])));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([real.address.toBase58()]);
    expect(r.list).toMatchObject({ unread: 0, otherPairs: 1 });
  });

  it('an address the index named that holds no pool is dropped, not listed and not counted as unread', async () => {
    const real = buildPool({ mint: key(), configIndex: 1, quoteReserve: 5_000n, tokenReserve: 5n });
    const accounts: Record<string, FakeAccount> = { ...real.accounts, [CLOCK]: clockAccount(7n) };
    const r = await listPools(fakeRpc(accounts), opts(venueIndex([key().toBase58(), real.address.toBase58()])));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([real.address.toBase58()]);
    expect(r.list.unread).toBe(0);
  });

  it('pools whose vaults could not be read are counted as unread, never listed and never "no pools"', async () => {
    const real = buildPool({ mint: key(), configIndex: 1, quoteReserve: 5_000n, tokenReserve: 5n });
    const accounts: Record<string, FakeAccount> = { ...real.accounts, [CLOCK]: clockAccount(7n) };
    const base = fakeRpc(accounts);
    let n = 0;
    // The first round (the pools and the clock) answers; the second (vaults, config, record) fails.
    const rpc: SolanaRpc = (method, params) => (++n === 2 ? Promise.reject(new Error('getMultipleAccounts: HTTP 502')) : base(method, params));
    const r = await listPools(rpc, opts(venueIndex([real.address.toBase58()])));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools).toEqual([]);
    expect(r.list).toMatchObject({ unread: 1, otherPairs: 0, chainNow: 7n });
  });
});
