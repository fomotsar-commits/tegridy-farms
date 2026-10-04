import { afterEach, describe, expect, it, vi } from 'vitest';
import { LP_WRITES, OWN_POOL_ROUTE, lpWriteMode, ownPoolRouteMode } from './lpWriteFlag';

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

// The swap's own-pool route has its own switch, with the same hardened rule (SPEC_S3 D1,
// T-FLAG-01..04). Whether a trade may actually run through our pool also needs LP mode
// 'on', a program id and the fee env: that is siteFee.ts ownPoolRouteOffered, tested there.
describe('own-pool route mode', () => {
  it('ships OFF: a production build compares the routes and sends every trade through Jupiter', () => {
    // Flipping it is the owner's own one-line commit, after the first real pool exists.
    expect(OWN_POOL_ROUTE).toBe('off');
    expect(ownPoolRouteMode(PROD)).toBe('off');
  });

  it('T-FLAG-01: a committed off is not raised by the env flag in production', () => {
    expect(ownPoolRouteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
    expect(ownPoolRouteMode({ ...PROD, VITE_SOLANA_CURVE_WRITES: '1' })).toBe('off');
  });

  it('T-FLAG-02: the named e2e build, or a dev server, raises it with the flag (and only for the exact value 1)', () => {
    expect(ownPoolRouteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('on');
    expect(ownPoolRouteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('on');
    expect(ownPoolRouteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: 'true' }, 'off')).toBe('off');
    expect(ownPoolRouteMode(E2E, 'off')).toBe('off');
    expect(ownPoolRouteMode(DEV, 'off')).toBe('off');
  });

  it('T-FLAG-03: a committed on is never lowered by env', () => {
    for (const env of [PROD, E2E, DEV]) {
      expect(ownPoolRouteMode({ ...env, VITE_SOLANA_CURVE_WRITES: '0' }, 'on')).toBe('on');
      expect(ownPoolRouteMode(env, 'on')).toBe('on');
    }
  });

  it('T-FLAG-04: no env name raises it in production: not a custom mode, not a route flag of its own, not DEV as a string', () => {
    expect(ownPoolRouteMode({ DEV: false, MODE: 'staging', VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
    expect(ownPoolRouteMode({ DEV: 'true', MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, 'off')).toBe('off');
    expect(
      ownPoolRouteMode({ ...PROD, VITE_SOLANA_OWN_POOL_ROUTE: 'on', VITE_OWN_POOL_ROUTE: '1', OWN_POOL_ROUTE: 'on', VITE_SOLANA_LP_WRITES: '1' }, 'off'),
    ).toBe('off');
  });

  it('a build with DEV true (NODE_ENV=development on the build host) still ignores the env flag', () => {
    for (const v of [false, undefined]) {
      vi.stubGlobal('__VITE_DEV_SERVER__', v);
      expect(ownPoolRouteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('off');
      expect(ownPoolRouteMode({ DEV: true, MODE: 'production', VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('off');
      expect(ownPoolRouteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'off'), String(v)).toBe('on');
    }
  });

  it('the route’s switch and LP’s switch are separate: neither moves the other', () => {
    // LP 'on' does not open the route...
    expect(lpWriteMode(PROD, 'on')).toBe('on');
    expect(ownPoolRouteMode(PROD, 'off')).toBe('off');
    // ...and the route 'on' does not raise a committed LP 'withdraw-only' or 'off'.
    expect(ownPoolRouteMode(PROD, 'on')).toBe('on');
    expect(lpWriteMode(PROD, 'withdraw-only')).toBe('withdraw-only');
    expect(lpWriteMode(PROD, 'off')).toBe('off');
  });
});
