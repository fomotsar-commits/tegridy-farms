// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readPositions } from './positions';
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
    expect(r.kind === 'ok' && r.positions.map((x) => x.placement)).toEqual(['index-unread']);
    const bad = await readPositions(fakeRpc(accounts, { fail: new Set(['getTokenAccountsByOwner']) }), wallet, opts(fakeIndex({})));
    expect(bad.kind).toBe('unread');
  });
});
