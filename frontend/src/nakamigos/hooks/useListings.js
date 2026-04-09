import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchListings } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";
import { listingsQuery, queryKeys } from "../lib/queryConfig";

export default function useListings() {
  const collection = useActiveCollection();
  const slug = collection.openseaSlug || collection.slug;

  const { data, isLoading, error, dataUpdatedAt, refetch } = useQuery({
    queryKey: queryKeys.listings(slug),
    queryFn: ({ signal }) => fetchListings(slug, { signal }),
    ...listingsQuery,
    enabled: !!slug,
    // When the slug changes, show loading state immediately instead of
    // keeping stale data from the previous collection.
    placeholderData: undefined,
  });

  // Preserve the exact return shape expected by consumers (App.jsx, etc.)
  return useMemo(() => ({
    listings: data?.listings ?? [],
    listingsLoading: isLoading,
    listingsError: data?.error ?? (error ? "Listing data temporarily unavailable. Please try again shortly." : null),
    listingsSource: data?.source ?? null,
    hasRealListings: (data?.listings?.length ?? 0) > 0,
    refreshListings: refetch,
    lastRefresh: dataUpdatedAt || null,
  }), [data, isLoading, error, dataUpdatedAt, refetch]);
}
