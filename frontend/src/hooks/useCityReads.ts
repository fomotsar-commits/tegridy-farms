// What the city page reads. It adds NO read of its own to the site: each one here is a read
// another page already makes, through the same hook, under the same rules.
//
//  - A room's pool dollars: the island's market pools on GeckoTerminal, through this app's own
//    edge (hooks/useMarketFeed.ts), the read the dashboard prices its coins with. The three
//    networks are asked one after another, never together: that budget is shared by every
//    surface in the tab.
//  - Which pools hold staking pay for the connected wallet: Harvest's own plans, Ethereum and
//    Base through wagmi (hooks/useEvmHarvest.ts) and Solana through the top bar's connection
//    (lib/solanaSurface.ts, lib/harvest/solana.ts), as the Earn page reads them.
//
// THE RULE EVERY READ KEEPS: a figure is drawn only when a read returned it. A pool that was not
// read is drawn dry and dashed, never empty; a wallet's pool that was not read is counted as not
// read, never as paying nothing.

import { useEffect, useMemo, useState } from 'react';
import { BUNGALOWS, type Bungalow } from '../lib/bungalows';
import type { GeckoNetwork, MarketRow } from '../lib/geckoTerminal/pools';
import type { MarketFeedState } from '../lib/terminal/feedBanner';
import { TOWELI_POOL, islandPoolsOn } from '../lib/terminal/islandPools';
import type { HarvestPlan } from '../lib/harvest/types';
import { useSolanaSurface } from '../lib/solanaSurface';
import type { PoolRead, Room } from '../lib/city/plan';
import { useEvmHarvest } from './useEvmHarvest';
import { useMarketFeed } from './useMarketFeed';

/** The three networks the island's rooms are on. */
type Network = Extract<GeckoNetwork, 'eth' | 'base' | 'solana'>;
const POOLS: Record<Network, readonly string[]> = { eth: islandPoolsOn('eth'), base: islandPoolsOn('base'), solana: islandPoolsOn('solana') };

/** The island's rooms as the plan wants them: the registry's own facts, live rooms only. */
export function cityRooms(bungalows: readonly Bungalow[] = BUNGALOWS): Room[] {
  return bungalows
    .filter((b) => b.live && b.chain !== 'tbd')
    .map((b) => ({ id: b.id, name: b.name, symbol: b.symbol, chain: b.chain, address: b.address, accent: b.accent ?? '#22c55e' }));
}

/** The market pool a room's water stands for, or null when the registry records none. */
function marketOf(b: Bungalow): { network: GeckoNetwork; pool: string } | null {
  if (b.market) return { network: b.market.network, pool: b.market.pool };
  // TOWELI's market is kept beside the registry, not on its row (lib/terminal/islandPools.ts).
  return b.id === 'toweli' ? { network: TOWELI_POOL.network, pool: TOWELI_POOL.pool } : null;
}
/** base58 is case-sensitive, hex is not. */
const samePool = (network: GeckoNetwork, a: string, b: string): boolean => (network === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());

/**
 * Each room's pool, from what the feeds returned. A room is left out (so drawn dry and dashed)
 * while its network is unread, unreachable, or answered without its pool. A pool that answered
 * with its dollars withheld or absent is still water: read, but no figure.
 */
export function poolReadsOf(feeds: Partial<Record<GeckoNetwork, MarketFeedState>>, bungalows: readonly Bungalow[] = BUNGALOWS): Map<string, PoolRead> {
  const out = new Map<string, PoolRead>();
  for (const b of bungalows) {
    const market = marketOf(b);
    if (!market) continue;
    const feed = feeds[market.network];
    if (feed?.status !== 'ready') continue;
    const row: MarketRow | undefined = feed.rows.find((r) => samePool(market.network, r.pool, market.pool));
    if (!row) continue;
    out.set(b.id, row.withheld || row.liquidityUsd === null || !(row.liquidityUsd > 0) ? { state: 'still' } : { state: 'level', usd: row.liquidityUsd });
  }
  return out;
}

export interface WalletPay {
  /** Rooms whose pool holds staking pay for this wallet, or is paying it now. */
  rooms: string[];
  /** Pools that could not be read. Never counted as paying nothing. */
  unread: number;
}
/**
 * The rooms a wallet's harvest plans say are paying it: a claim above zero, or a daily figure
 * above zero. A plan that is null was not read yet and says nothing.
 */
export function walletPayOf(plans: readonly (HarvestPlan | null)[]): WalletPay {
  const rooms = new Set<string>();
  let unread = 0;
  for (const plan of plans) {
    if (!plan) continue;
    for (const c of plan.claims) if (c.amountRaw > 0n && c.roomId) rooms.add(c.roomId);
    for (const e of plan.earning ?? []) if (e.perDayRaw > 0n && e.roomId) rooms.add(e.roomId);
    unread += plan.unread.length;
  }
  return { rooms: [...rooms], unread };
}

/** The connected Solana wallet's harvest plan, read as the Earn page reads it. Null until read. */
function useSolanaPlan(address: string | null): HarvestPlan | null {
  // Kept with the wallet it was read for, so a switched wallet never shows the last one's pools.
  const [read, setRead] = useState<{ owner: string; plan: HarvestPlan } | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    void import('../lib/harvest/solana')
      .then((m): Promise<HarvestPlan> => m.readSolanaHarvest(address))
      .catch((e: unknown): HarvestPlan => ({
        claims: [],
        held: [],
        unread: [{ key: 'sol', chain: 'solana', roomId: '', what: 'your Solana pools', detail: e instanceof Error ? e.message : 'the Solana code could not load' }],
      }))
      .then((plan) => {
        if (live) setRead({ owner: address, plan });
      });
    return () => {
      live = false;
    };
  }, [address]);
  return address && read?.owner === address ? read.plan : null;
}

export interface CityReads {
  rooms: Room[];
  pools: Map<string, PoolRead>;
  /** When the newest pool figures were read (unix seconds), or null before any. */
  poolsReadAt: number | null;
  /** No wallet / its pools are being read / read. */
  wallet: 'none' | 'reading' | 'read';
  pay: WalletPay;
}

export function useCityReads(): CityReads {
  const rooms = useMemo(() => cityRooms(), []);

  // One network at a time: the next is asked once the one before has answered, either way.
  const settled = (s: MarketFeedState): boolean => s.status === 'ready' || s.status === 'unreachable';
  const eth = useMarketFeed({ view: 'multi', network: 'eth', pools: POOLS.eth });
  const base = useMarketFeed(settled(eth.state) ? { view: 'multi', network: 'base', pools: POOLS.base } : null);
  const sol = useMarketFeed(settled(base.state) ? { view: 'multi', network: 'solana', pools: POOLS.solana } : null);
  const pools = useMemo(() => poolReadsOf({ eth: eth.state, base: base.state, solana: sol.state }), [eth.state, base.state, sol.state]);
  const poolsReadAt = useMemo(() => {
    const at = [eth.state, base.state, sol.state].flatMap((s) => (s.status === 'ready' ? [s.readAt] : []));
    return at.length ? Math.max(...at) : null;
  }, [eth.state, base.state, sol.state]);

  const evm = useEvmHarvest();
  const solAddress = useSolanaSurface().surface?.address ?? null;
  const solPlan = useSolanaPlan(solAddress);
  const evmPlan: HarvestPlan | null = evm.address ? evm.plan : null;
  const wallet: CityReads['wallet'] = !evm.address && !solAddress ? 'none' : (evm.address && !evmPlan) || (solAddress && !solPlan) ? 'reading' : 'read';
  const pay = useMemo(() => walletPayOf([evmPlan, solPlan]), [evmPlan, solPlan]);

  return { rooms, pools, poolsReadAt, wallet, pay };
}
