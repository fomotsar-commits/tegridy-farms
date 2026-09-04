import { describe, it, expect, afterEach, vi } from 'vitest';
import { indexerConfigProblem } from '../indexer/client';
import { terminalSourceReadiness } from './feedSources';

// ONE FUNCTION GATES THE TAB AND WRITES THE SENTENCE THAT REPLACES IT. These
// tests exist so the two cannot drift: a build that hides the Venue-pairs tab
// while telling the reader the indexer is fine (or vice versa) is the failure
// mode, and it would never show up in a component test that stubs one of them.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the indexer half is a live read', () => {
  it('is unreadable with VITE_INDEXER_URL unset, and says which variable', () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const readiness = terminalSourceReadiness();
    expect(readiness.indexer.readable).toBe(false);
    // Naming the variable is the difference between a dead end and a work item.
    expect(readiness.indexer.detail).toContain('VITE_INDEXER_URL');
    // And it must not imply the market feed is affected.
    expect(readiness.indexer.detail).toMatch(/does not need it/i);
  });

  it('flips to readable with a valid URL, and then carries no detail', () => {
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
    const readiness = terminalSourceReadiness();
    expect(readiness.indexer.readable).toBe(true);
    // `detail` is non-null EXACTLY when readable is false — a leftover sentence
    // beside a working tab is how a reader learns to ignore the sentences.
    expect(readiness.indexer.detail).toBeNull();
  });

  it('distinguishes a typo from an unset value, using the client’s own words', () => {
    // A live misconfiguration deserves different copy than the intended
    // pre-deploy state; reporting a typo as "not configured" sends the operator
    // looking for a variable that is already there.
    vi.stubEnv('VITE_INDEXER_URL', 'not-a-url');
    const readiness = terminalSourceReadiness();
    expect(readiness.indexer.readable).toBe(false);
    expect(readiness.indexer.detail).toBe(indexerConfigProblem());
    expect(readiness.indexer.detail).toMatch(/is set but is not a valid/i);
  });

  it('reads the env on every call rather than at import time', () => {
    // A module constant would snapshot whichever value happened to be present
    // when this file first loaded, making the flip above untestable and a
    // per-request build indistinguishable from a stale one.
    vi.stubEnv('VITE_INDEXER_URL', '');
    expect(terminalSourceReadiness().indexer.readable).toBe(false);
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
    expect(terminalSourceReadiness().indexer.readable).toBe(true);
  });
});

describe('the GeckoTerminal half claims nothing it cannot read', () => {
  it('is constant-readable, with no detail, in every env', () => {
    // Deliberate and documented: a keyless public API on a CSP-allowed origin
    // with no operator step has NO client-readable gate. Dressing that constant
    // up as a live check is what the nav pill decision refuses — the honest
    // live signal is the feed's own "could not be read" banner at read time.
    for (const url of ['', 'https://indexer.example', 'not-a-url']) {
      vi.stubEnv('VITE_INDEXER_URL', url);
      expect(terminalSourceReadiness().geckoterminal).toEqual({ readable: true, detail: null });
    }
  });
});
