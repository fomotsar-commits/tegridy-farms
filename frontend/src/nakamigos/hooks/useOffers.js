import { useQuery } from "@tanstack/react-query";
import { useActiveCollection } from "../contexts/CollectionContext";
import { fetchCollectionOffers, fetchTraitOffers } from "../api-offers";
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

export function useTraitOffers() {
  const collection = useActiveCollection();
  const slug = collection?.slug;
  const openseaSlug = collection?.openseaSlug;
  const osSlug = openseaSlug || slug;
  return useQuery({
    queryKey: queryKeys.traitOffers(osSlug),
    queryFn: ({ signal }) => fetchTraitOffers(slug, { openseaSlug, signal }),
    ...offersQuery,
    enabled: !!osSlug,
  });
}
