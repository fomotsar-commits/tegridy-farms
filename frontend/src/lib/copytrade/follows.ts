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

import { safeGetItem, safeJsonParse, safeSetItem } from '../storage';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export const FOLLOWS_STORAGE_KEY = 'tegridy_copytrade_follows';
export const MIRRORS_STORAGE_KEY = 'tegridy_copytrade_mirrors';

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
  /** Wallet whose venue-routed swaps this follow watches. Lowercased. */
  leader: string;
  /**
   * The ONLY token a mirror will size from. A leader swap whose `tokenIn` is not
   * this token is refused rather than converted: the indexer stores amounts in
   * each token's own smallest unit and carries no price, so "cap this trade at
   * 0.5 ETH" cannot be applied to a swap denominated in something else without
   * inventing a rate.
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
  | 'self-follow'
  | 'cap-not-positive'
  | 'slippage-out-of-range'
  | 'duplicate'
  | 'too-many-follows';

export const FOLLOW_REJECTION_TEXT: Record<FollowRejection, string> = {
  'bad-leader': 'A leader must be a 20-byte hex address.',
  'bad-quote-token': 'The quote token must be a 20-byte hex address.',
  'self-follow': 'A wallet cannot follow itself — mirroring your own trades would double them.',
  'cap-not-positive': 'A per-trade cap of zero would size every mirror at nothing.',
  'slippage-out-of-range': `A slippage guard must be between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} basis points. Above that it is not a guard.`,
  duplicate: 'This wallet is already followed on this quote token.',
  'too-many-follows': `This browser holds at most ${MAX_FOLLOWS} follows.`,
};

export interface FollowDraft {
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
  if (!ADDRESS_RE.test(draft.leader)) return { ok: false, reason: 'bad-leader' };
  if (!ADDRESS_RE.test(draft.quoteToken)) return { ok: false, reason: 'bad-quote-token' };

  const leader = draft.leader.toLowerCase();
  const quoteToken = draft.quoteToken.toLowerCase();

  if (draft.follower && draft.follower.toLowerCase() === leader) return { ok: false, reason: 'self-follow' };
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
    config: { leader, quoteToken, maxNotionalWei: draft.maxNotionalWei, slippageBps: draft.slippageBps, createdAt: draft.now },
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// bigint is not JSON, so `maxNotionalWei` travels as a decimal string. A JSON
// number would round above 2^53 and turn a cap into a slightly different cap —
// silently, and always in one direction.

interface StoredFollow {
  leader: string;
  quoteToken: string;
  maxNotionalWei: string;
  slippageBps: number;
  createdAt: number;
}

interface FollowEnvelope {
  v: 1;
  ts: number;
  follows: StoredFollow[];
}

function decodeFollow(raw: unknown): FollowConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<StoredFollow>;
  if (typeof r.leader !== 'string' || !ADDRESS_RE.test(r.leader)) return null;
  if (typeof r.quoteToken !== 'string' || !ADDRESS_RE.test(r.quoteToken)) return null;
  if (typeof r.maxNotionalWei !== 'string' || !/^\d+$/.test(r.maxNotionalWei)) return null;
  if (typeof r.slippageBps !== 'number' || !Number.isInteger(r.slippageBps)) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  const cap = BigInt(r.maxNotionalWei);
  if (cap <= 0n) return null;
  if (r.slippageBps < MIN_SLIPPAGE_BPS || r.slippageBps > MAX_SLIPPAGE_BPS) return null;
  return {
    leader: r.leader.toLowerCase(),
    quoteToken: r.quoteToken.toLowerCase(),
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
    v: 1,
    ts: now,
    follows: follows.slice(0, MAX_FOLLOWS).map((f) => ({
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
 * that, and the venue's own record of it arrives later through the indexer. So
 * this record deliberately carries no output amount, no price and no outcome. It
 * is the timestamped fact "the user chose to mirror this leader trade", which is
 * exactly what followerRelative.ts needs to measure a real entry lag and exactly
 * what it must not be allowed to inflate into a realised return.
 */
export interface MirrorIntent {
  leader: string;
  /** The leader swap being mirrored — the join key back to the indexed row. */
  leaderTxHash: string;
  /** Unix seconds of the leader's swap, from the indexed row. */
  leaderTimestamp: number;
  /** Unix seconds when the user confirmed. Not when anything filled. */
  confirmedAt: number;
  /** The wallet that confirmed. Lowercased. */
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
}

/** Most intents kept. Older ones fall off — this is a measurement log, not an archive. */
export const MAX_MIRROR_INTENTS = 200;

interface StoredIntent {
  leader: string;
  leaderTxHash: string;
  leaderTimestamp: number;
  confirmedAt: number;
  follower: string;
  quoteToken: string;
  tokenOut: string;
  notionalWei: string;
}

interface IntentEnvelope {
  v: 1;
  ts: number;
  intents: StoredIntent[];
}

function decodeIntent(raw: unknown): MirrorIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<StoredIntent>;
  if (typeof r.leader !== 'string' || !ADDRESS_RE.test(r.leader)) return null;
  if (typeof r.follower !== 'string' || !ADDRESS_RE.test(r.follower)) return null;
  if (typeof r.quoteToken !== 'string' || !ADDRESS_RE.test(r.quoteToken)) return null;
  if (typeof r.tokenOut !== 'string' || !ADDRESS_RE.test(r.tokenOut)) return null;
  if (typeof r.leaderTxHash !== 'string' || !TX_HASH_RE.test(r.leaderTxHash)) return null;
  if (typeof r.leaderTimestamp !== 'number' || !Number.isFinite(r.leaderTimestamp)) return null;
  if (typeof r.confirmedAt !== 'number' || !Number.isFinite(r.confirmedAt)) return null;
  if (typeof r.notionalWei !== 'string' || !/^\d+$/.test(r.notionalWei)) return null;
  return {
    leader: r.leader.toLowerCase(),
    leaderTxHash: r.leaderTxHash.toLowerCase(),
    leaderTimestamp: r.leaderTimestamp,
    confirmedAt: r.confirmedAt,
    follower: r.follower.toLowerCase(),
    quoteToken: r.quoteToken.toLowerCase(),
    tokenOut: r.tokenOut.toLowerCase(),
    notionalWei: BigInt(r.notionalWei),
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
    v: 1,
    ts: now,
    intents: intents.slice(0, MAX_MIRROR_INTENTS).map((i) => ({
      leader: i.leader,
      leaderTxHash: i.leaderTxHash,
      leaderTimestamp: i.leaderTimestamp,
      confirmedAt: i.confirmedAt,
      follower: i.follower,
      quoteToken: i.quoteToken,
      tokenOut: i.tokenOut,
      notionalWei: i.notionalWei.toString(),
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
