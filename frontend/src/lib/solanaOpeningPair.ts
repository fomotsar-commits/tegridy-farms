// What /solana opens buying. $BAYLA first (the owner, 2026-10-03): a link's own ?out=
// wins, then the Solana room the visitor is in, then $BAYLA.
import { BAYLA_MINT, type Bungalow } from './bungalows';
import { looksLikeMint, USDC } from './solanaTokenList';

export function openingBuyMint(search: string, room: Pick<Bungalow, 'chain' | 'address'> | null): string {
  const params = new URLSearchParams(search);
  const out = params.get('out')?.trim();
  if (out && looksLikeMint(out)) return out;
  const coin = room?.chain === 'solana' && room.address ? room.address : BAYLA_MINT;
  // A link that pays WITH that coin buys USDC, as it did before: never a pair of one coin.
  return params.get('in')?.trim() === coin ? USDC.mint : coin;
}
