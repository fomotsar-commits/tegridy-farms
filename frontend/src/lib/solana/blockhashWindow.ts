// Can a transaction still land? Its blockhash says, once a server that knew it says it is gone.
// A server that never saw the blockhash also answers "not valid", so a "gone" counts only from
// a server at or past the confirmed slot where one was seen valid (minContextSlot).
import type { Connection } from '@solana/web3.js';

/** A transaction's blockhash, and a confirmed slot at which the RPC said it was valid. */
export interface NoteBlockhash {
  hash: string;
  validAt: number;
}

type Rpc = Partial<Pick<Connection, 'isBlockhashValid'>>;

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const slotOf = (r: unknown): number | null => {
  const s = (r as { context?: { slot?: unknown } } | null)?.context?.slot;
  return typeof s === 'number' && Number.isSafeInteger(s) && s > 0 ? s : null;
};

/** The blockhash with the confirmed slot it was valid at, or null: not valid there, unread, or not a blockhash. */
export async function blockhashSeen(rpc: Rpc, hash: string | null | undefined): Promise<NoteBlockhash | null> {
  if (!hash || !HASH.test(hash) || !rpc.isBlockhashValid) return null;
  try {
    const r = await rpc.isBlockhashValid(hash, { commitment: 'confirmed' });
    const slot = slotOf(r);
    return r?.value === true && slot !== null ? { hash, validAt: slot } : null;
  } catch {
    return null;
  }
}

/**
 * `{ gone: slot }`: a confirmed bank at `slot`, after one where it was valid, says it is too
 * old, so it can never land again; any block it landed in is at or before `slot`. 'live': it
 * can still land. null: unread, or a server behind the one that saw it, which proves nothing.
 */
export async function blockhashGone(rpc: Rpc, bh: NoteBlockhash): Promise<{ gone: number } | 'live' | null> {
  if (!rpc.isBlockhashValid) return null;
  try {
    const r = await rpc.isBlockhashValid(bh.hash, { commitment: 'confirmed', minContextSlot: bh.validAt });
    const slot = slotOf(r);
    if (slot === null || slot < bh.validAt) return null;
    return r.value === false ? { gone: slot } : r.value === true ? 'live' : null;
  } catch {
    return null;
  }
}

/** The blockhash a built transaction carries, or null when it cannot be read. */
export function recentBlockhashOf(tx: unknown): string | null {
  try {
    const h = (tx as { message?: { recentBlockhash?: unknown } } | null)?.message?.recentBlockhash;
    return typeof h === 'string' && HASH.test(h) ? h : null;
  } catch {
    return null;
  }
}
