// ═══ TanStack Query cache configurations per data type ═══
// Centralized so every hook uses consistent, tuned settings.

/** NFT metadata — rarely changes, cache aggressively */
export const nftMetadataQuery = {
  staleTime: Infinity,
  gcTime: 24 * 60 * 60_000, // 24 hours
  refetchOnWindowFocus: false,
  retry: 2,
};

/** Floor price — moves fast, keep fresh */
export const floorPriceQuery = {
  staleTime: 30_000,           // 30 seconds
  refetchInterval: 60_000,     // poll every 60 seconds
  refetchOnWindowFocus: false,
  retry: 2,
};

/** Active listings — moderate freshness */
export const listingsQuery = {
  staleTime: 2 * 60_000,       // 2 minutes
  refetchInterval: 5 * 60_000, // poll every 5 minutes
  gcTime: 15 * 60_000,
  refetchOnWindowFocus: false,
  retry: 2,
};

/** Collection stats (owners, volume, supply) */
export const collectionStatsQuery = {
  staleTime: 5 * 60_000,        // 5 minutes
  refetchInterval: 10 * 60_000, // poll every 10 minutes
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
  retry: 2,
};

/** Owned NFTs — invalidate on mutation rather than polling */
export const ownedNftsQuery = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
  retry: 2,
};

/** Offers (collection & trait) — OpenSea is heavily rate-limited, avoid redundant refetches */
export const offersQuery = {
  staleTime: 2 * 60_000,   // 2 minutes (was 30s — too aggressive for rate-limited API)
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  retry: 2,
};

// ═══ Query key factories ═══
// Structured keys make targeted invalidation easy.
export const queryKeys = {
  listings: (slug) => ["listings", slug],
  collectionOffers: (slug) => ["collection-offers", slug],
  traitOffers: (slug) => ["trait-offers", slug],
  collectionStats: (slug) => ["collection-stats", slug],
  ownedNfts: (wallet, contract) => ["owned-nfts", wallet, contract],
  nftMetadata: (contract, tokenId) => ["nft-metadata", contract, tokenId],
};
