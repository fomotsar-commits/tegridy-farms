// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PublicKey } from '@solana/web3.js';
import { deriveAuthority } from '../cpswap/program';
import { LOOKUPS_AT_ONCE, MAX_POSITIONS, MISS_KEPT_MS, readPositions } from './positions';
import { rememberCreatedShare } from './positions';
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
    // "Look up more" spends lookups only on shares not placed yet (review 2026-09-30:
    // it used to re-place every share and ran into the index's per-IP limit).
    const more: string[] = [];
    const all = await readPositions(fakeRpc(accounts), wallet, { ...opts(fakeIndex(table, { calls: more })), limit: MAX_POSITIONS * 2 });
    expect(all.kind === 'ok' && [all.positions.length, all.totalShares]).toEqual([n, n]);
    expect(more).toHaveLength(n - MAX_POSITIONS);
    expect(all.kind === 'ok' && all.positions.every((p) => p.placement === 'found')).toBe(true);
  });

  it('two accounts holding the same share cost one lookup', async () => {
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000n });
    const accounts: Record<string, FakeAccount> = {
      ...p.accounts,
      [CLOCK]: clockAccount(5n),
      [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 100n) },
      [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 200n) },
    };
    const calls: string[] = [];
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] }, { calls })));
    expect(r.kind === 'ok' && r.positions.map((x) => x.placement)).toEqual(['found', 'found']);
    expect(calls).toHaveLength(1);
  });
});

// ATK-2 (audit 2026-10-03): a "share" is cheap to fake. Anyone can make a mint, hand its
// authority to the pool program's authority address and send one unit to a wallet. Fakes
// must not push a real share off the first page, and must not spend the index's
// lookups again on every read.
describe('readPositions: junk "shares" sent to the wallet', () => {
  const AUTHORITY = deriveAuthority(PROGRAM);

  /** `n` mints handed to the pool authority with no pool behind them, one unit of each in `wallet`. */
  function junkShares(wallet: PublicKey, n: number, keep: (mint: string) => boolean = () => true) {
    const accounts: Record<string, FakeAccount> = {};
    const mints: string[] = [];
    while (mints.length < n) {
      const m = key();
      if (!keep(m.toBase58())) continue;
      mints.push(m.toBase58());
      accounts[m.toBase58()] = { owner: TOKEN_PROGRAM, data: mintBytes(AUTHORITY, 9) };
      accounts[key().toBase58()] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(m, wallet, 1n) };
    }
    return { accounts, mints: mints.sort() };
  }

  /** An index that takes a moment to answer, and counts how many lookups are waiting at once. */
  function slowIndex(table: Record<string, string[]>, calls: string[]) {
    const answer = fakeIndex(table, { calls });
    const waiting = { now: 0, most: 0 };
    const fetchImpl = (async (url: string) => {
      waiting.most = Math.max(waiting.most, ++waiting.now);
      await new Promise((r) => setTimeout(r, 0));
      waiting.now--;
      return answer(url);
    }) as unknown as typeof fetch;
    return { fetchImpl, waiting };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a miss is not asked again within the minute: "read again" asks nothing, "more" asks only for the new ones', async () => {
    const wallet = key();
    const junk = junkShares(wallet, MAX_POSITIONS + 5);
    const accounts = { ...junk.accounts, [CLOCK]: clockAccount(5n) };
    const first: string[] = [];
    const a = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { calls: first })));
    expect(a.kind === 'ok' && [a.positions.length, a.totalShares, a.positions.every((p) => p.placement === 'not-found')]).toEqual([MAX_POSITIONS, MAX_POSITIONS + 5, true]);
    expect(first).toHaveLength(MAX_POSITIONS);

    const again: string[] = [];
    const b = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { calls: again })));
    expect(again).toEqual([]);
    // The rows are still there, still unplaced: nothing dropped off the list.
    expect(b.kind === 'ok' && b.positions.map((p) => [p.lpMint, p.placement])).toEqual(junk.mints.slice(0, MAX_POSITIONS).map((m) => [m, 'not-found']));

    const more: string[] = [];
    const c = await readPositions(fakeRpc(accounts), wallet, { ...opts(fakeIndex({}, { calls: more })), limit: MAX_POSITIONS * 2 });
    expect(more.sort()).toEqual(junk.mints.slice(MAX_POSITIONS).map((m) => `lpMint:${m}`));
    expect(c.kind === 'ok' && c.positions.length).toBe(MAX_POSITIONS + 5);
  });

  it('a miss is asked again after the minute, so a pool the index had not caught up with is placed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000n });
    const accounts: Record<string, FakeAccount> = { ...p.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 100n) } };
    const caughtUp = { [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] };
    const placement = async (table: Record<string, string[]>, calls: string[]) => {
      const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex(table, { calls })));
      return r.kind === 'ok' ? r.positions.map((x) => x.placement) : r.kind;
    };
    expect(await placement({}, [])).toEqual(['not-found']);
    vi.setSystemTime(Date.now() + MISS_KEPT_MS - 1);
    const early: string[] = [];
    expect(await placement(caughtUp, early)).toEqual(['not-found']);
    expect(early).toEqual([]);
    vi.setSystemTime(Date.now() + 1);
    const late: string[] = [];
    expect(await placement(caughtUp, late)).toEqual(['found']);
    expect(late).toHaveLength(1);
  });

  it('an index that could not be read is not a miss: it is asked again at once', async () => {
    const wallet = key();
    const junk = junkShares(wallet, 3);
    const accounts = { ...junk.accounts, [CLOCK]: clockAccount(5n) };
    const down = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { status: 429 })));
    expect(down.kind === 'ok' && down.positions.map((p) => p.placement)).toEqual(['index-unread', 'index-unread', 'index-unread']);
    const asked: string[] = [];
    await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { calls: asked })));
    expect(asked).toHaveLength(3);
  });

  it('lookups go a few at a time, and shares never asked go before misses that have aged out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wallet = key();
    const junk = junkShares(wallet, MAX_POSITIONS * 2);
    const accounts = { ...junk.accounts, [CLOCK]: clockAccount(5n) };
    const first: string[] = [];
    const one = slowIndex({}, first);
    await readPositions(fakeRpc(accounts), wallet, opts(one.fetchImpl));
    const page1 = junk.mints.slice(0, MAX_POSITIONS).map((m) => `lpMint:${m}`);
    const page2 = junk.mints.slice(MAX_POSITIONS).map((m) => `lpMint:${m}`);
    // In share order, and never more than LOOKUPS_AT_ONCE waiting: a rate limit then
    // lands on the last ones asked, not on whichever arrive last.
    expect(first).toEqual(page1);
    expect(one.waiting.most).toBe(LOOKUPS_AT_ONCE);
    expect(LOOKUPS_AT_ONCE).toBeLessThan(MAX_POSITIONS);

    vi.setSystemTime(Date.now() + MISS_KEPT_MS);
    const second: string[] = [];
    const two = slowIndex({}, second);
    await readPositions(fakeRpc(accounts), wallet, { ...opts(two.fetchImpl), limit: MAX_POSITIONS * 2 });
    expect(second).toEqual([...page2, ...page1]);
    expect(two.waiting.most).toBe(LOOKUPS_AT_ONCE);
  });

  it('a proven share is listed before junk whose mints sort ahead of it, and costs no lookup', async () => {
    const wallet = key();
    const pool = () => buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000n });
    let p = pool();
    // A share mint that does not sort near the very front, so junk ahead of it is quick to make.
    while (p.lpMint.toBase58() < '9') p = pool();
    const lpMint = p.lpMint.toBase58();
    // More than a page of junk, every mint sorting before the real share's.
    const junk = junkShares(wallet, MAX_POSITIONS + 3, (m) => m < lpMint);
    const accounts: Record<string, FakeAccount> = { ...p.accounts, ...junk.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 100n) } };
    const table = { [`lpMint:${lpMint}`]: [p.address.toBase58()] };

    // Not proven yet: it is past the first page, and is still counted.
    const before = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex(table)));
    expect(before.kind === 'ok' && [before.positions.some((x) => x.lpMint === lpMint), before.totalShares]).toEqual([false, MAX_POSITIONS + 4]);
    // "Look up more" reaches it, and the index proves it.
    const reached = await readPositions(fakeRpc(accounts), wallet, { ...opts(fakeIndex(table)), limit: MAX_POSITIONS * 2 });
    expect(reached.kind === 'ok' && reached.positions.find((x) => x.lpMint === lpMint)?.placement).toBe('found');

    // From then on it is on the first page, first, whatever junk sorts ahead of it.
    const asked: string[] = [];
    const after = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex(table, { calls: asked })));
    expect(after.kind === 'ok' && after.positions.length).toBe(MAX_POSITIONS);
    const mine = after.kind === 'ok' ? after.positions[0] : undefined;
    expect(mine).toMatchObject({ lpMint, placement: 'found' });
    expect(mine?.value?.sharePct).toBeCloseTo(10, 6);
    expect(asked).not.toContain(`lpMint:${lpMint}`);
  });
});

// 6006: burning a share that pays 0 on one side is refused by the pool program, so the
// list never shows it as a payout with a zero side.
describe('readPositions: a share too small to take out', () => {
  it('a dust share is tooSmall, never a payout with a zero side', async () => {
    const wallet = key();
    // 10 lamports against 10^9 tokens over 10^6 shares: 7 shares are worth 0 SOL.
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n, tokenReserve: 10n ** 9n, lpSupply: 1_000_000n });
    const accounts: Record<string, FakeAccount> = { ...p.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 7n) } };
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] })));
    const pos = r.kind === 'ok' ? r.positions[0] : undefined;
    expect(pos?.pool?.kind).toBe('pool');
    expect(pos?.tooSmall).toBe(true);
    expect(pos?.value).toBeNull();
  });

  it('a share that pays on both sides is not tooSmall', async () => {
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000_000n });
    const accounts: Record<string, FakeAccount> = { ...p.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 7n) } };
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] })));
    const pos = r.kind === 'ok' ? r.positions[0] : undefined;
    expect(pos?.tooSmall).toBe(false);
    expect(pos?.value).toMatchObject({ token0: 7_000n, token1: 7_000n });
  });
});

// SPEC_S2_CREATE N14: the share of a pool this page just opened is placed without the
// index (which may not have the new pool yet, or be down). The cache is module state,
// so every key here is fresh.
describe('readPositions: the share of a pool this page opened', () => {
  it('after rememberCreatedShare, an index that answers unread is never asked, and the share is placed "chain" and valued', async () => {
    const wallet = key();
    const p = buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000_000n });
    const accounts: Record<string, FakeAccount> = { ...p.accounts, [CLOCK]: clockAccount(5n), [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 999_900n) } };
    const asked: string[] = [];
    const before = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { status: 502, calls: asked })));
    expect(before.kind === 'ok' && before.positions.map((x) => x.placement)).toEqual(['index-unread']);
    expect(asked).toHaveLength(1);

    rememberCreatedShare(PROGRAM, p.address);
    const after: string[] = [];
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({}, { status: 502, calls: after })));
    expect(r.kind === 'ok' && r.positions.map((x) => [x.placement, x.pool?.kind, x.value?.sharePct])).toEqual([['chain', 'pool', 99.99]]);
    expect(after).toEqual([]);
  });
});
