import type { PublicKey } from '@solana/web3.js';
import { browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { withReadCommitment } from '../curve/confirmedRpc';
import { readTokenSafety, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { findPools, readFeeTiers, readPools, type FeeTierRead, type PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OwnPoolReaders } from '../../../lib/solana/swap/ownPools';
import { readOutsidePrice, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { placeShareOnChain, readPositions, type ChainPlacement, type PositionsRead } from '../../../lib/solana/lp/positions';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { readWalletFacts, type WalletFacts } from '../../../lib/solana/lp/walletFacts';

/**
 * Everything the LP section reads, behind one interface so a component test can hand
 * in its own answers. The browser implementation goes through `/api/solrpc` (reads at
 * 'confirmed', like the /curve-launch pages), `/api/pools` and `/api/jupiter`: no
 * Solana host is ever contacted directly.
 */
export interface LpReaders {
  programId: string;
  safety(mints: string[]): Promise<Map<string, TokenSafety>>;
  /**
   * `also`: pool addresses the caller already holds (a position's own pool), read as well
   * as what the index names, under the same this-token-only filter (poolFinder.ts).
   */
  findPools(mint: PublicKey, also?: readonly string[]): Promise<PoolSearchRead>;
  outsidePrice(mint: string, decimals: number): Promise<OutsidePrice>;
  /** `limit`: how many pool shares to place (each costs one index lookup). */
  positions(owner: PublicKey, limit?: number): Promise<PositionsRead>;
  feeTiers(): Promise<FeeTierRead>;
  /**
   * The wallet's SOL, its token account for the pool's token, its wrapped-SOL account
   * and whether it has a pool-share account: for the panels' hints and Max buttons only.
   * Every number a transaction carries is read again when Review is pressed. With
   * `opening`, also the deposits a new pool's own accounts keep for good. With `quote`
   * (the pool's pairing coin, default SOL), a coin that is not SOL is read from the
   * wallet's own account for it and no wrapped-SOL account is read (walletFacts.ts).
   */
  wallet(owner: PublicKey, tokenMint: string, tokenProgram: string, lpMint: string | null, opts?: { opening?: true; quote?: QuoteCoin }): Promise<WalletFacts>;
  /** Find a share's pool from its own chain history, when our pool index cannot answer (D12). */
  placeShareOnChain(share: { lpMint: string; lpAccount: string }): Promise<ChainPlacement>;
}

/**
 * `LpReaders.wallet`'s arguments as `readWalletFacts` takes them. On its own so a test
 * can see the pairing coin reach the read: left out, a USDC pool would be read as a SOL
 * pool and show the wallet's wrapped SOL as its USDC side.
 */
export function walletArgs(
  owner: PublicKey,
  tokenMint: string,
  tokenProgram: string,
  lpMint: string | null,
  opts?: { opening?: true; quote?: QuoteCoin },
): Parameters<typeof readWalletFacts>[1] {
  return { owner: owner.toBase58(), tokenMint, tokenProgram, lpMint, ...(opts?.opening ? { opening: true as const } : {}), ...(opts?.quote ? { quote: opts.quote } : {}) };
}

export function browserLpReaders(): LpReaders | null {
  const programId = LIVE_PROGRAM_ID;
  if (!programId) return null;
  const rpc = withReadCommitment(browserRpc(), 'confirmed');
  const opts = { programId, launchProgramId: LAUNCH_PROGRAM_ID };
  return {
    programId: programId.toBase58(),
    safety: (mints) => readTokenSafety(rpc, mints),
    findPools: (mint, also) => findPools(rpc, mint, also?.length ? { ...opts, also } : opts),
    outsidePrice: (mint, decimals) => readOutsidePrice(mint, decimals, { rpc, programId: programId.toBase58() }),
    positions: (owner, limit) => readPositions(rpc, owner, { ...opts, limit }),
    feeTiers: () => readFeeTiers(rpc, programId),
    wallet: (owner, tokenMint, tokenProgram, lpMint, o) => readWalletFacts(rpc, walletArgs(owner, tokenMint, tokenProgram, lpMint, o)),
    placeShareOnChain: (share) => placeShareOnChain(rpc, opts, share),
  };
}

/** The swap page's reads of our pools (lib/solana/swap/ownPools.ts): the same proxy, program and commitment. */
export function browserOwnPoolReaders(): OwnPoolReaders | null {
  const programId = LIVE_PROGRAM_ID;
  if (!programId) return null;
  const rpc = withReadCommitment(browserRpc(), 'confirmed');
  const opts = { programId, launchProgramId: LAUNCH_PROGRAM_ID };
  return {
    findPools: (mint) => findPools(rpc, mint, opts),
    readPools: (addresses) => readPools(rpc, addresses, opts),
    safety: (mints) => readTokenSafety(rpc, mints),
  };
}
