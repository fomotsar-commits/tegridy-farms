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
  newReaderPass,
  readAll,
  readDeployerReputation,
  readHeatTier,
  readIndexedKind,
  readLaunchLive,
  readPoolLargeTrade,
  readPoolPrice,
  reputationSignature,
} from './readers';
import { ALERT_RULE_KINDS, SUBJECT_SHAPE, type AlertRule, type AlertRuleKind } from './rules';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;
const POOL_ID = '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0';
const POOL = `base:${POOL_ID}`;
const NOW = Math.floor(Date.now() / 1000);

function rule(kind: AlertRuleKind, over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: `r-${kind}`,
    kind,
    // A subject of the shape this kind actually takes, so the sweep at the bottom
    // exercises each reader's real network path rather than tripping every pool
    // reader on a malformed subject before it gets there.
    subject: SUBJECT_SHAPE[kind] === 'pool' ? POOL : SUBJECT,
    threshold: kind === 'whale-move' || SUBJECT_SHAPE[kind] === 'pool' ? 1000 : null,
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

/** A `fetch` double that answers each URL from a table and counts every call. */
function stubFetch(routes: { match: RegExp; body: unknown; status?: number }[]) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) throw new Error(`unrouted fetch: ${url}`);
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      json: async () => hit.body,
    } as unknown as Response;
  });
}

/** One `pools/multi` row, in GeckoTerminal's JSON:API shape. */
function poolRow(over: Record<string, unknown> = {}) {
  return {
    id: `base_${POOL_ID}`,
    attributes: {
      address: POOL_ID,
      name: 'QR / WETH',
      base_token_price_usd: '1.5',
      reserve_in_usd: '250000',
      ...over,
    },
    relationships: { base_token: { data: { id: `base_${SUBJECT}` } } },
  };
}

/** One trades-feed row. */
function tradeRow(over: Record<string, unknown> = {}) {
  return {
    attributes: {
      block_timestamp: '2026-09-02T10:00:00Z',
      kind: 'buy',
      tx_hash: '0xfeed',
      volume_in_usd: '9000',
      to_token_amount: '5',
      ...over,
    },
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

  // THE FABRICATED FIRE, pinned. The signature is built from classification
  // counts, and a token with no market reading classifies as `unobserved`. The
  // old code swallowed an enrichment failure into `outcomes = {}`, so every
  // creation degraded to unobserved and the SIGNATURE MOVED — c1/a1/t0/n0/u0
  // became c1/a0/t0/n0/u1 — which evaluate.ts then reported as "Deployer
  // reputation change". An outage in our own enrichment call became a confident,
  // specific claim about somebody's address.
  it('an enrichment outage is unavailable, not a reputation change', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => TXLIST_OK }) as unknown as Response);
    fetchLauncherOutcomesMock.mockRejectedValue(new Error('down'));
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toMatch(/No change was concluded/);
  });

  it('a body with no outcomes object is refused the same way', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => TXLIST_OK }) as unknown as Response);
    fetchLauncherOutcomesMock.mockResolvedValue({});
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('unavailable');
  });

  it('a deployer with NO creations needs no enrichment and is still a real reading', async () => {
    // Nothing to enrich is not an enrichment failure. Calling out for zero
    // baselines would let a third-party outage refuse a reading that was already
    // complete without it.
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: [] }) }) as unknown as Response,
    );
    fetchLauncherOutcomesMock.mockRejectedValue(new Error('down'));
    const result = await readDeployerReputation(rule('deployer-reputation'), { fetchImpl });
    expect(result.status).toBe('ok');
    expect(fetchLauncherOutcomesMock).not.toHaveBeenCalled();
  });

  it('two rules on one deployer cost the explorer one read', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => TXLIST_OK }) as unknown as Response);
    fetchLauncherOutcomesMock.mockResolvedValue({ outcomes: {} });
    const rules = [rule('deployer-reputation', { id: 'a' }), rule('deployer-reputation', { id: 'b' })];
    await readAll(rules, { fetchImpl, pass: newReaderPass(rules) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('the signature is built from counts, not from an invented score', () => {
    const sig = reputationSignature({ created: 2, activeMarket: 1, thinMarket: 0, noMarket: 1, unobserved: 0 }, 'low');
    expect(sig).toBe('c2/a1/t0/n1/u0@low');
    expect(sig).not.toMatch(/score/i);
  });
});

describe('GeckoTerminal pool kinds', () => {
  it('a price rule reads the quote endpoint and nothing else', async () => {
    const fetchImpl = stubFetch([{ match: /pools\/multi/, body: { data: [poolRow()] } }]);
    const result = await readPoolPrice(rule('pool-price-above'), { fetchImpl });
    expect(result.status).toBe('ok');
    if (result.status === 'ok' && result.value.kind === 'pool-price-above') {
      expect(result.value.priceUsd).toBe(1.5);
      expect(result.value.poolName).toBe('QR / WETH');
    }
    // The trades feed is NOT touched for a price rule: one endpoint per kind is
    // what keeps a pass inside a keyless quota.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toMatch(/trades/);
  });

  it('several price rules across pools on one network are ONE request', async () => {
    const other = '0xb08a99ab559e5456907278727a3b0d968c0a313b';
    const fetchImpl = stubFetch([
      { match: /pools\/multi/, body: { data: [poolRow(), poolRow({ address: other })] } },
    ]);
    const rules = [
      rule('pool-price-above', { id: 'a' }),
      rule('pool-price-below', { id: 'b', subject: `base:${other}` }),
    ];
    await readAll(rules, { fetchImpl, pass: newReaderPass(rules) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Both pools in the one URL, or the batching claim is not true.
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain(POOL_ID);
    expect(url).toContain(other);
  });

  it('a pool asked about but not answered about is unavailable, not priceless', async () => {
    const fetchImpl = stubFetch([{ match: /pools\/multi/, body: { data: [] } }]);
    const result = await readPoolPrice(rule('pool-price-above'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toMatch(/without this pool/i);
  });

  it('a null price is an outage, in those words — never a zero', async () => {
    const fetchImpl = stubFetch([
      { match: /pools\/multi/, body: { data: [poolRow({ base_token_price_usd: null })] } },
    ]);
    const result = await readPoolPrice(rule('pool-price-above'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toMatch(/outage, not a zero/i);
  });

  it('a 429 is a refusal to read, and is not retried', async () => {
    const fetchImpl = stubFetch([{ match: /pools\/multi/, body: {}, status: 429 }]);
    const result = await readPoolPrice(rule('pool-price-above'), { fetchImpl });
    expect(result.status).toBe('unavailable');
    // One call. A retry spends the same throttled quota twice for a pass nobody
    // is watching.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a swap rule reads the trades feed, and two such rules on one pool read it once', async () => {
    const fetchImpl = stubFetch([{ match: /trades/, body: { data: [tradeRow()] } }]);
    const rules = [rule('pool-large-trade', { id: 'a' }), rule('pool-large-trade', { id: 'b', threshold: 50 })];
    const readings = await readAll(rules, { fetchImpl, pass: newReaderPass(rules) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const reading = readings['a']!;
    expect(reading.status).toBe('ok');
    if (reading.status === 'ok' && reading.value.kind === 'pool-large-trade') {
      expect(reading.value.trades).toHaveLength(1);
      expect(reading.value.trades[0]!.usd).toBe(9000);
      expect(reading.value.trades[0]!.at).toBe(Math.floor(Date.parse('2026-09-02T10:00:00Z') / 1000));
    }
  });

  it('a trade with no USD size stays null — never 0', async () => {
    const fetchImpl = stubFetch([
      {
        match: /trades/,
        body: { data: [tradeRow({ kind: 'sell', volume_in_usd: null, from_token_amount: '5' })] },
      },
    ]);
    const result = await readPoolLargeTrade(rule('pool-large-trade'), { fetchImpl });
    if (result.status === 'ok' && result.value.kind === 'pool-large-trade') {
      // `Number(x) || 0` here would make an unmeasurable trade a $0 trade, which
      // passes every threshold comparison as "too small" without saying so.
      expect(result.value.trades[0]!.usd).toBeNull();
    }
  });

  it('a subject that is not network:pool reads nothing at all', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await readPoolPrice(rule('pool-price-above', { subject: SUBJECT }), { fetchImpl });
    expect(result.status).toBe('unavailable');
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

  it('no substitute source is silently used in the indexer’s place', async () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const fetchImpl = vi.fn(async () => {
      throw new Error('no substitute may be read for an indexed kind');
    }) as unknown as typeof fetch;
    const rules = [rule('whale-move')];
    const readings = await readAll(rules, { fetchImpl, pass: newReaderPass(rules) });
    expect(readings['r-whale-move']!.status).toBe('unavailable');
    expect(fetchLaunchRadarMock).not.toHaveBeenCalled();
    expect(fetchHeatMock).not.toHaveBeenCalled();
    // And specifically not GeckoTerminal. A pool's trade tape is a DIFFERENT
    // fact from an indexed transfer, and serving it under this rule's name would
    // be exactly the substitution this module refuses.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a deadline rule with nothing wired to read it says so', () => {
  it('refuses when no on-chain loan reader was supplied to the pass', async () => {
    const reading = await READERS['loan-deadline'](rule('loan-deadline'), {});
    expect(reading.status).toBe('unavailable');
    if (reading.status === 'unavailable') {
      expect(reading.detail).toMatch(/no on-chain loan reader was supplied/i);
    }
  });

  it('the refusal is not a claim that the wallet has no loans', async () => {
    const reading = await READERS['loan-deadline'](rule('loan-deadline'), {});
    expect(reading.status).not.toBe('ok');
  });

  it('delegates to the supplied reader when one exists', async () => {
    const supplied = vi.fn(async () => ({
      status: 'ok' as const,
      observedAt: 1,
      value: { kind: 'loan-deadline' as const, loans: [] },
    }));
    const reading = await READERS['loan-deadline'](rule('loan-deadline'), { loanDeadlineReader: supplied });
    expect(supplied).toHaveBeenCalledTimes(1);
    expect(reading.status).toBe('ok');
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

  it('two launch-live rules in one pass read the market-wide feed once', async () => {
    fetchLaunchRadarMock.mockResolvedValue({ observedAt: NOW, entries: [] });
    const rules = [rule('launch-live', { id: 'a' }), rule('launch-live', { id: 'b' })];
    await readAll(rules, { pass: newReaderPass(rules) });
    // The radar ignores the rule entirely, so N rules used to mean N identical
    // requests for one market-wide body.
    expect(fetchLaunchRadarMock).toHaveBeenCalledTimes(1);
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
