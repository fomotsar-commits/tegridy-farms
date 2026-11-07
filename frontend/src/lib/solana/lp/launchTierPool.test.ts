// @vitest-environment node
//
// Fee tier 0 is the launch tier: a graduation opens its pool there, at the launch pool.
// The pool program at 88b98aa9 (rolled back 2026-10-24) also lets anyone open a pool on it
// directly, for free, skipping the public tier's 1% and its 0.15 SOL opening fee. Owner,
// 2026-10-24: the site does not allow that option. Such a pool is never listed, never
// quoted for a swap and never added to; the launch pool on the same tier stays as it was.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { quoteVenuePools, readVenuePools } from '../swap/venuePools';
import { LAUNCH_TIER_POOL, findPools, knownPoolAddresses, type PoolView } from './poolFinder';
import { assessPool } from './poolHealth';
import { listPools } from './poolList';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeIndex, fakeRpc, key, mintBytes, viewOf, type FakeAccount } from './testkit.fixture';
import { TOKEN_PROGRAM, WSOL_MINT as WSOL } from './tokenSafety';

const OPTS = { programId: PROGRAM, launchProgramId: LAUNCH };
const SOL = 10n ** 9n;
const NOW = 2_000_000_000n;

describe('which pools are on the launch tier without a launch', () => {
  it('a tier-0 pool at the standard address or at an address of its own is one; the launch pool and a tier-1 pool are not', async () => {
    const mint = key();
    const standard = buildPool({ mint, configIndex: 0, quoteReserve: SOL, tokenReserve: SOL });
    const own = buildPool({ mint, configIndex: 0, address: key(), quoteReserve: SOL, tokenReserve: SOL });
    const launch = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: SOL, tokenReserve: SOL });
    const tier1 = buildPool({ mint, configIndex: 1, quoteReserve: SOL, tokenReserve: SOL });
    const accounts = { ...standard.accounts, ...own.accounts, ...launch.accounts, ...tier1.accounts, [CLOCK]: clockAccount(NOW) };
    const r = await findPools(fakeRpc(accounts), mint, {
      ...OPTS,
      fetchImpl: fakeIndex({ [`mint:${mint.toBase58()}`]: [standard.address, own.address, tier1.address].map((p) => p.toBase58()) }),
    });
    if (r.kind !== 'ok') throw new Error(r.kind);
    const listed = r.search.pools.map((p) => (p.kind === 'pool' ? [p.view.address, p.view.launchTierWithoutLaunch] : p.kind));
    expect(listed).toEqual(
      expect.arrayContaining([
        [launch.address.toBase58(), false],
        [tier1.address.toBase58(), false],
      ]),
    );
    expect(listed).toHaveLength(2);
    expect([...r.search.launchTierPools].sort()).toEqual([standard.address.toBase58(), own.address.toBase58()].sort());
  });

  it('a pool the caller already holds (a share’s own pool) is left out the same way', async () => {
    const mint = key();
    const stray = buildPool({ mint, configIndex: 0, address: key(), quoteReserve: 9n * SOL, tokenReserve: SOL });
    const r = await findPools(fakeRpc({ ...stray.accounts, [CLOCK]: clockAccount(NOW) }), mint, { ...OPTS, fetchImpl: fakeIndex({}), also: [stray.address.toBase58()] });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.search.pools).toEqual([]);
    expect(r.search.launchTierPools).toEqual([stray.address.toBase58()]);
  });

  it('the finder works out no standard address on the launch tier: only a launch-less pool could sit there', () => {
    const known = knownPoolAddresses(key(), PROGRAM, LAUNCH);
    expect(known.standard.map((s) => s.index)).not.toContain(0);
    expect(known.standard.length).toBeGreaterThan(0);
  });

  it('the list of every pool leaves it out', async () => {
    const stray = buildPool({ mint: key(), configIndex: 0, address: key(), quoteReserve: 9n * SOL, tokenReserve: SOL });
    const fair = buildPool({ mint: key(), configIndex: 1, address: key(), quoteReserve: SOL, tokenReserve: SOL });
    const pools = [stray, fair].map((b) => b.address.toBase58());
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ all: true, program: PROGRAM.toBase58(), pools, truncated: false }), { status: 200 })) as unknown as typeof fetch;
    const r = await listPools(fakeRpc({ ...stray.accounts, ...fair.accounts, [CLOCK]: clockAccount(NOW) }), { ...OPTS, fetchImpl });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.list.pools.map((v) => v.address)).toEqual([fair.address.toBase58()]);
    expect(r.list.unread).toBe(0);
  });
});

describe('a swap is never routed into one', () => {
  const tokenMint = (mint: PublicKey): Record<string, FakeAccount> => ({ [mint.toBase58()]: { owner: TOKEN_PROGRAM, data: mintBytes(null, 6) } });

  it('a deeper free pool beside a tier-1 pool gives no candidate; the tier-1 pool is quoted', async () => {
    const mint = key();
    const stray = buildPool({ mint, configIndex: 0, quoteReserve: 100n * SOL, tokenReserve: 100_000n * SOL });
    const fair = buildPool({ mint, configIndex: 1, quoteReserve: SOL, tokenReserve: 1_000n * SOL });
    const accounts = { ...stray.accounts, ...fair.accounts, ...tokenMint(mint), [CLOCK]: clockAccount(NOW) };
    const r = await readVenuePools(fakeRpc(accounts), WSOL, mint.toBase58(), { ...OPTS, fetchImpl: fakeIndex({ [`mint:${mint.toBase58()}`]: [stray.address.toBase58()] }) });
    const q = quoteVenuePools(r, WSOL, SOL);
    expect(q.state).toBe('quoted');
    expect(q.candidates.map((c) => c.poolAddress)).toEqual([fair.address.toBase58()]);
  });

  it('a pair whose only pool of ours is a free one has no pool of ours: the swap goes elsewhere', async () => {
    const mint = key();
    const stray = buildPool({ mint, configIndex: 0, address: key(), quoteReserve: 100n * SOL, tokenReserve: 100_000n * SOL });
    const accounts = { ...stray.accounts, ...tokenMint(mint), [CLOCK]: clockAccount(NOW) };
    const r = await readVenuePools(fakeRpc(accounts), WSOL, mint.toBase58(), { ...OPTS, fetchImpl: fakeIndex({ [`mint:${mint.toBase58()}`]: [stray.address.toBase58()] }) });
    expect(quoteVenuePools(r, WSOL, SOL)).toEqual({ state: 'absent', candidates: [] });
  });
});

describe('a deposit is never offered into one', () => {
  const assess = (view: PoolView) =>
    assessPool({ view, tokenDecimals: 9, chainNow: NOW, outside: { kind: 'ok', solPerToken: 1, source: 'Jupiter' }, safety: null });

  it('its deposit check refuses, saying why; the launch pool on the same tier is not refused for its tier', () => {
    const mint = key();
    const stray = viewOf(buildPool({ mint, configIndex: 0, address: key(), quoteReserve: SOL, tokenReserve: SOL }), { sol: SOL, tok: SOL, origin: 'other' });
    const launch = viewOf(buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: SOL, tokenReserve: SOL }), { sol: SOL, tok: SOL, origin: 'launch-pool' });
    const refused = assess({ ...stray, launchTierWithoutLaunch: true }).deposits;
    expect(refused.verdict).toBe('refused');
    expect(refused.reasons).toContain(LAUNCH_TIER_POOL);
    expect(assess({ ...launch, launchTierWithoutLaunch: false }).deposits.reasons).not.toContain(LAUNCH_TIER_POOL);
  });
});
