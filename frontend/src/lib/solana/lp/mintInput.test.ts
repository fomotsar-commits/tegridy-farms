// @vitest-environment node
//
// What a pasted mint is told before anything is read. SOL itself is never a pool's token:
// the line names every coin a pool here pairs a token with, from the one list (quotes.ts),
// so a coin added there is named here too.
import { describe, it, expect } from 'vitest';
import { parseMintInput } from './mintInput';
import { QUOTE_COINS } from './quotes';
import { WSOL_MINT } from './tokenSafety';

describe('parseMintInput', () => {
  it('SOL itself: refused, naming every pairing coin', () => {
    const r = parseMintInput(` ${WSOL_MINT} `);
    expect(r).toEqual({
      ok: false,
      reason: 'That is SOL itself. Pools here pair a token with SOL, USDC, BAYLA, BOBO, SOY, BRAINLET or RIZZ: paste the other token.',
    });
    for (const q of QUOTE_COINS) expect(r.ok ? '' : r.reason).toContain(q.symbol);
  });

  it('a token’s mint passes; an empty box and a non-address are each told why', () => {
    expect(parseMintInput('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump')).toEqual({ ok: true, mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump' });
    expect(parseMintInput('  ')).toEqual({ ok: false, reason: 'Paste a token’s mint address.' });
    expect(parseMintInput('not a mint')).toEqual({ ok: false, reason: 'That does not look like a Solana address.' });
  });
});
