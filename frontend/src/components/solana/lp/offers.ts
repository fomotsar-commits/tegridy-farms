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
import { launchReference, tokenReasons, type PoolHealth, type PriceCheck } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import { SOL_QUOTE, quotesFor, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { SafetyReason, TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { CreateFacts } from '../../../lib/launcher/solana/write/types';
import type { PendingTrade } from '../curve/pendingTrade';
import type { LpGate, LpKind } from '../curve/ports';

export type DepositOffer = 'offer' | 'paused-here' | 'held' | 'checks' | 'gate' | 'off';

/**
 * Add liquidity, in this order: LP switched off → the gate is not open → adding is
 * paused ('withdraw-only') → a deposit to this pool is still pending → the pool's
 * deposit checks do not say 'allowed' → offer. 'unchecked' never deposits. An 'allowed'
 * pool is offered whatever warnings it carries (poolHealth.ts): a warning is told, and
 * never takes the button away.
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
 * names) → the pool does not pair the token with a pairing coin → a withdrawal from this pool is
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
 * unread one. The index lists, for each pairing coin, the pools holding the most of it,
 * and the standard addresses are read directly, so a pool left out holds no more of its
 * coin than the ones listed, and Create is decided from the pools that were read. A pool
 * costs only rent to open and can never be closed, so treating a cut list as unread let
 * anyone switch Create off for a token for good (audit 2026-10-03, ATK-3). The card says
 * the list was cut, and never calls a new pool "the first".
 */
export function poolListCut(search: PoolSearchRead): boolean {
  return search.kind === 'ok' && search.search.index.kind === 'ok' && search.search.index.truncated;
}

/**
 * Open a new pool, in this order (the first that applies wins): LP switched off → the
 * gate is not open → paused ('withdraw-only') → an opening is still pending → the create
 * facts are not read yet → the public tier: unread, not created, not a tier, switched
 * off, fee above the ceiling → the fee account: unread, not set up → the token: unread,
 * refused → the market price unread → any pool unread or unchecked → offer.
 *
 * Unread is never "no": every unread input stops here before `offer`. A truncated index
 * is not unread (`poolListCut`): the answer comes from the pools that were read.
 *
 * ANY TOKEN MAY HAVE A POOL (owner ruling 2026-10-04). A token is refused only when it is
 * absent or blocked (tokenSafety.ts says what still blocks), or is SOL under the newer
 * token program. A token that copies a well-known name, one its creator can freeze, and
 * one Jupiter ANSWERED it has no market price for are all offered: the card says each as
 * a warning before the button (`openingCautions`). Jupiter failing to answer is not "no
 * market price": that is unread, and stops here.
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

  // Not asked, or Jupiter failed to answer. "No route" is an answer, and goes on.
  if (!a.outside || a.outside.kind === 'unread') return 'price-unread';

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
 * The token warnings that change what a pool for the token risks: it copies a well-known
 * name, its creator can freeze accounts, or a wallet shows a changing amount for it.
 * `tokenReasons` (poolHealth.ts) says each of these again for the pool, and the
 * open-a-pool form shows those lines above Review. So the form leaves these out of the
 * list above its amount boxes (on a phone that list pushes the boxes off the first
 * screen), and the card says them in the token's own words before its button. A test pins
 * that every code here has such a line: none may be left out of the form and said nowhere.
 */
export const POOL_RISK_CODES: ReadonlySet<SafetyReason['code']> = new Set<SafetyReason['code']>([
  'copies-known-name',
  'freeze-authority',
  'interest-bearing',
  'scaled-amount',
]);

const NO_MARKET_CAUTION =
  'Jupiter has no market price for this token, so there is nothing to compare an opening price with. If you open a pool, you set its first price yourself.';
const LAUNCH_POOL_CAUTION =
  'Jupiter has no market price for this token, so an opening price is compared with its launch pool’s price instead (the launch pool’s card above shows it).';

/**
 * The price check of `mint`'s own launch pool, as the page judged it for this search
 * (`assessPools`), or null when the search read none. What an opening price is compared
 * with when Jupiter has no route (opening.ts `openingReference`). A launch pool of
 * another token is never one.
 */
export function launchPoolCheck(mint: string, search: PoolSearchRead, healths: ReadonlyMap<string, PoolHealth>): PriceCheck | null {
  if (search.kind !== 'ok') return null;
  const launch = search.search.pools.find((e) => e.kind === 'pool' && e.view.origin === 'launch-pool' && e.view.tokenMint === mint);
  return launch?.kind === 'pool' ? (healths.get(launch.view.address)?.price ?? null) : null;
}

/**
 * What the Open-a-pool card says, before its button, about a token it offers a pool for:
 * each `POOL_RISK_CODES` warning in the token's own words (the copy warning names the real
 * token's mint), and, when Jupiter ANSWERED it has no market price, what an opening price
 * is compared with instead: the launch pool's price (`launchPrice`, when it gives a
 * reference), or nothing. Warnings: none of them takes the button away. A price that was
 * not read is not one of them (`createOffer` stops on it).
 */
export function openingCautions(safety: TokenSafety, outside: OutsidePrice | null, launchPrice: PriceCheck | null): string[] {
  const token = safety.kind === 'read' ? safety.warnings.filter((w) => POOL_RISK_CODES.has(w.code)).map((w) => w.text) : [];
  if (outside?.kind !== 'no-route') return token;
  return [...token, launchReference(launchPrice) === null ? NO_MARKET_CAUTION : LAUNCH_POOL_CAUTION];
}

/**
 * The pool an opener is pointed to before they open another. Advice, never a stop:
 *
 *   - 'opened-here': a pool this tab opened in this session, whatever its checks say;
 *   - 'exists': else the pool on the public tier that passes the deposit checks and
 *     holds the most of the coin (the same tier a new pool would go on, so the same fees);
 *   - 'none': neither. A passing pool on ANOTHER tier is not a referral (the card names
 *     it and says a new pool will not share its liquidity or fees).
 *
 * ONE ANSWER PER PAIRING COIN (`quote`, default SOL). A new pool is paired with one coin,
 * and the pool to add to instead is one paired with that same coin: a SOL pool is no
 * reason not to open the first USDC pool. So only pools paired with `quote` are looked
 * at, and a reserve of one coin is never compared with a reserve of another: the same
 * number of base units is 10 SOL in one pool and 10,000 USDC in the next.
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
  /** The coin the new pool would be paired with. Left out, it is SOL. */
  quote?: QuoteCoin;
}): CreateAdvice {
  if (!a.gate || a.gate.kind !== 'open' || a.search.kind !== 'ok') return { kind: 'none' };
  const coin = (a.quote ?? SOL_QUOTE).mint;
  const views = a.search.search.pools.flatMap((e) => (e.kind === 'pool' && e.view.quote.mint === coin ? [e.view] : []));
  const biggest = (list: PoolView[]): PoolView | null =>
    list.reduce<PoolView | null>((best, v) => (best === null || v.quoteReserve > best.quoteReserve ? v : best), null);
  const mine = biggest(views.filter((v) => a.openedHere(v.address)));
  if (mine) return { kind: 'opened-here', pool: mine };
  const tier1 = publicTierConfig(a.gate.cfg.cpSwapProgram).toBase58();
  const passing = views.filter((v) => v.snapshot.pool.ammConfig === tier1 && a.healths.get(v.address)?.deposits.verdict === 'allowed');
  // A pool more than 3% off its reference is 'allowed' now, with a warning (owner ruling
  // 2026-10-04). One big pool at a wrong price must not hide a smaller one at the market:
  // the biggest pool whose price is not off is the one pointed to, and an off-price pool
  // is named only when it is all there is (review, 2026-10-04).
  const pick = biggest(passing.filter((v) => a.healths.get(v.address)?.price.state !== 'disagrees')) ?? biggest(passing);
  return pick ? { kind: 'exists', pool: pick } : { kind: 'none' };
}

/**
 * Did a pool's price check end in a warning: its price is more than 3% off its reference,
 * or the token has no market price, so it was compared with nothing? Such a pool takes
 * deposits, and nothing on the page says it "passes the checks": the Open-a-pool card
 * and its form both say it "takes deposits, with a warning" (review, 2026-10-04).
 */
export function priceWarned(health: PoolHealth | undefined): boolean {
  return health?.price.state === 'disagrees' || health?.price.state === 'no-market';
}

/**
 * What the Open-a-pool card and its form know about ONE coin the token can be paired
 * with. Each pair is its own question: its own pool to add to first, its own standard
 * address, and whether any pool pairs the token with that coin at all.
 */
export interface PairFacts {
  coin: QuoteCoin;
  /** The pool to add to first among the pools paired with this coin (`createAdvice`). */
  advice: CreateAdvice;
  /** The pool `advice` names takes deposits with a warning about its price (`priceWarned`). False when it names none. */
  warned: boolean;
  /** Did the search read any pool paired with this coin, passing its checks or not? */
  hasPool: boolean;
  /** Whether the search found anything at THIS pair's standard tier-1 address. Prepare decides for good. */
  standard: 'empty' | 'taken';
}

/**
 * Whether anything sits at the standard tier-1 address of the token paired with `coin`.
 * Every pair has its own standard address (the address is made from both mints), so a
 * SOL pool at the SOL pair's address says nothing about where a USDC pool would go. An
 * address the search did not read is 'empty' here, and Prepare reads it again.
 */
export function standardState(search: PoolSearchRead, coin: QuoteCoin): 'empty' | 'taken' {
  if (search.kind !== 'ok') return 'empty';
  const address = search.search.known.standard.find((s) => s.index === 1 && s.quote === coin.mint)?.address;
  const state = address ? search.search.knownState[address] : undefined;
  return state !== undefined && state !== 'absent' ? 'taken' : 'empty';
}

/**
 * `PairFacts` for each coin `tokenMint` can be paired with, in rank order (SOL first).
 * `advise: false` names no pool for any coin: a card that does not offer an opening has
 * its own line, and points nowhere.
 */
export function pairFacts(a: {
  tokenMint: string;
  gate: LpGate | null;
  search: PoolSearchRead;
  healths: ReadonlyMap<string, PoolHealth>;
  openedHere: (pool: string) => boolean;
  advise: boolean;
}): PairFacts[] {
  const paired = new Set(a.search.kind === 'ok' ? a.search.search.pools.flatMap((e) => (e.kind === 'pool' ? [e.view.quote.mint] : [])) : []);
  return quotesFor(a.tokenMint).map((coin) => {
    const advice: CreateAdvice = a.advise ? createAdvice({ gate: a.gate, search: a.search, healths: a.healths, openedHere: a.openedHere, quote: coin }) : { kind: 'none' };
    return {
      coin,
      advice,
      warned: advice.kind !== 'none' && priceWarned(a.healths.get(advice.pool.address)),
      hasPool: paired.has(coin.mint),
      standard: standardState(a.search, coin),
    };
  });
}
