import { BUNGALOWS } from '../../bungalows';

/**
 * The tokens with a room on this site whose mint is on Solana, by the addresses in the
 * site's own registry (lib/bungalows.ts). A phone has no token address to paste: these
 * are picked by a press, and what is looked up is the address, never the name. The
 * Pools tab's finder and the Range tab both offer them.
 */
export function siteTokens(roomId: string | null): { id: string; symbol: string; mint: string }[] {
  const all = BUNGALOWS.flatMap((b) => (b.chain === 'solana' && b.address ? [{ id: b.id, symbol: b.symbol, mint: b.address }] : []));
  // The visitor's own room first.
  return [...all.filter((t) => t.id === roomId), ...all.filter((t) => t.id !== roomId)];
}
