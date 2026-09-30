import { describe, it, expect, vi } from 'vitest';
import { readOutsidePrice, PROBE_LAMPORTS } from './outsidePrice';
import { readPoolIndex } from './poolIndex';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function jupiter(solPerToken: number, feeEachWay = 0.01, decimals = 6) {
  return vi.fn(async (url: string) => {
    const u = new URL(url, 'http://x');
    const input = u.searchParams.get('inputMint')!;
    const output = u.searchParams.get('outputMint')!;
    const amount = BigInt(u.searchParams.get('amount')!);
    let out: bigint;
    if (input === SOL) out = BigInt(Math.floor((Number(amount) / 1e9 / solPerToken) * 10 ** decimals * (1 - feeEachWay)));
    else out = BigInt(Math.floor((Number(amount) / 10 ** decimals) * solPerToken * 1e9 * (1 - feeEachWay)));
    return new Response(JSON.stringify({ inputMint: input, outputMint: output, inAmount: amount.toString(), outAmount: out.toString() }), { status: 200 });
  });
}

describe('readOutsidePrice', () => {
  it('recovers the mid price from a round trip, cancelling the route’s fees', async () => {
    const f = jupiter(0.0042, 0.01);
    const r = await readOutsidePrice(MINT, 6, f as unknown as typeof fetch);
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
    for (const f of bad) expect((await readOutsidePrice(MINT, 6, f as unknown as typeof fetch)).kind).toBe('unread');
    expect((await readOutsidePrice(MINT, -1, jupiter(1) as unknown as typeof fetch)).kind).toBe('unread');
  });
});

describe('readPoolIndex', () => {
  const A = '11111111111111111111111111111111';
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('accepts only a well-formed answer about the token it asked for', async () => {
    expect(await readPoolIndex({ mint: MINT }, ok({ mint: MINT, pools: [A], truncated: false }))).toEqual({ kind: 'ok', pools: [A], truncated: false });
    expect((await readPoolIndex({ mint: MINT }, ok({ mint: SOL, pools: [A], truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, ok({ mint: MINT, pools: ['nope'], truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, ok({ mint: MINT, truncated: false }))).kind).toBe('unread');
    expect((await readPoolIndex({ mint: MINT }, (async () => new Response('', { status: 429 })) as unknown as typeof fetch))).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/busy/) });
    expect((await readPoolIndex({ mint: 'x' }, ok({}))).kind).toBe('unread');
  });
});
