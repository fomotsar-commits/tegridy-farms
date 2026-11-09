import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/**
 * Plain SOL for fees, tips and new accounts, kept up from the keeper's wrapped SOL.
 *
 * A trip's gain lands WRAPPED, while its network fee, its Jito tip and any new account's rent are
 * paid in PLAIN SOL, so a keeper that trades well still runs its plain SOL down. Measured
 * 2026-11-08: from 0.01 SOL at 23:48Z it fell under the 0.001 SOL a tip must leave (jito.ts
 * JITO_KEEP_LAMPORTS) by 04:43Z, so every trip after went without a Jito tip, the three largest
 * among them; at 0.00078 SOL it had ~130 sends left and could not open a new account, with 0.21
 * SOL wrapped beside it.
 *
 * When plain SOL is under `lowLamports`, wrapped SOL is unwrapped to bring it back to
 * `targetLamports`, in ONE transaction that only the keeper signs: close the wrapped-SOL account
 * (all of it, rent included, becomes plain SOL), open it again, wrap back all but the top-up, and
 * sync. Nothing leaves the wallet but the network fee. Proven read-only on mainnet from the
 * robot's own wallet 2026-11-08 (simulateTransaction): plain 777,248 -> 19,995,000 lamports,
 * wrapped 211,139,319 -> 191,916,567, 335 bytes, 13,882 compute units.
 */

export interface GasSettings {
  /** Under this much plain SOL (lamports), wrapped SOL is unwrapped. */
  lowLamports: bigint;
  /** What plain SOL is brought back to. */
  targetLamports: bigint;
}

/** 0.005 SOL is ~800 plain sends; 0.02 SOL lets a tip of up to ~0.019 SOL go out (a 0.065 SOL gain's 30%). */
export const DEFAULT_GAS: GasSettings = { lowLamports: 5_000_000n, targetLamports: 20_000_000n };

/** Compute units the top-up is given: it used 13,882 on mainnet. */
export const GAS_TOPUP_UNITS = 30_000;

/**
 * Lamports of wrapped SOL to unwrap: none while plain SOL is at or over the low mark, else what
 * brings it back to the target, or all the wrapped SOL there is when that is less.
 */
export function gasTopUp(plain: bigint, wrapped: bigint, g: GasSettings): bigint {
  if (plain >= g.lowLamports || wrapped <= 0n || g.targetLamports <= plain) return 0n;
  const want = g.targetLamports - plain;
  return want < wrapped ? want : wrapped;
}

/**
 * The top-up's instructions: close the keeper's wrapped-SOL account to the keeper, and unless all
 * of it is unwrapped, open it again, put back `wrapped - unwrap` and sync. `microLamports` is the
 * priority fee per unit, as trips pay it.
 */
export function gasTopUpIxs(owner: PublicKey, wrapped: bigint, unwrap: bigint, microLamports: number): TransactionInstruction[] {
  if (unwrap <= 0n || unwrap > wrapped) throw new Error(`cannot unwrap ${unwrap} of ${wrapped} wrapped lamports`);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  const keep = wrapped - unwrap;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: GAS_TOPUP_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    createCloseAccountInstruction(ata, owner, owner),
    ...(keep > 0n
      ? [
          createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: keep }),
          createSyncNativeInstruction(ata),
        ]
      : []),
  ];
}
