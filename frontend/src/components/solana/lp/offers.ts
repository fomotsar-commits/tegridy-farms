// Which liquidity action a card or a position row offers, and if not, why. Pure.
//
// THE LEAVE RULE (spec 3.7). Removing liquidity is refused only for the pool
// program's own rules (the withdraw switch, a frozen vault, a side that would round to
// zero), our own emergency switch, a pool this site cannot build for, and a withdrawal
// already pending on that pool. `withdrawOffer` therefore NEVER takes: the deposit
// verdict, the price, the open time, the swap or deposit switches, the token verdict,
// the fee settings, or anything about the launch program. Its inputs are the mode,
// the LP gate, the position (the pool as read), and the pending lock.
//
// Opening a pool (`createOffer`) is the only one that reads the create facts (the
// public fee tier and the fee account): neither Add nor Remove ever takes them.

import { publicTierConfig, withdrawEnabled } from '../../../lib/solana/cpswap/program';
import type { LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { minLpForBothSides } from '../../../lib/solana/lp/liquidityMath';
import { TOKEN_2022_NATIVE_MINT } from '../../../lib/solana/lp/opening';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { tokenReasons, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { CreateFacts } from '../../../lib/launcher/solana/write/types';
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

// ── opening a pool ────────────────────────────────────────────────────────────

export type CreateOffer =
  | 'offer'
  | 'off'
  | 'gate'
  | 'paused-here'
  | 'held'
  | 'checking'
  | 'tier-unread'
  | 'tier-not-open'
  | 'tier-bad'
  | 'tier-off'
  | 'tier-fee-too-high'
  | 'fee-account-unread'
  | 'fee-account'
  | 'token-unread'
  | 'token-refused'
  | 'price-unread'
  | 'no-route'
  | 'pools-unread'
  | 'opened-here'
  | 'exists';

/**
 * Is an opening of any pool still unconfirmed in this tab? It holds Create on EVERY
 * token, whatever its pool says (or whether its pool could be read back at all): a
 * second opening while the first may still land could open two pools and pay twice.
 */
export function createHeld(notes: PendingTrade[]): boolean {
  return notes.some((n) => n.kind === 'lp-create');
}

/**
 * Open a new pool, in this order (the first that applies wins): LP switched off → the
 * gate is not open → paused ('withdraw-only') → an opening is still pending → the create
 * facts are not read yet → the public tier: unread, not created, not a tier, switched
 * off, fee above the ceiling → the fee account: unread, not set up → the token: unread,
 * refused → the market price: unread, no route → any pool unread or unchecked → a pool
 * this tab just opened → a passing pool already on the public tier → offer.
 *
 * Unread is never "no": every unread input stops here before `offer`. A passing pool on
 * ANOTHER tier does not stop an opening on tier 1 (the card says they will not share
 * liquidity or fees).
 */
export function createOffer(a: {
  mode: LpWriteMode;
  gate: LpGate | null;
  facts: CreateFacts | null;
  notes: PendingTrade[];
  safety: TokenSafety;
  outside: OutsidePrice | null;
  search: PoolSearchRead;
  healths: ReadonlyMap<string, PoolHealth>;
  openedHere: (pool: string) => boolean;
}): CreateOffer {
  if (a.mode === 'off') return 'off';
  if (!a.gate || a.gate.kind !== 'open') return 'gate';
  if (a.mode === 'withdraw-only' || a.gate.mode === 'withdraw-only') return 'paused-here';
  if (createHeld(a.notes)) return 'held';
  if (!a.facts) return 'checking';

  switch (a.facts.tier.kind) {
    case 'unread':
      return 'tier-unread';
    case 'not-open':
      return 'tier-not-open';
    case 'not-a-tier':
      return 'tier-bad';
    case 'switched-off':
      return 'tier-off';
    case 'fee-too-high':
      return 'tier-fee-too-high';
    case 'ready':
      break;
  }
  if (a.facts.feeAccount.kind === 'unread') return 'fee-account-unread';
  if (a.facts.feeAccount.kind !== 'ready') return 'fee-account';

  const token = tokenReasons(a.safety, 'pools');
  if (token.unchecked.length > 0) return 'token-unread';
  if (token.refused.length > 0 || a.safety.mint === TOKEN_2022_NATIVE_MINT) return 'token-refused';

  if (!a.outside || a.outside.kind === 'unread') return 'price-unread';
  if (a.outside.kind === 'no-route') return 'no-route';

  if (a.search.kind !== 'ok') return 'pools-unread';
  const s = a.search.search;
  if (s.index.kind !== 'ok' || s.index.truncated) return 'pools-unread';
  for (const e of s.pools) {
    if (e.kind !== 'pool') return 'pools-unread';
    const verdict = a.healths.get(e.view.address)?.deposits.verdict;
    if (verdict === undefined || verdict === 'unchecked') return 'pools-unread';
  }

  const pools = s.pools.filter((e): e is Extract<typeof e, { kind: 'pool' }> => e.kind === 'pool');
  if (pools.some((e) => a.openedHere(e.view.address))) return 'opened-here';
  const tier1 = publicTierConfig(a.gate.cfg.cpSwapProgram).toBase58();
  if (pools.some((e) => e.view.snapshot.pool.ammConfig === tier1 && a.healths.get(e.view.address)?.deposits.verdict === 'allowed')) {
    return 'exists';
  }
  return 'offer';
}
