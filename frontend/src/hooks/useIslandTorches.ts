import { useEffect, useState } from 'react';
import { fetchIslandTorches, type IslandTorches } from '../lib/heat/torchesClient';

/**
 * The island's torches, read once on mount (lib/heat/torchesClient.ts). Null until a read
 * lands, and null for good when nothing could be read: a surface on it renders nothing
 * then, never an error card and never a zero.
 */
export function useIslandTorches(): IslandTorches | null {
  const [data, setData] = useState<IslandTorches | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    fetchIslandTorches({ signal: ac.signal })
      .then((d) => { if (live) setData(d); })
      .catch(() => { /* unread: stay empty */ });
    return () => {
      live = false;
      ac.abort();
    };
  }, []);
  return data;
}
