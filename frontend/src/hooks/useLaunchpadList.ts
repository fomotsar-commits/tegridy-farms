import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import {
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  CHAIN_ID,
  isDeployed,
} from '../lib/constants';
import {
  TEGRIDY_LAUNCHPAD_V2_ABI,
  TEGRIDY_DROP_V2_ABI,
} from '../lib/contracts';

// V2 mint-phase enum (mirrors TegridyDropV2.sol):
//   0=CLOSED, 1=ALLOWLIST, 2=PUBLIC, 3=DUTCH_AUCTION, 4=CANCELLED
export const PHASE = {
  CLOSED: 0,
  ALLOWLIST: 1,
  PUBLIC: 2,
  DUTCH: 3,
  CANCELLED: 4,
} as const;

export type DropRow = {
  id: bigint;
  address: Address;
  creator: Address;
  name: string;
  symbol: string;
  mintPhase: number;
  totalSupply: bigint;
  maxSupply: bigint;
  mintPrice: bigint;
  currentPrice: bigint;
  paused: boolean;
  contractURI: string;
};

export type CategorizedDrops = {
  live: DropRow[];
  upcoming: DropRow[];
  soldOut: DropRow[];
};

// Hard cap on how many V2 collections we'll surface on the home gallery.
// Keep it low for first-paint cost; deeper paging happens at /nft-finance.
// 24 covers 4 rows of 6, 6 rows of 4, or 8 rows of 3 across all breakpoints.
const MAX_DROPS = 24;

/**
 * Discover launchpad drops for the landing-page gallery.
 *
 * Day-0 behaviour: when the V2 factory address is still the zero placeholder
 * (`TEGRIDY_LAUNCHPAD_V2_ADDRESS === 0x000…`), every list returns empty and
 * `isFactoryDeployed === false`. The page surfaces a creator-CTA empty state
 * in that case rather than rendering an empty grid.
 *
 * Once V2 is deployed and `getCollectionCount() > 0`, we batch-read the most
 * recent `MAX_DROPS` collections (newest-first by id) plus the per-drop state
 * needed for categorisation. Everything happens in two multicalls
 * (`useReadContracts` collapses each batch).
 *
 * V1 clones: deliberately not enumerated here. The V1 factory source was
 * deleted 2026-04-19 and V1 discovery belongs on the indexer (P0-2), not in
 * a frontend hook polling Etherscan from every visitor's browser.
 */
export function useLaunchpadList() {
  const factoryDeployed = isDeployed(TEGRIDY_LAUNCHPAD_V2_ADDRESS);

  // ─── 1. how many collections does the factory know about? ────────
  const { data: countData, isLoading: countLoading } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_V2_ADDRESS as Address,
    abi: TEGRIDY_LAUNCHPAD_V2_ABI,
    functionName: 'getCollectionCount',
    chainId: CHAIN_ID,
    query: {
      enabled: factoryDeployed,
      // Mirrors the 60s cadence used elsewhere (useNFTDropV2). P0-3 will
      // swap this for a WebSocket subscription on `CollectionCreated`.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });

  const factoryCount = countData !== undefined ? Number(countData) : 0;

  // ─── 2. fetch the most-recent `MAX_DROPS` collection structs ────
  const ids = useMemo(() => {
    if (!factoryDeployed || factoryCount === 0) return [];
    const start = Math.max(0, factoryCount - MAX_DROPS);
    // newest first: walk backwards from the highest id
    const out: bigint[] = [];
    for (let i = factoryCount - 1; i >= start; i--) out.push(BigInt(i));
    return out;
  }, [factoryDeployed, factoryCount]);

  const collectionReads = useMemo(
    () =>
      ids.map((id) => ({
        address: TEGRIDY_LAUNCHPAD_V2_ADDRESS as Address,
        abi: TEGRIDY_LAUNCHPAD_V2_ABI,
        functionName: 'getCollection' as const,
        args: [id],
        chainId: CHAIN_ID,
      })),
    [ids],
  );

  const { data: collectionData, isLoading: collectionsLoading } =
    useReadContracts({
      contracts: collectionReads,
      query: {
        enabled: collectionReads.length > 0,
        refetchInterval: 60_000,
      },
    });

  // ─── 3. fetch per-drop state for everything we just discovered ──
  const baseRows = useMemo(() => {
    if (!collectionData) return [];
    type Struct = {
      id: bigint;
      collection: Address;
      creator: Address;
      name: string;
      symbol: string;
    };
    const out: Pick<DropRow, 'id' | 'address' | 'creator' | 'name' | 'symbol'>[] = [];
    collectionData.forEach((r) => {
      if (r?.status !== 'success' || !r.result) return;
      const s = r.result as Struct;
      out.push({
        id: s.id,
        address: s.collection,
        creator: s.creator,
        name: s.name,
        symbol: s.symbol,
      });
    });
    return out;
  }, [collectionData]);

  const stateReads = useMemo(
    () =>
      baseRows.flatMap((row) => [
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPhase' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPrice' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'currentPrice' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'paused' as const, chainId: CHAIN_ID },
        { address: row.address, abi: TEGRIDY_DROP_V2_ABI, functionName: 'contractURI' as const, chainId: CHAIN_ID },
      ]),
    [baseRows],
  );

  const { data: stateData, isLoading: stateLoading } = useReadContracts({
    contracts: stateReads,
    query: {
      enabled: stateReads.length > 0,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });

  const drops: DropRow[] = useMemo(() => {
    if (!stateData || baseRows.length === 0) return [];
    const stride = 7;
    return baseRows.map((row, i) => {
      const off = i * stride;
      const phaseR = stateData[off + 0];
      const totalR = stateData[off + 1];
      const maxR = stateData[off + 2];
      const priceR = stateData[off + 3];
      const curR = stateData[off + 4];
      const pausedR = stateData[off + 5];
      const uriR = stateData[off + 6];
      return {
        ...row,
        mintPhase: phaseR?.status === 'success' ? Number(phaseR.result as number) : PHASE.CLOSED,
        totalSupply: totalR?.status === 'success' ? (totalR.result as bigint) : 0n,
        maxSupply: maxR?.status === 'success' ? (maxR.result as bigint) : 0n,
        mintPrice: priceR?.status === 'success' ? (priceR.result as bigint) : 0n,
        currentPrice: curR?.status === 'success' ? (curR.result as bigint) : 0n,
        paused: pausedR?.status === 'success' ? (pausedR.result as boolean) : false,
        contractURI: uriR?.status === 'success' ? (uriR.result as string) : '',
      };
    });
  }, [baseRows, stateData]);

  const categorized: CategorizedDrops = useMemo(() => {
    const live: DropRow[] = [];
    const upcoming: DropRow[] = [];
    const soldOut: DropRow[] = [];
    for (const d of drops) {
      const isFull = d.maxSupply > 0n && d.totalSupply >= d.maxSupply;
      if (isFull) {
        soldOut.push(d);
        continue;
      }
      if (d.mintPhase === PHASE.CANCELLED) {
        // Cancelled drops live in the "sold out / closed" bucket so they're
        // still discoverable for refund flows but never block the live row.
        soldOut.push(d);
        continue;
      }
      if (d.mintPhase === PHASE.CLOSED || d.paused) {
        upcoming.push(d);
        continue;
      }
      live.push(d);
    }
    return { live, upcoming, soldOut };
  }, [drops]);

  return {
    drops,
    categorized,
    factoryCount,
    isFactoryDeployed: factoryDeployed,
    isLoading: countLoading || collectionsLoading || stateLoading,
  };
}
