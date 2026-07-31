import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PublicClient } from 'viem';
import { fetchCohortAssets, cohortLogClient, CohortUnavailableError } from './cohortLogSource';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

// THE INVARIANT: an unreadable launch history must THROW, never resolve to []. The caller
// renders an empty cohort as "nothing has launched yet" — so a silent [] on failure turns
// an outage into a fabricated track record, which is the exact defect class these surfaces
// exist to avoid.
describe('fetchCohortAssets — failure is never an empty cohort', () => {
  it('returns the addresses on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [A, B] })));
    await expect(fetchCohortAssets()).resolves.toEqual([A, B]);
  });

  it('an genuinely empty history resolves to [] (this one IS "nothing launched")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [] })));
    await expect(fetchCohortAssets()).resolves.toEqual([]);
  });

  it('THROWS on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response));
    await expect(fetchCohortAssets()).rejects.toBeInstanceOf(CohortUnavailableError);
  });

  it('THROWS when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(fetchCohortAssets()).rejects.toBeInstanceOf(CohortUnavailableError);
  });

  it('THROWS when the body has no asset list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'nope' })));
    await expect(fetchCohortAssets()).rejects.toBeInstanceOf(CohortUnavailableError);
  });

  it('THROWS when a non-empty list decodes to nothing (corruption, not emptiness)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: ['garbage', 42, null] })));
    await expect(fetchCohortAssets()).rejects.toBeInstanceOf(CohortUnavailableError);
  });

  it('drops individual malformed entries when others are valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [A, 'garbage', B] })));
    await expect(fetchCohortAssets()).resolves.toEqual([A, B]);
  });
});

describe('cohortLogClient', () => {
  it('serves getLogs from the endpoint, shaped as readOurLaunches expects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [A, B] })));
    const wrapped = cohortLogClient({ multicall: async () => 'MC' } as unknown as PublicClient);
    const logs = await wrapped.getLogs({} as never);
    expect(logs).toEqual([{ args: { asset: A } }, { args: { asset: B } }]);
  });

  it('DELEGATES every other method — multicall must survive the wrap', async () => {
    // A plain object spread drops viem client methods that live on the prototype or behind
    // getters; losing multicall would silently break the provenance half.
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [] })));
    const base = Object.create({ multicall: async () => 'FROM_PROTOTYPE' }) as PublicClient;
    const wrapped = cohortLogClient(base);
    await expect((wrapped as unknown as { multicall: () => Promise<string> }).multicall()).resolves.toBe('FROM_PROTOTYPE');
  });

  it('propagates the failure rather than yielding an empty log set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
    const wrapped = cohortLogClient({} as PublicClient);
    await expect(wrapped.getLogs({} as never)).rejects.toBeInstanceOf(CohortUnavailableError);
  });
});

// INTEGRATION: the wrapped client fed to the REAL readOurLaunches.
//
// The unit tests above all passed while the page wiring was broken: I first drove the
// "couldn't read" banner off a try/catch, but readOurLaunches NEVER throws — it degrades
// to an empty result and reports `complete: false`. The catch was dead code, so an outage
// would have rendered as "nothing has launched". Unit-green, integration-broken. These
// pin the contract that actually matters: a failing log source must yield complete=false.
describe('cohortLogClient + readOurLaunches — a failing log source is INCOMPLETE, not empty', () => {
  const multicallOnly = { multicall: async () => [] } as unknown as PublicClient;

  it('reports complete=false when the log source is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response));
    const { readOurLaunches } = await import('./ourLaunches');
    const r = await readOurLaunches({ client: cohortLogClient(multicallOnly) });
    expect(r.baselines).toEqual([]);
    // The whole point: empty AND incomplete, so the caller can say "couldn't read".
    expect(r.complete).toBe(false);
  });

  it('reports complete=true for a genuinely empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ assets: [] })));
    const { readOurLaunches } = await import('./ourLaunches');
    const r = await readOurLaunches({ client: cohortLogClient(multicallOnly) });
    expect(r.baselines).toEqual([]);
    expect(r.complete).toBe(true);
  });
});
