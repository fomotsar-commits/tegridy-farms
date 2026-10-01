// Which liquidity action a card or a position row offers, and if not, why. Pure.
//
// THE LEAVE RULE (spec 3.7). Removing liquidity is refused only for the pool
// program's own rules (the withdraw switch, a frozen vault, a side that would round to
// zero), our own emergency switch, a pool this site cannot build for, and a withdrawal
// already pending on that pool. `withdrawOffer` therefore NEVER takes: the deposit
// verdict, the price, the open time, the swap or deposit switches, the token verdict,
// the fee settings, or anything about the launch program. Its inputs are the mode,
// the LP gate, the position (the pool as read), and the pending lock.

import { withdrawEnabled } from '../../../lib/solana/cpswap/program';
import type { LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { minLpForBothSides } from '../../../lib/solana/lp/liquidityMath';
import type { PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { Position } from '../../../lib/solana/lp/positions';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { PendingTrade } from '../curve/pendingTrade';
import type { LpGate, LpKind } from '../curve/ports';

export type DepositOffer = 'offer' | 'paused-here' | 'held' | 'checks' | 'gate' | 'off';

/**
 * Add liquidity, in this order: LP switched off → the gate is not open → adding is
 * paused ('withdraw-only') → a deposit to this pool is still pending → the pool's
 * deposit checks do not say 'allowed' → offer. 'unchecked' never deposits.
 */
export function depositOffer(a: { mode: LpWriteMode; gate: LpGate | null; health: PoolHealth; held: boolean }): DepositOffer {
  if (a.mode === 'off') return 'off';
  if (!a.gate || a.gate.kind !== 'open') return 'gate';
  if (a.mode === 'withdraw-only' || a.gate.mode === 'withdraw-only') return 'paused-here';
  if (a.held) return 'held';
  if (a.health.deposits.verdict !== 'allowed') return 'checks';
  return 'offer';
}

export type WithdrawOffer =
  | 'offer'
  | 'switched-off'
  | 'vault-frozen'
  | 'dust'
  | 'other-pair'
  | 'unplaced'
  | 'pool-unread'
  | 'held'
  | 'gate'
  | 'off';

/**
 * Remove liquidity, in this order: LP switched off → the gate is not open → the share
 * has no pool placed → its pool could not be read (or was not the pool the share
 * names) → the pool does not pair the token with SOL → a withdrawal from this pool is
 * still pending → the pool program's withdraw switch is off → a vault is frozen → the
 * whole share is below the program's minimum (one side would round to zero) → offer.
 */
export function withdrawOffer(a: { mode: LpWriteMode; gate: LpGate | null; position: Position; held: boolean }): WithdrawOffer {
  if (a.mode === 'off') return 'off';
  if (!a.gate || a.gate.kind !== 'open') return 'gate';
  const pool = a.position.pool;
  if (!pool) return 'unplaced';
  if (pool.kind === 'other-pair') return 'other-pair';
  // Absent, not a pool, unread: nothing this site can build against. So is a pool that
  // does not itself name this share's mint (positions.ts values a share only then).
  if (pool.kind !== 'pool' || pool.view.snapshot.pool.lpMint !== a.position.lpMint) return 'pool-unread';
  if (a.held) return 'held';
  if (!withdrawEnabled(pool.view.snapshot.pool)) return 'switched-off';
  if (pool.view.vaultsFrozen) return 'vault-frozen';
  const minLp = minLpForBothSides(pool.view.snapshot);
  if (minLp === null || a.position.lpAmount < minLp) return 'dust';
  return 'offer';
}

/** Which form each liquidity kind's pending note holds. A Record, so a new kind must say. */
const LP_SIDE: Readonly<Record<LpKind, 'add' | 'remove' | 'create'>> = {
  'lp-deposit': 'add',
  'lp-withdraw': 'remove',
  'lp-create': 'create',
};

/**
 * Does a pending liquidity note hold this pool in this direction? A note whose pool
 * could not be read back (`pool: null`) holds every pool: it fails closed. Notes of
 * other kinds never hold a liquidity form, and a pending opening never holds Add or
 * Remove (it is not a repeat of either).
 */
export function lpHeld(notes: PendingTrade[], pool: string, side: 'add' | 'remove'): boolean {
  return notes.some((n) => {
    if (!isLpKind(n.kind)) return false;
    if (LP_SIDE[n.kind] !== side) return false;
    return n.pool === null || n.pool === pool;
  });
}
