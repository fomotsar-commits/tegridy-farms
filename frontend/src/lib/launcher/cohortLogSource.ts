// The log half of `readOurLaunches`, served from our own backend.
//
// `readOurLaunches` needs every Airlock `Create` since block 21,000,000 — millions of
// blocks. Every RPC the browser can reach refuses that range (publicnode: "Archive requests
// require a personal token"; drpc: "ranges over 10000 blocks are not supported"; our own
// api/alchemy.js caps the delta at 10,000 by audit R049 H-5, a cap worth keeping). So the
// cohort surfaces rendered permanently empty — not "nothing launched", but "we never asked".
//
// This wraps a viem client so its `getLogs` comes from `?resource=launch-cohort` instead,
// while every other method (notably `multicall`, which does the per-asset provenance read)
// passes straight through. `ourLaunches.ts` therefore needs no change and stays the single
// implementation of what counts as ours.

import type { Address, PublicClient } from 'viem';

export interface CohortLogSourceOptions {
  signal?: AbortSignal;
  /** Overridable for tests. */
  endpoint?: string;
}

const ENDPOINT = '/api/aggregator?resource=launch-cohort';
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Thrown when the launch history could not be READ. Distinct from "there are none". */
export class CohortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortUnavailableError';
  }
}

/**
 * Fetch the Airlock-created asset list. THROWS when the history is unreadable — it must
 * never return `[]` for a failure, because the caller renders an empty cohort as "nothing
 * has launched yet", which would be a fabricated track record.
 */
export async function fetchCohortAssets(opts: CohortLogSourceOptions = {}): Promise<Address[]> {
  let res: Response;
  try {
    res = await fetch(opts.endpoint ?? ENDPOINT, { signal: opts.signal });
  } catch (e) {
    throw new CohortUnavailableError(`launch history request failed: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) throw new CohortUnavailableError(`launch history unavailable (HTTP ${res.status})`);

  const body: unknown = await res.json().catch(() => null);
  const assets = (body as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) throw new CohortUnavailableError('launch history returned no asset list');

  const out: Address[] = [];
  for (const a of assets) {
    if (typeof a === 'string' && ETH_ADDRESS_RE.test(a)) out.push(a as Address);
  }
  // A non-empty upstream list that decodes to nothing is corruption, not an empty cohort.
  if (assets.length > 0 && out.length === 0) {
    throw new CohortUnavailableError('launch history was unreadable');
  }
  return out;
}

/**
 * A client whose `getLogs` is backed by {@link fetchCohortAssets}, shaped as the minimal
 * `{ args: { asset } }` records `readOurLaunches` consumes. Everything else delegates.
 */
export function cohortLogClient(client: PublicClient, opts: CohortLogSourceOptions = {}): PublicClient {
  const getLogs = async () => {
    const assets = await fetchCohortAssets(opts);
    return assets.map((asset) => ({ args: { asset } }));
  };
  // Proxy rather than object-spread: a viem client carries its methods on a prototype
  // chain and behind getters, and a spread would silently drop `multicall`.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'getLogs') return getLogs;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as PublicClient;
}
