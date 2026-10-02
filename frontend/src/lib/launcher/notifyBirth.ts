// The one call a launch path makes to announce a birth: a launch result becomes the six
// fields the island's socket wants (birthNotify.ts queues them, births.js signs them).
// birth_block is read from the receipt, since both SDKs return only a hash. A holder's
// clock starts at their first hold, so the birth block is the zero point of every degree
// the token will ever earn: an unreadable block queues nothing, never a wall-clock guess.

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

/** The origin the island fetches `record_url` from: configuration, never
 *  window.location.origin, which on a preview or localhost would publish a dead URL the
 *  island stores permanently. */
export function recordOrigin(explicit?: string): string {
  if (explicit) return explicit;
  const configured = (import.meta.env.VITE_CANONICAL_ORIGIN as string | undefined)?.trim();
  // The fallback is SITE_URL's value (src/lib/constants.ts), the venue's canonical host.
  return configured || 'https://memetics.finance';
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

/** Announce a birth: resolve the block, build the six fields, queue them, kick a flush.
 *  Never throws and never blocks a launch; callers fire it with `void`. */
export async function notifyBirth(input: NotifyBirthInput): Promise<NotifyOutcome> {
  try {
    const birthBlock =
      input.chain === 'solana' ? (input.slot ?? null) : await readBirthBlock(input.publicClient, input.txHash);

    // The two facts the socket rejects without; neither is ever fabricated.
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
