// What the browser remembers about copy-trading: which wallets are followed, on
// what terms, and which mirrors the user actually confirmed.
//
// NON-CUSTODIAL, AND THE STORAGE CHOICE IS THE PROOF. Everything here is a
// public address, a cap and a timestamp. No private key, no seed, no session
// secret, and no server copy — there is no endpoint in api/ that reads or writes
// any of it. A "follow" therefore grants nothing: it cannot move a token, cannot
// sign, and cannot survive the user clearing site data. That is the entire
// security model and it is why this is a localStorage module and not a table.
//
// A follow is ALSO NOT A SUBSCRIPTION TO EXECUTION. The venue runs no keeper, so
// nothing in this repo watches a leader and fires a trade. A follow decides how a
// mirror would be SIZED if the user chooses to place it; see mirror.ts, where the
// refusal to imply automatic execution is encoded rather than written in copy.
//
// ─── A FOLLOW NOW NAMES ITS VENUE ────────────────────────────────────────────
//
// The island tape spans Ethereum, Base and Solana, so "leader" is no longer one
// address shape and "quote token" is no longer one contract. A follow therefore
// carries a `venue`, and both of its addresses are validated AGAINST THAT VENUE
// rather than against whichever regex happens to match: a base58 string stored
// as an EVM leader would never match a fill and would sit in the list looking
// like a working follow forever.
//
// The stored envelope moved to v2 for that field, and the v2 decoder still reads
// a v1 row — as venue 'evm', which is what every v1 row was — with its cap and
// its guard intact. A migration that DROPS rows it can read is a migration that
// deletes a user's per-trade caps to save the author a branch.

import { safeGetItem, safeJsonParse, safeSetItem } from '../storage';
import { ETH_ADDRESS_RE } from '../scanner/scanner';
import { isSolanaPubkey, isSolanaSignature } from './base58';
import { findQuoteToken } from './quoteTokens';
import type { PoolFamily } from './tape';

const ADDRESS_RE = ETH_ADDRESS_RE;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export const FOLLOWS_STORAGE_KEY = 'tegridy_copytrade_follows';
export const MIRRORS_STORAGE_KEY = 'tegridy_copytrade_mirrors';

/**
 * Where the reader's own Solana address is kept.
 *
 * Under the `tegridy-own-` namespace ON PURPOSE: lib/storage.ts protects that
 * whole prefix from the quota sweeper, and a pasted wallet address is a thing
 * the user typed, not a cache that re-fetches. (The two keys above predate that
 * namespace and are still evictable — the fix is a shared edit to
 * EVICTION_PROTECTED_KEYS, filed separately, because renaming a live key would
 * silently orphan every follow already saved in a real browser.)
 */
export const SOLANA_FOLLOWER_STORAGE_KEY = 'tegridy-own-copytrade-solana-wallet';

/** Is this string an address on this venue? The ONLY address test in this module. */
export function isVenueAddress(venue: PoolFamily, value: string): boolean {
  return venue === 'solana' ? isSolanaPubkey(value) : ADDRESS_RE.test(value.trim());
}

/** Venue-correct comparison form: hex is case-insensitive, base58 is not. */
export function normaliseVenueAddress(venue: PoolFamily, value: string): string {
  return venue === 'solana' ? value.trim() : value.trim().toLowerCase();
}

/**
 * Upper bound on a slippage guard, in basis points.
 *
 * 5% is where a guard stops guarding: past it the tolerance is wider than the
 * move most mirrored fills suffer, so the transaction would go through in
 * exactly the conditions the guard exists to refuse. A user who wants more than
 * this wants no guard, and this module will not write one that pretends to be.
 */
export const MAX_SLIPPAGE_BPS = 500;
export const MIN_SLIPPAGE_BPS = 1;

/** Most follows one browser will hold. Past this the mirror queue is unreadable. */
export const MAX_FOLLOWS = 20;

export interface FollowConfig {
  /** Which chain family this follow's addresses belong to. */
  venue: PoolFamily;
  /** Wallet whose fills this follow watches. Lowercased on EVM, exact on Solana. */
  leader: string;
  /**
   * The ONLY token a mirror will size from. A leader fill whose quote leg is not
   * this token is refused rather than converted: neither the indexer nor the
   * tape carries a rate, so "cap this trade at 0.5 ETH" cannot be applied to a
   * fill denominated in something else without inventing one.
   */
  quoteToken: string;
  /** Per-trade ceiling, in `quoteToken`'s smallest unit. */
  maxNotionalWei: bigint;
  /** Handed to the quoting layer at confirm time. Never a promise of a fill. */
  slippageBps: number;
  /** Unix seconds. */
  createdAt: number;
}

export type FollowRejection =
  | 'bad-leader'
  | 'bad-quote-token'
  | 'leader-venue-mismatch'
  | 'quote-venue-mismatch'
  | 'self-follow'
  | 'cap-not-positive'
  | 'slippage-out-of-range'
  | 'duplicate'
  | 'too-many-follows';

export const FOLLOW_REJECTION_TEXT: Record<FollowRejection, string> = {
  'bad-leader': 'A leader must be an address on the venue you picked.',
  'bad-quote-token': 'The quote token must be one of the tokens listed for this venue.',
  'leader-venue-mismatch':
    'That address is not an address on the venue you picked — a 0x address is Ethereum or Base, a base58 key is Solana. Stored on the wrong venue it would never match a fill.',
  'quote-venue-mismatch':
    'That quote token is not on the venue you picked. WETH on Ethereum and WETH on Base are different contracts, and neither of them is SOL.',
  'self-follow': 'A wallet cannot follow itself — mirroring your own trades would double them.',
  'cap-not-positive': 'A per-trade cap of zero would size every mirror at nothing.',
  'slippage-out-of-range': `A slippage guard must be between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} basis points. Above that it is not a guard.`,
  duplicate: 'This wallet is already followed on this quote token.',
  'too-many-follows': `This browser holds at most ${MAX_FOLLOWS} follows.`,
};

export interface FollowDraft {
  venue: PoolFamily;
  leader: string;
  quoteToken: string;
  maxNotionalWei: bigint;
  slippageBps: number;
  /** The connected wallet, when there is one. Used only for the self-follow check. */
  follower?: string | null;
  /** Unix seconds. Injected so the result is a pure function of its inputs. */
  now: number;
}

export type FollowValidation =
  | { ok: true; config: FollowConfig }
  | { ok: false; reason: FollowRejection };

export function validateFollow(draft: FollowDraft, existing: readonly FollowConfig[] = []): FollowValidation {
  const venue = draft.venue;
  const rawLeader = draft.leader.trim();
  if (rawLeader.length === 0) return { ok: false, reason: 'bad-leader' };
  if (!isVenueAddress(venue, rawLeader)) {
    // A 0x address typed under "Solana" is a real address on the wrong chain, and
    // that is a different mistake from a typo — so it gets its own sentence.
    const otherVenue: PoolFamily = venue === 'solana' ? 'evm' : 'solana';
    return { ok: false, reason: isVenueAddress(otherVenue, rawLeader) ? 'leader-venue-mismatch' : 'bad-leader' };
  }

  const quote = findQuoteToken(draft.quoteToken);
  if (!quote) return { ok: false, reason: 'bad-quote-token' };
  if (quote.family !== venue) return { ok: false, reason: 'quote-venue-mismatch' };

  const leader = normaliseVenueAddress(venue, rawLeader);
  const quoteToken = quote.address;

  if (draft.follower && normaliseVenueAddress(venue, draft.follower) === leader) {
    return { ok: false, reason: 'self-follow' };
  }
  if (draft.maxNotionalWei <= 0n) return { ok: false, reason: 'cap-not-positive' };
  if (
    !Number.isInteger(draft.slippageBps) ||
    draft.slippageBps < MIN_SLIPPAGE_BPS ||
    draft.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    return { ok: false, reason: 'slippage-out-of-range' };
  }
  if (existing.some((f) => f.leader === leader && f.quoteToken === quoteToken)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (existing.length >= MAX_FOLLOWS) return { ok: false, reason: 'too-many-follows' };

  return {
    ok: true,
    config: {
      venue,
      leader,
      quoteToken,
      maxNotionalWei: draft.maxNotionalWei,
      slippageBps: draft.slippageBps,
      createdAt: draft.now,
    },
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// bigint is not JSON, so `maxNotionalWei` travels as a decimal string. A JSON
// number would round above 2^53 and turn a cap into a slightly different cap —
// silently, and always in one direction.

interface StoredFollow {
  venue?: string;
  leader: string;
  quoteToken: string;
  maxNotionalWei: string;
  slippageBps: number;
  createdAt: number;
}

interface FollowEnvelope {
  v: 1 | 2;
  ts: number;
  follows: StoredFollow[];
}

/**
 * A stored row's venue.
 *
 * An absent value is 'evm', because every row written before v2 was one. This is
 * the whole migration and it is a default rather than a drop for one reason: a
 * dropped row is a per-trade cap the user set and this module deleted.
 */
function venueOf(raw: unknown): PoolFamily {
  return raw === 'solana' ? 'solana' : 'evm';
}

function decodeFollow(raw: unknown): FollowConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<StoredFollow>;
  const venue = venueOf(r.venue);
  if (typeof r.leader !== 'string' || !isVenueAddress(venue, r.leader)) return null;
  if (typeof r.quoteToken !== 'string') return null;
  const quote = findQuoteToken(r.quoteToken);
  if (!quote || quote.family !== venue) return null;
  if (typeof r.maxNotionalWei !== 'string' || !/^\d+$/.test(r.maxNotionalWei)) return null;
  if (typeof r.slippageBps !== 'number' || !Number.isInteger(r.slippageBps)) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  const cap = BigInt(r.maxNotionalWei);
  if (cap <= 0n) return null;
  if (r.slippageBps < MIN_SLIPPAGE_BPS || r.slippageBps > MAX_SLIPPAGE_BPS) return null;
  return {
    venue,
    leader: normaliseVenueAddress(venue, r.leader),
    quoteToken: quote.address,
    maxNotionalWei: cap,
    slippageBps: r.slippageBps,
    createdAt: r.createdAt,
  };
}

/**
 * Rows that no longer decode are DROPPED, not repaired.
 *
 * The two fields that could be "repaired" are the cap and the slippage guard,
 * and a guessed value for either is a trade sized by this module rather than by
 * the user. Dropping loses a follow, which the user can see is gone and re-enter;
 * repairing loses the user's intent while looking intact.
 */
export function loadFollows(): FollowConfig[] {
  const envelope = safeJsonParse<Partial<FollowEnvelope> | null>(safeGetItem(FOLLOWS_STORAGE_KEY), null);
  if (!envelope || !Array.isArray(envelope.follows)) return [];
  const out: FollowConfig[] = [];
  for (const row of envelope.follows) {
    const decoded = decodeFollow(row);
    if (decoded) out.push(decoded);
  }
  return out.slice(0, MAX_FOLLOWS);
}

/** False when the browser refused the write — the caller must say so, not assume it stuck. */
export function saveFollows(follows: readonly FollowConfig[], now: number): boolean {
  const envelope: FollowEnvelope = {
    v: 2,
    ts: now,
    follows: follows.slice(0, MAX_FOLLOWS).map((f) => ({
      venue: f.venue,
      leader: f.leader,
      quoteToken: f.quoteToken,
      maxNotionalWei: f.maxNotionalWei.toString(),
      slippageBps: f.slippageBps,
      createdAt: f.createdAt,
    })),
  };
  return safeSetItem(FOLLOWS_STORAGE_KEY, JSON.stringify(envelope));
}

// ─── Mirror intents ──────────────────────────────────────────────────────────

/**
 * A mirror the user confirmed — AN INTENT, NOT A FILL.
 *
 * Nothing in this repo can observe the user's transaction land; the wallet does
 * that, and the venue's own record of it arrives later through the indexer or
 * through the next read of the pool's tape. So this record deliberately carries
 * no output amount, no price and no outcome. It is the timestamped fact "the
 * user chose to mirror this leader fill", which is exactly what followerRelative
 * and tapeReconcile need to measure a real entry lag and exactly what they must
 * not be allowed to inflate into a realised return.
 */
export interface MirrorIntent {
  venue: PoolFamily;
  leader: string;
  /** The leader trade being mirrored — the join key back to the source row. */
  leaderTxHash: string;
  /** Unix seconds of the leader's trade, from the source row. */
  leaderTimestamp: number;
  /** Unix seconds when the user confirmed. Not when anything filled. */
  confirmedAt: number;
  /** The wallet that confirmed, in its venue's own form. */
  follower: string;
  quoteToken: string;
  /**
   * The token the plan was going to buy. Stored ON the intent rather than looked
   * up later: the leader's row falls out of the signal window within hours, and
   * a match rule that quietly loosens from "same pair" to "same input token" the
   * moment the source row ages out would raise the measured fill rate without
   * anything about the fills changing.
   */
  tokenOut: string;
  /** What the plan sized, in `quoteToken`'s smallest unit. */
  notionalWei: bigint;
  /**
   * `${network}:${pool}` when the source was the island tape, null when it was
   * the indexer's router feed. The tape reconciler matches inside ONE pool, so a
   * null here is a row it honestly cannot judge rather than one it judges loosely.
   */
  poolKey: string | null;
}

/** Most intents kept. Older ones fall off — this is a measurement log, not an archive. */
export const MAX_MIRROR_INTENTS = 200;

interface StoredIntent {
  venue?: string;
  leader: string;
  leaderTxHash: string;
  leaderTimestamp: number;
  confirmedAt: number;
  follower: string;
  quoteToken: string;
  tokenOut: string;
  notionalWei: string;
  poolKey?: string | null;
}

interface IntentEnvelope {
  v: 1 | 2;
  ts: number;
  intents: StoredIntent[];
}

/** A transaction hash on this venue, in the venue's own shape. */
function isVenueTxHash(venue: PoolFamily, value: string): boolean {
  return venue === 'solana' ? isSolanaSignature(value) : TX_HASH_RE.test(value.trim());
}

function decodeIntent(raw: unknown): MirrorIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<StoredIntent>;
  const venue = venueOf(r.venue);
  if (typeof r.leader !== 'string' || !isVenueAddress(venue, r.leader)) return null;
  if (typeof r.follower !== 'string' || !isVenueAddress(venue, r.follower)) return null;
  if (typeof r.quoteToken !== 'string' || !isVenueAddress(venue, r.quoteToken)) return null;
  if (typeof r.tokenOut !== 'string' || !isVenueAddress(venue, r.tokenOut)) return null;
  if (typeof r.leaderTxHash !== 'string' || !isVenueTxHash(venue, r.leaderTxHash)) return null;
  if (typeof r.leaderTimestamp !== 'number' || !Number.isFinite(r.leaderTimestamp)) return null;
  if (typeof r.confirmedAt !== 'number' || !Number.isFinite(r.confirmedAt)) return null;
  if (typeof r.notionalWei !== 'string' || !/^\d+$/.test(r.notionalWei)) return null;
  return {
    venue,
    leader: normaliseVenueAddress(venue, r.leader),
    // A Solana signature is case-sensitive base58; lowercasing it makes a link
    // that resolves to nothing. Only hex is normalised.
    leaderTxHash: venue === 'solana' ? r.leaderTxHash.trim() : r.leaderTxHash.toLowerCase(),
    leaderTimestamp: r.leaderTimestamp,
    confirmedAt: r.confirmedAt,
    follower: normaliseVenueAddress(venue, r.follower),
    quoteToken: normaliseVenueAddress(venue, r.quoteToken),
    tokenOut: normaliseVenueAddress(venue, r.tokenOut),
    notionalWei: BigInt(r.notionalWei),
    poolKey: typeof r.poolKey === 'string' && r.poolKey.length > 0 ? r.poolKey : null,
  };
}

export function loadMirrorIntents(): MirrorIntent[] {
  const envelope = safeJsonParse<Partial<IntentEnvelope> | null>(safeGetItem(MIRRORS_STORAGE_KEY), null);
  if (!envelope || !Array.isArray(envelope.intents)) return [];
  const out: MirrorIntent[] = [];
  for (const row of envelope.intents) {
    const decoded = decodeIntent(row);
    if (decoded) out.push(decoded);
  }
  return out.slice(0, MAX_MIRROR_INTENTS);
}

export function saveMirrorIntents(intents: readonly MirrorIntent[], now: number): boolean {
  const envelope: IntentEnvelope = {
    v: 2,
    ts: now,
    intents: intents.slice(0, MAX_MIRROR_INTENTS).map((i) => ({
      venue: i.venue,
      leader: i.leader,
      leaderTxHash: i.leaderTxHash,
      leaderTimestamp: i.leaderTimestamp,
      confirmedAt: i.confirmedAt,
      follower: i.follower,
      quoteToken: i.quoteToken,
      tokenOut: i.tokenOut,
      notionalWei: i.notionalWei.toString(),
      poolKey: i.poolKey,
    })),
  };
  return safeSetItem(MIRRORS_STORAGE_KEY, JSON.stringify(envelope));
}

/** Newest first, and one intent per leader transaction — a double-confirm is one mirror. */
export function addMirrorIntent(
  existing: readonly MirrorIntent[],
  intent: MirrorIntent,
): MirrorIntent[] {
  const deduped = existing.filter(
    (i) => !(i.leaderTxHash === intent.leaderTxHash && i.follower === intent.follower),
  );
  return [intent, ...deduped].slice(0, MAX_MIRROR_INTENTS);
}
