import { describe, it, expect } from 'vitest';
import { BUNGALOWS, type Bungalow } from '../lib/bungalows';
import type { MarketRow } from '../lib/geckoTerminal/pools';
import type { MarketFeedState } from '../lib/terminal/feedBanner';
import { TOWELI_POOL } from '../lib/terminal/islandPools';
import type { HarvestClaim, HarvestEarning, HarvestPlan } from '../lib/harvest/types';
import { cityRooms, poolReadsOf, walletPayOf } from './useCityReads';

const row = (network: MarketRow['network'], pool: string, liquidityUsd: number | null, withheld = false): MarketRow => ({
  key: `${network}:${pool}`, network, pool, token: 'token', quoteToken: null, name: null, dex: null, createdAt: null,
  priceUsd: 1, liquidityUsd, fdvUsd: null, volume24hUsd: null, change24hPct: null, tx24h: null, tx5m: null, withheld,
});
const ready = (...rows: MarketRow[]): MarketFeedState => ({ status: 'ready', rows, dropped: 0, readAt: 1_800_000_000 });
const withMarket = BUNGALOWS.filter((b) => b.market);
const base = withMarket.find((b) => b.market!.network === 'base')!;
const sol = withMarket.find((b) => b.market!.network === 'solana')!;

describe('what the city reads of a pool', () => {
  it('has rooms to read: the registry records a market pool on Base and on Solana', () => {
    expect(base).toBeDefined();
    expect(sol).toBeDefined();
  });

  it('draws nothing for a network that has not answered, or could not be reached: dashed, never empty', () => {
    expect(poolReadsOf({}).size).toBe(0);
    expect(poolReadsOf({ base: { status: 'loading' }, solana: { status: 'idle' } }).size).toBe(0);
    const unreachable = { status: 'unreachable' } as MarketFeedState;
    expect(poolReadsOf({ base: unreachable }).has(base.id)).toBe(false);
  });

  it('fills a pool to the dollars its read returned', () => {
    expect(poolReadsOf({ base: ready(row('base', base.market!.pool, 640_000)) }).get(base.id)).toEqual({ state: 'level', usd: 640_000 });
  });

  it('draws still water, and no figure, when the dollars were withheld, absent or nothing', () => {
    for (const r of [row('base', base.market!.pool, 640_000, true), row('base', base.market!.pool, null), row('base', base.market!.pool, 0)]) {
      expect(poolReadsOf({ base: ready(r) }).get(base.id)).toEqual({ state: 'still' });
    }
  });

  it('leaves a room dashed when its network answered without its pool', () => {
    expect(poolReadsOf({ base: ready(row('base', '0x0000000000000000000000000000000000000001', 5)) }).has(base.id)).toBe(false);
  });

  it('matches an Ethereum or Base pool whatever its case, and a Solana pool only as written', () => {
    expect(poolReadsOf({ base: ready(row('base', base.market!.pool.toUpperCase().replace('0X', '0x'), 9_000)) }).get(base.id)).toEqual({ state: 'level', usd: 9_000 });
    const flipped = sol.market!.pool.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    expect(flipped).not.toBe(sol.market!.pool);
    expect(poolReadsOf({ solana: ready(row('solana', flipped, 9_000)) }).has(sol.id)).toBe(false);
    expect(poolReadsOf({ solana: ready(row('solana', sol.market!.pool, 9_000)) }).get(sol.id)).toEqual({ state: 'level', usd: 9_000 });
  });

  it("reads TOWELI's pool from where the island keeps it, beside the registry", () => {
    expect(BUNGALOWS.find((b) => b.id === 'toweli')?.market).toBeUndefined();
    expect(poolReadsOf({ eth: ready(row('eth', TOWELI_POOL.pool, 380_000)) }).get('toweli')).toEqual({ state: 'level', usd: 380_000 });
  });

  it('never reads a figure across networks: a Base answer says nothing of a Solana room', () => {
    expect(poolReadsOf({ base: ready(row('base', sol.market!.pool, 9_000)) }).has(sol.id)).toBe(false);
  });
});

describe('the rooms the city draws', () => {
  it('are the live rooms of the registry, with their own ticker and whole address', () => {
    const rooms = cityRooms();
    expect(rooms.map((r) => r.id)).toEqual(BUNGALOWS.filter((b) => b.live && b.chain !== 'tbd').map((b) => b.id));
    for (const r of rooms) {
      const b = BUNGALOWS.find((x) => x.id === r.id)!;
      expect(r.symbol).toBe(b.symbol);
      expect(r.address).toBe(b.address);
    }
  });
  it('leave out a room that is not live or has no chain yet', () => {
    const closed = { ...BUNGALOWS[0]!, id: 'closed', live: false } as Bungalow;
    const unbuilt = { ...BUNGALOWS[0]!, id: 'unbuilt', chain: 'tbd' } as Bungalow;
    expect(cityRooms([closed, unbuilt])).toEqual([]);
  });
});

describe('which pools hold staking pay for a wallet', () => {
  const claim = (roomId: string, amountRaw: bigint): HarvestClaim => ({ key: roomId, chain: 'base', roomId, symbol: 'X', where: 'lock ladder', detail: null, amountRaw, decimals: 18, caution: null });
  const earning = (roomId: string, perDayRaw: bigint): HarvestEarning => ({ key: roomId, chain: 'solana', roomId, symbol: 'X', where: 'lock ladder', decimals: 6, principalRaw: 1n, perDayRaw, apr: '1%', fundedToSecs: 0 });
  const plan = (p: Partial<HarvestPlan>): HarvestPlan => ({ claims: [], held: [], unread: [], ...p });

  it('says nothing before a plan is read', () => {
    expect(walletPayOf([null, null])).toEqual({ rooms: [], unread: 0 });
  });
  it('names a room with a claim above zero, and not one whose claim is zero', () => {
    expect(walletPayOf([plan({ claims: [claim('mfer', 5n), claim('drb', 0n)] })]).rooms).toEqual(['mfer']);
  });
  it('names a room that is paying by the day even with nothing to claim yet, once', () => {
    expect(walletPayOf([plan({ claims: [claim('bayla', 0n)], earning: [earning('bayla', 9n)] })]).rooms).toEqual(['bayla']);
    expect(walletPayOf([plan({ claims: [claim('bayla', 3n)], earning: [earning('bayla', 9n)] })]).rooms).toEqual(['bayla']);
  });
  it('adds the chains together', () => {
    expect(walletPayOf([plan({ claims: [claim('mfer', 5n)] }), plan({ earning: [earning('bayla', 9n)] })]).rooms.sort()).toEqual(['bayla', 'mfer']);
  });
  it('counts a pool that could not be read as not read, never as paying nothing', () => {
    const unread = { key: 'sol', chain: 'solana' as const, roomId: '', what: 'your Solana pools', detail: 'no answer' };
    expect(walletPayOf([plan({ unread: [unread] }), plan({ claims: [claim('mfer', 5n)] })])).toEqual({ rooms: ['mfer'], unread: 1 });
  });
});
