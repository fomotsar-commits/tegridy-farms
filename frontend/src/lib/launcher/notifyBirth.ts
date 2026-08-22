// The one call a launch path makes to announce a birth.
//
// Everything hard lives elsewhere — `birthNotify.ts` owns the queue, `births.js` owns the
// signature. This module is the small, awkward middle: turning what a launch RESULT
// carries into the six fields the island's socket wants, and in particular resolving
// `birth_block`, which no launch result carries because both SDKs return a transaction
// hash rather than a receipt.
//
// ## Why birth_block is worth this trouble
//
// "The island enrols the token, anchors its birth from birth_block (CHAIN TRUTH, NEVER
// APPROXIMATED), and the next daily scan begins measuring it." Heat is time-weighted, so
// the birth block is the zero point of every degree the token will ever earn. Guessing it
// from a wall clock would mis-date the token's whole history — so if the block cannot be
// read, the notify is queued WITHOUT being sent rather than sent with a fabricated one.

import type { PublicClient } from 'viem';
import { enqueueBirth, flushBirthQueue, type BirthNotifyBody } from './birthNotify';
import { birthRecordUrl, normaliseCa, type BirthChain } from './birthRecord';

export interface NotifyBirthInput {
  chain: BirthChain;
  /** The token contract / mint. */
  ca: string;
  creator: string;
  /** EVM tx hash, or a Solana signature. */
  txHash: string | null;
  gateDecisionId: string | null;
  /** EVM only: used to read the receipt for the block number. */
  publicClient?: PublicClient | null;
  /** Solana only: the slot, when the caller already knows it. */
  slot?: number | null;
  /** Injectable for tests. */
  origin?: string;
}

/**
 * The public origin the island will fetch `record_url` from.
 *
 * `window.location.origin` is deliberately NOT used: a launch made from a preview
 * deployment or a localhost dev server would publish a record_url nobody else can
 * resolve, and the island would store that dead URL permanently. The canonical origin is
 * configuration.
 */
export function recordOrigin(explicit?: string): string {
  if (explicit) return explicit;
  const configured = (import.meta.env.VITE_CANONICAL_ORIGIN as string | undefined)?.trim();
  return configured || 'https://memetic.fun';
}

/** Read the block a transaction landed in. Null when it cannot be read — never guessed. */
async function readBirthBlock(client: PublicClient | null | undefined, txHash: string | null): Promise<number | null> {
  if (!client || !txHash) return null;
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    const n = Number(receipt.blockNumber);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export type NotifyOutcome =
  | { queued: true; body: BirthNotifyBody }
  /** Queued nothing: we could not establish a fact the socket requires. */
  | { queued: false; reason: string };

/**
 * Announce a birth. NEVER THROWS, never blocks a launch.
 *
 * Resolves the block, builds the six fields, queues them, and kicks a flush. The caller
 * fires this with `void` on its success path — the returned promise exists for tests and
 * for the ops surface, not for a UI to await.
 */
export async function notifyBirth(input: NotifyBirthInput): Promise<NotifyOutcome> {
  try {
    const birthBlock =
      input.chain === 'solana' ? (input.slot ?? null) : await readBirthBlock(input.publicClient, input.txHash);

    // The two facts the socket will reject without. Both are refusals to fabricate:
    // a wrong birth block mis-dates every degree the token will ever earn, and a missing
    // gate_decision_id breaks the link back to the decision that permitted the launch.
    if (birthBlock === null) {
      return { queued: false, reason: 'The birth block could not be read, and the island anchors births from chain truth rather than an approximation.' };
    }
    if (!input.gateDecisionId) {
      return { queued: false, reason: 'This launch carries no gate decision id, so it cannot be linked to the decision that permitted it.' };
    }

    const body: BirthNotifyBody = {
      ca: normaliseCa(input.ca, input.chain),
      chain: input.chain,
      creator: normaliseCa(input.creator, input.chain),
      birth_block: birthBlock,
      gate_decision_id: input.gateDecisionId,
      record_url: birthRecordUrl(input.chain, input.ca, recordOrigin(input.origin)),
    };

    enqueueBirth(body);
    // Fire the flush; its own failures are recorded on the queue item, not thrown.
    void flushBirthQueue().catch(() => undefined);
    return { queued: true, body };
  } catch (e) {
    // The launch has already happened. Nothing in this function may escape into its path.
    return { queued: false, reason: e instanceof Error ? e.message : 'The birth notify could not be prepared.' };
  }
}
