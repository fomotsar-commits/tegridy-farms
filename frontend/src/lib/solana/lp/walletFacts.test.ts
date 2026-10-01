// @vitest-environment node
//
// The panels' wallet read: one account call, and an unread wallet is never a 0.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';
import { readWalletFacts } from './walletFacts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from './tokenSafety';
import { fakeRpc, key, tokenAccountBytes, type FakeAccount } from './testkit.fixture';

const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM) => associatedTokenAddress(mint, owner, new PublicKey(program)).toBase58();
const rentFor = (n: number) => BigInt((128 + n) * 6960);

function wallet() {
  const owner = key();
  const mint = key();
  const lpMint = key();
  const accounts: Record<string, FakeAccount> = { [owner.toBase58()]: { owner: '11111111111111111111111111111111', data: new Uint8Array(0), lamports: 3_000_000_000 } };
  return { owner, mint, lpMint, accounts };
}

describe('readWalletFacts', () => {
  it('reads the wallet, its token, wrapped-SOL and pool-share accounts in one call, plus the two rents', async () => {
    const w = wallet();
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.mint, w.owner, 1_234n) };
    w.accounts[ata(new PublicKey(WSOL_MINT), w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(new PublicKey(WSOL_MINT), w.owner, 50n) };
    w.accounts[ata(w.lpMint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.lpMint, w.owner, 0n) };
    const calls: [string, unknown[]][] = [];
    const f = await readWalletFacts(fakeRpc(w.accounts, { calls }), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: w.lpMint.toBase58() });
    expect(f).toEqual({
      kind: 'ok',
      lamports: 3_000_000_000n,
      token: { address: ata(w.mint, w.owner), amount: 1_234n },
      wsol: { exists: true, amount: 50n },
      lpAccountExists: true,
      rents: expect.objectContaining({ tokenAccount165: rentFor(165) }),
    });
    expect(calls.filter(([m]) => m === 'getMultipleAccounts')).toHaveLength(1);
  });

  it('missing accounts are said as missing, and the token account is looked for under the pool’s token program', async () => {
    const w = wallet();
    // A classic account exists, but the pool's token is Token-2022: that is not its account.
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.mint, w.owner, 9n) };
    const f = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM, lpMint: null });
    expect(f).toMatchObject({ kind: 'ok', token: null, wsol: { exists: false, amount: 0n }, lpAccountExists: false });
  });

  it('a failed read, or an account that is not a token account, is unread, never a 0', async () => {
    const w = wallet();
    const failed = await readWalletFacts(fakeRpc(w.accounts, { fail: new Set(['getMultipleAccounts']) }), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null });
    expect(failed).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/502/) });
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(key(), w.owner, 9n) };
    const wrong = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null });
    expect(wrong).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/different token/) });
  });

  it('asks the rents once per session', async () => {
    const w = wallet();
    const calls: [string, unknown[]][] = [];
    const rpc = fakeRpc(w.accounts, { calls });
    const a = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null };
    await readWalletFacts(rpc, a);
    await readWalletFacts(rpc, a);
    expect(calls.filter(([m]) => m === 'getMinimumBalanceForRentExemption').length).toBeLessThanOrEqual(2);
    expect(calls.filter(([m]) => m === 'getMultipleAccounts')).toHaveLength(2);
  });

  // SPEC_S2_CREATE 2.3 (K4): an opening also needs the deposits the new pool's own
  // accounts keep for good, from the same per-size rent reads.
  it('with `opening`, adds what the pool, its price record, share token and two vaults keep forever; without it, nothing changes', async () => {
    const w = wallet();
    const a = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null };
    const opened = await readWalletFacts(fakeRpc(w.accounts), { ...a, opening: true });
    expect(opened.kind).toBe('ok');
    if (opened.kind !== 'ok') return;
    expect(opened.rents.neverRefunded).toBe(rentFor(637) + rentFor(4075) + rentFor(82) + rentFor(165) + rentFor(165));
    const plain = await readWalletFacts(fakeRpc(w.accounts), a);
    expect(plain.kind === 'ok' && Object.keys(plain.rents).sort()).toEqual(['tokenAccount165', 'walletFloor']);
  });
});
