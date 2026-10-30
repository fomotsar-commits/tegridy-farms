// Harvest: one button that claims a wallet's staking rewards from every island pool
// (owner, 2026-10-24: "currently you have to click each pool, i would like a harvest
// feature that claims rewards across the apps").
//
// Pure: no chain code here, so the Earn page can import it without loading Solana.
//
// THE RULE EVERY POOL KEEPS (lib/wallet/walletRows.ts): an amount is shown only when a
// read returned it. A pool that could not be read is listed by name as not read, never
// as nothing to claim, and the button claims only what was read above zero.

export type HarvestChain = 'solana' | 'ethereum' | 'base';

export const HARVEST_CHAIN_LABEL: Record<HarvestChain, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base' };

/** The order a harvest runs in: Solana first, then each EVM chain, so the wallet switches network once per chain. */
export const HARVEST_CHAIN_ORDER: readonly HarvestChain[] = ['solana', 'ethereum', 'base'];

/** One claim the button will send: one wallet approval. */
export interface HarvestClaim {
  key: string;
  chain: HarvestChain;
  roomId: string;
  /** The room's ticker; every claim here pays the room's own coin. */
  symbol: string;
  /** "lighthouse pool", "lock ladder", "old pool", … */
  where: string;
  /** "on 1,000 BAYLA staked", or null. */
  detail: string | null;
  amountRaw: bigint;
  decimals: number;
  /** Said beside the amount when the claim may pay less than it, or may not pay. Null = none. */
  caution: string | null;
}

/** Rewards seen in a pool that the button leaves alone, and why. Claimed on the pool's own page. */
export interface HarvestHeld {
  key: string;
  chain: HarvestChain;
  roomId: string;
  symbol: string;
  where: string;
  /** Null when the amount is in a coin this page does not name (another mint's reward pool). */
  amountRaw: bigint | null;
  decimals: number;
  reason: string;
}

/** A pool whose rewards could not be read. Never a zero. */
export interface HarvestUnread {
  key: string;
  chain: HarvestChain;
  roomId: string;
  /** "your BAYLA stakes", … */
  what: string;
  detail: string;
}

export interface HarvestPlan<C extends HarvestClaim = HarvestClaim> {
  claims: C[];
  held: HarvestHeld[];
  unread: HarvestUnread[];
}

export const EMPTY_PLAN: HarvestPlan<never> = { claims: [], held: [], unread: [] };

/** What one claim came to. */
export type ClaimResult =
  /** It landed and paid. */
  | { kind: 'claimed'; tx: string }
  /** Cancelled in the wallet: nothing was sent, and the harvest stops there. */
  | { kind: 'declined' }
  /** It landed and reverted: nothing was claimed, the network fee was spent. */
  | { kind: 'reverted'; reason: string; tx: string }
  /**
   * Not confirmed: it did not go through, or it was sent and its outcome could not be
   * read. `reason` is the claim path's own words, which say which; never "claimed",
   * and never a plain "failed" for a claim that may still land. `stop` ends the run.
   */
  | { kind: 'unconfirmed'; reason: string; tx?: string; stop?: true };

/** A claim's place in a run: waiting, at the wallet, what it came to, or left unsent when the run stopped. */
export type ClaimState = { kind: 'waiting' } | { kind: 'sending' } | { kind: 'not-sent' } | ClaimResult;

/**
 * Claims in run order: Solana, then the EVM chain the wallet is already on, then the
 * other, so the wallet switches network at most once; within a chain every sure claim
 * before a cautioned one.
 */
export function orderClaims<C extends HarvestClaim>(claims: readonly C[], evmFirst: HarvestChain | null = null): C[] {
  const chainRank = (ch: HarvestChain) => (ch === 'solana' ? 0 : ch === evmFirst ? 1 : 1 + HARVEST_CHAIN_ORDER.indexOf(ch));
  const rank = (c: C) => chainRank(c.chain) * 2 + (c.caution ? 1 : 0);
  return claims
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}
