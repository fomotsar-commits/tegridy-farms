// @vitest-environment node
//
// `LpReaders.wallet` in the browser: its arguments reach `readWalletFacts` whole. A
// pairing coin dropped on the way would read a USDC pool as a SOL pool.
//
// And the browser readers' transport: every read goes through a fetch that ends
// (readFetch.ts), named for what it reads, and the chain's answers feed the budget
// (rpcBudget.ts). A plain `fetch` handed to any of them could wait for good.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress } from '../../../lib/launcher/solana/curve/ix';
import { BROWSER_RPC_TIMEOUT_MS, browserRpc, type SolanaRpc } from '../../../lib/launcher/solana/curve/rpc';
import { findPools } from '../../../lib/solana/lp/poolFinder';
import { readOutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { readPositions } from '../../../lib/solana/lp/positions';
import { BAYLA_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { READ_TIMEOUT_MS } from '../../../lib/solana/lp/readFetch';
import { remaining } from '../../../lib/solana/lp/rpcBudget';
import { fakeRpc, key, mintBytes, tokenAccountBytes, type FakeAccount } from '../../../lib/solana/lp/testkit.fixture';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../../lib/solana/lp/tokenSafety';
import { readWalletFacts } from '../../../lib/solana/lp/walletFacts';
import { browserLpReaders, walletArgs } from './readers';

// The reads themselves are stubbed: only what the browser readers HAND them is under test.
vi.mock('../../../lib/solana/lp/poolFinder', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/solana/lp/poolFinder')>();
  return { ...mod, findPools: vi.fn(async () => ({ kind: 'unread', detail: 'stub', index: { kind: 'unread', detail: 'stub' } })) };
});
vi.mock('../../../lib/solana/lp/outsidePrice', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/solana/lp/outsidePrice')>();
  return { ...mod, readOutsidePrice: vi.fn(async () => ({ kind: 'unread', detail: 'stub' })) };
});
vi.mock('../../../lib/solana/lp/positions', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/solana/lp/positions')>();
  return { ...mod, readPositions: vi.fn(async () => ({ kind: 'unread', detail: 'stub' })) };
});
vi.mock('../../../lib/launcher/solana/curve/rpc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/launcher/solana/curve/rpc')>();
  return { ...mod, browserRpc: vi.fn(mod.browserRpc) };
});

/** A fetch that only settles when its signal aborts, as a real fetch does. */
const hangs = vi.fn(
  (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return;
      if (s.aborted) reject(s.reason);
      else s.addEventListener('abort', () => reject(s.reason), { once: true });
    }),
);

/** What `f` does against a proxy that never answers, once 20 s have passed. */
async function after20s(f: typeof fetch | undefined): Promise<string> {
  if (typeof f !== 'function') return `no fetch was passed (${String(f)})`;
  const outcome = Promise.race([
    f('/x').then(
      () => 'answered',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    ),
    new Promise<string>((r) => setTimeout(() => r('still waiting after 20 seconds'), READ_TIMEOUT_MS + 1)),
  ]);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
  return outcome;
}

describe('browserLpReaders: every read goes through a fetch that ends, named for what it reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangs);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('findPools and positions get the pool index’s fetch: "the pool index did not answer in 20 seconds"', async () => {
    const readers = browserLpReaders();
    expect(readers, 'LIVE_PROGRAM_ID is set in this build').not.toBeNull();
    await readers!.findPools(key());
    const findOpts = vi.mocked(findPools).mock.calls[0]?.[2];
    expect(await after20s(findOpts?.fetchImpl)).toBe('the pool index did not answer in 20 seconds');
    await readers!.positions(key(), 3);
    const posOpts = vi.mocked(readPositions).mock.calls[0]?.[2];
    expect(posOpts?.limit).toBe(3);
    expect(await after20s(posOpts?.fetchImpl)).toBe('the pool index did not answer in 20 seconds');
  });

  it('outsidePrice gets Jupiter’s fetch: "Jupiter did not answer in 20 seconds"', async () => {
    const readers = browserLpReaders()!;
    await readers.outsidePrice(key().toBase58(), 6);
    const jupiterFetch = vi.mocked(readOutsidePrice).mock.calls[0]?.[3];
    expect(await after20s(jupiterFetch)).toBe('Jupiter did not answer in 20 seconds');
  });

  it('the chain’s transport gets the chain’s fetch, and its answers feed the budget', async () => {
    browserLpReaders();
    const chainFetch = vi.mocked(browserRpc).mock.calls[0]?.[0];
    expect(await after20s(chainFetch)).toBe('the chain did not answer in 20 seconds');
    // An answer that arrives carries the proxy's header into rpcBudget.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":null}', { headers: { 'X-RateLimit-Remaining': '7', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60) } })));
    expect(remaining()).toBeNull();
    await chainFetch!('/api/solrpc', { method: 'POST' });
    expect(remaining()).toBe(7);
  });

  // The transport has a 10 s clock of its own for a fetch that has none (curve/rpc.ts).
  // On this read it must not run: the read would end at 10 s under the 20 s sentence's name.
  it('the chain’s transport does not time the read a second time: a held read ends at 20 s, not at 10 s', async () => {
    browserLpReaders();
    const rpc = vi.mocked(browserRpc).mock.results.at(-1)?.value as SolanaRpc;
    let settled: string | null = null;
    void rpc('getMultipleAccounts', [[]]).then(
      () => {
        settled = 'answered';
      },
      (e: unknown) => {
        settled = e instanceof Error ? e.message : String(e);
      },
    );
    await vi.advanceTimersByTimeAsync(BROWSER_RPC_TIMEOUT_MS + 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - BROWSER_RPC_TIMEOUT_MS - 2);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('the chain did not answer in 20 seconds');
  });
});

describe('walletArgs: what the browser’s wallet reader hands to the read', () => {
  const owner = key();
  const mint = key().toBase58();
  const lpMint = key().toBase58();

  it('a SOL pool: the four facts and nothing else, or `opening` alone', () => {
    expect(walletArgs(owner, mint, TOKEN_PROGRAM, lpMint)).toEqual({ owner: owner.toBase58(), tokenMint: mint, tokenProgram: TOKEN_PROGRAM, lpMint });
    expect(Object.keys(walletArgs(owner, mint, TOKEN_PROGRAM, lpMint)).sort()).toEqual(['lpMint', 'owner', 'tokenMint', 'tokenProgram']);
    expect(walletArgs(owner, mint, TOKEN_2022_PROGRAM, null, { opening: true })).toEqual({ owner: owner.toBase58(), tokenMint: mint, tokenProgram: TOKEN_2022_PROGRAM, lpMint: null, opening: true });
  });

  it('the pairing coin is passed on, alone and with `opening`', () => {
    expect(walletArgs(owner, mint, TOKEN_PROGRAM, lpMint, { quote: USDC_QUOTE })).toEqual({ owner: owner.toBase58(), tokenMint: mint, tokenProgram: TOKEN_PROGRAM, lpMint, quote: USDC_QUOTE });
    expect(walletArgs(owner, mint, TOKEN_PROGRAM, null, { opening: true, quote: BAYLA_QUOTE })).toEqual({
      owner: owner.toBase58(),
      tokenMint: mint,
      tokenProgram: TOKEN_PROGRAM,
      lpMint: null,
      opening: true,
      quote: BAYLA_QUOTE,
    });
  });

  it('so a USDC pool’s wallet read answers with the wallet’s USDC, not its wrapped SOL', async () => {
    const usdc = new PublicKey(USDC_QUOTE.mint);
    const accounts: Record<string, FakeAccount> = {
      [owner.toBase58()]: { owner: '11111111111111111111111111111111', data: new Uint8Array(0), lamports: 1_000_000_000 },
      [USDC_QUOTE.mint]: { owner: TOKEN_PROGRAM, data: mintBytes(key(), 6) },
      [associatedTokenAddress(usdc, owner).toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(usdc, owner, 250_000_000n) },
    };
    const f = await readWalletFacts(fakeRpc(accounts), walletArgs(owner, mint, TOKEN_PROGRAM, null, { quote: USDC_QUOTE }));
    expect(f).toMatchObject({ kind: 'ok', coin: { exists: true, amount: 250_000_000n }, wsol: { exists: false, amount: 0n } });
  });
});
