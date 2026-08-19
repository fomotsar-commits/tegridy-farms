// Guard for the readers — the network boundary.
//
// One rule, restated for every source: a reader may return `{ status: 'ok' }`
// ONLY when it actually read something. A timeout, a 502, an off-schema body, a
// throttled explorer key and an unconfigured indexer must all come back as
// `unavailable` with a reason, because the alternative — an empty-but-successful
// shape — is indistinguishable from a calm market by the time it reaches the UI.
//
// The sweep at the bottom is the guard that survives refactors: for every rule
// kind, a source that throws must produce `unavailable`, and no reader may ever
// answer `ok` with an empty payload it did not earn.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level binding, so the doubles
// they close over have to be hoisted too.
const H = vi.hoisted(() => {
  class FakeHeatUnavailable extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'HeatUnavailableError';
    }
  }
  return {
    fetchHeatMock: vi.fn(),
    fetchLaunchRadarMock: vi.fn(),
    fetchLauncherOutcomesMock: vi.fn(),
    FakeHeatUnavailable,
  };
});

const { fetchHeatMock, fetchLaunchRadarMock, fetchLauncherOutcomesMock, FakeHeatUnavailable } = H;

vi.mock('../heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => H.fetchHeatMock(...args),
  HeatUnavailableError: H.FakeHeatUnavailable,
}));
vi.mock('../launcher/radarClient', () => ({
  fetchLaunchRadar: (...args: unknown[]) => H.fetchLaunchRadarMock(...args),
}));
vi.mock('../launcher/outcomesClient', () => ({
  fetchLauncherOutcomes: (...args: unknown[]) => H.fetchLauncherOutcomesMock(...args),
}));

import {
  READERS,
  readAll,
  readDeployerReputation,
  readHeatTier,
  readIndexedKind,
  readLaunchLive,
  reputationSignature,
} from './readers';
import { ALERT_RULE_KINDS, type AlertRule, type AlertRuleKind } from './rules';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;
const NOW = Math.floor(Date.now() / 1000);

function rule(kind: AlertRuleKind): AlertRule {
  return {
    id: `r-${kind}`,
    kind,
    subject: SUBJECT,
    threshold: kind === 'whale-move' ? 1000 : null,
    enabled: true,
    createdAt: 0,
  };
}

function heatReading(over: Record<string, unknown> = {}) {
  return {
    address: SUBJECT,
    degrees: 160,
    tier: 'Builder',
    isCold: false,
    heldSinceUnix: NOW - 100_000,
    asOfUnix: NOW - 600,
    tokenCount: 3,
    breakdown: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('heat-tier', () => {
  it('a reading becomes an ok fact carrying the island’s own as-of time', async () => {
    fetchHeatMock.mockResolvedValue(heatReading());
    const result = await readHeatTier(rule('heat-tier'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.observedAt).toBe(NOW - 600);
      expect(result.value.kind).toBe('heat-tier');
    }
  });

  it('asks for a FRESH read — a change rule comparing two cached copies proves nothing', async () => {
    fetchHeatMock.mockResolvedValue(heatReading());
    await readHeatTier(rule('heat-tier'));
    expect(fetchHeatMock.mock.calls[0]![1]).toMatchObject({ fresh: true });
  });

  it('an unreachable oracle is unavailable, never a Drifter reading', async () => {
    fetchHeatMock.mockRejectedValue(new FakeHeatUnavailable('The instrument is unreachable.'));
    const result = await readHeatTier(rule('heat-tier'));
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.detail).toMatch(/unreachable/i);
      expect(result.detail).not.toMatch(/drifter/i);
    }
  });

  it('a reading the island would not certify is marked stale rather than compared', async () => {
    fetchHeatMock.mockResolvedValue(heatReading({ asOfUnix: NOW - 40 * 86_400 }));
    const result = await readHeatTier(rule('heat-tier'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok' && result.value.kind === 'heat-tier') {
      expect(result.value.change.staleDetail).toBeTruthy();
    }
  });

  it('an unexpected throw is still unavailable, not a crash and not a zero', async () => {
    fetchHeatMock.mockRejectedValue(new TypeError('boom'));
    expect((await readHeatTier(rule('heat-tier'))).status).toBe('unavailable');
  });
});

describe('launch-live', () => {
  it('maps radar entries into launch facts', async () => {
    fetchLaunchRadarMock.mockResolvedValue({
      observedAt: NOW,
      entries: [{ token: SUBJECT, pool: '0x1111111111111111111111111111111111111111', launchedAt: NOW - 30, name: 'X' }],
    });
    const result = await readLaunchLive(rule('launch-live'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok' && result.value.kind === 'launch-live') {
      expect(result.value.launches).toHaveLength(1);
    }
  });

  it('a feed failure is an outage, and says so in those words', async () => {
    fetchLaunchRadarMock.mockRejectedValue(new Error('502'));
    const result = await readLaunchLive(rule('launch-live'));
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.detail).toMatch(/outage, not an absence of launches/i);
    }
  });
});

describe('deployer-reputation', () => {
  const TXLIST_OK = {
    status: '1',
    message: 'OK',
    result: [
      { to: '', contractAddress: '0x1111111111111111111111111111111111111111', hash: '0xaaa', timeStamp: String(NOW - 1000), from: SUBJECT },
    ],
  };

  it('an explorer HTTP failure is unavailable', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response);
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('unavailable');
  });

  it('a NOTOK envelope inside a 200 is unavailable — not an empty creation history', async () => {
    // Etherscan reports failure inside a 200 body. Reading that as "this address
    // created nothing" would manufacture a claim about somebody's address out of
    // our own missing or throttled API key.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }),
        }) as unknown as Response,
    );
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail.length).toBeGreaterThan(20);
  });

  it('a rate-limit envelope is unavailable and says to retry', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }),
        }) as unknown as Response,
    );
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toMatch(/rate-limiting/i);
  });

  it('a genuine empty history IS a real answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) }) as unknown as Response,
    );
    fetchLauncherOutcomesMock.mockResolvedValue({ outcomes: {} });
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('ok');
  });

  it('enrichment failing does not invalidate discovery', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => TXLIST_OK }) as unknown as Response);
    fetchLauncherOutcomesMock.mockRejectedValue(new Error('down'));
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('ok');
  });

  it('the signature is built from counts, not from an invented score', () => {
    const sig = reputationSignature({ created: 2, activeMarket: 1, thinMarket: 0, noMarket: 1, unobserved: 0 }, 'low');
    expect(sig).toBe('c2/a1/t0/n1/u0@low');
    expect(sig).not.toMatch(/score/i);
  });
});

describe('the indexed kinds are dark, and say so', () => {
  it('an unconfigured indexer produces the registry’s reason', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    for (const kind of ['whale-move', 'lp-unlock'] as const) {
      const result = readIndexedKind(rule(kind));
      expect(result.status, kind).toBe('unavailable');
      if (result.status === 'unavailable') {
        expect(result.detail).toMatch(/not the same as there being nothing to report/i);
      }
    }
  });

  it('a CONFIGURED indexer with no query wired still refuses to claim a read', () => {
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example.com');
    const result = readIndexedKind(rule('whale-move'));
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.detail).toMatch(/missing implementation, not a quiet market/i);
    }
  });

  it('no substitute source is silently used in the indexer’s place', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    readIndexedKind(rule('whale-move'));
    expect(fetchLaunchRadarMock).not.toHaveBeenCalled();
    expect(fetchHeatMock).not.toHaveBeenCalled();
  });
});

describe('readAll', () => {
  it('a reader that throws becomes an unavailable reading, not a lost rule', async () => {
    fetchHeatMock.mockImplementation(() => {
      throw new Error('sync throw');
    });
    const readings = await readAll([rule('heat-tier')]);
    expect(readings['r-heat-tier']!.status).toBe('unavailable');
  });

  it('every rule gets a reading, and one failure does not empty the pass', async () => {
    fetchHeatMock.mockResolvedValue(heatReading());
    fetchLaunchRadarMock.mockRejectedValue(new Error('down'));
    const readings = await readAll([rule('heat-tier'), rule('launch-live')]);
    expect(Object.keys(readings).sort()).toEqual(['r-heat-tier', 'r-launch-live']);
    expect(readings['r-heat-tier']!.status).toBe('ok');
    expect(readings['r-launch-live']!.status).toBe('unavailable');
  });

  it('every kind has a reader', () => {
    for (const kind of ALERT_RULE_KINDS) expect(typeof READERS[kind], kind).toBe('function');
  });

  it('sweep: a failing source never produces an ok reading, for any kind', async () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    fetchHeatMock.mockRejectedValue(new FakeHeatUnavailable('down'));
    fetchLaunchRadarMock.mockRejectedValue(new Error('down'));
    fetchLauncherOutcomesMock.mockRejectedValue(new Error('down'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    for (const kind of ALERT_RULE_KINDS) {
      const reading = await READERS[kind](rule(kind), { fetchImpl });
      expect(reading.status, kind).toBe('unavailable');
      if (reading.status === 'unavailable') {
        expect(reading.detail.length, kind).toBeGreaterThan(20);
      }
    }
  });
});
