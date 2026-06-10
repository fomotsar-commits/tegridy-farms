import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveCollection } from "../contexts/CollectionContext";
import { fetchCollectionOffers, deriveTraitOffers } from "../api-offers";
import { offersQuery, queryKeys } from "../lib/queryConfig";

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

// Trait offers are derived from the same `offers/collection/{slug}/all` feed
// that powers useCollectionOffers — one network call serves both panels
// (React Query dedupes on the shared key).
export function useTraitOffers() {
  const query = useCollectionOffers();
  const data = useMemo(() => deriveTraitOffers(query.data || []), [query.data]);
  return { ...query, data };
}
