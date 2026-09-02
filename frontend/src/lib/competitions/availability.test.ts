// The pill's condition, tested on both of its inputs.
//
// A "SOON" pill is a promise about what a page cannot do yet, and the only way
// it stays honest is if it is a live read of the same config the page reads. The
// three cases below are the three states that config can be in.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { hasScoreableBoard } from './availability';
import { cupPools } from './islandCup';
import { isIndexerConfigured } from '../indexer/client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('./islandCup');
});

describe('hasScoreableBoard', () => {
  it('is true against the real registry, with no indexer and no env at all', () => {
    // The precondition is asserted first so a configured indexer in some future
    // environment fails loudly instead of silently satisfying the expectation
    // through the other branch.
    expect(isIndexerConfigured(), 'no indexer should be configured in tests').toBe(false);
    expect(cupPools().length).toBeGreaterThan(0);
    expect(hasScoreableBoard()).toBe(true);
  });

  it('is FALSE when the registry names no pool and no indexer is configured', async () => {
    // The pill has to be able to come back. If every market were removed from the
    // registry there would be nothing to score, and the entry would be promising
    // a board again.
    vi.resetModules();
    vi.doMock('./islandCup', () => ({ cupPools: () => [] }));
    const { hasScoreableBoard: predicate } = await import('./availability');
    expect(predicate()).toBe(false);
  });

  it('is true on the indexer alone, with no pools', async () => {
    vi.resetModules();
    vi.doMock('./islandCup', () => ({ cupPools: () => [] }));
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example.com');
    const { hasScoreableBoard: predicate } = await import('./availability');
    expect(predicate()).toBe(true);
  });
});
