import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { buildPool, key, viewOf } from './testkit.fixture';
import { LARGEST_ACCOUNTS, readPoolHolders } from './holders';
import { TOKEN_PROGRAM } from './tokenSafety';

// A pool of 10 SOL and 1,000 tokens with 1,000,000 shares out.
const built = buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 10n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n, lpSupply: 1_000_000n });
const view = viewOf(built, { sol: 10n * 10n ** 9n, tok: 1_000n * 10n ** 6n });
const LP = view.snapshot.pool.lpMint;

/** A classic SPL token account: mint(32) owner(32) amount(u64 LE). */
function tokenAccount(mint: string, owner: string, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new PublicKey(mint).toBytes(), 0);
  d.set(new PublicKey(owner).toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

interface Acc { mint?: string; owner: string; amount: bigint; program?: string }

/** An RPC that names `largest` and answers each account from `accounts` (missing = closed). */
function chain(largest: { address: string; amount: bigint }[], accounts: Record<string, Acc>): SolanaRpc {
  return async (method, params) => {
    if (method === 'getTokenLargestAccounts') {
      expect(params[0]).toBe(LP);
      return { value: largest.map((l) => ({ address: l.address, amount: l.amount.toString(), decimals: 9, uiAmount: null })) };
    }
    if (method === 'getMultipleAccounts') {
      return {
        value: (params[0] as string[]).map((a) => {
          const acc = accounts[a];
          if (!acc) return null;
          const data = Buffer.from(tokenAccount(acc.mint ?? LP, acc.owner, acc.amount)).toString('base64');
          return { data: [data, 'base64'], owner: acc.program ?? TOKEN_PROGRAM, lamports: 2_039_280, executable: false };
        }),
      };
    }
    throw new Error(`unexpected ${method}`);
  };
}

const A = key().toBase58();
const B = key().toBase58();
const accs = (n: number) => Array.from({ length: n }, () => key().toBase58());

describe('readPoolHolders: every holder of one pool, read from the chain', () => {
  it('lists each wallet once, largest first, with what its share pays out now', async () => {
    const [a1, a2, b1] = accs(3);
    const read = await readPoolHolders(
      chain(
        [{ address: b1!, amount: 300_000n }, { address: a1!, amount: 200_000n }, { address: a2!, amount: 150_000n }],
        { [a1!]: { owner: A, amount: 200_000n }, [a2!]: { owner: A, amount: 150_000n }, [b1!]: { owner: B, amount: 300_000n } },
      ),
      view,
    );
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    // A's two accounts are one row of 350,000; it is larger than B's 300,000.
    expect(read.holders.map((h) => [h.owner, h.amount])).toEqual([[A, 350_000n], [B, 300_000n]]);
    expect(read.holders[0]!.value!.sharePct).toBeCloseTo(35, 6);
    // 35% of 10 SOL and of 1,000 tokens, whichever side each coin is on.
    const sides = [read.holders[0]!.value!.token0, read.holders[0]!.value!.token1].sort();
    expect(sides).toEqual([350n * 10n ** 6n, 35n * 10n ** 8n].sort());
    expect(read.capped).toBe(false);
  });

  it('keeps only classic token accounts of THIS share mint, with a balance', async () => {
    const [good, otherMint, otherProgram, closed, empty] = accs(5);
    const read = await readPoolHolders(
      chain(
        [good, otherMint, otherProgram, closed, empty].map((address) => ({ address: address!, amount: 10_000n })),
        {
          [good!]: { owner: A, amount: 10_000n },
          [otherMint!]: { owner: B, amount: 10_000n, mint: key().toBase58() },
          [otherProgram!]: { owner: B, amount: 10_000n, program: key().toBase58() },
          [empty!]: { owner: B, amount: 0n },
        },
      ),
      view,
    );
    expect(read.kind === 'ok' && read.holders.map((h) => h.owner)).toEqual([A]);
  });

  it('says a share too small to take out is too small, never a payout with a zero side', async () => {
    // 10^15 shares out: one share is worth 10^-5 of a lamport, so it pays 0 SOL.
    const deep = viewOf(
      buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 10n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n, lpSupply: 10n ** 15n }),
      { sol: 10n * 10n ** 9n, tok: 1_000n * 10n ** 6n },
    );
    const lp = deep.snapshot.pool.lpMint;
    const [a1] = accs(1);
    const rpc: SolanaRpc = async (method, params) =>
      method === 'getTokenLargestAccounts'
        ? { value: [{ address: a1, amount: '1', decimals: 9, uiAmount: null }] }
        : { value: (params[0] as string[]).map(() => ({ data: [Buffer.from(tokenAccount(lp, A, 1n)).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 1, executable: false })) };
    const read = await readPoolHolders(rpc, deep);
    expect(read.kind === 'ok' && read.holders[0]).toMatchObject({ owner: A, tooSmall: true, value: null });
  });

  it('says when the chain named as many accounts as it ever names: smaller holders may be past them', async () => {
    const list = accs(LARGEST_ACCOUNTS);
    const read = await readPoolHolders(
      chain(list.map((address) => ({ address, amount: 1_000n })), Object.fromEntries(list.map((a) => [a, { owner: key().toBase58(), amount: 1_000n }]))),
      view,
    );
    expect(read.kind === 'ok' && [read.holders.length, read.capped]).toEqual([LARGEST_ACCOUNTS, true]);
  });

  it('a pool nobody holds a share of reads as no holders, and is not capped', async () => {
    const read = await readPoolHolders(chain([], {}), view);
    expect(read).toEqual({ kind: 'ok', holders: [], capped: false });
  });

  it('a read that fails is unread, never "no holders"', async () => {
    const failing: SolanaRpc = async () => { throw new Error('429 Too Many Requests'); };
    expect(await readPoolHolders(failing, view)).toEqual({ kind: 'unread', detail: '429 Too Many Requests' });
    const odd: SolanaRpc = async () => ({ nothing: true });
    expect((await readPoolHolders(odd, view)).kind).toBe('unread');
  });
});
