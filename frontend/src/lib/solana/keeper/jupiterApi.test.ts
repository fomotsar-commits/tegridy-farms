// @vitest-environment node
//
// The keeper's own Jupiter client: its own key (never the site's), its own pace, and the
// instructions it hands back for the checks in plan.ts.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { JUPITER_KEYED_BASE, JUPITER_KEYLESS_BASE, jupiterApi, refusedVenues } from './jupiterApi';
import { RAYDIUM_PROGRAMS } from './plan';

function recorder(answer: (url: string) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const quoteArgs = { inputMint: 'A', outputMint: 'B', amount: 123n, slippageBps: 50, excludeDexes: ['Raydium', 'Raydium CLMM'], maxAccounts: 30 };

describe('jupiterApi', () => {
  it('uses the keyed host with the key, and the keyless one without', async () => {
    const keyed = recorder(() => ({ body: {} }));
    await jupiterApi({ key: ' k1 ', fetchImpl: keyed.fetchImpl, gapMs: 0 }).quote(quoteArgs);
    expect(keyed.calls[0]!.url.startsWith(`${JUPITER_KEYED_BASE}/swap/v1/quote?`)).toBe(true);
    expect((keyed.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('k1');

    const keyless = recorder(() => ({ body: {} }));
    await jupiterApi({ fetchImpl: keyless.fetchImpl, gapMs: 0 }).quote(quoteArgs);
    expect(keyless.calls[0]!.url.startsWith(`${JUPITER_KEYLESS_BASE}/swap/v1/quote?`)).toBe(true);
    expect((keyless.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('asks for an exact-in, V2 quote that leaves the refused venues out', async () => {
    const r = recorder(() => ({ body: {} }));
    await jupiterApi({ fetchImpl: r.fetchImpl, gapMs: 0 }).quote(quoteArgs);
    const q = new URL(r.calls[0]!.url).searchParams;
    expect(q.get('amount')).toBe('123');
    expect(q.get('swapMode')).toBe('ExactIn');
    expect(q.get('instructionVersion')).toBe('V2');
    expect(q.get('excludeDexes')).toBe('Raydium,Raydium CLMM');
    expect(q.get('maxAccounts')).toBe('30');
  });

  it('spaces its calls, so a free key’s one request a second holds', async () => {
    let clock = 0;
    const slept: number[] = [];
    const r = recorder(() => ({ body: {} }));
    const api = jupiterApi({ fetchImpl: r.fetchImpl, gapMs: 1100, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
    await api.quote(quoteArgs);
    clock += 300;
    await api.labels();
    expect(slept).toEqual([800]);
  });

  it('says Jupiter’s own reason for a refusal', async () => {
    const r = recorder(() => ({ status: 400, body: { error: 'No routes found', errorCode: 'NO_ROUTES_FOUND' } }));
    await expect(jupiterApi({ fetchImpl: r.fetchImpl, gapMs: 0 }).quote(quoteArgs)).rejects.toThrow('answered 400 (NO_ROUTES_FOUND)');
  });

  it('hands back the swap instruction, its lookup tables, and a count of anything else Jupiter added', async () => {
    const user = Keypair.generate().publicKey;
    const wire = { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [{ pubkey: user.toBase58(), isSigner: true, isWritable: false }], data: Buffer.from([1, 2, 3]).toString('base64') };
    const r = recorder(() => ({ body: { swapInstruction: wire, addressLookupTableAddresses: ['T1'], cleanupInstruction: wire, otherInstructions: [wire] } }));
    const si = await jupiterApi({ fetchImpl: r.fetchImpl, gapMs: 0 }).swapInstructions({ inputMint: 'A' } as never, user);
    expect([...si.swap.data]).toEqual([1, 2, 3]);
    expect(si.swap.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(si.lookupTables).toEqual(['T1']);
    expect(si.extra).toBe(2);
    const body = JSON.parse(String(r.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.wrapAndUnwrapSol).toBe(false);
    expect(body.useSharedAccounts).toBe(false);
  });

  it('reads USD prices, skipping coins without one', async () => {
    const r = recorder(() => ({ body: { A: { usdPrice: 2 }, B: null, C: { usdPrice: 'x' } } }));
    expect(await jupiterApi({ fetchImpl: r.fetchImpl, gapMs: 0 }).prices(['A', 'B', 'C', 'A'])).toEqual({ A: 2 });
    expect(new URL(r.calls[0]!.url).searchParams.get('ids')).toBe('A,B,C');
  });
});

describe('refusedVenues', () => {
  it('is every venue whose name says Raydium, by name and by program', () => {
    const r = refusedVenues({ P1: 'Raydium', P2: 'Raydium CLMM', P3: 'Orca V2', P4: 'raydium cp', P5: 'Meteora DLMM' });
    expect(r.names).toEqual(['Raydium', 'Raydium CLMM', 'raydium cp']);
    expect([...r.programs].sort()).toEqual([...RAYDIUM_PROGRAMS, 'P1', 'P2', 'P4'].sort());
  });

  it('refuses nothing when the owner allows Raydium for the keeper', () => {
    const r = refusedVenues({ P1: 'Raydium' }, true);
    expect(r.names).toEqual([]);
    expect(r.programs.size).toBe(0);
  });

  it('refuses Raydium’s known programs even when Jupiter’s list names none', () => {
    const r = refusedVenues({});
    expect(r.names).toEqual([]);
    expect([...r.programs].sort()).toEqual([...RAYDIUM_PROGRAMS].sort());
  });
});
