import type { PublicKey } from '@solana/web3.js';
import { browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { withReadCommitment } from '../curve/confirmedRpc';
import { readTokenSafety, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { findPools, readFeeTiers, type FeeTierRead, type PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import { readOutsidePrice, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { readPositions, type PositionsRead } from '../../../lib/solana/lp/positions';

/**
 * Everything the LP section reads, behind one interface so a component test can hand
 * in its own answers. The browser implementation goes through `/api/solrpc` (reads at
 * 'confirmed', like the /curve-launch pages), `/api/pools` and `/api/jupiter`: no
 * Solana host is ever contacted directly.
 */
export interface LpReaders {
  programId: string;
  safety(mints: string[]): Promise<Map<string, TokenSafety>>;
  findPools(mint: PublicKey): Promise<PoolSearchRead>;
  outsidePrice(mint: string, decimals: number): Promise<OutsidePrice>;
  positions(owner: PublicKey): Promise<PositionsRead>;
  feeTiers(): Promise<FeeTierRead>;
}

export function browserLpReaders(): LpReaders | null {
  const programId = LIVE_PROGRAM_ID;
  if (!programId) return null;
  const rpc = withReadCommitment(browserRpc(), 'confirmed');
  const opts = { programId, launchProgramId: LAUNCH_PROGRAM_ID };
  return {
    programId: programId.toBase58(),
    safety: (mints) => readTokenSafety(rpc, mints),
    findPools: (mint) => findPools(rpc, mint, opts),
    outsidePrice: (mint, decimals) => readOutsidePrice(mint, decimals),
    positions: (owner) => readPositions(rpc, owner, opts),
    feeTiers: () => readFeeTiers(rpc, programId),
  };
}
