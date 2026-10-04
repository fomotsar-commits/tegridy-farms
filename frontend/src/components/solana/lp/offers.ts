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
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
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

/**
 * Which form each liquidity kind's pending note holds. A Record, so a new kind must say.
 * `null`: none. A swap through a pool is not a liquidity change, and its notes live in
 * the swap page's own scope, so one never holds Add or Remove.
 */
const LP_SIDE: Readonly<Record<LpKind, 'add' | 'remove' | 'create' | null>> = {
  'lp-deposit': 'add',
  'lp-withdraw': 'remove',
  'lp-create': 'create',
  'lp-swap': null,
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
  | 'pools-unread';

/**
 * Is an opening of any pool still unconfirmed in this tab? It holds Create on EVERY
 * token, whatever its pool says (or whether its pool could be read back at all): a
 * second opening while the first may still land could open two pools and pay twice.
 */
export function createHeld(notes: PendingTrade[]): boolean {
  return notes.some((n) => n.kind === 'lp-create');
}

/**
 * Did the index say this token has more pools than it listed? That is a cut list, not an
 * unread one. The index lists the pools holding the most SOL and the standard addresses
 * are read directly, so a pool left out holds no more SOL than the ones listed, and
 * Create is decided from the pools that were read. A pool costs only rent to open and
 * can never be closed, so treating a cut list as unread let anyone switch Create off
 * for a token for good (audit 2026-10-03, ATK-3). The card says the list was cut, and
 * never calls a new pool "the first".
 */
export function poolListCut(search: PoolSearchRead): boolean {
  return search.kind === 'ok' && search.search.index.kind === 'ok' && search.search.index.truncated;
}

/**
 * Open a new pool, in this order (the first that applies wins): LP switched off → the
 * gate is not open → paused ('withdraw-only') → an opening is still pending → the create
 * facts are not read yet → the public tier: unread, not created, not a tier, switched
 * off, fee above the ceiling → the fee account: unread, not set up → the token: unread,
 * refused → the market price: unread, no route → any pool unread or unchecked → offer.
 *
 * Unread is never "no": every unread input stops here before `offer`. A truncated index
 * is not unread (`poolListCut`): the answer comes from the pools that were read.
 *
 * A pool that already exists NEVER stops an opening (owner ruling 2026-10-03): a token
 * may have as many pools as people open. The card points to the pool to add to first
 * (`createAdvice`), which is why every pool must be read and checked before `offer`.
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
  if (s.index.kind !== 'ok') return 'pools-unread';
  for (const e of s.pools) {
    if (e.kind !== 'pool') return 'pools-unread';
    const verdict = a.healths.get(e.view.address)?.deposits.verdict;
    if (verdict === undefined || verdict === 'unchecked') return 'pools-unread';
  }
  return 'offer';
}

/**
 * The pool an opener is pointed to before they open another. Advice, never a stop:
 *
 *   - 'opened-here': a pool this tab opened in this session, whatever its checks say;
 *   - 'exists': else the pool on the public tier that passes the deposit checks and
 *     holds the most SOL (the same tier a new pool would go on, so the same fees);
 *   - 'none': neither. A passing pool on ANOTHER tier is not a referral (the card names
 *     it and says a new pool will not share its liquidity or fees).
 *
 * The pool program keeps no creation time, so "the bigger pool" is the only ranking
 * there is. Pure; it reads only pools the search read, and names nothing while the gate
 * is not open (there is then no tier to compare with).
 */
export type CreateAdvice = { kind: 'none' } | { kind: 'opened-here' | 'exists'; pool: PoolView };

export function createAdvice(a: {
  gate: LpGate | null;
  search: PoolSearchRead;
  healths: ReadonlyMap<string, PoolHealth>;
  openedHere: (pool: string) => boolean;
}): CreateAdvice {
  if (!a.gate || a.gate.kind !== 'open' || a.search.kind !== 'ok') return { kind: 'none' };
  const views = a.search.search.pools.flatMap((e) => (e.kind === 'pool' ? [e.view] : []));
  const biggest = (list: PoolView[]): PoolView | null =>
    list.reduce<PoolView | null>((best, v) => (best === null || v.solReserve > best.solReserve ? v : best), null);
  const mine = biggest(views.filter((v) => a.openedHere(v.address)));
  if (mine) return { kind: 'opened-here', pool: mine };
  const tier1 = publicTierConfig(a.gate.cfg.cpSwapProgram).toBase58();
  const passing = biggest(views.filter((v) => v.snapshot.pool.ammConfig === tier1 && a.healths.get(v.address)?.deposits.verdict === 'allowed'));
  return passing ? { kind: 'exists', pool: passing } : { kind: 'none' };
}
