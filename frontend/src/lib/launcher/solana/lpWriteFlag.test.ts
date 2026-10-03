import { afterEach, describe, expect, it, vi } from 'vitest';
import { LP_WRITES, lpWriteMode } from './lpWriteFlag';

afterEach(() => {
  vi.unstubAllGlobals();
});

// LP's own switch (spec D1). Production reads only the committed constant; a dev
// server or the named e2e build can turn a committed 'off' into 'on' with the same
// env flag the curve uses, and nothing else.

const PROD = { DEV: false, PROD: true, MODE: 'production' };
const E2E = { DEV: false, MODE: 'solana-e2e' };
const DEV = { DEV: true, MODE: 'development' };

describe('LP write mode', () => {
  it('ships ON (the LP release): a production build offers adding, removing and opening a pool', () => {
    // Owner rulings: 2026-09-29 "public LP opens before the fork review, with a disclosure";
    // 2026-10-01 "finish it all". Deliberately pinned: switching back is its own commit.
    expect(LP_WRITES).toBe('on');
    expect(lpWriteMode(PROD)).toBe('on');
    // No env variable closes it in production either.
    expect(lpWriteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '0' })).toBe('on');
  });

  it('production ignores env, both ways', () => {
    // A committed 'off' is not opened by the flag...
    expect(lpWriteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
    // ...nor by a custom build mode that names itself something else.
    expect(lpWriteMode({ DEV: false, MODE: 'staging', VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
    // And a committed 'on' or 'withdraw-only' is not closed by env either.
    expect(lpWriteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '0' }, 'on')).toBe('on');
    expect(lpWriteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '0' }, 'withdraw-only')).toBe('withdraw-only');
  });

  it('the committed off, with the dev or e2e flag set, is on (and only for the exact value 1)', () => {
    expect(lpWriteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('on');
    expect(lpWriteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('on');
    expect(lpWriteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: 'true' }, 'off')).toBe('off');
    expect(lpWriteMode(E2E, 'off')).toBe('off');
    // DEV must be the boolean, not a string an env file could inject.
    expect(lpWriteMode({ DEV: 'true', MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
  });

  // The same rule as the curve's switch (curveWriteFlag.ts curveWriteEnvOverridesAllowed):
  // Vite inlines DEV from NODE_ENV, so `NODE_ENV=development vite build` ships DEV true.
  // Only code a dev server compiled (src/devServerDefine.d.ts) may honour the flag.
  it('a build with DEV true (NODE_ENV=development on the build host) still ignores the env flag', () => {
    for (const v of [false, undefined]) {
      vi.stubGlobal('__VITE_DEV_SERVER__', v);
      expect(lpWriteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('off');
      expect(lpWriteMode({ DEV: true, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('off');
      // The named local-validator build is its own, explicit exception.
      expect(lpWriteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('on');
    }
  });

  it('a committed withdraw-only is never raised by env', () => {
    expect(lpWriteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'withdraw-only')).toBe('withdraw-only');
    expect(lpWriteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'withdraw-only')).toBe('withdraw-only');
  });
});
