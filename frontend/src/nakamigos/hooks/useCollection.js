import { useState, useEffect, useMemo } from "react";
import { fetchCollectionStats, fetchActivity } from "../api";
import { FALLBACK_STATS, DEFAULT_COLLECTION } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import useActivityWebSocket from "./useActivityWebSocket";
import useOpenSeaStream from "./useOpenSeaStream";

// Poll every 5 minutes when WebSocket is connected, 60s otherwise
const POLL_INTERVAL_WS = 300000;
const POLL_INTERVAL_FALLBACK = 60000;

const EMPTY_STATS = { floor: null, volume: null, owners: null, supply: null };

export default function useCollection() {
  const collection = useActiveCollection();
  // Only use Nakamigos fallback stats for Nakamigos; other collections start empty
  const [stats, setStats] = useState(
    collection.slug === DEFAULT_COLLECTION ? FALLBACK_STATS : EMPTY_STATS
  );
  const [activities, setActivities] = useState([]);
  const [activitiesLoading, setActivitiesLoading] = useState(true); // true until first fetch completes
  const [activitiesEmpty, setActivitiesEmpty] = useState(false); // true when API returned 0 sales (not an error)
  const [isLive, setIsLive] = useState(false);

  // OpenSea Stream — real-time marketplace events (listings, sales, bids, cancellations)
  const openSea = useOpenSeaStream(collection.openseaSlug);

  // Flatten all OpenSea event categories into a single array for merging
  const allOpenSeaEvents = useMemo(
    () => [...openSea.listings, ...openSea.sales, ...openSea.bids, ...openSea.cancellations],
    [openSea.listings, openSea.sales, openSea.bids, openSea.cancellations]
  );

  // Alchemy WebSocket (on-chain transfers) — now also merges OpenSea events
  const { liveActivities, isWebSocketConnected } = useActivityWebSocket(
    collection.contract,
    allOpenSeaEvents
  );

  // Reset stats when switching collections so stale data doesn't bleed across
  useEffect(() => {
    setStats(collection.slug === DEFAULT_COLLECTION ? FALLBACK_STATS : EMPTY_STATS);
    setActivities([]);
    setActivitiesLoading(true);
    setActivitiesEmpty(false);
    setIsLive(false);
  }, [collection.slug]);

  useEffect(() => {
    const controller = new AbortController();
    const { contract, slug, openseaSlug } = collection;

    async function load() {
      try {
        const signal = controller.signal;
        const [statsData, actData] = await Promise.all([
          fetchCollectionStats({ contract, slug, openseaSlug, signal }),
          fetchActivity({ contract, limit: 50, signal }),
        ]);

        if (controller.signal.aborted) return;

        // Ensure supply always falls back to the collection config value
        setStats({
          ...statsData,
          supply: statsData.supply ?? collection.supply ?? null,
        });
        setActivities(actData.activities || []);
        setActivitiesLoading(false);
        setActivitiesEmpty(!!actData.empty);
        setIsLive(!statsData.fallback && !actData.fallback);
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) return;
        console.warn("useCollection: Failed to load data:", err);
      }
    }

    load();

    const interval = isWebSocketConnected ? POLL_INTERVAL_WS : POLL_INTERVAL_FALLBACK;
    const iv = setInterval(load, interval);
    return () => {
      controller.abort();
      clearInterval(iv);
    };
    // Use primitive deps so the effect re-runs exactly when collection identity
    // or WS status changes — avoids coupling to object reference stability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWebSocketConnected, collection.slug, collection.contract, collection.openseaSlug]);

  // Merge live WebSocket activities with polled activities
  const mergedActivities = useMemo(() => {
    if (liveActivities.length === 0) return activities;

    // Build a set of existing tx hashes to avoid duplicates
    const existingKeys = new Set(
      activities
        .filter((a) => a.hash)
        .map((a) => `${a.hash}-${a.token?.id}`)
    );

    // Filter out live activities that already exist in polled data
    const newLive = liveActivities.filter(
      (a) => !existingKeys.has(`${a.hash}-${a.token?.id}`)
    );

    if (newLive.length === 0) return activities;

    // Prepend new live activities, cap at 500 to prevent unbounded growth
    return [...newLive, ...activities].slice(0, 500);
  }, [activities, liveActivities]);

  return useMemo(() => ({
    stats,
    activities: mergedActivities,
    activitiesLoading,
    activitiesEmpty,
    isLive,
    isWebSocketConnected,
    isOpenSeaConnected: openSea.isConnected,
  }), [stats, mergedActivities, activitiesLoading, activitiesEmpty, isLive, isWebSocketConnected, openSea.isConnected]);
}
