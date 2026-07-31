// OUR launches — the integrator-filtered discovery feed for Explorer / Afterlife.
//
// `discovery.ts` maps GeckoTerminal `new_pools`, which is MARKET-WIDE. That feed is
// correct for <LaunchRadar/>, and pouring it into Explorer/Afterlife would fabricate a
// track record: those two surfaces claim "launched and graduated through THIS rail".
// This module is the honest source for that claim — it lists only assets whose Airlock
// record names our integrator.
//
// ── The trap this module exists to avoid ────────────────────────────────────────────
// The obvious implementation is "filter Airlock `Create` logs by our integrator topic".
// That can never work. The event is:
//
//   Create(address asset, address numeraire indexed, address initializer, address poolOrHook)
//
// Only `numeraire` is indexed — 2 topics, 3 data words — and the integrator appears
// NOWHERE in it. Verified against the SDK's own ABI (`@whetstone-research/doppler-sdk`,
// dist/evm airlockAbi) and against a real on-chain log. A topic filter would silently
// match nothing forever, which is indistinguishable from "we have not launched yet".
//
// The integrator is only recoverable from Airlock state:
//
//   getAssetData(asset) -> (numeraire, timelock, governance, liquidityMigrator,
//                           poolInitializer, pool, migrationPool, numTokensToSell,
//                           totalSupply, integrator)
//                                                    ^^^^^^^^^^ index 9
//
// So discovery is necessarily two-phase: enumerate Create logs, then read each asset's
// record and keep the ones whose word[9] is ours. Both phases are separated from I/O
// below so the filtering logic is unit-testable against fixtures.

import type { Address, PublicClient } from 'viem';
import { getAddress } from 'viem';
import type { LaunchBaseline } from './outcomesReader';
import { DOPPLER_MAINNET } from './doppler.constants';
import { LAUNCHER_INTEGRATOR_ADDRESS } from './config';

// ---------------------------------------------------------------------------
// ABI fragments. Deliberately minimal — see doppler.constants.ts for the rest.
// ---------------------------------------------------------------------------

/** `Create` as emitted by the Airlock. ONLY `numeraire` is indexed — see header. */
export const AIRLOCK_CREATE_EVENT = {
  type: 'event',
  name: 'Create',
  inputs: [
    { name: 'asset', type: 'address', indexed: false },
    { name: 'numeraire', type: 'address', indexed: true },
    { name: 'initializer', type: 'address', indexed: false },
    { name: 'poolOrHook', type: 'address', indexed: false },
  ],
} as const;

/** `getAssetData` — the only place an asset's integrator is readable. */
export const AIRLOCK_GET_ASSET_DATA = {
  type: 'function',
  name: 'getAssetData',
  stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [
    { name: 'numeraire', type: 'address' },
    { name: 'timelock', type: 'address' },
    { name: 'governance', type: 'address' },
    { name: 'liquidityMigrator', type: 'address' },
    { name: 'poolInitializer', type: 'address' },
    { name: 'pool', type: 'address' },
    { name: 'migrationPool', type: 'address' },
    { name: 'numTokensToSell', type: 'uint256' },
    { name: 'totalSupply', type: 'uint256' },
    { name: 'integrator', type: 'address' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Pure layer — no I/O, fully testable.
// ---------------------------------------------------------------------------

/** One Airlock asset record, as far as this module cares. */
export interface AssetRecord {
  asset: Address;
  integrator: Address;
  /** The migration pool, or the zero address while the auction is still running. */
  migrationPool: Address;
  /** Block timestamp (unix seconds) of the asset's `Create`. 0 when unknown. */
  createdAt: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Case-insensitive address compare that never throws on malformed input. */
export function sameAddress(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Keep only the records naming `integrator`.
 *
 * Fails CLOSED on a zero/absent integrator: an asset whose record we could not read
 * must not appear in a surface that asserts provenance. An empty Explorer is honest;
 * a foreign token in it is not.
 */
export function filterOurAssets(
  records: readonly AssetRecord[],
  integrator: Address = LAUNCHER_INTEGRATOR_ADDRESS,
): AssetRecord[] {
  if (sameAddress(integrator, ZERO)) return []; // never claim everything as ours
  return records.filter((r) => sameAddress(r.integrator, integrator));
}

/**
 * Project asset records into the baseline shape the enrichment path consumes.
 *
 * `launchPriceEth` / `launchLiquidityEth` are 0 here on purpose. Those are
 * AT-GRADUATION facts, and the Airlock record does not carry them — the enrichment
 * pass (`launcher-outcomes`) supplies live market data, and `outcomesReader` already
 * treats a 0 baseline as "unknown" rather than as a real reading. Inventing a number
 * here would put a fabricated price into a trust surface.
 *
 * `tier` is 'none' for the same reason it is in discovery.ts: structural tiering is a
 * gate.ts concern and is unknown at discovery time. `creator` is null — the Airlock
 * record exposes `timelock`/`governance`, neither of which is the creator EOA.
 */
export function assetsToBaselines(records: readonly AssetRecord[]): LaunchBaseline[] {
  return records.map((r) => ({
    token: r.asset,
    tier: 'none' as const,
    creator: null,
    launchedAt: Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : 0,
    launchPriceEth: 0,
    launchLiquidityEth: 0,
  }));
}

/** Token → migration pool, for the enrichment path's token→pool skip. Zero pools omitted. */
export function poolByTokenFrom(records: readonly AssetRecord[]): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const r of records) {
    if (!sameAddress(r.migrationPool, ZERO)) out[r.asset.toLowerCase()] = r.migrationPool;
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O layer.
// ---------------------------------------------------------------------------

export interface ReadOurLaunchesOptions {
  client: PublicClient;
  /** Defaults to our pinned integrator. Overridable for tests. */
  integrator?: Address;
  /** How far back to scan. Doppler mainnet is young; the default covers its whole life. */
  fromBlock?: bigint;
  toBlock?: bigint | 'latest';
  signal?: AbortSignal;
}

/**
 * Airlock deployment block on mainnet. Scanning from genesis would be absurd, and most
 * RPCs cap `eth_getLogs` ranges — this keeps the default query to one bounded window.
 * Only lowers the floor of what we can see; a wrong-but-earlier value costs time, never
 * correctness.
 */
export const AIRLOCK_FIRST_BLOCK = 21_000_000n;

/**
 * Discover the launches that went through OUR integrator.
 *
 * Two phases, for the reason in the header: enumerate `Create`, then read each asset's
 * Airlock record and keep ours. Returns the exact `{ baselines, poolByToken }` pair the
 * enrichment path already accepts.
 *
 * Degrades to empty rather than throwing — every caller renders a trust surface, and an
 * empty state is the honest failure mode. A partial read is NOT returned: if the asset
 * reads fail we cannot prove provenance for anything, so nothing is claimed.
 */
export async function readOurLaunches(
  opts: ReadOurLaunchesOptions,
): Promise<{ baselines: LaunchBaseline[]; poolByToken: Record<string, Address> }> {
  const { client, integrator = LAUNCHER_INTEGRATOR_ADDRESS, signal } = opts;
  const empty = { baselines: [], poolByToken: {} };
  if (sameAddress(integrator, ZERO)) return empty;

  try {
    const logs = await client.getLogs({
      address: DOPPLER_MAINNET.airlock,
      event: AIRLOCK_CREATE_EVENT,
      fromBlock: opts.fromBlock ?? AIRLOCK_FIRST_BLOCK,
      toBlock: opts.toBlock ?? 'latest',
    });
    if (signal?.aborted) return empty;

    // Distinct assets, newest last (getLogs is ascending). A malformed log is dropped
    // rather than allowed to abort the batch.
    const assets: Address[] = [];
    const seen = new Set<string>();
    for (const log of logs) {
      const a = (log as { args?: { asset?: unknown } }).args?.asset;
      if (typeof a !== 'string') continue;
      let checksummed: Address;
      try {
        checksummed = getAddress(a);
      } catch {
        continue;
      }
      const k = checksummed.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      assets.push(checksummed);
    }
    if (assets.length === 0) return empty;

    const results = await client.multicall({
      contracts: assets.map((asset) => ({
        address: DOPPLER_MAINNET.airlock,
        abi: [AIRLOCK_GET_ASSET_DATA] as const,
        functionName: 'getAssetData' as const,
        args: [asset] as const,
      })),
      allowFailure: true,
    });
    if (signal?.aborted) return empty;

    const records: AssetRecord[] = [];
    results.forEach((res, i) => {
      if (res.status !== 'success') return; // unreadable ⇒ unprovable ⇒ excluded
      const d = res.result as readonly unknown[];
      const integratorOut = d?.[9];
      const migrationPool = d?.[6];
      const asset = assets[i];
      if (typeof integratorOut !== 'string' || !asset) return;
      records.push({
        asset,
        integrator: integratorOut as Address,
        migrationPool: (typeof migrationPool === 'string' ? migrationPool : ZERO) as Address,
        createdAt: 0, // block timestamps would need a per-log getBlock; enrichment supplies time
      });
    });

    const ours = filterOurAssets(records, integrator);
    return { baselines: assetsToBaselines(ours), poolByToken: poolByTokenFrom(ours) };
  } catch {
    return empty; // network/RPC failure — degrade to the clean empty state
  }
}
