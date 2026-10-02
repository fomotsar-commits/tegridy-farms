import { afterEach, describe, expect, it, vi } from 'vitest';
import { heatEnvOverridesAllowed, heatGateMaxAgeDays, heatLaunchFloor, isHeatGateEnabled } from './heatGateConfig';
import { assertMayLaunch, HeatGateDenied } from './launchGate';
import { clearGateAudit } from './gateAudit';
import { parseHeatReading } from './heatOracle';

// The door has no exception in a production build: no env value can switch denial off
// or move the 80 floor, and the freshness window can only shrink. A dev server (and this
// test runner) still honours the dials, so the dial-off tests elsewhere keep meaning.

const PROD = { DEV: false, PROD: true, MODE: 'production' };
const DEV = { DEV: true, PROD: false, MODE: 'development' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearGateAudit();
});

describe('in a production build the heat dials are ignored', () => {
  it('VITE_HEAT_GATE=off cannot switch denial off', () => {
    expect(isHeatGateEnabled({ ...PROD, VITE_HEAT_GATE: 'off' })).toBe(true);
    expect(isHeatGateEnabled({ ...PROD, VITE_HEAT_GATE: ' OFF ' })).toBe(true);
  });

  it('VITE_HEAT_LAUNCH_FLOOR cannot move the floor off 80, either way', () => {
    expect(heatLaunchFloor({ ...PROD, VITE_HEAT_LAUNCH_FLOOR: '0.001' })).toBe(80);
    expect(heatLaunchFloor({ ...PROD, VITE_HEAT_LAUNCH_FLOOR: '300' })).toBe(80);
  });

  it('a custom build mode is production too, and DEV must be the boolean true', () => {
    for (const env of [
      { DEV: false, MODE: 'solana-e2e' },
      { DEV: false, MODE: 'staging' },
      { DEV: 'true', MODE: 'production' },
    ]) {
      expect(heatEnvOverridesAllowed(env)).toBe(false);
      expect(isHeatGateEnabled({ ...env, VITE_HEAT_GATE: 'off' })).toBe(true);
      expect(heatLaunchFloor({ ...env, VITE_HEAT_LAUNCH_FLOOR: '1' })).toBe(80);
    }
  });

  // Vite inlines DEV from NODE_ENV, so `NODE_ENV=development vite build` ships DEV true.
  // Only code a dev server compiled may honour a dial (the __VITE_DEV_SERVER__ define, src/devServerDefine.d.ts).
  it('a build with DEV true (NODE_ENV=development on the build host) still ignores every dial', () => {
    for (const v of [false, undefined]) {
      vi.stubGlobal('__VITE_DEV_SERVER__', v);
      expect(heatEnvOverridesAllowed(DEV), String(v)).toBe(false);
      expect(isHeatGateEnabled({ ...DEV, VITE_HEAT_GATE: 'off' }), String(v)).toBe(true);
      expect(heatLaunchFloor({ ...DEV, VITE_HEAT_LAUNCH_FLOOR: '60' }), String(v)).toBe(80);
      expect(heatGateMaxAgeDays({ ...DEV, VITE_HEAT_MAX_AGE_DAYS: '30' }), String(v)).toBe(7);
    }
  });

  it('the callers read the build itself: with DEV false, a stubbed dial changes nothing', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_HEAT_GATE', 'off');
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '1');
    vi.stubEnv('VITE_HEAT_MAX_AGE_DAYS', '30');
    expect(isHeatGateEnabled()).toBe(true);
    expect(heatLaunchFloor()).toBe(80);
    expect(heatGateMaxAgeDays()).toBe(7);
    // The enforcing call at submit refuses a 12-degree wallet whatever the dials say.
    const now = 1786104024;
    const cold = async () =>
      parseHeatReading({
        address: '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a',
        degrees: 12,
        tier: 'Drifter',
        is_cold: false,
        held_since_unix: now - 400 * 86_400,
        as_of_unix: now,
        token_count: 1,
        breakdown: [],
      });
    await expect(
      assertMayLaunch('0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a', { nowUnix: now, read: cold }),
    ).rejects.toBeInstanceOf(HeatGateDenied);
  });
});

describe('a dev server (and this test runner) honours the dials', () => {
  it('VITE_HEAT_GATE=off switches denial off, and only the word off', () => {
    expect(heatEnvOverridesAllowed(DEV)).toBe(true);
    expect(isHeatGateEnabled({ ...DEV, VITE_HEAT_GATE: 'off' })).toBe(false);
    expect(isHeatGateEnabled({ ...DEV, VITE_HEAT_GATE: ' OFF ' })).toBe(false);
    expect(isHeatGateEnabled({ ...DEV, VITE_HEAT_GATE: 'no' })).toBe(true);
    expect(isHeatGateEnabled(DEV)).toBe(true);
  });

  it('VITE_HEAT_LAUNCH_FLOOR moves the floor, and a nonsense value is ignored', () => {
    expect(heatLaunchFloor({ ...DEV, VITE_HEAT_LAUNCH_FLOOR: '123' })).toBe(123);
    expect(heatLaunchFloor({ ...DEV, VITE_HEAT_LAUNCH_FLOOR: '0' })).toBe(80);
    expect(heatLaunchFloor({ ...DEV, VITE_HEAT_LAUNCH_FLOOR: 'abc' })).toBe(80);
    expect(heatLaunchFloor(DEV)).toBe(80);
  });

  it('the callers read the build itself: under vitest a stubbed dial is honoured', () => {
    vi.stubEnv('VITE_HEAT_GATE', 'off');
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '123');
    expect(isHeatGateEnabled()).toBe(false);
    expect(heatLaunchFloor()).toBe(123);
  });
});

describe('VITE_HEAT_MAX_AGE_DAYS may only shrink the 7-day window, in every build', () => {
  it('a smaller window is honoured, a larger one is clamped to 7', () => {
    for (const env of [PROD, DEV]) {
      expect(heatGateMaxAgeDays({ ...env, VITE_HEAT_MAX_AGE_DAYS: '3' })).toBe(3);
      expect(heatGateMaxAgeDays({ ...env, VITE_HEAT_MAX_AGE_DAYS: '30' })).toBe(7);
      expect(heatGateMaxAgeDays({ ...env, VITE_HEAT_MAX_AGE_DAYS: '0' })).toBe(7);
      expect(heatGateMaxAgeDays(env)).toBe(7);
    }
  });
});
