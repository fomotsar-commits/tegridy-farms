// Deployer launch discovery — the PURE, network-free mapper that turns an
// Etherscan `account/txlist` response into the set of contracts an address
// deployed DIRECTLY, plus the LaunchBaseline[] the outcomes-enrichment path
// consumes.
//
// WHY THIS SHAPE (and its honest limit):
//   A contract-creation transaction from an EOA has an empty `to` and a
//   populated `contractAddress` (the freshly deployed address). Those are the
//   only creations visible in the EOA's own txlist. Tokens minted by a FACTORY
//   contract are created inside an internal call whose `from` is the factory —
//   they are NOT in this list, and the free RPC/Etherscan surface cannot map
//   them back to the human deployer without a deployed event index. So this
//   mapper is a FLOOR on what an address launched (direct deploys), never the
//   full picture; the gap is disclosed loudly by summarizeDeployer().
//
// PURITY: no I/O, no clock. A caller does the /api/etherscan fetch and hands the
// parsed JSON here, keeping this unit-testable against fixtures and adding zero
// serverless functions (see api/SERVERLESS_BUDGET.md). Every field is
// hostile-JSON-safe: unparseable values are dropped, never trusted.

import type { Address } from 'viem';
import type { LaunchBaseline } from '../launcher/outcomesReader';

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** One created contract discovered from a deployer's tx history. */
export interface CreatedContract {
  /** The deployed contract address (lowercased). */
  address: Address;
  /** Unix seconds the creation transaction was mined, or 0 when unknown. */
  createdAt: number;
  /** The creation transaction hash, when present. */
  txHash: string | null;
}

export interface DiscoveryResult {
  /** Direct creations, newest-first, de-duped by address, capped at `maxCreations`. */
  created: CreatedContract[];
  /**
   * True when the read could not see the full history: either the raw txlist hit
   * the explorer's row ceiling (older txs — and their creations — were dropped) or
   * more creations were found than the cap allows. Drives the low-confidence flag.
   */
  truncated: boolean;
  /** How many raw transactions were scanned (for diagnostics). */
  totalTxScanned: number;
}

export interface DiscoveryOptions {
  /** Max creations to keep (matches the enrichment adapter's MAX_BASELINES). Default 50. */
  maxCreations?: number;
  /**
   * The explorer's per-response row ceiling. When the raw result length reaches
   * this, older transactions were truncated by the explorer. Default 10000
   * (Etherscan's default page size when no offset is supplied).
   */
  txRowCeiling?: number;
}

const DEFAULT_MAX_CREATIONS = 50;
const DEFAULT_TX_ROW_CEILING = 10_000;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract the raw transaction rows from an Etherscan envelope (or a bare array). */
function extractRows(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    const result = (response as { result?: unknown }).result;
    if (Array.isArray(result)) return result;
  }
  return [];
}

/**
 * Is this row a SUCCESSFUL direct contract creation? A creation has an empty (or
 * null) `to` and a well-formed `contractAddress`. `isError === "1"` (a reverted
 * tx) is rejected so we never present a failed deploy as a launched token.
 */
function creationAddress(row: unknown): { address: Address; createdAt: number; txHash: string | null } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  // Reverted transactions never produced a contract — drop them.
  if (typeof r.isError === 'string' && r.isError === '1') return null;
  if (typeof r.txreceipt_status === 'string' && r.txreceipt_status === '0') return null;

  // A creation has no recipient.
  const to = r.to;
  const toEmpty = to == null || (typeof to === 'string' && to.trim() === '');
  if (!toEmpty) return null;

  const ca = typeof r.contractAddress === 'string' ? r.contractAddress : '';
  if (!ETH_ADDRESS_RE.test(ca)) return null;

  const ts = num(r.timeStamp);
  const createdAt = ts != null && ts >= 0 ? Math.floor(ts) : 0;
  const txHash = typeof r.hash === 'string' && r.hash ? r.hash : null;

  return { address: ca.toLowerCase() as Address, createdAt, txHash };
}

/**
 * Map an Etherscan `account/txlist` response into a deployer's direct creations.
 * Pure and total: never throws, never fetches. De-dupes by address (a contract is
 * created once; the newest occurrence wins), sorts newest-first, and caps the set.
 */
export function parseCreatedContracts(
  response: unknown,
  options: DiscoveryOptions = {},
): DiscoveryResult {
  const maxCreations = options.maxCreations ?? DEFAULT_MAX_CREATIONS;
  const txRowCeiling = options.txRowCeiling ?? DEFAULT_TX_ROW_CEILING;

  const rows = extractRows(response);
  const totalTxScanned = rows.length;

  const byAddress = new Map<string, CreatedContract>();
  for (const row of rows) {
    const c = creationAddress(row);
    if (!c) continue;
    const prev = byAddress.get(c.address);
    // Keep the record with the newest createdAt (defensive — addresses are unique).
    if (!prev || c.createdAt > prev.createdAt) {
      byAddress.set(c.address, { address: c.address, createdAt: c.createdAt, txHash: c.txHash });
    }
  }

  const all = [...byAddress.values()].sort((a, b) => b.createdAt - a.createdAt);
  const created = all.slice(0, maxCreations);

  // Truncated when the explorer capped the tx history OR we found more creations
  // than we can enrich in one pass.
  const truncated = totalTxScanned >= txRowCeiling || all.length > maxCreations;

  return { created, truncated, totalTxScanned };
}

/**
 * Build the LaunchBaseline[] the outcomes-enrichment client consumes from a set of
 * created contracts. The deployer is the `creator` (for its last-activity lookup);
 * tier is 'none' (structural tiering is unknown at discovery) and the launch-time
 * price/liquidity are 0 (unknown — see the summarizeDeployer disclosures), so the
 * enrichment path returns CURRENT market only and never fabricates a drain.
 */
export function toBaselines(created: readonly CreatedContract[], deployer: string): LaunchBaseline[] {
  const creator = ETH_ADDRESS_RE.test(deployer) ? (deployer.toLowerCase() as Address) : null;
  return created.map((c) => ({
    token: c.address,
    tier: 'none' as const,
    creator,
    launchedAt: c.createdAt,
    launchPriceEth: 0,
    launchLiquidityEth: 0,
  }));
}

/** True iff `raw` is a well-formed EVM address the discovery path can read. */
export function isDeployerAddress(raw: string): boolean {
  return ETH_ADDRESS_RE.test((raw ?? '').trim());
}
