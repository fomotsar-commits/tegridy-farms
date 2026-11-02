// Island answer twenty-four, build 1: one price loop for everyone. A page reads the shared
// list (api/outside-prices.js) and never asks Jupiter for a listed token; a price up to ten
// minutes old passes; only a token with no price in ten minutes holds, in one row; a token
// the list does not carry, a list that does not answer, and a fresh read use the two quotes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  __resetSharedPrices,
  fromShared,
  listedUsdPrices,
  readAgo,
  readListedOrOutsidePrice,
  readSharedPrices,
  FRESH_FOR_MS,
  SHARED_FOR_MS,
  type OwnPoolGuard,
  type SharedPrices,
} from './outsidePrice';
import { fakeRpc, PROGRAM } from './testkit.fixture';

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const UNLISTED = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ROUTE_POOL = Keypair.generate().publicKey.toBase58();
const MIN = 60_000;

const guard = (): OwnPoolGuard => ({
  rpc: fakeRpc({ [ROUTE_POOL]: { owner: Keypair.generate().publicKey.toBase58(), data: new Uint8Array(8) } }),
  programId: PROGRAM.toBase58(),
});

/** A fetch that answers the shared list as given, and Jupiter's quote for anything else. */
function world(list: SharedPrices | 'down' | 'not-json') {
  const calls: string[] = [];
  const f = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith('/api/outside-prices')) {
      if (list === 'down') return new Response('down', { status: 502 });
      if (list === 'not-json') return new Response('<html>', { status: 200 });
      return new Response(JSON.stringify(list), { status: 200 });
    }
    const u = new URL(url, 'http://x');
    const input = u.searchParams.get('inputMint')!;
    const output = u.searchParams.get('outputMint')!;
    const amount = BigInt(u.searchParams.get('amount')!);
    const out = input === SOL ? BigInt(Math.floor((Number(amount) / 1e9 / 0.0042) * 1e6)) : BigInt(Math.floor((Number(amount) / 1e6) * 0.0042 * 1e9));
    return new Response(JSON.stringify({ inputMint: input, outputMint: output, inAmount: amount.toString(), outAmount: out.toString(), routePlan: [{ swapInfo: { ammKey: ROUTE_POOL } }] }), { status: 200 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const listWith = (entry: SharedPrices['prices'][string], mint = BAYLA, readAt = Date.now()): SharedPrices => ({ read_at: readAt, prices: { [mint]: entry } });

beforeEach(() => __resetSharedPrices());

describe('fromShared: the list’s entry as a price', () => {
  const now = 1_762_000_000_000;
  it('a price five minutes old passes, with when it was read', () => {
    const r = fromShared({ state: 'ok', sol_per_token: 7.5e-6, read_at: now - 5 * MIN }, BAYLA, now);
    expect(r).toEqual({ kind: 'ok', solPerToken: 7.5e-6, source: 'Jupiter', readAtMs: now - 5 * MIN });
  });
  it('ten minutes is the line: a price a second past it is the one-row hold', () => {
    expect(fromShared({ state: 'ok', sol_per_token: 7.5e-6, read_at: now - FRESH_FOR_MS }, BAYLA, now)?.kind).toBe('ok');
    __resetSharedPrices();
    const r = fromShared({ state: 'ok', sol_per_token: 7.5e-6, read_at: now - FRESH_FOR_MS - 1000 }, BAYLA, now);
    expect(r).toEqual({ kind: 'unread', detail: 'Outside price not read for 10 min; adding waits', hold: true });
  });
  it('a token the loop could not read is still a price while its last good read is under ten minutes old', () => {
    const r = fromShared({ state: 'unread', detail: 'HTTP 429', last: { sol_per_token: 7.4e-6, read_at: now - 4 * MIN } }, BAYLA, now);
    expect(r).toEqual({ kind: 'ok', solPerToken: 7.4e-6, source: 'Jupiter', readAtMs: now - 4 * MIN });
  });
  it('none for eleven minutes is the one-row hold, in the island’s words', () => {
    const r = fromShared({ state: 'unread', detail: 'HTTP 429', last: { sol_per_token: 7.4e-6, read_at: now - 11 * MIN } }, BAYLA, now);
    expect(r).toEqual({ kind: 'unread', detail: 'Outside price not read for 11 min; adding waits', hold: true });
  });
  it('with no read at all, the hold says why', () => {
    const r = fromShared({ state: 'unread', detail: 'Jupiter did not answer', last: null }, BAYLA, now);
    expect(r).toEqual({ kind: 'unread', detail: 'Outside price not read (Jupiter did not answer); adding waits', hold: true });
  });
  it('this tab remembers a good read, so a later list with none still passes inside ten minutes', () => {
    expect(fromShared({ state: 'ok', sol_per_token: 7.5e-6, read_at: now - 2 * MIN }, BAYLA, now)?.kind).toBe('ok');
    const later = fromShared({ state: 'unread', detail: 'HTTP 502', last: null }, BAYLA, now + 6 * MIN);
    expect(later).toEqual({ kind: 'ok', solPerToken: 7.5e-6, source: 'Jupiter', readAtMs: now - 2 * MIN });
    const much = fromShared({ state: 'unread', detail: 'HTTP 502', last: null }, BAYLA, now + 9 * MIN);
    expect(much).toEqual({ kind: 'unread', detail: 'Outside price not read for 11 min; adding waits', hold: true });
  });
  it('Jupiter’s no-route is the answer no-route; a token the list does not carry is null', () => {
    expect(fromShared({ state: 'no-route', read_at: now }, BAYLA, now)).toEqual({ kind: 'no-route', detail: 'Jupiter has no route for this token' });
    expect(fromShared(undefined, BAYLA, now)).toBeNull();
  });
  it('a nonsense price is never ok', () => {
    expect(fromShared({ state: 'ok', sol_per_token: 0, read_at: now }, BAYLA, now)?.kind).toBe('unread');
    expect(fromShared({ state: 'ok', sol_per_token: Number.NaN, read_at: now }, BAYLA, now)?.kind).toBe('unread');
  });
  it('says the age as a row does', () => {
    expect(readAgo(now - 40_000, now)).toBe('read 40 s ago');
    expect(readAgo(now - 3 * MIN, now)).toBe('read 3 min ago');
    expect(readAgo(now + 5000, now)).toBe('read 0 s ago');
  });
});

describe('listedUsdPrices: the list\'s dollar prices for the $ figures', () => {
  const now = Date.now();
  const list = (usd: Record<string, number> | null, usdAt: number | null = now): SharedPrices => ({ read_at: now, prices: {}, usd, usd_read_at: usdAt });
  it('every mint asked for, under ten minutes old: the prices; else null, and the caller reads price/v3', async () => {
    const w = world(list({ [BAYLA]: 0.001, [SOL]: 180 }));
    expect(await listedUsdPrices([BAYLA, SOL], w.f)).toEqual({ [BAYLA]: 0.001, [SOL]: 180 });
    expect(await listedUsdPrices([BAYLA, UNLISTED], w.f)).toBeNull();
    __resetSharedPrices();
    expect(await listedUsdPrices([BAYLA], world(list({ [BAYLA]: 0.001 }, now - 11 * MIN)).f)).toBeNull();
    __resetSharedPrices();
    expect(await listedUsdPrices([BAYLA], world(list(null)).f)).toBeNull();
    __resetSharedPrices();
    expect(await listedUsdPrices([BAYLA], world(list({ [BAYLA]: 0 })).f)).toBeNull();
    expect(await listedUsdPrices([], w.f)).toEqual({});
  });
});

describe('readListedOrOutsidePrice: what a page reads', () => {
  it('a listed token comes from the list, and Jupiter is not asked', async () => {
    const w = world(listWith({ state: 'ok', sol_per_token: 7.5e-6, read_at: Date.now() - 40_000 }));
    const r = await readListedOrOutsidePrice(BAYLA, 6, guard(), w.f);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.solPerToken).toBe(7.5e-6);
    expect(w.calls).toEqual(['/api/outside-prices']);
  });
  it('many tokens share one list read in flight, and the list is asked again only after its time', async () => {
    const w = world({ read_at: Date.now(), prices: { [BAYLA]: { state: 'ok', sol_per_token: 7.5e-6, read_at: Date.now() }, [UNLISTED]: { state: 'ok', sol_per_token: 0.0055, read_at: Date.now() } } });
    await Promise.all([readListedOrOutsidePrice(BAYLA, 6, guard(), w.f), readListedOrOutsidePrice(UNLISTED, 6, guard(), w.f), readListedOrOutsidePrice(BAYLA, 6, guard(), w.f)]);
    expect(w.calls.filter((c) => c.startsWith('/api/outside-prices'))).toHaveLength(1);
    const second = await readSharedPrices(w.f, Date.now() + SHARED_FOR_MS + 1);
    expect(second?.prices[BAYLA]?.state).toBe('ok');
    expect(w.calls.filter((c) => c.startsWith('/api/outside-prices'))).toHaveLength(2);
  });
  it('a token the list does not carry is read with the two quotes, as before', async () => {
    const w = world(listWith({ state: 'ok', sol_per_token: 7.5e-6, read_at: Date.now() }));
    const r = await readListedOrOutsidePrice(UNLISTED, 6, guard(), w.f);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && Math.abs(r.solPerToken / 0.0042 - 1)).toBeLessThan(0.001);
    expect(r.kind === 'ok' && r.readAtMs).toBeUndefined();
    expect(w.calls.filter((c) => c.includes('/quote?'))).toHaveLength(2);
  });
  it('a list that is down, or not JSON, falls back to the two quotes and is asked again next time', async () => {
    for (const state of ['down', 'not-json'] as const) {
      __resetSharedPrices();
      const w = world(state);
      const r = await readListedOrOutsidePrice(BAYLA, 6, guard(), w.f);
      expect(r.kind).toBe('ok');
      expect(w.calls.filter((c) => c.includes('/quote?'))).toHaveLength(2);
      await readListedOrOutsidePrice(BAYLA, 6, guard(), w.f);
      expect(w.calls.filter((c) => c.startsWith('/api/outside-prices'))).toHaveLength(2);
    }
  });
  it('a fresh read (Review) never reads the list: it asks Jupiter itself', async () => {
    const w = world(listWith({ state: 'ok', sol_per_token: 7.5e-6, read_at: Date.now() }));
    const r = await readListedOrOutsidePrice(BAYLA, 6, guard(), w.f, undefined, { fresh: true });
    expect(r.kind).toBe('ok');
    expect(w.calls.some((c) => c.startsWith('/api/outside-prices'))).toBe(false);
    expect(w.calls.filter((c) => c.includes('/quote?') && !c.includes('priceCheck'))).toHaveLength(2);
  });
  it('the list’s hold is the answer for a listed token: no quote is made to get round it', async () => {
    const w = world(listWith({ state: 'unread', detail: 'HTTP 429', last: { sol_per_token: 7.5e-6, read_at: Date.now() - 12 * MIN } }));
    const r = await readListedOrOutsidePrice(BAYLA, 6, guard(), w.f);
    expect(r).toEqual({ kind: 'unread', detail: 'Outside price not read for 12 min; adding waits', hold: true });
    expect(w.calls).toEqual(['/api/outside-prices']);
  });
});
