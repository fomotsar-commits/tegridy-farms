import type { PublicKey } from '@solana/web3.js';
import { browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { withReadCommitment } from '../curve/confirmedRpc';
import { readTokenSafety, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { findPools, readFeeTiers, type FeeTierRead, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { readLedger, type LedgerRead } from '../../../lib/solana/lp/ledger';
import { readOutsidePrice, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { listPools, type PoolListRead } from '../../../lib/solana/lp/poolList';
import { readPoolPast, type PoolPastRead } from '../../../lib/solana/lp/poolPast';
import { placeShareOnChain, readPositions, type ChainPlacement, type PositionsRead } from '../../../lib/solana/lp/positions';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { lpFetch } from '../../../lib/solana/lp/readFetch';
import { noteResponse } from '../../../lib/solana/lp/rpcBudget';
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
  /**
   * On a press only, never on page load (ledger.ts, poolPast.ts): a position's ledger from
   * its share account's last 20 transactions, and a pool's last 20 classified. Optional:
   * a reader without them shows no history block, and every existing fake still fits.
   */
  ledger?(share: { lpAccount: string; lpMint: string; owner: PublicKey; lpAmount: bigint }, view: PoolView, opts?: { before?: string }): Promise<LedgerRead>;
  poolPast?(view: PoolView, opts?: { before?: string }): Promise<PoolPastRead>;
  /**
   * Every pool on the venue with a pairing coin, for the list shown before a token is typed
   * (poolList.ts): one index fetch (`/api/pools?all=1`), then every address read on the
   * chain. Optional: a reader without it shows no venue list, and every existing fake fits.
   */
  listPools?(): Promise<PoolListRead>;
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
  // Every read ends (readFetch.ts); the chain's answers feed the budget (rpcBudget.ts).
  const rpc = withReadCommitment(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse })), 'confirmed');
  const opts = { programId, launchProgramId: LAUNCH_PROGRAM_ID };
  const indexOpts = { ...opts, fetchImpl: lpFetch({ what: 'the pool index' }) };
  const jupiter = lpFetch({ what: 'Jupiter' });
  return {
    programId: programId.toBase58(),
    safety: (mints) => readTokenSafety(rpc, mints),
    findPools: (mint, also) => findPools(rpc, mint, also?.length ? { ...indexOpts, also } : indexOpts),
    outsidePrice: (mint, decimals) => readOutsidePrice(mint, decimals, { rpc, programId: programId.toBase58() }, jupiter),
    positions: (owner, limit) => readPositions(rpc, owner, { ...indexOpts, limit }),
    feeTiers: () => readFeeTiers(rpc, programId),
    wallet: (owner, tokenMint, tokenProgram, lpMint, o) => readWalletFacts(rpc, walletArgs(owner, tokenMint, tokenProgram, lpMint, o)),
    placeShareOnChain: (share) => placeShareOnChain(rpc, opts, share),
    ledger: (share, view, o) => readLedger(rpc, { ...share, owner: share.owner.toBase58() }, view, programId.toBase58(), o ?? {}),
    poolPast: (view, o) => readPoolPast(rpc, view, programId.toBase58(), o ?? {}),
    listPools: () => listPools(rpc, indexOpts),
  };
}
