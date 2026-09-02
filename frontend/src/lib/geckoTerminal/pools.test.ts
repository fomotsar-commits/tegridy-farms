// THESE TESTS PARSE REAL RESPONSES, NOT HAND-WRITTEN ONES.
//
// fixtures/ holds trimmed live captures taken 2026-09-02 from
// `networks/eth/new_pools`, `networks/base/trending_pools`,
// `networks/solana/trending_pools` and `networks/eth/pools/multi/{a,b}`, plus a
// real 429 body. A hand-written fixture only ever proves the parser agrees with
// whoever wrote the fixture; these caught two things nobody would have invented:
//
//  - Two of the three newest Ethereum pools were Uniswap v4, whose pool
//    identifier is a 32-BYTE POOL ID, not a 20-byte address. Held to the address
//    rule, "new pools" would have quietly shown a third of the list.
//  - A live pool quoting `reserve_in_usd: "-100.058883136323"`. Negative
//    liquidity is not a number, and it is exactly what `withheld` is for.
//
// The single invariant underneath everything below: a row is either TRUE or it
// is not shown, and anything not shown is COUNTED so a surface can say so.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GECKO_NETWORKS,
  GECKO_POOLS_MULTI_MAX,
  geckoPoolsMultiUrl,
  geckoPoolsUrl,
  isGeckoNetwork,
  parseGeckoPoolList,
  readGeckoPools,
  type MarketRow,
} from './pools';

// vitest's cwd is frontend/; jsdom's import.meta.url is an http: URL, so the
// repo anchors file reads on cwd (same as bungalowDoors.test.ts).
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/lib/geckoTerminal/fixtures', name), 'utf8'),
  );
}

const ETH_NEW = fixture('eth_new_pools.json');
const BASE_TRENDING = fixture('base_trending_pools.json');
const SOL_TRENDING = fixture('solana_trending_pools.json');
const ETH_MULTI = fixture('eth_pools_multi.json');
const RATE_LIMITED = fixture('rate_limited_429.json');

function itemCount(raw: unknown): number {
  return (raw as { data: unknown[] }).data.length;
}

function parsed(raw: unknown, network: 'eth' | 'base' | 'solana') {
  const out = parseGeckoPoolList(raw, network);
  if (!out) throw new Error('expected the fixture to parse');
  return out;
}

function byName(rows: MarketRow[], name: string): MarketRow {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

describe('the network union', () => {
  it('is closed to the three slugs GeckoTerminal knows this venue by', () => {
    expect([...GECKO_NETWORKS]).toEqual(['eth', 'base', 'solana']);
    expect(isGeckoNetwork('eth')).toBe(true);
    // 'ethereum' is this app's own word for the chain everywhere else, and it
    // is a silent 404 at GeckoTerminal — the exact reason the union is closed.
    expect(isGeckoNetwork('ethereum')).toBe(false);
    expect(isGeckoNetwork(null)).toBe(false);
  });
});

describe('parseGeckoPoolList — every entry is accounted for', () => {
  it('shows or counts every item upstream sent, on all three networks', () => {
    for (const [raw, net] of [[ETH_NEW, 'eth'], [BASE_TRENDING, 'base'], [SOL_TRENDING, 'solana'], [ETH_MULTI, 'eth']] as const) {
      const { rows, dropped } = parsed(raw, net);
      // The whole point of returning `dropped`: a surface can say "18 of 20
      // pools shown" instead of presenting 18 as the whole market.
      expect(rows.length + dropped).toBe(itemCount(raw));
    }
  });

  it('counts an unusable entry rather than silently shortening the list', () => {
    const poisoned = { data: [...(ETH_NEW as { data: unknown[] }).data, { id: 'eth_not-an-address', attributes: {}, relationships: {} }] };
    const { rows, dropped } = parsed(poisoned, 'eth');
    expect(dropped).toBe(1);
    expect(rows.length + dropped).toBe(itemCount(poisoned));
  });

  it('rejects a body with no pool list at all, and NEVER calls it zero pools', () => {
    // The 429 fixture is a real rate-limit body: `{ status: { error_code: 429 } }`
    // with no `data` key. Parsed into `{ rows: [], dropped: 0 }` it would render
    // as "this network has no pools" — the fabricated zero, in its purest form.
    expect(parseGeckoPoolList(RATE_LIMITED, 'solana')).toBeNull();
    expect(parseGeckoPoolList(null, 'eth')).toBeNull();
    expect(parseGeckoPoolList({ data: 'nope' }, 'eth')).toBeNull();
  });
});

describe('parseGeckoPoolList — identity', () => {
  it('keeps Uniswap v4 pools, which are identified by a 32-byte pool id', () => {
    const { rows, dropped } = parsed(ETH_NEW, 'eth');
    expect(dropped, 'a v4 pool is a real pool, not a malformed row').toBe(0);
    const v4 = byName(rows, 'Paired / ETH 1%');
    expect(v4.pool).toMatch(/^0x[0-9a-f]{64}$/);
    // Its base TOKEN is still held to the 20-byte address rule: a token is a
    // contract and always has an address.
    expect(v4.token).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('lowercases EVM ids and leaves Solana base58 EXACTLY as sent', () => {
    const eth = parsed(ETH_MULTI, 'eth').rows[0]!;
    expect(eth.pool).toBe(eth.pool.toLowerCase());

    const sol = parsed(SOL_TRENDING, 'solana').rows[0]!;
    // Base58 is case-sensitive: a lowercased key is a different, valid-looking,
    // wrong address that would match nothing and link to the wrong pool page.
    expect(sol.pool).toBe('3HCKRmDnU3Fy43uaK99EtBvfyEevbCC1c8GkD9srs85C');
    expect(sol.token).toBe('ChxxxU8mxpgBRtAFx7hXz1nKZKA6NyyZ543Lqdtnpump');
  });

  it('strips the {network}_ prefix off JSON:API ids', () => {
    const sol = parsed(SOL_TRENDING, 'solana').rows[0]!;
    expect(sol.pool.startsWith('solana_')).toBe(false);
    expect(sol.token.startsWith('solana_')).toBe(false);
  });

  it('keys each row by network AND pool, so two chains never collide', () => {
    const eth = parsed(ETH_MULTI, 'eth').rows;
    expect(eth[0]!.key).toBe(`eth:${eth[0]!.pool}`);
    expect(new Set(eth.map((r) => r.key)).size).toBe(eth.length);
  });

  it('carries the dex slug through verbatim, in either spelling upstream uses', () => {
    expect(parsed(ETH_MULTI, 'eth').rows[0]!.dex).toBe('uniswap_v2');
    expect(parsed(BASE_TRENDING, 'base').rows[0]!.dex).toBe('uniswap-v3-base');
  });
});

describe('parseGeckoPoolList — createdAt is never 0', () => {
  it('parses the ISO timestamp into unix seconds', () => {
    const pepe = byName(parsed(ETH_MULTI, 'eth').rows, 'PEPE / WETH');
    expect(pepe.createdAt).toBe(Math.floor(Date.parse('2023-04-14T17:21:11Z') / 1000));
  });

  it('reports an ABSENT creation time as null, not as 1970', () => {
    // lib/launcher/discovery.ts defaults a missing `pool_created_at` to 0. That
    // is 1970: the pool sorts first under "oldest", and an age column renders it
    // as 56 years old. Absent is absent.
    const anonymous = { data: [{ id: 'eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', attributes: {}, relationships: { base_token: { data: { id: 'eth_0x6982508145454ce325ddbe47a25d4ec3d2311933' } } } }] };
    const row = parsed(anonymous, 'eth').rows[0]!;
    expect(row.createdAt).toBeNull();
    expect(row.createdAt).not.toBe(0);
  });

  it('refuses an unparseable creation time rather than guessing at one', () => {
    const junk = { data: [{ id: 'eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', attributes: { pool_created_at: 'soon' }, relationships: { base_token: { data: { id: 'eth_0x6982508145454ce325ddbe47a25d4ec3d2311933' } } } }] };
    expect(parsed(junk, 'eth').rows[0]!.createdAt).toBeNull();
  });
});

describe('parseGeckoPoolList — the money is shown or withheld, never invented', () => {
  it('reads a believable quote straight through', () => {
    const pepe = byName(parsed(ETH_MULTI, 'eth').rows, 'PEPE / WETH');
    expect(pepe.withheld).toBe(false);
    expect(pepe.priceUsd).toBeCloseTo(0.00000344793515233555, 20);
    expect(pepe.liquidityUsd).toBeCloseTo(26662287.3381, 3);
    expect(pepe.fdvUsd).toBeCloseTo(1428174350.4385, 3);
    expect(pepe.volume24hUsd).toBeCloseTo(707632.291884063, 3);
  });

  it('withholds the whole USD quartet for a LIVE pool quoting negative liquidity', () => {
    // Real row from the eth/new_pools capture: reserve_in_usd "-100.058…".
    const altair = byName(parsed(ETH_NEW, 'eth').rows, 'Altair / ETH 1%');
    expect(altair.withheld).toBe(true);
    expect(altair.liquidityUsd).toBeNull();
    // The other three come from the same broken quote, so they go too — an FDV
    // derived from an impossible reserve is a confident-looking wrong number.
    expect(altair.priceUsd).toBeNull();
    expect(altair.fdvUsd).toBeNull();
    expect(altair.volume24hUsd).toBeNull();
  });

  it('still renders the parts of a withheld row that are independently true', () => {
    const altair = byName(parsed(ETH_NEW, 'eth').rows, 'Altair / ETH 1%');
    // Identity, age and trade counts do not come from the price quote, so they
    // survive. A withheld row is a row with unknown money, not a deleted row.
    expect(altair.pool).toBeTruthy();
    expect(altair.createdAt).not.toBeNull();
    expect(altair.tx24h).toEqual({ buys: 8, sells: 0 });
  });

  it('withholds when the quote is simply absent', () => {
    const noPrice = { data: [{ id: 'eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', attributes: { fdv_usd: '1000' }, relationships: { base_token: { data: { id: 'eth_0x6982508145454ce325ddbe47a25d4ec3d2311933' } } } }] };
    const row = parsed(noPrice, 'eth').rows[0]!;
    expect(row.withheld).toBe(true);
    // The FDV upstream did send is dropped too: on its own it is a number with
    // no price behind it, and it would be the only figure on the row.
    expect(row.fdvUsd).toBeNull();
  });

  it('accepts a figure sent as a JSON number as readily as one sent as a string', () => {
    // Upstream is inconsistent about this between endpoints — reserve_in_usd
    // came back as a number from pools/multi and as a string from the lists.
    const asNumber = { data: [{ id: 'eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', attributes: { base_token_price_usd: 1.5, reserve_in_usd: 4200 }, relationships: { base_token: { data: { id: 'eth_0x6982508145454ce325ddbe47a25d4ec3d2311933' } } } }] };
    const row = parsed(asNumber, 'eth').rows[0]!;
    expect(row.withheld).toBe(false);
    expect(row.liquidityUsd).toBe(4200);
  });

  it('keeps a NEGATIVE price change, which is a fall and not a fault', () => {
    const drb = byName(parsed(BASE_TRENDING, 'base').rows, 'DRB / WETH 1%');
    expect(drb.change24hPct).toBeCloseTo(-5.92, 5);
    expect(drb.withheld).toBe(false);
  });

  it('drops half a transaction count rather than inviting a ratio from one number', () => {
    const halfCount = { data: [{ id: 'eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', attributes: { transactions: { h24: { buys: 12 } } }, relationships: { base_token: { data: { id: 'eth_0x6982508145454ce325ddbe47a25d4ec3d2311933' } } } }] };
    expect(parsed(halfCount, 'eth').rows[0]!.tx24h).toBeNull();
  });

  it('reads both transaction windows off a real row', () => {
    const useless = byName(parsed(SOL_TRENDING, 'solana').rows, 'USELESS / SOL');
    expect(useless.tx24h).toEqual({ buys: 11799, sells: 17152 });
    expect(useless.tx5m).toEqual({ buys: 4, sells: 50 });
  });
});

describe('URLs', () => {
  it('names the two list views', () => {
    expect(geckoPoolsUrl('eth', 'new')).toBe('https://api.geckoterminal.com/api/v2/networks/eth/new_pools');
    expect(geckoPoolsUrl('solana', 'trending')).toBe('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
  });

  it('joins multi addresses with commas in the PATH', () => {
    const url = geckoPoolsMultiUrl('eth', [
      '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
      '0x11950d141ecb863f01007add7d1a342041227b58',
    ]);
    expect(url).toBe('https://api.geckoterminal.com/api/v2/networks/eth/pools/multi/0xa43fe16908251ee70ef74718545e4fe6c5ccec9f,0x11950d141ecb863f01007add7d1a342041227b58');
  });

  it('never lets an unvalidated string reach the path', () => {
    // A comma or a slash inside one entry re-shapes which endpoint is called.
    const url = geckoPoolsMultiUrl('eth', [
      '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
      '../../simple/networks/eth/token_price/x',
      'not-an-address',
      '0xdeadbeef,0xdeadbeef',
    ]);
    expect(url).toBe('https://api.geckoterminal.com/api/v2/networks/eth/pools/multi/0xa43fe16908251ee70ef74718545e4fe6c5ccec9f');
    expect(url).not.toContain('..');
  });

  it('caps the batch at 30 addresses', () => {
    const many = Array.from({ length: 45 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const tail = geckoPoolsMultiUrl('base', many).split('/multi/')[1] ?? '';
    expect(tail.split(',')).toHaveLength(GECKO_POOLS_MULTI_MAX);
  });

  it('accepts a Solana pool key, and rejects an EVM one on the Solana path', () => {
    expect(geckoPoolsMultiUrl('solana', ['3HCKRmDnU3Fy43uaK99EtBvfyEevbCC1c8GkD9srs85C']))
      .toContain('/multi/3HCKRmDnU3Fy43uaK99EtBvfyEevbCC1c8GkD9srs85C');
    expect(geckoPoolsMultiUrl('solana', ['0xa43fe16908251ee70ef74718545e4fe6c5ccec9f']))
      .toBe('https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/');
  });
});

describe('readGeckoPools', () => {
  function res(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it('reads a real trending response end to end', async () => {
    const read = await readGeckoPools(geckoPoolsUrl('solana', 'trending'), {
      fetchImpl: res(SOL_TRENDING),
      now: () => 1_788_000_000_000,
    });
    expect(read.status).toBe('read');
    if (read.status !== 'read') return;
    expect(read.rows).toHaveLength(2);
    expect(read.rows[0]!.network).toBe('solana');
    expect(read.dropped).toBe(0);
    expect(read.fetchedAt).toBe(1_788_000_000_000);
  });

  it('takes the network from the URL, so a response cannot be parsed under the wrong chain rules', async () => {
    // Parsed as 'eth', every base58 pool key fails the address rule and the
    // whole Solana list would come back as 2 rows dropped and nothing shown.
    const read = await readGeckoPools(geckoPoolsUrl('eth', 'new'), { fetchImpl: res(SOL_TRENDING) });
    if (read.status !== 'read') throw new Error('expected a read');
    expect(read.rows).toHaveLength(0);
    expect(read.dropped).toBe(2);
  });

  it('calls a 429 rate-limiting from the STATUS CODE, before any parse', async () => {
    // The 429 body has no `data` key, so a parse-first reader would report
    // 'schema' — a confusing message for the one failure that just needs a wait.
    const read = await readGeckoPools(geckoPoolsUrl('eth', 'new'), { fetchImpl: res(RATE_LIMITED, 429) });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    expect(read.reason).toBe('rate-limited');
  });

  it('separates a refusal, an unreachable feed and a cancel', async () => {
    const http = await readGeckoPools(geckoPoolsUrl('eth', 'new'), { fetchImpl: res({}, 500) });
    expect(http).toMatchObject({ status: 'unread', reason: 'http' });

    const net = await readGeckoPools(geckoPoolsUrl('eth', 'new'), {
      fetchImpl: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    expect(net).toMatchObject({ status: 'unread', reason: 'network' });

    const ac = new AbortController();
    ac.abort();
    const cancelled = await readGeckoPools(geckoPoolsUrl('eth', 'new'), {
      signal: ac.signal,
      fetchImpl: vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }),
    });
    expect(cancelled).toMatchObject({ status: 'unread', reason: 'aborted' });
  });

  it('asks nothing when the URL is not a pool list for a network we read', async () => {
    const fetchImpl = res(ETH_NEW);
    const read = await readGeckoPools('https://api.geckoterminal.com/api/v2/networks/arbitrum/new_pools', { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(read).toMatchObject({ status: 'unread', reason: 'schema' });
  });

  it('NEVER rejects', async () => {
    const thrower = vi.fn(() => { throw new Error('sync throw'); }) as unknown as typeof fetch;
    await expect(readGeckoPools(geckoPoolsUrl('eth', 'new'), { fetchImpl: thrower }))
      .resolves.toMatchObject({ status: 'unread' });
  });
});
