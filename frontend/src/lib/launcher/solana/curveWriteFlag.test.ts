import { describe, expect, it } from 'vitest';
import { CURVE_WRITES_ENABLED, curveWriteEnvOverridesAllowed, isCurveWriteEnabled } from './curveWriteFlag';

// The first gate: may the write code even load? In a production build only the
// committed constant can say yes; no env variable can, whatever it holds.

describe('curve write flag', () => {
  it('ships switched off', () => {
    // Flipping this is the owner's step after the mainnet deploy and the id flip.
    expect(CURVE_WRITES_ENABLED).toBe(false);
  });

  it('a production build ignores the env flag', () => {
    expect(isCurveWriteEnabled({ DEV: false, PROD: true, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(false);
  });

  it('a custom build mode is production too, so `--mode anything` cannot open it', () => {
    expect(curveWriteEnvOverridesAllowed({ DEV: false, MODE: 'staging' })).toBe(false);
    expect(isCurveWriteEnabled({ DEV: false, MODE: 'staging', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(false);
  });

  it('the named local-validator build honours the env flag', () => {
    expect(isCurveWriteEnabled({ DEV: false, MODE: 'solana-e2e', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(true);
    expect(isCurveWriteEnabled({ DEV: false, MODE: 'solana-e2e' })).toBe(false);
  });

  it('a dev server honours the env flag, and only the exact value 1', () => {
    expect(isCurveWriteEnabled({ DEV: true, MODE: 'development', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(true);
    expect(isCurveWriteEnabled({ DEV: true, MODE: 'development', VITE_SOLANA_CURVE_WRITES: 'true' })).toBe(false);
    expect(isCurveWriteEnabled({ DEV: true, MODE: 'development' })).toBe(false);
  });

  it('DEV must be the boolean true, not a truthy string an env file could inject', () => {
    expect(isCurveWriteEnabled({ DEV: 'true', MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(false);
  });
});
