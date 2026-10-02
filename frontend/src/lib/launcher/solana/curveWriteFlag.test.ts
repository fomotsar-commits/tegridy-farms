import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURVE_WRITES_ENABLED, curveWriteEnvOverridesAllowed, isCurveWriteEnabled } from './curveWriteFlag';

// The first gate: may the write code even load? In a production build only the
// committed constant can say yes; no env variable can, whatever it holds.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('curve write flag', () => {
  it('ships switched OFF (the LP release), so a production build never loads the write path', () => {
    // Owner 2026-10-02: launching stays off until the owner's own one-line PR after #682.
    // No env variable can turn a production build on; only this constant can.
    expect(CURVE_WRITES_ENABLED).toBe(false);
    expect(isCurveWriteEnabled({ DEV: false, PROD: true, MODE: 'production' })).toBe(false);
    expect(isCurveWriteEnabled({ DEV: false, PROD: true, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' })).toBe(false);
  });

  // The rules below are for a build with the constant OFF (release 1, or a rollback that
  // turns it off again). They are exercised through the `committed` parameter so they
  // stay pinned while the committed value is on.
  describe('with the constant off', () => {
    it('a production build ignores the env flag', () => {
      expect(isCurveWriteEnabled({ DEV: false, PROD: true, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(false);
    });

    it('a custom build mode is production too, so `--mode anything` cannot open it', () => {
      expect(curveWriteEnvOverridesAllowed({ DEV: false, MODE: 'staging' })).toBe(false);
      expect(isCurveWriteEnabled({ DEV: false, MODE: 'staging', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(false);
    });

    it('the named local-validator build honours the env flag', () => {
      expect(isCurveWriteEnabled({ DEV: false, MODE: 'solana-e2e', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(true);
      expect(isCurveWriteEnabled({ DEV: false, MODE: 'solana-e2e' }, false)).toBe(false);
    });

    it('a dev server honours the env flag, and only the exact value 1', () => {
      expect(isCurveWriteEnabled({ DEV: true, MODE: 'development', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(true);
      expect(isCurveWriteEnabled({ DEV: true, MODE: 'development', VITE_SOLANA_CURVE_WRITES: 'true' }, false)).toBe(false);
      expect(isCurveWriteEnabled({ DEV: true, MODE: 'development' }, false)).toBe(false);
    });

    it('DEV must be the boolean true, not a truthy string an env file could inject', () => {
      expect(isCurveWriteEnabled({ DEV: 'true', MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(false);
    });

    // Vite inlines DEV from NODE_ENV, so `NODE_ENV=development vite build` ships DEV true.
    // Only code a dev server compiled may honour the flag (src/lib/devServer.ts).
    it('a build with DEV true (NODE_ENV=development on the build host) still ignores the env flag', () => {
      for (const v of [false, undefined]) {
        vi.stubGlobal('__VITE_DEV_SERVER__', v);
        expect(curveWriteEnvOverridesAllowed({ DEV: true, MODE: 'production' }), String(v)).toBe(false);
        expect(isCurveWriteEnabled({ DEV: true, MODE: 'development', VITE_SOLANA_CURVE_WRITES: '1' }, false), String(v)).toBe(false);
        // The named local-validator build is its own, explicit exception.
        expect(isCurveWriteEnabled({ DEV: false, MODE: 'solana-e2e', VITE_SOLANA_CURVE_WRITES: '1' }, false)).toBe(true);
      }
    });
  });

  it('with the constant on, no env value can turn it off (the constant is the only switch in production)', () => {
    expect(isCurveWriteEnabled({ DEV: false, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '0' }, true)).toBe(true);
  });
});
