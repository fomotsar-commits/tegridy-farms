import { describe, it, expect, vi } from 'vitest';
import { checkLaunchEligibility, assertMayLaunch, HeatGateDenied } from './launchGate';
import { LAUNCH_MIN_HELD_DAYS, type HeatReading } from './heatOracle';

const NOW = 1_800_000_000;
const DAY = 86_400;

/** A reading whose held history is exactly `days` old. */
function reading(days: number | null, overrides: Partial<HeatReading> = {}): HeatReading {
  return {
    address: '0x' + '1'.repeat(40),
    islandHeat: 120,
    tier: 'Resident',
    heldSinceUnix: days === null ? null : NOW - days * DAY,
    asOfUnix: NOW,
    breakdown: [],
    ...overrides,
  } as HeatReading;
}

describe('checkLaunchEligibility', () => {
  it('passes a wallet whose held history clears the floor', async () => {
    const read = vi.fn(async () => reading(LAUNCH_MIN_HELD_DAYS + 1));
    await expect(checkLaunchEligibility('0xabc', { nowUnix: NOW, read })).resolves.toBeNull();
  });

  it('denies a wallet that is too new, and says how much longer', async () => {
    const read = vi.fn(async () => reading(10));
    const d = await checkLaunchEligibility('0xabc', { nowUnix: NOW, read });
    expect(d?.reason).toBe('too-new');
    expect(d?.detail).toMatch(/more day/i);
  });

  it('denies a cold wallet with no measured history', async () => {
    const read = vi.fn(async () => reading(null));
    expect((await checkLaunchEligibility('0xabc', { nowUnix: NOW, read }))?.reason).toBe('no-history');
  });

  // THE fail-closed property. An unreachable instrument is not a pass, and it must not
  // throw either — the caller renders the reason rather than catching.
  it('DENIES when the oracle is unreachable, rather than passing or throwing', async () => {
    const read = vi.fn(async () => { throw new Error('instrument down'); });
    const d = await checkLaunchEligibility('0xabc', { nowUnix: NOW, read });
    expect(d?.reason).toBe('unreadable');
  });

  it('denies on a stale reading — a stale ruler certifies nobody', async () => {
    const read = vi.fn(async () => reading(LAUNCH_MIN_HELD_DAYS + 1, { asOfUnix: NOW - 30 * DAY }));
    expect((await checkLaunchEligibility('0xabc', { nowUnix: NOW, read }))?.reason).toBe('stale');
  });

  it('honours an injected floor instead of the standard default', async () => {
    const read = vi.fn(async () => reading(20));
    await expect(checkLaunchEligibility('0xabc', { nowUnix: NOW, read, minHeldDays: 10 })).resolves.toBeNull();
    expect((await checkLaunchEligibility('0xabc', { nowUnix: NOW, read, minHeldDays: 30 }))?.reason).toBe('too-new');
  });
});

describe('assertMayLaunch', () => {
  it('resolves silently for an eligible wallet', async () => {
    const read = vi.fn(async () => reading(LAUNCH_MIN_HELD_DAYS));
    await expect(assertMayLaunch('0xabc', { nowUnix: NOW, read })).resolves.toBeUndefined();
  });

  it('throws HeatGateDenied carrying the machine-readable reason', async () => {
    const read = vi.fn(async () => reading(3));
    const err = await assertMayLaunch('0xabc', { nowUnix: NOW, read }).catch((e) => e);
    expect(err).toBeInstanceOf(HeatGateDenied);
    expect((err as HeatGateDenied).ineligibility.reason).toBe('too-new');
  });

  // Load-bearing for the Solana rail: submitLaunch treats anything that is NOT
  // ConfirmationTimeout/LaunchFailedOnChain as "never broadcast". A denial IS never
  // broadcast, so HeatGateDenied must stay a plain Error subclass and must never grow
  // a `signature` — otherwise a refusal could be reported as a landed transaction.
  it('is a plain Error subclass with no signature — a denial is not a broadcast', async () => {
    const read = vi.fn(async () => reading(null));
    const err = await assertMayLaunch('0xabc', { nowUnix: NOW, read }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Record<string, unknown>).signature).toBeUndefined();
  });
});
