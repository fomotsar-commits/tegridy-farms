// Claim fees' one rule: when a pool share's fees can be claimed, and what the claim takes out.
// The Pools row's button (components/solana/lp/YourPositions.tsx) and Harvest
// (components/solana/lp/harvestFees.ts) both ask it, so the two never offer different claims.
import type { PoolSnapshot } from '../cpswap/read';
import { claimSentOn } from './claimed';
import type { LedgerFigures, LedgerRead } from './ledger';
import { isPlanProblem, planWithdrawShares, poolFeesOf, type WithdrawPlan } from './liquidityMath';
import type { LastTrade } from './poolPast';
import type { TransferFee } from './transferFee';

/**
 * A share's fees to claim, or null. Every condition must hold:
 *  - the pool program would let this share leave (`canClaim`: offers.ts withdrawOffer 'offer');
 *  - its ledger balances for every share held (`ok`, case A; case B's claim would leave a
 *    withdrawal the books cannot balance);
 *  - the pool has a trade on its record, so its growth is fees;
 *  - the growth is above zero and some shares are growth alone (`claimShares`);
 *  - no claim was already sent on this balance (claimed.ts);
 *  - taking those shares out pays out on both sides at the pool as read.
 * `plan` is that withdrawal at the pool as read: what the claim pays, about.
 */
export function feeClaimOf(a: {
  read: LedgerRead | null;
  trade: LastTrade;
  canClaim: boolean;
  lpAccount: string;
  lpAmount: bigint;
  snapshot: PoolSnapshot;
  quoteIsToken0: boolean;
  tokenFee: TransferFee | null;
  slippageBps: bigint;
}): { figures: LedgerFigures; plan: WithdrawPlan } | null {
  const r = a.read;
  if (!a.canClaim || r?.kind !== 'ok' || r.case !== 'A' || a.trade.kind === 'none') return null;
  const f = r.figures;
  if (f.growth.kind !== 'amount' || f.growth.coin <= 0n || f.claimShares <= 0n || claimSentOn(a.lpAccount, a.lpAmount)) return null;
  const plan = planWithdrawShares(a.snapshot, { held: a.lpAmount, lp: f.claimShares, bps: a.slippageBps, fees: poolFeesOf(a.quoteIsToken0, a.tokenFee) });
  return isPlanProblem(plan) ? null : { figures: f, plan };
}
