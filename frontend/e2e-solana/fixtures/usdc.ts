// USDC on the local validator: a coin a pool may pair a token with (owner ruling
// 2026-10-03: SOL, USDC or BAYLA). The mint is seeded at its real address by
// genesis-accounts.mjs (mainnet's bytes; only the mint authority differs: Circle's on
// mainnet, a test key here). Addresses are written out and amounts decoded by hand, so a
// bug in the code under test cannot agree with itself here.
import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
// @ts-expect-error -- a plain .mjs module shared with the validator scripts; it has no types
import { usdcMintAuthority } from '../../scripts/solana-localnet/genesis-accounts.mjs';
import { assertLocalCluster, chain, sendFromNode } from './chain';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DECIMALS = 6;

/** Whole USDC to base units (6 decimals). */
export const usdc = (whole: number | bigint) => BigInt(whole) * 1_000_000n;

/** An owner's USDC account: the associated account under the classic token program. */
export function usdcAccount(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, owner, true, TOKEN_PROGRAM_ID);
}

/** Raw USDC in a classic token account, decoded by hand; null when the account does not exist. */
export async function usdcAmount(account: PublicKey): Promise<bigint | null> {
  const a = await chain().getAccountInfo(account, 'confirmed');
  if (!a) return null;
  const d = a.data;
  if (!a.owner.equals(TOKEN_PROGRAM_ID) || d.length < 165 || !new PublicKey(d.subarray(0, 32)).equals(USDC_MINT)) {
    throw new Error(`${account.toBase58()} is not a USDC account`);
  }
  return d.readBigUInt64LE(64);
}

/**
 * Give `wallet` `amount` raw USDC, minted by the stand-in's test authority into the
 * wallet's own USDC account (opened if it is not there). The wallet pays the fees.
 */
export async function giveUsdc(wallet: Keypair, amount: bigint): Promise<PublicKey> {
  await assertLocalCluster();
  const authority = usdcMintAuthority() as Keypair;
  const account = usdcAccount(wallet.publicKey);
  await sendFromNode([
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, account, wallet.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    createMintToCheckedInstruction(USDC_MINT, account, authority.publicKey, amount, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
  ], [wallet, authority]);
  return account;
}
