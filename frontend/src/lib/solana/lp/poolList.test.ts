// @vitest-environment node
//
// The list of every pool, shown before a token is picked: the index names addresses, the
// browser reads and checks each one, and an index that did not answer is never "no pools".
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { listPools } from './poolList';
import { readPoolIndex } from './poolIndex';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeRpc, key, type FakeAccount } from './testkit.fixture';
import { BAYLA_QUOTE, USDC_QUOTE } from './quotes';

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
    expect(r).toEqual({ kind: 'ok', list: { pools: [], unread: 0, truncated: false } });
    expect(calls).toHaveLength(0);
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
