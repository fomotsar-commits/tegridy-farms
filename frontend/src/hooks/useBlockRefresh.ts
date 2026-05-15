import { useWatchBlockNumber } from 'wagmi';

/**
 * Subscribe to new blocks via wagmi's WS-driven `useWatchBlockNumber` and
 * fire `refetch()` whenever a new block lands. The substitute for wagmi
 * v1's `watch: true` flag on `useReadContract` (which was dropped in v2 —
 * see https://wagmi.sh/react/api/hooks/useReadContract#watching-for-changes).
 *
 * Pass `enabled: false` (or omit while disabled) to fully detach the
 * subscription — e.g. when the consuming hook hasn't yet got the
 * `enabled` it needs.
 *
 * P0-3 of the 30-day UX push.
 */
export function useBlockRefresh(
  refetch: () => unknown,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled !== false;
  useWatchBlockNumber({
    enabled,
    emitOnBegin: false,
    onBlockNumber: () => {
      if (!enabled) return;
      refetch();
    },
  });
}
