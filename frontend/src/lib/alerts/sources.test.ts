// Guard for the source registry.
//
// Two claims are being tested. First, that every rule kind is attributed to a
// named source — an alert that cannot say who told it is not shippable, and the
// registry is where that attribution comes from. Second, that the indexer's
// absence is reported as an absence: with VITE_INDEXER_URL unset, the kinds that
// depend on it must come back NOT readable, with a sentence that says an
// unreadable source is not the same as a quiet market.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ALERT_SOURCES,
  RULE_SOURCE,
  darkSources,
  evaluableRuleKinds,
  readinessForRule,
  sourceReadiness,
} from './sources';
import { ALERT_RULE_KINDS } from './rules';

// GONDI_LOAN_ADDRESS is zero until the deploy (the real state); `gondiState` stands in a
// deployed address where a test needs the loan contract to exist.
const gondiState = vi.hoisted(() => ({ address: '0x0000000000000000000000000000000000000000' }));
vi.mock('../gondi/loanOffer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get GONDI_LOAN_ADDRESS() {
      return gondiState.address;
    },
  };
});

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('every rule is attributable', () => {
  it('each kind maps to a source that exists in the registry', () => {
    for (const kind of ALERT_RULE_KINDS) {
      const id = RULE_SOURCE[kind];
      expect(ALERT_SOURCES[id], kind).toBeDefined();
      expect(ALERT_SOURCES[id]!.attribution.length, kind).toBeGreaterThan(10);
    }
  });

  it('each source states what an operator would have to do about it', () => {
    for (const source of Object.values(ALERT_SOURCES)) {
      expect(source.operatorStep.length, source.id).toBeGreaterThan(20);
    }
  });

  it('Heat is attributed to the island, not to this venue', () => {
    expect(ALERT_SOURCES['heat-oracle'].attribution).toMatch(/Jungle Bay Island/);
  });

  it('the new-pool feed is labelled market-wide, not as this rail’s cohort', () => {
    expect(ALERT_SOURCES['launch-radar'].attribution).toMatch(/market-wide/i);
    expect(ALERT_SOURCES['launch-radar'].operatorStep).toMatch(/whole market/i);
  });
});

describe('an unconfigured indexer is reported as unreadable', () => {
  it('is not readable when VITE_INDEXER_URL is unset', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    expect(sourceReadiness().indexer.readable).toBe(false);
  });

  it('the reason says an unreadable source is not an absence of events', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const detail = sourceReadiness().indexer.detail ?? '';
    expect(detail).toMatch(/not the same as there being nothing to report/i);
  });

  it('a set-but-invalid URL is described as a misconfiguration, not an outage', () => {
    vi.stubEnv('VITE_INDEXER_URL', 'not-a-url');
    const detail = sourceReadiness().indexer.detail ?? '';
    expect(detail).toMatch(/VITE_INDEXER_URL is set/);
  });

  it('becomes readable once a valid origin is configured', () => {
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example.com');
    expect(sourceReadiness().indexer.readable).toBe(true);
    expect(sourceReadiness().indexer.detail).toBeNull();
  });

  it('the indexer-backed kinds are exactly the ones that go dark with it', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const dark = ALERT_RULE_KINDS.filter((k) => !readinessForRule(k).readable);
    // loan-deadline is dark until Gondi's loan contract is deployed: see the describe below.
    expect(dark.sort()).toEqual(['loan-deadline', 'lp-unlock', 'whale-move']);
    expect(darkSources(ALERT_RULE_KINDS).sort()).toEqual(['indexer', 'venue-lending']);
  });
});

describe("loan deadlines: read from Gondi's loan contract once it is deployed", () => {
  it('while GONDI_LOAN_ADDRESS is zero, the venue-lending source is unreadable and says why', () => {
    gondiState.address = '0x0000000000000000000000000000000000000000';
    const r = sourceReadiness()['venue-lending'];
    expect(r.readable).toBe(false);
    expect(r.detail).toMatch(/not deployed/i);
    expect(readinessForRule('loan-deadline').readable).toBe(false);
  });

  it('with the loan contract deployed, deadline rules are readable', () => {
    gondiState.address = '0x5555555555555555555555555555555555555555';
    try {
      const r = sourceReadiness()['venue-lending'];
      expect(r.readable).toBe(true);
      expect(r.detail).toBeNull();
      expect(evaluableRuleKinds()).toContain('loan-deadline');
    } finally {
      gondiState.address = '0x0000000000000000000000000000000000000000';
    }
  });
});

describe('readiness never claims uptime', () => {
  it('every unreadable source carries a reason, and every readable one carries none', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    for (const readiness of Object.values(sourceReadiness())) {
      if (readiness.readable) expect(readiness.detail).toBeNull();
      else expect(readiness.detail?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe('which kinds this deployment could actually ask about', () => {
  it('is non-empty even with no indexer — the pill on /alerts rests on this', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    // Four sources ship with every deployment (same-origin heat, launch radar and
    // explorer proxies, plus the keyless GeckoTerminal feed), so there is no
    // build of this app in which the page can do nothing. If someone makes one of
    // them configurable, THIS assertion fails first and the nav comment that
    // cites it has to be re-read.
    expect(evaluableRuleKinds().length).toBeGreaterThan(0);
  });

  it('excludes exactly the indexer-backed kinds and loan deadlines, and nothing else', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const missing = ALERT_RULE_KINDS.filter((k) => !evaluableRuleKinds().includes(k));
    // loan-deadline: Gondi's loan contract is not deployed yet (lib/shield/venues.ts).
    expect(missing.sort()).toEqual(['loan-deadline', 'lp-unlock', 'whale-move']);
  });

  it('the GeckoTerminal source is readable, and states the quota it works inside', () => {
    const readiness = sourceReadiness()['gecko-pool'];
    expect(readiness.readable).toBe(true);
    expect(readiness.detail).toBeNull();
    // The ceilings are not decoration: they are what keeps a pass inside a
    // keyless per-IP budget shared with the chart and the market strip.
    expect(ALERT_SOURCES['gecko-pool'].operatorStep).toContain('10 rules');
    expect(ALERT_SOURCES['gecko-pool'].operatorStep).toContain('5 pools');
  });
});
