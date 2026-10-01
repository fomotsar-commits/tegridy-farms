import { describe, expect, it } from 'vitest';
import { LP_WRITES, lpWriteMode } from './lpWriteFlag';

// LP's own switch (spec D1). Production reads only the committed constant; a dev
// server or the named e2e build can turn a committed 'off' into 'on' with the same
// env flag the curve uses, and nothing else.

const PROD = { DEV: false, PROD: true, MODE: 'production' };
const E2E = { DEV: false, MODE: 'solana-e2e' };
const DEV = { DEV: true, MODE: 'development' };

describe('LP write mode', () => {
  it('ships off: a production build offers nothing', () => {
    expect(LP_WRITES).toBe('off');
    expect(lpWriteMode(PROD)).toBe('off');
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

  it('a committed withdraw-only is never raised by env', () => {
    expect(lpWriteMode({ ...E2E, VITE_SOLANA_CURVE_WRITES: '1' }, 'withdraw-only')).toBe('withdraw-only');
    expect(lpWriteMode({ ...DEV, VITE_SOLANA_CURVE_WRITES: '1' }, 'withdraw-only')).toBe('withdraw-only');
  });
});
