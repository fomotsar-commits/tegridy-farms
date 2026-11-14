// The NFTs a wallet holds from one lending collection, for the Borrow tab's picker.
//
// Read through the marketplace's own Alchemy walk (nakamigos/api.js fetchWalletNfts, proxied
// by api/alchemy.js). An indexer lags the chain, so this list only OFFERS tokens to pick: the
// Borrow tab still reads ownerOf on the loan's chain before it shows a button. A walk that
// did not finish says so (`complete: false`) and the typed token ID box stays as the way in.
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

export interface WalletNft {
  /** Token id, decimal. */
  id: string;
  image: string | null;
}

export interface WalletNfts {
  tokens: WalletNft[];
  /** False when the walk failed part-way or hit its page cap: `tokens` is then a partial set. */
  complete: boolean;
}

// Two pages = 200 tokens of one collection: enough to pick from, and two proxied calls at most.
const MAX_PAGES = 2;

export async function fetchWalletCollectionNfts(wallet: Address, collection: Address): Promise<WalletNfts> {
  const { fetchWalletNfts } = await import('../../nakamigos/api.js');
  // No metadata base: an image is shown only when the indexer returned one.
  const out = (await fetchWalletNfts(wallet, collection, '', { maxPages: MAX_PAGES })) as {
    tokens?: { id?: unknown; image?: unknown }[];
    complete?: boolean;
    error?: unknown;
  };
  const tokens: WalletNft[] = [];
  for (const t of out.tokens ?? []) {
    const id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id) : '';
    if (!/^\d{1,78}$/.test(id)) continue;
    tokens.push({ id, image: typeof t.image === 'string' && t.image ? t.image : null });
  }
  if (out.error && tokens.length === 0) throw new Error('Could not read the wallet');
  return { tokens, complete: out.complete === true && !out.error };
}

export function useWalletCollectionNfts(wallet: Address | undefined, collection: Address, enabled: boolean) {
  return useQuery({
    queryKey: ['gondi-wallet-nfts', wallet ?? 'none', collection.toLowerCase()],
    queryFn: () => fetchWalletCollectionNfts(wallet!, collection),
    enabled: enabled && !!wallet,
    staleTime: 60_000,
    retry: false,
  });
}
