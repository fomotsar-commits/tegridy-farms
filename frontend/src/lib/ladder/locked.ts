// How much is locked in the island's lock ladder, for the home's strip. Loaded by a
// dynamic import, so the home's chunk does not carry @solana/web3.js
// (scripts/check-dist-graph.mjs).
import { Connection, PublicKey } from '@solana/web3.js';
import { BUNGALOWS } from '../bungalows';
import { solanaRpcEndpoint } from '../solana';
import { isLadderConfigured, ladderProgramId } from './program';
import { readLadderPool } from './read';

/**
 * BAYLA's ladder pool's total principal, as the pool account holds it, or null when the ladder
 * is not configured for this deployment or could not be read. BAYLA's by name: the strip counts
 * the island's coin, and since 2026-10-31 other rooms have ladders too.
 */
export async function readLadderLocked(): Promise<{ symbol: string; raw: bigint; decimals: number } | null> {
  const room = BUNGALOWS.find((b) => b.id === 'bayla' && b.live && b.ladderPool);
  if (!room?.ladderPool || !isLadderConfigured()) return null;
  try {
    const conn = new Connection(solanaRpcEndpoint(), 'confirmed');
    const r = await readLadderPool(conn, ladderProgramId(), new PublicKey(room.ladderPool));
    return r.ok ? { symbol: room.symbol, raw: r.value.totalPrincipalRaw, decimals: r.value.decimals } : null;
  } catch {
    return null;
  }
}
