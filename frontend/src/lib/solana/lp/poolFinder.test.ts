// @vitest-environment node
//
// The pool finder never names one pool as "the" pool: it reads the launch pool, the
// standard addresses (each fee tier, for each coin the token can be paired with) and
// whatever the index returns, and checks every one on chain.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MAX_CANDIDATES, NEVER_REFUNDED_ACCOUNT_SIZES, findPools, knownPoolAddresses, readFeeTiers } from './poolFinder';
import { POOL_INDEX_MAX } from './poolIndex';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { deriveAmmConfig } from '../cpswap/program';
import {
  CLOCK, LAUNCH, PROGRAM, WSOL, buildPool, clockAccount, configBytes, fakeIndex, fakeRpc, key, keyStartingWith, observationBytes, tokenAccountBytes, type FakeAccount,
} from './testkit.fixture';
import { TOKEN_PROGRAM } from './tokenSafety';
import { isCreatedPool, rememberCreatedPool } from './poolFinder';
import { BAYLA_QUOTE, QUOTE_COINS, SOL_QUOTE, USDC_QUOTE } from './quotes';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

describe('findPools', () => {
  it('finds a pool at a random address through the index, next to a squatter on the standard address', async () => {
    const mint = key();
    const squat = buildPool({ mint, configIndex: 1, quoteReserve: 1_000n, tokenReserve: 1n, openTime: 9_999_999_999n });
    const real = buildPool({ mint, configIndex: 1, address: Keypair.generate().publicKey, quoteReserve: 5_000_000_000n, tokenReserve: 1_000_000_000n });
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
    expect(p.kind === 'pool' && [p.view.quoteReserve, p.view.tokenReserve, p.view.config?.index]).toEqual([5_000_000_000n, 1_000_000_000n, 1]);
  });

  it('labels the launch pool by its launch-program address', async () => {
    const mint = key();
    const lp = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const r = await findPools(fakeRpc({ ...lp.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    expect(r.kind === 'ok' && r.search.pools.map((p) => p.kind === 'pool' && p.view.origin)).toEqual(['launch-pool']);
  });

  it('still reads the known addresses when the index is down, and says the index is unread', async () => {
    const mint = key();
    const std = buildPool({ mint, configIndex: 0, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const r = await findPools(fakeRpc({ ...std.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({}, { status: 502 })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.search.index.kind).toBe('unread');
    expect(r.search.pools).toHaveLength(1);
  });

  it('drops what the index names that is not this token paired with a pairing coin, and counts other pairs', async () => {
    const mint = key();
    const other = buildPool({ mint: key(), configIndex: 1, address: key(), quoteReserve: 1n, tokenReserve: 1n });
    const stranger: FakeAccount = { owner: key().toBase58(), data: new Uint8Array(637) };
    const strangerAddr = key().toBase58();
    // A real pool of THIS token against a mint that is no pairing coin: token0/1 without one.
    const pairOnly = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 1n, tokenReserve: 1n });
    const pairAcc = pairOnly.accounts[pairOnly.address.toBase58()]!;
    const usdLike = key();
    pairAcc.data.set(usdLike.toBytes(), 168); // replace the WSOL/token pair's token0 with a mint that is no pairing coin
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
    const p = buildPool({ mint, configIndex: 1, quoteReserve: 10n, tokenReserve: 10n });
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
    const pools = Array.from({ length: 5 }, () => buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const calls: [string, unknown[]][] = [];
    const r = await findPools(fakeRpc(accounts, { calls }), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind === 'ok' && r.search.pools).toHaveLength(5);
    expect(calls.map((c) => c[0])).toEqual(['getMultipleAccounts', 'getMultipleAccounts']);
  });

  it('ranks by SOL depth, whatever order the index or the addresses come in', async () => {
    const mint = key();
    const depths = [3n, 1n, 5n, 2n, 4n, 6n, 0n];
    const pools = depths.map((d) => buildPool({ mint, configIndex: 1, address: key(), quoteReserve: d * 10n ** 9n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind === 'ok' && r.search.pools.map((p) => p.kind === 'pool' && p.view.quoteReserve / 10n ** 9n)).toEqual([6n, 5n, 4n, 3n, 2n, 1n, 0n]);
  });
});

describe('findPools: what a pool read must not hide', () => {
  // F7: a frozen vault means nobody can withdraw; the vault's state byte says so.
  it('a frozen vault is read as frozen, and a vault that is not a working token account is unread', async () => {
    const mint = key();
    const p = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n, frozenVault: true });
    const r = await findPools(fakeRpc({ ...p.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    const e = r.kind === 'ok' ? r.search.pools[0] : null;
    expect(e?.kind === 'pool' && e.view.vaultsFrozen).toBe(true);

    const q = buildPool({ mint, configIndex: 0, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    const vaultAddr = Object.keys(q.accounts).find((a) => q.accounts[a]!.data.length === 165 && q.accounts[a]!.data[108] === 1)!;
    q.accounts[vaultAddr] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(mint, key(), 5n, 0) }; // state 0: uninitialized
    const r2 = await findPools(fakeRpc({ ...q.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    expect(r2.kind === 'ok' && r2.search.pools.map((x) => x.kind)).toEqual(['unread']);
  });

  // F5: the launch pool's own price record is read with it (and only for the launch pool).
  it('reads the launch pool’s price record, checks it is that pool’s, and leaves other pools’ unread', async () => {
    const mint = key();
    const lp = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const other = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const accounts: Record<string, FakeAccount> = {
      ...lp.accounts, ...other.accounts, [CLOCK]: clockAccount(5n),
      [lp.observation.toBase58()]: { owner: PROGRAM.toBase58(), data: observationBytes({ pool: lp.address, initialized: false }) },
      [other.observation.toBase58()]: { owner: PROGRAM.toBase58(), data: observationBytes({ pool: other.address, initialized: false }) },
    };
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({})));
    const byOrigin = Object.fromEntries((r.kind === 'ok' ? r.search.pools : []).map((e) => (e.kind === 'pool' ? [e.view.origin, e.view.history.kind] : ['x', 'x'])));
    expect(byOrigin).toEqual({ 'launch-pool': 'ok', standard: 'not-read' });

    // A record that names another pool is not this pool's record.
    accounts[lp.observation.toBase58()] = { owner: PROGRAM.toBase58(), data: observationBytes({ pool: other.address }) };
    const r2 = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({})));
    const launch = r2.kind === 'ok' ? r2.search.pools.find((e) => e.kind === 'pool' && e.view.origin === 'launch-pool') : undefined;
    expect(launch?.kind === 'pool' && launch.view.history).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/another pool/) });
  });

  // S1-R01: everything the index may return is read; nothing it names is cut here.
  it('reads every address the index may return, plus the seven it works out', async () => {
    // The launch pool, and a standard address on each of two fee tiers for each of three coins.
    expect(MAX_CANDIDATES).toBe(1 + 2 * QUOTE_COINS.length + POOL_INDEX_MAX);
    const mint = key();
    const pools = Array.from({ length: POOL_INDEX_MAX }, (_, i) => buildPool({ mint, configIndex: 1, address: key(), quoteReserve: BigInt(i + 1) * 10n ** 6n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) }, { truncated: true })));
    expect(r.kind === 'ok' && r.search.pools).toHaveLength(POOL_INDEX_MAX);
    expect(r.kind === 'ok' && r.search.index).toMatchObject({ kind: 'ok', truncated: true });
  });

  // S1-R06: an index answering for another program is unread, never "no pools".
  it('an index that answered for another pool program is unread, not an empty list', async () => {
    const mint = key();
    const r = await findPools(fakeRpc({ [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({}, { program: key().toBase58() })));
    expect(r.kind === 'ok' && r.search.index.kind).toBe('unread');
  });
});

describe('knownPoolAddresses', () => {
  it('for each pairing coin, SOL first: the public tier (1) before the graduation tier (0), for the sorted pair', () => {
    const mint = key();
    const k = knownPoolAddresses(mint, PROGRAM, LAUNCH);
    expect(k.standard.map((s) => [s.quote, s.index])).toEqual(QUOTE_COINS.flatMap((q) => [[q.mint, 1], [q.mint, 0]]));
    for (const s of k.standard) {
      const quote = QUOTE_COINS.find((q) => q.mint === s.quote)!;
      expect(s.address, `${quote.symbol} tier ${s.index}`).toBe(buildPool({ mint, quote, configIndex: s.index, quoteReserve: 1n, tokenReserve: 1n }).address.toBase58());
    }
    expect(new Set(k.standard.map((s) => s.address)).size).toBe(6);
    expect(k.launchPool).toBe(poolStatePda(mint, LAUNCH).toBase58());
    expect(WSOL.toBase58()).not.toBe(mint.toBase58());
  });

  it('a pairing coin is looked up only against the coins that outrank it, and SOL against none', () => {
    const coins = (mint: string) => [...new Set(knownPoolAddresses(new PublicKey(mint), PROGRAM, LAUNCH).standard.map((s) => s.quote))];
    expect(coins(BAYLA_QUOTE.mint)).toEqual([SOL_QUOTE.mint, USDC_QUOTE.mint]);
    expect(coins(USDC_QUOTE.mint)).toEqual([SOL_QUOTE.mint]);
    expect(coins(SOL_QUOTE.mint)).toEqual([]);
  });
});

// Owner ruling 2026-10-03: a pool may pair a token with SOL, USDC or BAYLA.
describe('findPools: pools paired with USDC and BAYLA', () => {
  const USDC6 = 10n ** 6n;

  it('a pool at each coin’s standard address is found with no index at all, and read in that coin’s units', async () => {
    const mint = key();
    const sol = buildPool({ mint, configIndex: 1, quoteReserve: 2n * 10n ** 9n, tokenReserve: 1_000n });
    const usdc = buildPool({ mint, quote: USDC_QUOTE, configIndex: 1, quoteReserve: 500n * USDC6, tokenReserve: 2_000n });
    const bayla = buildPool({ mint, quote: BAYLA_QUOTE, configIndex: 1, quoteReserve: 70_000n * USDC6, tokenReserve: 3_000n });
    const r = await findPools(fakeRpc({ ...sol.accounts, ...usdc.accounts, ...bayla.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.search.pools.map((e) => e.kind === 'pool' && [e.view.address, e.view.quote.symbol, e.view.origin, e.view.quoteReserve, e.view.tokenReserve, e.view.tokenMint])).toEqual([
      [sol.address.toBase58(), 'SOL', 'standard', 2n * 10n ** 9n, 1_000n, mint.toBase58()],
      [usdc.address.toBase58(), 'USDC', 'standard', 500n * USDC6, 2_000n, mint.toBase58()],
      [bayla.address.toBase58(), 'BAYLA', 'standard', 70_000n * USDC6, 3_000n, mint.toBase58()],
    ]);
    expect(r.search.otherPairs).toBe(0);
    for (const e of [sol, usdc, bayla]) expect(r.search.knownState[e.address.toBase58()]).toBe('pool');
  });

  it('which side is the quote follows the pair, not the address order', async () => {
    // One token that sorts below USDC's mint and one that sorts above it, made on purpose.
    const seen = new Set<boolean>();
    for (const mint of [keyStartingWith(1), keyStartingWith(250)]) {
      const b = buildPool({ mint, quote: USDC_QUOTE, configIndex: 1, quoteReserve: 9n, tokenReserve: 4n });
      const r = await findPools(fakeRpc({ ...b.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
      const e = r.kind === 'ok' ? r.search.pools[0] : undefined;
      expect(e?.kind).toBe('pool');
      if (e?.kind !== 'pool') return;
      const usdcIs0 = e.view.snapshot.pool.token0Mint === USDC_QUOTE.mint;
      expect(e.view.quoteIsToken0).toBe(usdcIs0);
      expect([e.view.quoteReserve, e.view.tokenReserve]).toEqual([9n, 4n]);
      expect(usdcIs0 ? e.view.snapshot.reserve0 : e.view.snapshot.reserve1).toBe(9n);
      seen.add(usdcIs0);
    }
    expect(seen.size).toBe(2);
  });

  it('lists each coin’s pools together (SOL, USDC, BAYLA), deepest first within a coin, and never compares amounts of different coins', async () => {
    const mint = key();
    // A USDC pool holding more base units than any SOL pool must still come after SOL's.
    const specs: Array<[typeof SOL_QUOTE, bigint]> = [
      [BAYLA_QUOTE, 5n], [USDC_QUOTE, 10n ** 15n], [SOL_QUOTE, 3n], [USDC_QUOTE, 7n], [SOL_QUOTE, 8n], [BAYLA_QUOTE, 10n ** 16n],
    ];
    const pools = specs.map(([quote, depth]) => buildPool({ mint, quote, configIndex: 1, address: key(), quoteReserve: depth, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts));
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind === 'ok' && r.search.pools.map((e) => e.kind === 'pool' && [e.view.quote.symbol, e.view.quoteReserve])).toEqual([
      ['SOL', 8n], ['SOL', 3n], ['USDC', 10n ** 15n], ['USDC', 7n], ['BAYLA', 10n ** 16n], ['BAYLA', 5n],
    ]);
  });

  it('BAYLA’s own pools are BAYLA priced in SOL or USDC; a pool where BAYLA is the pairing coin is the other token’s', async () => {
    const bayla = new PublicKey(BAYLA_QUOTE.mint);
    const withSol = buildPool({ mint: bayla, configIndex: 1, quoteReserve: 4n * 10n ** 9n, tokenReserve: 100n });
    const withUsdc = buildPool({ mint: bayla, quote: USDC_QUOTE, configIndex: 1, quoteReserve: 900n * USDC6, tokenReserve: 200n });
    const other = key();
    const otherInBayla = buildPool({ mint: other, quote: BAYLA_QUOTE, configIndex: 1, address: key(), quoteReserve: 50n, tokenReserve: 60n });
    const accounts = { ...withSol.accounts, ...withUsdc.accounts, ...otherInBayla.accounts, [CLOCK]: clockAccount(5n) };
    // The index is not trusted to have filtered: it names the other token's pool too.
    const index = fakeIndex({ [`mint:${BAYLA_QUOTE.mint}`]: [otherInBayla.address.toBase58()], [`mint:${other.toBase58()}`]: [otherInBayla.address.toBase58()] });
    const mine = await findPools(fakeRpc(accounts), bayla, opts(index));
    expect(mine.kind === 'ok' && mine.search.pools.map((e) => e.kind === 'pool' && [e.view.address, e.view.quote.symbol, e.view.tokenMint])).toEqual([
      [withSol.address.toBase58(), 'SOL', BAYLA_QUOTE.mint],
      [withUsdc.address.toBase58(), 'USDC', BAYLA_QUOTE.mint],
    ]);
    expect(mine.kind === 'ok' && mine.search.otherPairs).toBe(0);
    const theirs = await findPools(fakeRpc(accounts), other, opts(index));
    expect(theirs.kind === 'ok' && theirs.search.pools.map((e) => e.kind === 'pool' && [e.view.address, e.view.quote.symbol, e.view.tokenMint, e.view.quoteReserve])).toEqual([
      [otherInBayla.address.toBase58(), 'BAYLA', other.toBase58(), 50n],
    ]);
  });

  it('a BAYLA-paired pool’s BAYLA vault sits under the newer token program, and a vault under the wrong one is unread', async () => {
    const mint = key();
    const b = buildPool({ mint, quote: BAYLA_QUOTE, configIndex: 1, quoteReserve: 11n, tokenReserve: 12n });
    const pool = b.accounts[b.address.toBase58()]!;
    const read = async (accounts: Record<string, FakeAccount>) => {
      const r = await findPools(fakeRpc({ ...accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
      return r.kind === 'ok' ? r.search.pools[0] : undefined;
    };
    const ok = await read(b.accounts);
    expect(ok?.kind === 'pool' && ok.view.quote).toBe(BAYLA_QUOTE);
    // The same pool, with its BAYLA vault account owned by the classic program instead.
    const baylaVault = Object.keys(b.accounts).find((k) => b.accounts[k]!.owner === BAYLA_QUOTE.program)!;
    const wrong = await read({ ...b.accounts, [b.address.toBase58()]: pool, [baylaVault]: { ...b.accounts[baylaVault]!, owner: TOKEN_PROGRAM } });
    expect(wrong?.kind).toBe('unread');
  });

  it('only a SOL pool can be the launch pool: the launch program opens no other kind', async () => {
    const mint = key();
    const launchAddress = poolStatePda(mint, LAUNCH);
    const usdcThere = buildPool({ mint, quote: USDC_QUOTE, configIndex: 0, address: launchAddress, quoteReserve: 5n, tokenReserve: 5n });
    const r = await findPools(fakeRpc({ ...usdcThere.accounts, [CLOCK]: clockAccount(5n) }), mint, opts(fakeIndex({})));
    const e = r.kind === 'ok' ? r.search.pools[0] : undefined;
    expect(e?.kind === 'pool' && [e.view.quote.symbol, e.view.origin, e.view.history.kind]).toEqual(['USDC', 'other', 'not-read']);
  });
});

describe('readFeeTiers', () => {
  it('reads tier 1 as absent when it has not been created, never as a copy of a proposal', async () => {
    const c0 = deriveAmmConfig(PROGRAM, 0).toBase58();
    const r = await readFeeTiers(fakeRpc({ [c0]: { owner: PROGRAM.toBase58(), data: configBytes(0, 2_500n, 120_000n) } }), PROGRAM);
    expect(r.kind === 'ok' && r.tiers.map((t) => [t.index, t.state, t.config?.tradeFeeRate])).toEqual([[0, 'live', 2_500n], [1, 'absent', undefined]]);
  });

  // S1-R04: opening a pool is never "free": the accounts it creates hold rent for good.
  it('reads what opening a pool locks up in account deposits, and says unread when it cannot', async () => {
    const r = await readFeeTiers(fakeRpc({}), PROGRAM);
    const expected = NEVER_REFUNDED_ACCOUNT_SIZES.reduce((sum, n) => sum + BigInt((128 + n) * 6960), 0n);
    expect(r.kind === 'ok' && r.openingDeposits).toBe(expected);
    expect(expected).toBeGreaterThan(35_000_000n); // about 0.04 SOL
    const bad = await readFeeTiers(fakeRpc({}, { fail: new Set(['getMinimumBalanceForRentExemption']) }), PROGRAM);
    expect(bad.kind === 'ok' && bad.openingDeposits).toBeNull();
  });

  it('a config account owned by someone else is not a fee tier', async () => {
    const c0 = deriveAmmConfig(PROGRAM, 0).toBase58();
    const r = await readFeeTiers(fakeRpc({ [c0]: { owner: key().toBase58(), data: configBytes(0) } }), PROGRAM);
    expect(r.kind === 'ok' && r.tiers[0]!.state).toBe('not-a-config');
  });
});

// SPEC_S2_CREATE N14: a pool this page opened at a one-off address is listed at once,
// whatever the index says. The memory is module-wide, so every pool here is fresh.
describe('findPools: pools this page opened', () => {
  it('a remembered pool is read and listed when the index omits it or is down; one holding another token’s pool is never listed for this one', async () => {
    const mint = key();
    const mine = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 8n });
    const otherMint = key();
    const elsewhere = buildPool({ mint: otherMint, configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 8n });
    const accounts: Record<string, FakeAccount> = { ...mine.accounts, ...elsewhere.accounts, [CLOCK]: clockAccount(5n) };
    const before = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({})));
    expect(before.kind === 'ok' && before.search.pools).toEqual([]);
    expect(isCreatedPool(mine.address.toBase58())).toBe(false);

    rememberCreatedPool(mine.address.toBase58());
    rememberCreatedPool(elsewhere.address.toBase58());
    expect(isCreatedPool(mine.address.toBase58())).toBe(true);
    for (const index of [fakeIndex({}), fakeIndex({}, { status: 502 })]) {
      const r = await findPools(fakeRpc(accounts), mint, opts(index));
      expect(r.kind === 'ok' && r.search.pools.map((p) => (p.kind === 'pool' ? p.view.address : p.kind))).toEqual([mine.address.toBase58()]);
    }
    // And the other token's search lists its own pool, not this one.
    const other = await findPools(fakeRpc(accounts), otherMint, opts(fakeIndex({})));
    expect(other.kind === 'ok' && other.search.pools.map((p) => (p.kind === 'pool' ? p.view.address : p.kind))).toEqual([elsewhere.address.toBase58()]);
  });
});

// B review parity-2: a remembered pool is read only for its own token, and after every
// address the index names, so it never takes an index answer's place under the cap and
// never shows as an unread pool on another token's list.
describe('findPools: remembered pools never crowd out or leak into another token', () => {
  it('96 index pools are all read and listed next to a remembered pool of this token; other tokens’ remembered pools are not read', async () => {
    const mint = key();
    const pools = Array.from({ length: POOL_INDEX_MAX }, (_, i) => buildPool({ mint, configIndex: 1, address: key(), quoteReserve: BigInt(i + 2) * 10n ** 6n, tokenReserve: 10n }));
    const mine = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n ** 6n, tokenReserve: 10n });
    const otherMint = key();
    const others = Array.from({ length: 3 }, () => buildPool({ mint: otherMint, configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n }));
    rememberCreatedPool(mine.address.toBase58(), mint.toBase58());
    for (const o of others) rememberCreatedPool(o.address.toBase58(), otherMint.toBase58());
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, ...pools.map((p) => p.accounts), mine.accounts, ...others.map((o) => o.accounts));
    const calls: [string, unknown[]][] = [];
    const r = await findPools(fakeRpc(accounts, { calls }), mint, opts(fakeIndex({ [`mint:${mint.toBase58()}`]: pools.map((p) => p.address.toBase58()) })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const listed = r.search.pools.map((p) => (p.kind === 'pool' ? p.view.address : p.kind));
    expect(listed).toHaveLength(POOL_INDEX_MAX + 1);
    expect(new Set(listed)).toEqual(new Set([...pools.map((p) => p.address.toBase58()), mine.address.toBase58()]));
    const asked = new Set(calls.filter(([m]) => m === 'getMultipleAccounts').flatMap(([, params]) => (params as [string[]])[0]));
    for (const o of others) expect(asked.has(o.address.toBase58()), 'another token’s remembered pool is not read').toBe(false);
  });

  it('a remembered pool of another token whose vaults cannot be read is never listed for this one', async () => {
    const mint = key();
    const otherMint = key();
    const broken = buildPool({ mint: otherMint, configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n });
    rememberCreatedPool(broken.address.toBase58(), otherMint.toBase58());
    // The pool and its config, but no vaults: its own token's search lists it as unread.
    const accounts: Record<string, FakeAccount> = {
      [CLOCK]: clockAccount(5n),
      [broken.address.toBase58()]: broken.accounts[broken.address.toBase58()]!,
      [broken.config.toBase58()]: broken.accounts[broken.config.toBase58()]!,
    };
    const own = await findPools(fakeRpc(accounts), otherMint, opts(fakeIndex({})));
    expect(own.kind === 'ok' && own.search.pools.map((p) => p.kind)).toEqual(['unread']);
    const r = await findPools(fakeRpc(accounts), mint, opts(fakeIndex({})));
    expect(r.kind === 'ok' && r.search.pools).toEqual([]);
  });
});

// A position knows its pool's address from the share's own chain record. The lookup that
// "Add more liquidity" starts reads that address whatever the index says: a pool at its own
// address was otherwise found by the index or not at all (review, 2026-10-04).
describe('findPools: pools the caller already holds (`also`)', () => {
  it('is read and listed when the index omits it, is down, or is full; without it the pool is not found', async () => {
    const mint = key();
    const mine = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n ** 6n, tokenReserve: 10n });
    const full = Array.from({ length: POOL_INDEX_MAX }, (_, i) => buildPool({ mint, configIndex: 1, address: key(), quoteReserve: BigInt(i + 2) * 10n ** 6n, tokenReserve: 10n }));
    const accounts = Object.assign({ [CLOCK]: clockAccount(5n) }, mine.accounts, ...full.map((f) => f.accounts));
    const listed = (r: Awaited<ReturnType<typeof findPools>>) => (r.kind === 'ok' ? r.search.pools.map((x) => (x.kind === 'pool' ? x.view.address : x.kind)) : r.kind);
    const indexes = [fakeIndex({}), fakeIndex({}, { status: 502 }), fakeIndex({ [`mint:${mint.toBase58()}`]: full.map((f) => f.address.toBase58()) })];
    for (const index of indexes) {
      expect(listed(await findPools(fakeRpc(accounts), mint, opts(index)))).not.toContain(mine.address.toBase58());
      expect(listed(await findPools(fakeRpc(accounts), mint, { ...opts(index), also: [mine.address.toBase58()] }))).toContain(mine.address.toBase58());
    }
    // Under a full index nothing the index named was dropped to make room.
    const r = await findPools(fakeRpc(accounts), mint, { ...opts(indexes[2]!), also: [mine.address.toBase58()] });
    expect(listed(r)).toHaveLength(POOL_INDEX_MAX + 1);
  });

  it('an address the index already names is read once, and one that holds another token’s pool is never listed for this one', async () => {
    const mint = key();
    const mine = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n });
    const elsewhere = buildPool({ mint: key(), configIndex: 1, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n });
    const accounts: Record<string, FakeAccount> = { ...mine.accounts, ...elsewhere.accounts, [CLOCK]: clockAccount(5n) };
    const calls: [string, unknown[]][] = [];
    const also = [mine.address.toBase58(), elsewhere.address.toBase58(), key().toBase58()];
    const r = await findPools(fakeRpc(accounts, { calls }), mint, { ...opts(fakeIndex({ [`mint:${mint.toBase58()}`]: [mine.address.toBase58()] })), also });
    expect(r.kind === 'ok' && r.search.pools.map((x) => (x.kind === 'pool' ? x.view.address : x.kind))).toEqual([mine.address.toBase58()]);
    const first = (calls.find(([m]) => m === 'getMultipleAccounts')![1] as [string[]])[0];
    expect(first.filter((a) => a === mine.address.toBase58())).toHaveLength(1);
  });
});
