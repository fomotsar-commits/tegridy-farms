// @vitest-environment node
//
// `LpReaders.wallet` in the browser: its arguments reach `readWalletFacts` whole. A
// pairing coin dropped on the way would read a USDC pool as a SOL pool.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress } from '../../../lib/launcher/solana/curve/ix';
import { BAYLA_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { fakeRpc, key, mintBytes, tokenAccountBytes, type FakeAccount } from '../../../lib/solana/lp/testkit.fixture';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../../lib/solana/lp/tokenSafety';
import { readWalletFacts } from '../../../lib/solana/lp/walletFacts';
import { walletArgs } from './readers';

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
