import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fulfillSeaportOrder } from "../api";
import { cancelOrder, createItemOffer, createCollectionOffer, createTraitOffer, acceptOffer } from "../api-offers";
import { queryKeys } from "../lib/queryConfig";

/**
 * Purchase an NFT via Seaport fulfillment.
 * On success, invalidates listings and owned-NFT queries.
 */
export function useBuyNft({ slug, wallet, contract } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (listing) => fulfillSeaportOrder(listing),
    onMutate: async (listing) => {
      // Optimistic: remove the purchased listing from cache
      if (!slug) return;
      await qc.cancelQueries({ queryKey: queryKeys.listings(slug) });
      const prev = qc.getQueryData(queryKeys.listings(slug));
      if (prev?.listings) {
        qc.setQueryData(queryKeys.listings(slug), {
          ...prev,
          listings: prev.listings.filter((l) => l.tokenId !== listing.tokenId),
        });
      }
      return { prev };
    },
    onError: (_err, _listing, ctx) => {
      // Roll back optimistic update
      if (ctx?.prev && slug) {
        qc.setQueryData(queryKeys.listings(slug), ctx.prev);
      }
    },
    onSettled: () => {
      // Refetch to get the true server state
      if (slug) qc.invalidateQueries({ queryKey: queryKeys.listings(slug) });
      if (wallet && contract) {
        qc.invalidateQueries({ queryKey: queryKeys.ownedNfts(wallet, contract) });
      }
    },
  });
}

/**
 * Cancel an order (listing or bid).
 * On success, invalidates listings and offers.
 */
export function useCancelOrder({ slug } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order) => cancelOrder(order),
    onSettled: () => {
      if (slug) {
        qc.invalidateQueries({ queryKey: queryKeys.listings(slug) });
        qc.invalidateQueries({ queryKey: queryKeys.collectionOffers(slug) });
        qc.invalidateQueries({ queryKey: queryKeys.traitOffers(slug) });
      }
    },
  });
}

/**
 * Create an item-level offer (bid on a specific NFT).
 */
export function useCreateItemOffer({ slug } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params) => createItemOffer(params),
    onSettled: () => {
      if (slug) {
        qc.invalidateQueries({ queryKey: queryKeys.collectionOffers(slug) });
      }
    },
  });
}

/**
 * Create a collection-wide offer.
 */
export function useCreateCollectionOffer({ slug } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params) => createCollectionOffer(params),
    onSettled: () => {
      if (slug) {
        qc.invalidateQueries({ queryKey: queryKeys.collectionOffers(slug) });
      }
    },
  });
}

/**
 * Create a trait-specific offer.
 */
export function useCreateTraitOffer({ slug } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params) => createTraitOffer(params),
    onSettled: () => {
      if (slug) {
        qc.invalidateQueries({ queryKey: queryKeys.traitOffers(slug) });
      }
    },
  });
}

/**
 * Accept an incoming offer (sell your NFT to a bidder).
 */
export function useAcceptOffer({ slug, wallet, contract } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (offer) => acceptOffer(offer),
    onSettled: () => {
      if (slug) {
        qc.invalidateQueries({ queryKey: queryKeys.listings(slug) });
        qc.invalidateQueries({ queryKey: queryKeys.collectionOffers(slug) });
      }
      if (wallet && contract) {
        qc.invalidateQueries({ queryKey: queryKeys.ownedNfts(wallet, contract) });
      }
    },
  });
}
