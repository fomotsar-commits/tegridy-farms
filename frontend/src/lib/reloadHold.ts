import type { QueryClient } from '@tanstack/react-query';

// Who must not have the page reloaded under them right now. The site reloads itself in
// one place (staleBuild.ts), which asks here first: a wallet prompt left open by a reload
// can still be signed, and nothing on the new page would be watching for it.

let holds = 0;
const probes = new Set<() => boolean>();

/** Held from the wallet's turn until the transaction is answered. Returns its release. */
export function holdReload(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

/** Another record of work in flight, read at the moment a reload is wanted. */
export function addReloadProbe(probe: () => boolean): () => void {
  probes.add(probe);
  return () => {
    probes.delete(probe);
  };
}

/**
 * wagmi's own record of open wallet work, read from the app's query client: every write
 * or signature is a mutation until the wallet answers, and a sent transaction is a
 * receipt query (wagmi's `waitForTransactionReceiptQueryKey`) until it lands.
 */
export function holdReloadWhileWalletWorks(client: Pick<QueryClient, 'isMutating' | 'isFetching'>): () => void {
  return addReloadProbe(
    () => client.isMutating() > 0 || client.isFetching({ queryKey: ['waitForTransactionReceipt'] }) > 0,
  );
}

/** A probe that cannot answer counts as held: unread is never "nothing in flight". */
export function reloadHeld(): boolean {
  if (holds > 0) return true;
  for (const probe of probes) {
    try {
      if (probe()) return true;
    } catch {
      return true;
    }
  }
  return false;
}
