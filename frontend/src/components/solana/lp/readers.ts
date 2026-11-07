import type { PublicKey } from '@solana/web3.js';
import { browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { withReadCommitment } from '../curve/confirmedRpc';
import { readTokenSafety, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { findPools, readFeeTiers, type FeeTierRead, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { readLedger, type LedgerRead } from '../../../lib/solana/lp/ledger';
import { listedOutsidePrice, readLegQuote, readOutsidePrice, type LegQuote, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { ownPoolPrograms } from '../../../lib/solana/lp/ownPools';
import { readPoolPastPage, type PoolPastPage } from '../../../lib/solana/lp/poolPast';
import { listPools, type PoolListRead } from '../../../lib/solana/lp/poolList';
import { readPoolHolders, type HoldersRead } from '../../../lib/solana/lp/holders';
import { placeShareOnChain, readPositions, type ChainPlacement, type PositionsRead } from '../../../lib/solana/lp/positions';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { READ_TIMEOUT_MS, lpFetch } from '../../../lib/solana/lp/readFetch';
import { getUsdPrices } from '../../../lib/jupiter';
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
  /**
   * Every pool on the venue, for the list shown before a token is picked (poolList.ts).
   * Optional: a reader without it shows no list, and every existing fake still fits.
   * `fresh`: a read of its own, never the answer to a read already in flight (a finished
   * liquidity flow and a Read again press must see the chain as it is now).
   */
  listPools?(opts?: { fresh?: boolean }): Promise<PoolListRead>;
  /**
   * Jupiter's USD prices for a set of coins, in the one read the edge shares for 30
   * seconds (lib/jupiter.ts `getUsdPrices`): All pools' price tags (poolList.ts
   * `readMarketPrices`). Optional: a reader without it marks no row for its price.
   */
  marketPrices?(mints: string[]): Promise<Record<string, number>>;
  /**
   * `fresh`: ask Jupiter itself, not the copy the edge shares for 30 seconds
   * (outsidePrice.ts). The check run again at Review, and a visitor's own Read again.
   */
  outsidePrice(mint: string, decimals: number, opts?: { fresh?: boolean }): Promise<OutsidePrice>;
  /**
   * Jupiter's quote for one trade, shared at the edge for 30 seconds (outsidePrice.ts
   * `readLegQuote`): the Arbitrage card's check of each row's other leg. Optional: without
   * it no row is checked, and each figure is said to be at Jupiter's listed price.
   */
  legQuote?(inputMint: string, outputMint: string, amount: bigint): Promise<LegQuote>;
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
   * History, behind the budget gate (ledger.ts, poolPast.ts): a position's ledger from its
   * share account's last 20 transactions, and one page of a pool's transactions, classified.
   * The ledger is read by itself for the first two positions and on a press for the rest
   * (YourPositions.tsx); the pool's past on a press only (PoolCard.tsx). Optional: a reader
   * without them shows no history block, and every existing fake still fits.
   */
  ledger?(share: { lpAccount: string; lpMint: string; owner: PublicKey; lpAmount: bigint }, view: PoolView, opts?: { before?: string }): Promise<LedgerRead>;
  poolPast?(view: PoolView, opts?: { before?: string }): Promise<PoolPastPage>;
  /**
   * Every holder of one pool's shares (holders.ts), for "Every position". Optional: a
   * reader without it shows no such card, and every existing fake still fits.
   */
  holders?(view: PoolView): Promise<HoldersRead>;
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
  // All pools and Every position ask for the list together: they share the one read in flight.
  let listing: Promise<PoolListRead> | null = null;
  return {
    programId: programId.toBase58(),
    safety: (mints) => readTokenSafety(rpc, mints),
    findPools: (mint, also) => findPools(rpc, mint, also?.length ? { ...indexOpts, also } : indexOpts),
    listPools: (o) => {
      // A fresh read becomes the one in flight, so a card asking meanwhile shares it too; a read
      // it replaced clears nothing when it settles.
      if (o?.fresh || !listing) {
        const mine: Promise<PoolListRead> = listPools(rpc, indexOpts).finally(() => {
          if (listing === mine) listing = null;
        });
        listing = mine;
      }
      return listing;
    },
    // Ends like every LP read (readFetch.ts): a read that never answers is "not read", not a list with no price tags.
    // A shared read takes the list's dollar prices first (lib/jupiter.ts getUsdPrices); price/v3 for a mint the loop never asked about.
    marketPrices: (mints) => getUsdPrices(mints, AbortSignal.timeout(READ_TIMEOUT_MS), { shared: true }),
    // The shared list first (one read for everyone, api/outside-prices.js); the two quotes for a token it does not carry and for a fresh read.
    outsidePrice: async (mint, decimals, o) =>
      (o?.fresh ? null : await listedOutsidePrice(mint, jupiter)) ?? readOutsidePrice(mint, decimals, { rpc, programId: ownPoolPrograms([programId.toBase58()]) }, jupiter, undefined, o),
    legQuote: (inputMint, outputMint, amount) => readLegQuote(inputMint, outputMint, amount, jupiter),
    positions: (owner, limit) => readPositions(rpc, owner, { ...indexOpts, limit }),
    feeTiers: () => readFeeTiers(rpc, programId),
    wallet: (owner, tokenMint, tokenProgram, lpMint, o) => readWalletFacts(rpc, walletArgs(owner, tokenMint, tokenProgram, lpMint, o)),
    placeShareOnChain: (share) => placeShareOnChain(rpc, opts, share),
    ledger: (share, view, o) => readLedger(rpc, { ...share, owner: share.owner.toBase58() }, view, programId.toBase58(), o ?? {}),
    poolPast: (view, o) => readPoolPastPage(rpc, view, programId.toBase58(), o ?? {}),
    holders: (view) => readPoolHolders(rpc, view),
  };
}
