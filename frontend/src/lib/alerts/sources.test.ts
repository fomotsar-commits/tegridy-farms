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
  readinessForRule,
  sourceReadiness,
} from './sources';
import { ALERT_RULE_KINDS } from './rules';

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
    expect(dark.sort()).toEqual(['lp-unlock', 'whale-move']);
    expect(darkSources(ALERT_RULE_KINDS)).toEqual(['indexer']);
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
