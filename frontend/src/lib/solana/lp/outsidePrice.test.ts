import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { readOutsidePrice, PROBE_LAMPORTS, type OwnPoolGuard } from './outsidePrice';
import { POOL_INDEX_MAX, readPoolIndex } from './poolIndex';
import { fakeRpc, PROGRAM } from './testkit.fixture';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** A pool a stubbed Jupiter route goes through. */
const ROUTE_POOL = Keypair.generate().publicKey.toBase58();
/** The chain behind the guard: by default the route pool belongs to some other DEX. */
const guard = (owners: Record<string, string> = { [ROUTE_POOL]: Keypair.generate().publicKey.toBase58() }, fail = false): OwnPoolGuard => ({
  rpc: fakeRpc(Object.fromEntries(Object.entries(owners).map(([k, owner]) => [k, { owner, data: new Uint8Array(8) }])), fail ? { fail: new Set(['getMultipleAccounts']) } : {}),
  programId: PROGRAM.toBase58(),
});

function jupiter(solPerToken: number, feeEachWay = 0.01, decimals = 6, routePlan: unknown = [{ swapInfo: { ammKey: ROUTE_POOL, label: 'Somewhere' }, percent: 100 }]) {
  return vi.fn(async (url: string) => {
    const u = new URL(url, 'http://x');
    const input = u.searchParams.get('inputMint')!;
    const output = u.searchParams.get('outputMint')!;
    const amount = BigInt(u.searchParams.get('amount')!);
    let out: bigint;
    if (input === SOL) out = BigInt(Math.floor((Number(amount) / 1e9 / solPerToken) * 10 ** decimals * (1 - feeEachWay)));
    else out = BigInt(Math.floor((Number(amount) / 10 ** decimals) * solPerToken * 1e9 * (1 - feeEachWay)));
    return new Response(JSON.stringify({ inputMint: input, outputMint: output, inAmount: amount.toString(), outAmount: out.toString(), routePlan }), { status: 200 });
  });
}

describe('readOutsidePrice', () => {
  it('recovers the mid price from a round trip, cancelling the route’s fees', async () => {
    const f = jupiter(0.0042, 0.01);
    const r = await readOutsidePrice(MINT, 6, guard(), f as unknown as typeof fetch);
    expect(r.kind).toBe('ok');
    // A one-way quote would be 1% off; the round trip lands within a hair.
    expect(r.kind === 'ok' && Math.abs(r.solPerToken / 0.0042 - 1)).toBeLessThan(0.001);
    const first = new URL(f.mock.calls[0]![0], 'http://x');
    expect(first.pathname).toBe('/api/jupiter/swap/v1/quote');
    expect(first.searchParams.get('amount')).toBe(PROBE_LAMPORTS.toString());
    // Our own platform fee must not bend the check.
    expect(first.searchParams.has('platformFeeBps')).toBe(false);
  });

  it('no price is "unread", never a number: HTTP error, wrong trade, zero out, thrown fetch', async () => {
    const bad = [
      async () => new Response('{}', { status: 502 }),
      async () => new Response(JSON.stringify({ inputMint: SOL, outputMint: 'other', inAmount: PROBE_LAMPORTS.toString(), outAmount: '5' })),
      async () => new Response(JSON.stringify({ inputMint: SOL, outputMint: MINT, inAmount: PROBE_LAMPORTS.toString(), outAmount: '0' })),
      async () => { throw new Error('offline'); },
    ];
    for (const f of bad) expect((await readOutsidePrice(MINT, 6, guard(), f as unknown as typeof fetch)).kind).toBe('unread');
    expect((await readOutsidePrice(MINT, -1, guard(), jupiter(1) as unknown as typeof fetch)).kind).toBe('unread');
  });

  it('only the proxy\'s 404 NO_ROUTE is "no-route"; a 502 stays "unread"', async () => {
    const noRoute = async () => new Response(JSON.stringify({ error: 'No route', code: 'NO_ROUTE' }), { status: 404 });
    expect(await readOutsidePrice(MINT, 6, guard(), noRoute as unknown as typeof fetch)).toMatchObject({ kind: 'no-route' });
    const down = async () => new Response('{"error":"Upstream service error"}', { status: 502 });
    expect((await readOutsidePrice(MINT, 6, guard(), down as unknown as typeof fetch)).kind).toBe('unread');
  });

  // F5: if Jupiter ever routes through our own pool program, a pushed pool of ours must
  // not become its own "outside" price.
  it('a price that came through a pool our program owns is not an outside price', async () => {
    const r = await readOutsidePrice(MINT, 6, guard({ [ROUTE_POOL]: PROGRAM.toBase58() }), jupiter(0.0042) as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/our own pools/) });
  });

  it('a quote without its route, or a route we could not check, is not an outside price', async () => {
    for (const plan of [null, [], [{ swapInfo: { ammKey: 'nope' } }]]) {
      expect((await readOutsidePrice(MINT, 6, guard(), jupiter(0.0042, 0.01, 6, plan) as unknown as typeof fetch)).kind).toBe('unread');
    }
    expect((await readOutsidePrice(MINT, 6, guard({}, true), jupiter(0.0042) as unknown as typeof fetch)).kind).toBe('unread');
  });
});

describe('readPoolIndex', () => {
  const A = '11111111111111111111111111111111';
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  const P = PROGRAM.toBase58();

  it('accepts only a well-formed answer about the token it asked for', async () => {
    expect(await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: P, pools: [A], truncated: false }))).toEqual({ kind: 'ok', pools: [A], truncated: false });
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: SOL, program: P, pools: [A], truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: P, pools: ['nope'], truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: P, truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, P, (async () => new Response('', { status: 429 })) as unknown as typeof fetch))).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/busy/) });
    expect((await readPoolIndex({ mint: MINT }, P, (async () => new Response('', { status: 404 })) as unknown as typeof fetch))).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/not a token mint/) });
    expect((await readPoolIndex({ mint: 'x' }, P, ok({}))).kind).toBe('unread');
  });

  // S1-R06: the server scans one fixed program; a page reading another must not take its
  // answer as "asked, and there are none".
  it('an answer for a different pool program than the page reads is unread', async () => {
    expect(await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: Keypair.generate().publicKey.toBase58(), pools: [A], truncated: false }))).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/different pool program/) });
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, pools: [A], truncated: false }))).kind).toBe('unread');
  });

  it('takes up to its maximum, and no more', async () => {
    const many = Array.from({ length: POOL_INDEX_MAX + 1 }, () => Keypair.generate().publicKey.toBase58());
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: P, pools: many.slice(0, POOL_INDEX_MAX), truncated: true }))).kind).toBe('ok');
    expect((await readPoolIndex({ mint: MINT }, P, ok({ mint: MINT, program: P, pools: many, truncated: true }))).kind).toBe('unread');
  });
});

// Two holes in the "no route" rule (SPEC_S2 addendum 2.2): each let a failed Jupiter
// read reach a launch pool's own-history check.
describe('readOutsidePrice: only a real "no route" answer is no-route', () => {
  it('a 404 that is not the proxy’s NO_ROUTE answer is unread, with the status', async () => {
    const offList = async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    expect(await readOutsidePrice(MINT, 6, guard(), offList as unknown as typeof fetch)).toEqual({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 404)' });
  });

  it('a 404 with a body that is not JSON is unread', async () => {
    const platform = async () => new Response('<html>The page could not be found</html>', { status: 404 });
    expect((await readOutsidePrice(MINT, 6, guard(), platform as unknown as typeof fetch)).kind).toBe('unread');
  });

  it('a priced buy and then "no route" on the sale back is unread, not no-route', async () => {
    const priced = jupiter(0.0042);
    const f = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      if (u.searchParams.get('inputMint') === SOL) return priced(url);
      return new Response(JSON.stringify({ error: 'No route', code: 'NO_ROUTE' }), { status: 404 });
    });
    expect(await readOutsidePrice(MINT, 6, guard(), f as unknown as typeof fetch)).toEqual({ kind: 'unread', detail: 'Jupiter priced a buy but not the sale back' });
  });
});
