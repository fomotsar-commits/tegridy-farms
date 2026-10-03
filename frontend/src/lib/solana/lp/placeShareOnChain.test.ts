// @vitest-environment node
//
// Leaving does not depend on our index (spec D12, addendum D12): a share the index
// cannot place is found from its own chain history, proven the same way an index
// answer is, and kept for the session so a re-read with the index still down keeps
// offering the way out.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { POOL_STATE_OFFSETS } from '../cpswap/program';
import { CHAIN_HISTORY_LIMIT, placeShareOnChain, readPositions } from './positions';
import { TOKEN_PROGRAM } from './tokenSafety';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeIndex, fakeRpc, key, tokenAccountBytes, type FakeAccount } from './testkit.fixture';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

const opts = { programId: PROGRAM, launchProgramId: LAUNCH };

/** A chain with transaction history: `history[address]` = transactions newest first, each its account keys. */
function chainWith(accounts: Record<string, FakeAccount>, history: Record<string, Array<{ keys: string[]; loaded?: string[] } | 'junk'>>, calls: string[] = []): SolanaRpc {
  const base = fakeRpc(accounts);
  const txs = new Map<string, { keys: string[]; loaded?: string[] } | 'junk'>();
  return async (method, params) => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') {
      const [address, o] = params as [string, { limit: number }];
      return (history[address] ?? []).slice(0, o.limit).map((t, i) => {
        const signature = `${address.slice(0, 20)}${i}`.padEnd(88, '1');
        txs.set(signature, t);
        return { signature, slot: 1, err: null };
      });
    }
    if (method === 'getTransaction') {
      const t = txs.get((params as [string])[0]);
      if (!t) return null;
      if (t === 'junk') return { transaction: { message: { accountKeys: 'not a list' } } };
      return { transaction: { message: { accountKeys: t.keys } }, meta: { loadedAddresses: { writable: t.loaded ?? [], readonly: [] } } };
    }
    return base(method, params);
  };
}

function share(o: { lpMintRecord?: string } = {}) {
  const wallet = key();
  const p = buildPool({ mint: key(), address: key(), solReserve: 10n ** 9n, tokenReserve: 10n ** 9n, lpSupply: 1_000n });
  if (o.lpMintRecord) p.accounts[p.address.toBase58()]!.data.set(new PublicKey(o.lpMintRecord).toBytes(), POOL_STATE_OFFSETS.lpMint);
  const lpAccount = key().toBase58();
  const accounts: Record<string, FakeAccount> = { ...p.accounts, [CLOCK]: clockAccount(5n), [lpAccount]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 100n) } };
  return { wallet, p, lpAccount, accounts, lpMint: p.lpMint.toBase58() };
}

const noise = () => Array.from({ length: 6 }, () => key().toBase58());

describe('placeShareOnChain', () => {
  it('places a share by the derivation plus the pool’s own record, from the share account’s history', async () => {
    const s = share();
    const rpc = chainWith(s.accounts, { [s.lpAccount]: [{ keys: noise() }, { keys: [...noise(), s.p.address.toBase58()] }] });
    const r = await placeShareOnChain(rpc, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount });
    expect(r.kind).toBe('placed');
    expect(r.kind === 'placed' && r.entry.view.address).toBe(s.p.address.toBase58());
  });

  it('falls back to the share mint’s history, and reads keys loaded from lookup tables', async () => {
    const s = share();
    const rpc = chainWith(s.accounts, { [s.lpMint]: [{ keys: noise(), loaded: [s.p.address.toBase58()] }] });
    const r = await placeShareOnChain(rpc, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount });
    expect(r.kind === 'placed' && r.entry.view.address).toBe(s.p.address.toBase58());
  });

  it('a junk transaction naming random keys, and another real pool, never misplace a share', async () => {
    const s = share();
    const other = buildPool({ mint: key(), address: key(), solReserve: 10n, tokenReserve: 10n });
    const rpc = chainWith({ ...s.accounts, ...other.accounts }, { [s.lpAccount]: [{ keys: [...noise(), other.address.toBase58()] }, { keys: noise() }] });
    expect(await placeShareOnChain(rpc, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).toEqual({ kind: 'not-found' });
  });

  it('a key that derives the share mint but whose pool names another share mint is refused', async () => {
    const s = share({ lpMintRecord: key().toBase58() });
    const rpc = chainWith(s.accounts, { [s.lpAccount]: [{ keys: [s.p.address.toBase58()] }] });
    expect(await placeShareOnChain(rpc, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).toEqual({ kind: 'not-found' });
  });

  it('reads at most 20 transactions per address, 42 history calls in all', async () => {
    const s = share();
    const many = () => Array.from({ length: 30 }, () => ({ keys: noise() }));
    const calls: string[] = [];
    const rpc = chainWith(s.accounts, { [s.lpAccount]: many(), [s.lpMint]: many() }, calls);
    expect(await placeShareOnChain(rpc, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).toEqual({ kind: 'not-found' });
    expect(calls.filter((c) => c === 'getSignaturesForAddress')).toHaveLength(2);
    expect(calls.filter((c) => c === 'getTransaction')).toHaveLength(2 * CHAIN_HISTORY_LIMIT);
    expect(calls).toHaveLength(42);
  });

  it('a malformed answer is unread, never "not found"', async () => {
    const s = share();
    expect((await placeShareOnChain(chainWith(s.accounts, { [s.lpAccount]: ['junk'] }), opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('unread');
    const broken: SolanaRpc = async () => ({ not: 'a list' });
    expect((await placeShareOnChain(broken, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('unread');
  });

  // readPools reads the pool, then its vaults. When only that second read fails it
  // still answers 'ok', with this pool's entry 'unread'. That is "try again", not
  // "this share's pool is not on the chain".
  it('the pool is found but its vaults cannot be read: unread, never "not found"; once the network answers it is placed', async () => {
    const s = share();
    const history = { [s.lpAccount]: [{ keys: [s.p.address.toBase58()] }] };
    const base = chainWith(s.accounts, history);
    let reads = 0;
    const secondReadFails: SolanaRpc = async (method, params) => {
      if (method === 'getMultipleAccounts' && ++reads === 2) throw new Error('HTTP 429');
      return base(method, params);
    };
    const r = await placeShareOnChain(secondReadFails, opts, { lpMint: s.lpMint, lpAccount: s.lpAccount });
    expect(reads).toBe(2);
    expect(r).toEqual({ kind: 'unread', detail: expect.stringMatching(/HTTP 429/) });
    // The same share, read again once the network answers: placed.
    expect((await placeShareOnChain(chainWith(s.accounts, history), opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('placed');
  });
});

describe('a share placed on chain stays placed for the session', () => {
  it('after placeShareOnChain, a re-read with the index down shows it placed by "chain", asking the index nothing for it', async () => {
    const s = share();
    const history = { [s.lpAccount]: [{ keys: [s.p.address.toBase58()] }] };
    // The index is down from the start.
    const before = await readPositions(chainWith(s.accounts, history), s.wallet, { ...opts, fetchImpl: fakeIndex({}, { status: 502 }) });
    expect(before.kind === 'ok' && before.positions.map((x) => x.placement)).toEqual(['index-unread']);
    expect((await placeShareOnChain(chainWith(s.accounts, history), opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('placed');
    const asked: string[] = [];
    const after = await readPositions(chainWith(s.accounts, history), s.wallet, { ...opts, fetchImpl: fakeIndex({}, { status: 502, calls: asked }) });
    expect(after.kind === 'ok' && after.positions.map((x) => [x.placement, x.pool?.kind])).toEqual([['chain', 'pool']]);
    expect(asked).toEqual([]);
  });

  it('a share not found, or not read, is not kept: the index is asked again', async () => {
    const s = share();
    expect((await placeShareOnChain(chainWith(s.accounts, {}), opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('not-found');
    expect((await placeShareOnChain(chainWith(s.accounts, { [s.lpAccount]: ['junk'] }), opts, { lpMint: s.lpMint, lpAccount: s.lpAccount })).kind).toBe('unread');
    const asked: string[] = [];
    const r = await readPositions(chainWith(s.accounts, {}), s.wallet, { ...opts, fetchImpl: fakeIndex({}, { status: 502, calls: asked }) });
    expect(r.kind === 'ok' && r.positions.map((x) => x.placement)).toEqual(['index-unread']);
    expect(asked).toHaveLength(1);
  });

  it('a share placed by the index still says "found"', async () => {
    const s = share();
    const r = await readPositions(chainWith(s.accounts, {}), s.wallet, { ...opts, fetchImpl: fakeIndex({ [`lpMint:${s.lpMint}`]: [s.p.address.toBase58()] }) });
    expect(r.kind === 'ok' && r.positions.map((x) => x.placement)).toEqual(['found']);
  });
});
