// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isUnverified, findSolToken, SOL, USDC, BUY_TOKENS, LST_TOKENS } from './solanaTokenList';

describe('isUnverified — the one verified/unverified decision', () => {
  it('treats an UNSET flag as unverified (the curated BAYLA case)', () => {
    // BAYLA deliberately leaves `verified` unset — Jupiter's tag would be a
    // lie — and its own comment expects the Unverified chip to render. The
    // old `=== false` checks silently exempted it from the badge AND the
    // risk-ack gate; this pin fails on that shape.
    const bayla = findSolToken('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(bayla).toBeDefined();
    expect(bayla!.verified).toBeUndefined();
    expect(isUnverified(bayla!)).toBe(true);
  });

  it('treats an explicit false as unverified', () => {
    expect(isUnverified({ ...SOL, verified: false })).toBe(true);
  });

  it('only an explicit true passes', () => {
    expect(isUnverified(SOL)).toBe(false);
    expect(isUnverified(USDC)).toBe(false);
  });

  it('every curated featured/LST token except BAYLA is explicitly verified', () => {
    // Breadth guard the other way: `!== true` must not suddenly badge the
    // whole curated shortlist. If a future curated entry legitimately lacks
    // Jupiter verification, list it here with the reason, like BAYLA.
    const knownUnverified = new Set(['7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump']);
    for (const t of [...BUY_TOKENS, ...LST_TOKENS]) {
      if (knownUnverified.has(t.mint)) continue;
      expect(t.verified, `${t.symbol} (${t.mint})`).toBe(true);
    }
  });
});
