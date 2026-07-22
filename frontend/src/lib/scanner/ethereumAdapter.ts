// Ethereum data adapter for the public token scanner.
//
// Reads an ERC-20's top holders + supply through a NEW normalized route on the
// existing developer-API catchall (/api/v1?route=erc20scan&contract=0x…). That
// route is added server-side (see the build package's integrationPatch) so the
// scanner adds ZERO new top-level serverless functions and stays under the Vercel
// function cap. The client here depends only on the STABLE shape the route emits,
// not on whatever upstream explorer the route proxies.
//
// DATA-GAP HONESTY: there is no free, keyless way to enumerate the FULL holder set
// of an arbitrary ERC-20 on the current infra (the Alchemy proxy is NFT-scoped;
// Etherscan's holder list is a paid endpoint; the Ponder indexer is not deployed).
// So this reads the TOP ~100 holders via the route's explorer backend — a partial,
// largest-first read (an upper bound on concentration), disclosed as such. If the
// route is not present or returns nothing, the adapter throws a typed ScanError and
// the UI self-gates to an honest "unavailable" state — it NEVER invents numbers.

import type { HardFacts, RawHolder, HolderCategory } from '../detection';
import { type AdapterResult, ScanError, type TokenMeta } from './scanner';

const V1_PATH = '/api/v1';

/** Stable response shape the `erc20scan` route emits (server normalizes the explorer). */
interface EthScanResponse {
  chain?: string;
  contract?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  totalSupply?: string | null; // raw base-unit integer string
  holdersCount?: number | null; // total on-chain holder count, when the explorer reports it
  source?: string | null;
  holders?: Array<{
    address?: string;
    balance?: string | number | null; // raw base units (string preferred for precision)
    isContract?: boolean;
    label?: string | null; // optional explorer label → mapped to a core category
  }>;
}

const VALID_LABELS: ReadonlySet<HolderCategory> = new Set<HolderCategory>([
  'lp',
  'cex',
  'bridge',
  'burn',
  'locker',
  'contract',
]);

/**
 * PURE: normalize the route's JSON into the detection core's input. No network,
 * no clock — unit-testable with fixtures.
 */
export function parseEthereumScan(_contract: string, json: EthScanResponse): AdapterResult {
  const rawHolders = Array.isArray(json.holders) ? json.holders : [];
  const holders: RawHolder[] = [];
  for (const h of rawHolders) {
    const address = h?.address;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const balance = toBig(h.balance);
    if (balance <= 0n) continue;
    const label = h.label && VALID_LABELS.has(h.label as HolderCategory) ? (h.label as HolderCategory) : null;
    holders.push({ address, balance, isContract: !!h.isContract, label });
  }

  if (holders.length === 0) {
    throw new ScanError('empty', 'No holder data was returned for this token.');
  }

  const totalSupply = json.totalSupply ? toBig(json.totalSupply) : undefined;
  const holdersCount = typeof json.holdersCount === 'number' ? json.holdersCount : null;

  // No free, reliable way to read mint/pause/LP-lock facts for an arbitrary ERC-20
  // here, so leave every HARD FACT unknown — unknown never fires the gate.
  const hardFacts: HardFacts = {};

  const coverage: 'full' | 'top-n' =
    holdersCount != null && holders.length >= holdersCount ? 'full' : 'top-n';

  const token: TokenMeta = {
    name: json.name ?? null,
    symbol: json.symbol ?? null,
    decimals: typeof json.decimals === 'number' ? json.decimals : null,
    holdersCount,
  };

  return {
    input: {
      holders,
      chain: 'ethereum',
      totalSupply,
      hardFacts,
      launch: { bundlesResolved: false, snipersResolved: false, tokenAgeSeconds: null },
    },
    token,
    enumeratedHolders: holders.length,
    holderCoverage: coverage,
    source: json.source ? `Ethereum explorer (${json.source}, top holders)` : 'Ethereum explorer (top holders)',
  };
}

/** Fetch + parse an ERC-20 scan through the normalized v1 route. */
export async function fetchEthereumScan(contract: string, signal?: AbortSignal): Promise<AdapterResult> {
  const url = `${V1_PATH}?route=erc20scan&contract=${encodeURIComponent(contract.toLowerCase())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  } catch {
    throw new ScanError('network', 'Could not reach the Ethereum data proxy.');
  }

  if (res.status === 429) throw new ScanError('rate-limited', 'Too many scans right now — try again in a moment.');
  // The route (or the contract allowlist that precedes it) is not yet serving
  // arbitrary ERC-20s → present this as an honest "unavailable", not a failure of
  // the token being scanned.
  if (res.status === 400 || res.status === 403 || res.status === 404 || res.status === 501) {
    throw new ScanError(
      'unavailable',
      'Ethereum token scanning is not enabled on this deployment yet (the holder-data route is unconfigured).',
    );
  }
  if (!res.ok) throw new ScanError('network', `Ethereum data proxy returned ${res.status}.`);

  let json: EthScanResponse;
  try {
    json = (await res.json()) as EthScanResponse;
  } catch {
    throw new ScanError('network', 'Ethereum data proxy returned an invalid response.');
  }
  return parseEthereumScan(contract, json);
}

/** Coerce a raw base-unit balance (string preferred; number tolerated) to bigint. */
function toBig(v: string | number | null | undefined): bigint {
  if (v == null) return 0n;
  try {
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    // Strip a possible decimal tail defensively; balances should be integer base units.
    const cleaned = (v.trim().split('.')[0] ?? '').replace(/[^0-9]/g, '');
    return cleaned ? BigInt(cleaned) : 0n;
  } catch {
    return 0n;
  }
}
