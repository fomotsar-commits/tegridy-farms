import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import {
  fetchLauncherOutcomes,
  coerceResponseForTest,
  LAUNCHER_OUTCOMES_ENDPOINT,
  type LauncherOutcomesResponse,
} from './outcomesClient';
import type { LaunchBaseline } from './outcomesReader';

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address;
const POOL_A = '0x00000000000000000000000000000000000000ff' as Address;

function baseline(): LaunchBaseline {
  return {
    token: TOKEN_A,
    tier: 'flagship',
    creator: null,
    launchedAt: 1_800_000_000,
    launchPriceEth: 0.001,
    launchLiquidityEth: 10,
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchLauncherOutcomes', () => {
  it('POSTs the baselines as JSON to the catchall resource route', async () => {
    const payload: LauncherOutcomesResponse = { launches: [], outcomes: {} };
    const fetchImpl = vi.fn(async () => okResponse(payload));

    await fetchLauncherOutcomes({ baselines: [baseline()], fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(LAUNCHER_OUTCOMES_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent.baselines).toHaveLength(1);
    expect(sent.baselines[0].token).toBe(TOKEN_A);
    // poolByToken omitted when not supplied
    expect('poolByToken' in sent).toBe(false);
  });

  it('includes poolByToken in the body when supplied', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ launches: [], outcomes: {} }));
    await fetchLauncherOutcomes({
      baselines: [baseline()],
      poolByToken: { [TOKEN_A]: POOL_A },
      fetchImpl,
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.poolByToken[TOKEN_A]).toBe(POOL_A);
  });

  it('forwards the abort signal', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ launches: [], outcomes: {} }));
    const controller = new AbortController();
    await fetchLauncherOutcomes({ baselines: [], signal: controller.signal, fetchImpl });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it('honors a custom endpoint override', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ launches: [], outcomes: {} }));
    await fetchLauncherOutcomes({ baselines: [], endpoint: '/custom', fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe('/custom');
  });

  it('returns the parsed launches + outcomes on success', async () => {
    const body: LauncherOutcomesResponse = {
      launches: [
        {
          token: TOKEN_A,
          tier: 'flagship',
          launchedAt: 1_800_000_000,
          uniqueBuyers24h: 12,
          liquidityEth: 9,
          feeRevenueEth24h: 0,
          holderCount: 40,
        },
      ],
      outcomes: {
        [TOKEN_A]: {
          token: TOKEN_A,
          tier: 'flagship',
          launchedAt: 1_800_000_000,
          observedAt: 1_800_100_000,
          priceEth: 0.0012,
          launchPriceEth: 0.001,
          liquidityEth: 9,
          launchLiquidityEth: 10,
          holderCount: 40,
          unlocks: [],
          lastTeamActivityAt: null,
          marketObserved: true,
        },
      },
    };
    const fetchImpl = vi.fn(async () => okResponse(body));
    const out = await fetchLauncherOutcomes({ baselines: [baseline()], fetchImpl });
    expect(out.launches).toHaveLength(1);
    expect(out.outcomes[TOKEN_A]?.priceEth).toBe(0.0012);
  });

  it('throws on a non-2xx HTTP status', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response,
    );
    await expect(fetchLauncherOutcomes({ baselines: [], fetchImpl })).rejects.toThrow(/502/);
  });

  it('propagates a network rejection (e.g. abort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(fetchLauncherOutcomes({ baselines: [], fetchImpl })).rejects.toThrow(
      /network down/,
    );
  });

  it('coerces a malformed-but-200 body into a well-formed empty shape', async () => {
    // Missing/garbage fields must never reach the UI as undefined.
    const fetchImpl = vi.fn(async () => okResponse({ launches: 'nope', outcomes: null }));
    const out = await fetchLauncherOutcomes({ baselines: [], fetchImpl });
    expect(out.launches).toEqual([]);
    expect(out.outcomes).toEqual({});
  });
});

describe('coerceResponse', () => {
  it('defaults both fields when body is null/empty', () => {
    expect(coerceResponseForTest(null)).toEqual({ launches: [], outcomes: {} });
    expect(coerceResponseForTest(undefined)).toEqual({ launches: [], outcomes: {} });
    expect(coerceResponseForTest({})).toEqual({ launches: [], outcomes: {} });
  });

  it('rejects an array in the outcomes slot (arrays are not the record shape)', () => {
    expect(coerceResponseForTest({ outcomes: [] }).outcomes).toEqual({});
  });

  it('passes through well-formed fields', () => {
    const r = coerceResponseForTest({ launches: [{ token: TOKEN_A }], outcomes: { x: 1 } });
    expect(r.launches).toHaveLength(1);
    expect(r.outcomes).toEqual({ x: 1 });
  });
});
