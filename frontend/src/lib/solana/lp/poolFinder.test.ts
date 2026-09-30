// @vitest-environment node
//
// The pool finder never names one pool as "the" pool: it reads the launch pool, both
// standard addresses and whatever the index returns, and checks every one on chain.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { findPools, knownPoolAddresses, readFeeTiers } from './poolFinder';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { deriveAmmConfig } from '../cpswap/program';
import {
  CLOCK, LAUNCH, PROGRAM, WSOL, buildPool, clockAccount, configBytes, fakeIndex, fakeRpc, key, type FakeAccount,
} from './testkit.fixture';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

describe('findPools', () => {
  it('finds a pool at a random address through the index, next to a squatter on the standard address', async () => {
    const mint = key();
    const squat = buildPool({ mint, configIndex: 1, solReserve: 1_000n, tokenReserve: 1n, openTime: 9_999_999_999n });
    const real = buildPool({ mint, configIndex: 1, address: Keypair.generate().publicKey, solReserve: 5_000_000_000n, tokenReserve: 1_000_000_000n });
    const accounts: Record<string, FakeAccount> = { ...squat.accounts, ...real.accounts, [CLOCK]: clockAccount(1_000n) };
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: [real.address.toBase58(), squat.address.toBase58()] })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const s = r.search;
    // Deepest SOL side first; the standard address is NOT first just for being standard.
    expect(s.pools.map((p) => (p.kind === 'pool' ? [p.view.address, p.view.origin] : p.kind))).toEqual([
      [real.address.toBase58(), 'other'],
      [squat.address.toBase58(), 'standard'],
    ]);
    expect(s.chainNow).toBe(1_000n);
    expect(s.knownState[squat.address.toBase58()]).toBe('pool');
    expect(s.knownState[s.known.launchPool]).toBe('absent');
    const p = s.pools[0]!;
    expect(p.kind === 'pool' && [p.view.solReserve, p.view.tokenReserve, p.view.config?.index]).toEqual([5_000_000_000n, 1_000_000_000n, 1]);
  });

  it('labels the launch pool by its launch-program address', async () => {
    const mint = key();
    const lp = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), solReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const r = await findPools(fakeRpc({ ...lp.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    expect(r.kind === 'ok' && r.search.pools.map((p) => p.kind === 'pool' && p.view.origin)).toEqual(['launch-pool']);
  });

  it('still reads the known addresses when the index is down, and says the index is unread', async () => {
    const mint = key();
    const std = buildPool({ mint, configIndex: 0, solReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const r = await findPools(fakeRpc({ ...std.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({}, { status: 502 })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.search.index.kind).toBe('unread');
    expect(r.search.pools).toHaveLength(1);
  });

  it('drops what the index names that is not a TOKEN/SOL pool for this token, and counts other pairs', async () => {
    const mint = key();
    const other = buildPool({ mint: key(), configIndex: 1, address: key(), solReserve: 1n, tokenReserve: 1n });
    const stranger: FakeAccount = { owner: key().toBase58(), data: new Uint8Array(637) };
    const strangerAddr = key().toBase58();
    // A real pool of THIS token against USDC-like mint: token0/1 without WSOL.
    const pairOnly = buildPool({ mint, configIndex: 1, address: key(), solReserve: 1n, tokenReserve: 1n });
    const pairAcc = pairOnly.accounts[pairOnly.address.toBase58()]!;
    const usdLike = key();
    pairAcc.data.set(usdLike.toBytes(), 168); // replace the WSOL/token pair's token0 with a non-SOL mint
    pairAcc.data.set(mint.toBytes(), 200);
    const r = await findPools(
      fakeRpc({ ...other.accounts, ...pairOnly.accounts, [strangerAddr]: stranger, [CLOCK]: clockAccount(5n) }),
      mint,
      opts(fakeIndex({ [`mint:${mint.toBase58()}`]: [other.address.toBase58(), strangerAddr, pairOnly.address.toBase58()] })),
    );
    expect(r.kind === 'ok' && r.search.pools).toEqual([]);
    expect(r.kind === 'ok' && r.search.otherPairs).toBe(1);
  });

  it('a pool whose vault is missing or owned by the wrong program is unread, not an empty pool', async () => {
    const mint = key();
    const p = buildPool({ mint, configIndex: 1, solReserve: 10n, tokenReserve: 10n });
    const pool = p.accounts[p.address.toBase58()]!;
    const vaultAddr = Object.keys(p.accounts).find((a) => a !== p.address.toBase58() && p.accounts[a]!.data.length === 165)!;
    p.accounts[vaultAddr] = { ...p.accounts[vaultAddr]!, owner: key().toBase58() };
    const r = await findPools(fakeRpc({ ...p.accounts, [p.address.toBase58()]: pool, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    expect(r.kind === 'ok' && r.search.pools.map((x) => x.kind)).toEqual(['unread']);
  });

  it('an RPC failure is unread for the whole search, never "no pools"', async () => {
    const mint = key();
    const r = await findPools(fakeRpc({}, { fail: new Set(['getMultipleAccounts']) }), mint, opts(fakeIndex({})));
    expect(r.kind).toBe('unread');
  });

  it('reads everything in two account calls, however many pools', async () => {
    const mint = key();
    const pools = Array.from({ length: 5 }, () => buildPool({ mint, configIndex: 1, address: key(), solReserve: 10n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const calls: [string, unknown[]][] = [];
    const r = await findPools(fakeRpc(accounts, { calls }), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind === 'ok' && r.search.pools).toHaveLength(5);
    expect(calls.map((c) => c[0])).toEqual(['getMultipleAccounts', 'getMultipleAccounts']);
  });

  it('ranks by SOL depth, whatever order the index or the addresses come in', async () => {
    const mint = key();
    const depths = [3n, 1n, 5n, 2n, 4n, 6n, 0n];
    const pools = depths.map((d) => buildPool({ mint, configIndex: 1, address: key(), solReserve: d * 10n ** 9n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind === 'ok' && r.search.pools.map((p) => p.kind === 'pool' && p.view.solReserve / 10n ** 9n)).toEqual([6n, 5n, 4n, 3n, 2n, 1n, 0n]);
  });
});

describe('knownPoolAddresses', () => {
  it('checks the public tier (1) before the graduation tier (0), both for the sorted pair', () => {
    const mint = key();
    const k = knownPoolAddresses(mint, PROGRAM, LAUNCH);
    expect(k.standard.map((s) => s.index)).toEqual([1, 0]);
    expect(k.standard[0]!.address).toBe(buildPool({ mint, configIndex: 1, solReserve: 1n, tokenReserve: 1n }).address.toBase58());
    expect(k.standard[1]!.address).toBe(buildPool({ mint, configIndex: 0, solReserve: 1n, tokenReserve: 1n }).address.toBase58());
    expect(k.launchPool).toBe(poolStatePda(mint, LAUNCH).toBase58());
    expect(WSOL.toBase58()).not.toBe(mint.toBase58());
  });
});

describe('readFeeTiers', () => {
  it('reads tier 1 as absent when it has not been created, never as a copy of a proposal', async () => {
    const c0 = deriveAmmConfig(PROGRAM, 0).toBase58();
    const r = await readFeeTiers(fakeRpc({ [c0]: { owner: PROGRAM.toBase58(), data: configBytes(0, 2_500n, 120_000n) } }), PROGRAM);
    expect(r.kind === 'ok' && r.tiers.map((t) => [t.index, t.state, t.config?.tradeFeeRate])).toEqual([[0, 'live', 2_500n], [1, 'absent', undefined]]);
  });

  it('a config account owned by someone else is not a fee tier', async () => {
    const c0 = deriveAmmConfig(PROGRAM, 0).toBase58();
    const r = await readFeeTiers(fakeRpc({ [c0]: { owner: key().toBase58(), data: configBytes(0) } }), PROGRAM);
    expect(r.kind === 'ok' && r.tiers[0]!.state).toBe('not-a-config');
  });
});
