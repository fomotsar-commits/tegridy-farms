// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MAX_POSITIONS, readPositions } from './positions';
import { TOKEN_PROGRAM } from './tokenSafety';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeIndex, fakeRpc, key, mintBytes, tokenAccountBytes, type FakeAccount } from './testkit.fixture';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

describe('readPositions', () => {
  it('finds the wallet’s pool share, places it through the index and values it', async () => {
    const wallet = key();
    const mint = key();
    const p = buildPool({ mint, address: key(), solReserve: 10n * 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000_000n });
    const lpAcc = key().toBase58();
    const otherToken = key();
    const accounts: Record<string, FakeAccount> = {
      ...p.accounts,
      [CLOCK]: clockAccount(5n),
      [lpAcc]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 250_000n) },
      // An ordinary token the wallet holds: not a pool share (its mint authority is someone else).
      [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(otherToken, wallet, 5n) },
      [otherToken.toBase58()]: { owner: TOKEN_PROGRAM, data: mintBytes(key()) },
      // An empty share account: not a position.
      [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(key(), wallet, 0n) },
    };
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.positions).toHaveLength(1);
    const pos = r.positions[0]!;
    expect(pos).toMatchObject({ lpMint: p.lpMint.toBase58(), lpAccount: lpAcc, lpAmount: 250_000n, placement: 'found' });
    expect(pos.pool?.kind).toBe('pool');
    expect(pos.value?.sharePct).toBeCloseTo(25, 6);
  });

  it('refuses an index answer that does not derive to the share, and keeps the share listed', async () => {
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n, tokenReserve: 10n });
    const decoy = buildPool({ mint: key(), address: key(), solReserve: 10n, tokenReserve: 10n });
    const accounts: Record<string, FakeAccount> = { ...p.accounts, ...decoy.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 7n) } };
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [decoy.address.toBase58()] })));
    expect(r.kind === 'ok' && r.positions.map((x) => [x.placement, x.pool, x.value])).toEqual([['not-found', null, null]]);
  });

  it('an index outage keeps the share, marked unplaced; a wallet read failure is unread', async () => {
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n, tokenReserve: 10n });
    const accounts = { ...p.accounts, [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 7n) } };
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { status: 502 })));
    expect(r.kind === 'ok' && r.positions.map((x) => [x.placement, x.placementDetail])).toEqual([['index-unread', 'the pool index answered HTTP 502']]);
    const bad = await readPositions(fakeRpc(accounts, { fail: new Set(['getTokenAccountsByOwner']) }), wallet, opts(fakeIndex({})));
    expect(bad.kind).toBe('unread');
  });

  // F3 / S1-R03: a stranger can send junk pool shares to any wallet. None of the wallet's
  // shares may silently drop off the list, and the ones placed are ordered by value.
  it('says how many shares there are beyond the ones placed, places more on request, and lists the most valuable first', async () => {
    const wallet = key();
    const accounts: Record<string, FakeAccount> = { [CLOCK]: clockAccount(5n) };
    const table: Record<string, string[]> = {};
    const n = MAX_POSITIONS + 5;
    for (let i = 0; i < n; i++) {
      const p = buildPool({ mint: key(), address: key(), solReserve: BigInt(i + 1) * 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000n });
      Object.assign(accounts, p.accounts);
      accounts[key().toBase58()] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 100n) };
      table[`lpMint:${p.lpMint.toBase58()}`] = [p.address.toBase58()];
    }
    const calls: string[] = [];
    const first = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex(table, { calls })));
    expect(first.kind === 'ok' && [first.positions.length, first.totalShares]).toEqual([MAX_POSITIONS, n]);
    expect(calls).toHaveLength(MAX_POSITIONS);
    const sol = (first.kind === 'ok' ? first.positions : []).map((p) => (p.value && p.pool?.kind === 'pool' ? (p.pool.view.solIsToken0 ? p.value.token0 : p.value.token1) : -1n));
    expect(sol).toEqual([...sol].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
    const all = await readPositions(fakeRpc(accounts), wallet, { ...opts(fakeIndex(table)), limit: MAX_POSITIONS * 2 });
    expect(all.kind === 'ok' && [all.positions.length, all.totalShares]).toEqual([n, n]);
  });
});
