// Coins with no room on the island that the dashboard still lists and pictures (owner, 2026-11-01:
// the BIG BRAIN pool showed a bare green square, and the BIG BRAIN the wallet held was not listed).
// Each is pinned by its whole address. Its name is still the ticker it gives itself (identity.ts
// tokenTicker), so this list decides only which coins the holdings read and the picture each shows.
import type { DoorArt } from '../doorArt';
import type { WalletChain } from './walletRows';

export interface OffIslandCoin {
  chain: WalletChain;
  address: string;
  art: DoorArt;
}

export const OFF_ISLAND_COINS: readonly OffIslandCoin[] = [
  // BIG BRAIN, paired with SOL on the venue in pool 3YRW6wJscukRaWutB6QgPwtK1EQM9KA7CXcXTtmN3GJK. The owner's pick of picture.
  { chain: 'solana', address: 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump', art: { src: '/art/bobo/865DB7B3-E24E-452B-9358-36CBC610180E.jpg' } },
];

export function offIslandCoinsOn(chain: WalletChain, coins: readonly OffIslandCoin[] = OFF_ISLAND_COINS): OffIslandCoin[] {
  return coins.filter((c) => c.chain === chain);
}

/** The picture for a coin on this list; null for any other coin, or none named. */
export function offIslandArt(chain: string, address: string | undefined): DoorArt | null {
  return OFF_ISLAND_COINS.find((c) => c.chain === chain && c.address === address)?.art ?? null;
}
