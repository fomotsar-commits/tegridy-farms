// Opening a new pool on the public fee tier (`lp-create`).
//
// An opening has no pool to read yet, so its pins come from DERIVATION only: the tier
// from the constant (`publicTierConfig`), the pool's vaults, share token and price
// record from the pool address prepare chose, and the opener's pool-share account from
// that share token. The decoder (intent.ts `poolInitialize`) derives the same things
// again from the same address, so a pin can never point an opening anywhere else.
//
// The address is either the pool's STANDARD address for tier 1, or a fresh key made in
// this browser (when anything at all sits at the standard address or its accounts).

import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import type { CurveWriteConfig, PoolPins } from './types';

/**
 * The pins for an opening at `address`, by derivation only: there is no pool to read
 * yet. `origin` is 'standard' exactly when `address` is the standard tier-1 address for
 * this pair, and 'other' otherwise. A string says why no pins can be made.
 */
export function createPins(
  cfg: CurveWriteConfig,
  a: { address: PublicKey; tokenMint: PublicKey; tokenProgram: PublicKey; signer: PublicKey },
): PoolPins | string {
  if (a.tokenMint.equals(WSOL_MINT)) return 'a pool here pairs a token with SOL, not SOL with itself';
  if (!a.tokenProgram.equals(TOKEN_PROGRAM_ID) && !a.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    return 'the token is not owned by either token program';
  }
  const cp = cfg.cpSwapProgram;
  const ammConfig = publicTierConfig(cp);
  const { token0, token1 } = sortMints(WSOL_MINT, a.tokenMint);
  const solIsToken0 = token0.equals(WSOL_MINT);
  const programOf = (m: PublicKey): PublicKey => (m.equals(WSOL_MINT) ? TOKEN_PROGRAM_ID : a.tokenProgram);
  const lpMint = deriveLpMint(cp, a.address);
  return {
    address: a.address,
    ammConfig,
    origin: a.address.equals(derivePool(cp, ammConfig, token0, token1)) ? 'standard' : 'other',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: programOf(token0),
    token1Program: programOf(token1),
    vault0: deriveVault(cp, a.address, token0),
    vault1: deriveVault(cp, a.address, token1),
    lpMint,
    observation: deriveObservation(cp, a.address),
    tokenMint: a.tokenMint,
    tokenProgram: a.tokenProgram,
    solIsToken0,
    lpAccount: associatedTokenAddress(lpMint, a.signer, TOKEN_PROGRAM_ID),
  };
}
