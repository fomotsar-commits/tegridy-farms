import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSolToken, PAY_WITH_TOKENS, BUY_TOKENS } from '../lib/solanaTokenList';

/**
 * SHIELD SEVERITY — one decision, applied everywhere.
 *
 * On the venue's DEFAULT Solana pair (SOL -> USDC), before the user touches
 * anything, the swap surface painted USDC's freeze authority red. That warning
 * is true of USDC and of every regulated stablecoin — it is a documented
 * property of the asset, not a honeypot signal.
 *
 * The severity model to handle this ALREADY EXISTED and was already correct:
 * `dangerousShield` exempted HAS_FREEZE_AUTHORITY for curated mints, so the
 * "swap anyway" ack did not fire. But the three RENDER sites decided colour with
 * a bare `/warn|crit|danger/i.test(w.severity)` and knew nothing about it. Same
 * warning, two answers: the gate said benign, the text said danger.
 *
 * The cost is calibration, not cosmetics. A user who sees red on the safest pair
 * on the venue learns that red means nothing here, and carries that lesson to
 * the pair where it means everything.
 *
 * THE SECURITY PROPERTY THIS FILE EXISTS TO PIN: the exemption is keyed by MINT
 * ADDRESS and nothing else. A symbol- or name-matched allowlist would be a
 * spoofing vector — anyone can mint a token called "USDC" — so a fake must never
 * inherit the exemption. `findSolToken` matches on `t.mint === mint`; if that
 * ever loosens to a symbol comparison, the last test here fails.
 */

const PAGE = join(process.cwd(), 'src', 'pages', 'SolanaSwapPage.tsx');
const src = readFileSync(PAGE, 'utf8');
/** Strip comments so prose about a pattern never satisfies a check. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Shield severity is decided in one place', () => {
  it('no render site decides colour from raw severity any more', () => {
    // The three inline copies that did not know about the exemption. Each was
    // `${/warn|crit|danger/i.test(w.severity) ? 'text-red-300' : ...}`.
    const inlineSeverityColour = /test\(w\.severity\)\s*\?\s*'text-red-300'/g;
    expect(code.match(inlineSeverityColour)).toBeNull();
  });

  it('every shield warning row routes through shieldIsAlarming', () => {
    const rows = code.match(/text-red-300'\s*:\s*'text-white\/50'/g) ?? [];
    const routed = code.match(/shieldIsAlarming\(w, w\.mint\)/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(routed.length).toBe(rows.length);
  });

  it('warnings keep the mint they came from', () => {
    // Flattening both tokens' warnings used to discard which mint each described,
    // which is precisely why the render sites could not apply a per-mint rule.
    expect(code).toMatch(/\.map\(\(w\) => \(\{ \.\.\.w, mint: payToken\.mint \}\)\)/);
    expect(code).toMatch(/\.map\(\(w\) => \(\{ \.\.\.w, mint: buyToken\.mint \}\)\)/);
  });

  it('the ack gate and the colour share the same exemption helper', () => {
    // dangerousShield must not re-implement the rule inline again.
    expect(code).toMatch(/function dangerousShield[\s\S]{0,400}isExpectedAuthority\(w, mint\)/);
    expect(code).toMatch(/function shieldIsAlarming[\s\S]{0,200}isExpectedAuthority\(w, mint\)/);
  });

  it('exempts ONLY freeze authority, never an arbitrary warning type', () => {
    expect(code).toMatch(/w\.type === 'HAS_FREEZE_AUTHORITY' && Boolean\(findSolToken\(mint\)\)/);
  });
});

describe('the exemption is keyed by mint address, not symbol', () => {
  const usdc = [...PAY_WITH_TOKENS, ...BUY_TOKENS].find((t) => t.symbol === 'USDC');

  it('resolves the real curated USDC by its mint', () => {
    expect(usdc).toBeDefined();
    expect(findSolToken(usdc!.mint)).toBeDefined();
  });

  it('does NOT resolve a curated SYMBOL passed where a mint belongs', () => {
    // THE load-bearing assertion. If findSolToken ever compares `t.symbol` as
    // well as `t.mint`, anything carrying a curated symbol inherits the
    // freeze-authority exemption — and anyone can mint a token called "USDC".
    //
    // An earlier version of this test passed a made-up mint string, which a
    // symbol-matching implementation would ALSO fail to resolve: it proved
    // nothing. Mutation-checked 2026-09-03 by loosening findSolToken to
    // `t.mint === mint || t.symbol === mint`, which this now catches and the
    // made-up-mint version did not.
    expect(findSolToken('USDC')).toBeUndefined();
    expect(findSolToken(usdc!.symbol)).toBeUndefined();
  });

  it('does NOT resolve an impostor mint that is not curated', () => {
    const impostorMint = 'Fake11111111111111111111111111111111111111';
    expect(findSolToken(impostorMint)).toBeUndefined();
  });

  it('does not resolve an empty or malformed mint', () => {
    expect(findSolToken('')).toBeUndefined();
    expect(findSolToken('not-a-mint')).toBeUndefined();
  });
});
