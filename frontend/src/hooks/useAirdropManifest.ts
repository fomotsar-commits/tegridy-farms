import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { fetchStoredProof, type ManifestStoreResult } from '../lib/merkle';

/**
 * One wallet's leaf and proof for one campaign, from the hosted manifest store.
 *
 * WHY THE ANSWER IS STORED WITH THE QUESTION IT ANSWERS:
 *   The state here is `{ key, result }`, and `result` is only exposed when its `key`
 *   still matches the campaign+wallet currently being asked about. That is not a
 *   micro-optimisation — a response that lands after the user has pasted a different
 *   campaign address would otherwise render as a verdict about the wrong campaign, and
 *   "not in this campaign" is precisely the sentence that must never be shown about a
 *   campaign nobody asked about. Comparing keys makes a stale response unrenderable
 *   rather than merely unlikely.
 *
 *   `loading` falls out of the same comparison: a question with no matching answer yet
 *   is in flight, so there is no separate flag that could disagree with the data.
 *
 * WHY `result` IS NULL RATHER THAN AN EMPTY SHAPE:
 *   A hook that returned a "no allocation" shape while its first request was in flight
 *   would flash "not a recipient" before the answer arrived. Null means unasked or
 *   unanswered, and the eligibility evaluator turns a null manifest into `unknown`.
 *   The hook never invents a manifest — `result.manifest` is non-null only for the two
 *   statuses that mean a list was genuinely read. See src/lib/merkle/manifestStore.ts
 *   for the full degradation contract.
 */

export interface AirdropManifestState {
  /** The store's answer to the CURRENT question, or `null` while there isn't one. */
  result: ManifestStoreResult | null;
  loading: boolean;
  /** Re-ask. Used after a claim lands and after the creator attaches a distributor. */
  refetch: () => void;
}

export function useAirdropManifest(
  campaign: { chainId: number; distributor?: Address | null; root?: Hex | null } | null,
  account: Address | null,
): AirdropManifestState {
  const [answered, setAnswered] = useState<{ key: string; result: ManifestStoreResult } | null>(null);
  const [nonce, setNonce] = useState(0);

  const chainId = campaign?.chainId ?? null;
  const distributor = campaign?.distributor ?? null;
  const root = campaign?.root ?? null;

  // Null whenever there is nothing to ask. Every input that changes the answer is in
  // here, so a change to any of them invalidates the previous answer by construction.
  const key =
    chainId !== null && (distributor || root) && account
      ? `${chainId}|${distributor ?? ''}|${root ?? ''}|${account}|${nonce}`
      : null;

  useEffect(() => {
    if (!key || chainId === null || !account) return;
    const controller = new AbortController();
    void fetchStoredProof({ chainId, distributor, root }, account, { signal: controller.signal })
      .then((result) => setAnswered({ key, result }))
      .catch(() => {
        // fetchStoredProof converts every network failure into a status of its own, so
        // reaching here means something above it threw. Deliberately records nothing:
        // no answer is honest, and a synthesised empty one is the bug this file guards.
      });
    return () => controller.abort();
  }, [key, chainId, distributor, root, account]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const result = answered && answered.key === key ? answered.result : null;
  return { result, loading: key !== null && result === null, refetch };
}
