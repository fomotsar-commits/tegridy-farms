// @vitest-environment node
//
// The venue's pool list trusts the index for addresses only: every pool is read on chain,
// and an index that did not answer is "unread", never "no pools".
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { listPools } from './poolList';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeIndex, fakeRpc, key, type FakeAccount } from './testkit.fixture';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

describe('listPools', () => {
  it('asks the index for every pool, reads each on chain, and lists them deepest SOL side first', async () => {
    const shallow = buildPool({ mint: key(), configIndex: 1, solReserve: 1_000n, tokenReserve: 1n });
    const deep = buildPool({ mint: key(), configIndex: 1, address: Keypair.generate().publicKey, solReserve: 5_000_000_000n, tokenReserve: 1_000_000_000n });
    const accounts: Record<string, FakeAccount> = { ...shallow.accounts, ...deep.accounts, [CLOCK]: clockAccount(1_000n) };
    const calls: string[] = [];
    const index = fakeIndex({ 'all:1': [shallow.address.toBase58(), deep.address.toBase58()] }, { calls });
    const r = await listPools(fakeRpc(accounts), opts(index));
    expect(calls).toEqual(['all:1']);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([deep.address.toBase58(), shallow.address.toBase58()]);
    expect(r.list.pools.map((p) => p.origin)).toEqual(['other', 'standard']);
    expect(r.list).toMatchObject({ unread: 0, otherPairs: 0, truncated: false, chainNow: 1_000n });
  });

  it('an index that did not answer is unread, and the chain is not asked', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(fakeIndex({}, { status: 502 })));
    expect(r).toMatchObject({ kind: 'unread' });
    expect(calls).toEqual([]);
  });

  it('an index for another pool program is unread', async () => {
    const r = await listPools(fakeRpc({}), opts(fakeIndex({ 'all:1': [] }, { program: key().toBase58() })));
    expect(r).toMatchObject({ kind: 'unread' });
  });

  it('an empty index is an empty list, with its truncation flag, and the chain is not asked', async () => {
    const calls: [string, unknown[]][] = [];
    const r = await listPools(fakeRpc({}, { calls }), opts(fakeIndex({ 'all:1': [] }, { truncated: true })));
    expect(r).toEqual({ kind: 'ok', list: { pools: [], unread: 0, otherPairs: 0, truncated: true, chainNow: null } });
    expect(calls).toEqual([]);
  });

  it('an address the index named that holds no pool is dropped, not listed and not counted as unread', async () => {
    const real = buildPool({ mint: key(), configIndex: 1, solReserve: 5_000n, tokenReserve: 5n });
    const accounts: Record<string, FakeAccount> = { ...real.accounts, [CLOCK]: clockAccount(7n) };
    const r = await listPools(fakeRpc(accounts), opts(fakeIndex({ 'all:1': [key().toBase58(), real.address.toBase58()] })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.list.pools.map((p) => p.address)).toEqual([real.address.toBase58()]);
    expect(r.list.unread).toBe(0);
  });
});
