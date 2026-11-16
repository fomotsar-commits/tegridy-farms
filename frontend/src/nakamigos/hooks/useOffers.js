import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveCollection } from "../contexts/CollectionContext";
import { fetchCollectionOffers, fetchAllCollectionOffers, deriveTraitOffers } from "../api-offers";
import { offersQuery, queryKeys } from "../lib/queryConfig";
import { openseaTraitOffersOn } from "../constants";

export function useCollectionOffers() {
  const collection = useActiveCollection();
  const slug = collection?.slug;
  const openseaSlug = collection?.openseaSlug;
  const osSlug = openseaSlug || slug;
  return useQuery({
    queryKey: queryKeys.collectionOffers(osSlug),
    queryFn: ({ signal }) => fetchCollectionOffers(slug, { openseaSlug, signal }),
    ...offersQuery,
    enabled: !!osSlug,
  });
}

// Trait offers are derived from `offers/collection/{slug}/all`, which is NOT the
// feed useCollectionOffers reads: that one holds only bids for ANY token (see
// fetchCollectionOffers), and a trait bid is not one. `traitBidsOn` says whether
// OpenSea takes a NEW trait bid on this collection (constants.js
// OPENSEA_TRAIT_OFFERS): the trait-bid buttons that read these offers show only then.
export function useTraitOffers() {
  const collection = useActiveCollection();
  const slug = collection?.slug;
  const openseaSlug = collection?.openseaSlug;
  const osSlug = openseaSlug || slug;
  const query = useQuery({
    queryKey: queryKeys.traitOffers(osSlug),
    queryFn: ({ signal }) => fetchAllCollectionOffers(slug, { openseaSlug, signal }),
    ...offersQuery,
    enabled: !!osSlug,
  });
  const data = useMemo(() => deriveTraitOffers(query.data || []), [query.data]);
  return { ...query, data, traitBidsOn: openseaTraitOffersOn(collection) };
}
