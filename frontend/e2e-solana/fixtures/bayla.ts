// $BAYLA on the local validator, for the plant: every launch made on the site pays 100,000
// $BAYLA in its create transaction, 50,000 burned and 50,000 to the island's Workshop.
// The mint is seeded at its real address by genesis-accounts.mjs (mainnet's bytes; only the
// mint authority differs: null on mainnet, a test key here). Addresses are written out, not
// imported from write/plant.ts, and amounts are decoded by hand, so a bug in the code under
// test cannot agree with itself here.
import { PublicKey, type Keypair, type TransactionResponse, type VersionedTransactionResponse } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
// @ts-expect-error -- a plain .mjs module shared with the validator scripts; it has no types
import { baylaMintAuthority } from '../../scripts/solana-localnet/genesis-accounts.mjs';
import { assertLocalCluster, chain, sendFromNode } from './chain';

export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const BAYLA_MINT = new PublicKey('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
export const BAYLA_DECIMALS = 6;
/** The island's Workshop wallet, and its $BAYLA account (the Token-2022 associated account). */
export const WORKSHOP_WALLET = new PublicKey('G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu');
export const WORKSHOP_BAYLA_ACCOUNT = new PublicKey('9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT');

/** Whole $BAYLA to base units (6 decimals). */
export const bayla = (whole: number | bigint) => BigInt(whole) * 1_000_000n;
/** Half the plant: burned, and again to the Workshop. */
export const PLANT_HALF = bayla(50_000);
export const PLANT_TOTAL = bayla(100_000);

/** An owner's $BAYLA account: the associated account under TOKEN-2022 (the legacy derivation names nothing). */
export function baylaAccount(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(BAYLA_MINT, owner, false, TOKEN_2022_PROGRAM_ID);
}

if (!TOKEN_2022_PROGRAM_ID.equals(TOKEN_2022) || !baylaAccount(WORKSHOP_WALLET).equals(WORKSHOP_BAYLA_ACCOUNT)) {
  throw new Error('the Workshop $BAYLA account is not ATA($BAYLA, Workshop, Token-2022): the e2e will not guess it');
}

/** Raw $BAYLA in a Token-2022 account, decoded by hand; null when the account does not exist. */
export async function baylaAmount(account: PublicKey): Promise<bigint | null> {
  const a = await chain().getAccountInfo(account, 'confirmed');
  if (!a) return null;
  const d = a.data;
  if (!a.owner.equals(TOKEN_2022) || d.length < 165 || !new PublicKey(d.subarray(0, 32)).equals(BAYLA_MINT)) {
    throw new Error(`${account.toBase58()} is not a $BAYLA account`);
  }
  return d.readBigUInt64LE(64);
}

/** The $BAYLA mint's supply, decoded by hand (u64 at byte 36). */
export async function baylaSupply(): Promise<bigint> {
  const a = await chain().getAccountInfo(BAYLA_MINT, 'confirmed');
  if (!a || !a.owner.equals(TOKEN_2022) || a.data.length < 82) throw new Error('the $BAYLA mint is not on the validator: run genesis-accounts.mjs and restart it');
  return a.data.readBigUInt64LE(36);
}

/**
 * Give `maker` `amount` raw $BAYLA, minted by the stand-in's test authority into the
 * maker's own $BAYLA account. The same transaction opens the Workshop's $BAYLA account
 * if it is not there yet (idempotent; its owner need not sign). The maker pays the fees.
 */
export async function giveBayla(maker: Keypair, amount: bigint): Promise<PublicKey> {
  await assertLocalCluster();
  const authority = baylaMintAuthority() as Keypair;
  const account = baylaAccount(maker.publicKey);
  await sendFromNode([
    createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, WORKSHOP_BAYLA_ACCOUNT, WORKSHOP_WALLET, BAYLA_MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, account, maker.publicKey, BAYLA_MINT, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(BAYLA_MINT, account, authority.publicKey, amount, BAYLA_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  ], [maker, authority]);
  return account;
}

type AnyTx = TransactionResponse | VersionedTransactionResponse;
export interface BaylaMoves {
  /** post - pre of each $BAYLA account the transaction touched, by address. */
  byAccount: Map<string, bigint>;
  /** Sum of post - pre over every $BAYLA balance: what left the supply in this transaction. */
  net: bigint;
}

/** The $BAYLA a landed transaction moved, from its own token-balance meta. */
export function baylaMoves(t: AnyTx, keys: PublicKey[]): BaylaMoves {
  const pre = t.meta?.preTokenBalances ?? [];
  const post = t.meta?.postTokenBalances ?? [];
  const byAccount = new Map<string, bigint>();
  const add = (list: typeof pre, sign: bigint) => {
    for (const b of list) {
      if (b.mint !== BAYLA_MINT.toBase58()) continue;
      if (b.programId !== undefined && b.programId !== TOKEN_2022.toBase58()) throw new Error(`a $BAYLA balance under ${b.programId}`);
      const k = keys[b.accountIndex].toBase58();
      byAccount.set(k, (byAccount.get(k) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  };
  add(pre, -1n);
  add(post, 1n);
  let net = 0n;
  for (const v of byAccount.values()) net += v;
  return { byAccount, net };
}
