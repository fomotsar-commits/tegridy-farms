// useProtocolHealth — the rule that a green light must be earned.
//
// THE BUG THIS PINS. `LiveActivity` rendered a green pulse and the words
// "Protocol Active" unconditionally: it was copy, not a reading. It stayed green
// through an RPC outage, through a paused staking contract, and through a total
// price-feed failure — the exact shape the house doctrine forbids, because an
// outage that renders as health is worse than no indicator at all.
//
// The property held here: `active` is reachable ONLY from a *successful*
// `paused()` read that came back false. Every other combination — pending read,
// failed read, unwired address — resolves to `unknown`, never upward.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { deriveProtocolHealth, useProtocolHealth, type ProtocolHealthInputs } from './useProtocolHealth';
import { TEGRIDY_STAKING_ADDRESS, isDeployed } from '../lib/constants';

/** Price legs the hook consumes; healthy by default so the chain leg is isolated. */
const priceState = { priceUnavailable: false, displayPriceStale: false };
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => priceState,
}));

/** A fully-healthy input set; each test perturbs exactly one field. */
const HEALTHY: ProtocolHealthInputs = {
  stakingDeployed: true,
  pausedReadOk: true,
  paused: false,
  priceUnavailable: false,
  displayPriceStale: false,
};

describe('deriveProtocolHealth', () => {
  it('claims active only when the pause read succeeded false and a price answers', () => {
    const h = deriveProtocolHealth(HEALTHY);
    expect(h.status).toBe('active');
    expect(h.label).toBe('Protocol Active');
    expect(h.color).toBe('#22c55e');
  });

  it('reports unknown — not active — when the pause read has not returned', () => {
    const h = deriveProtocolHealth({ ...HEALTHY, pausedReadOk: false });
    expect(h.status).toBe('unknown');
    expect(h.color).not.toBe('#22c55e');
  });

  it('reports unknown when no staking address is wired', () => {
    const h = deriveProtocolHealth({ ...HEALTHY, stakingDeployed: false });
    expect(h.status).toBe('unknown');
  });

  it('reports paused when the chain says paused', () => {
    const h = deriveProtocolHealth({ ...HEALTHY, paused: true });
    expect(h.status).toBe('paused');
    expect(h.label).toMatch(/paused/i);
  });

  it('reports degraded when no price source answers', () => {
    const h = deriveProtocolHealth({ ...HEALTHY, priceUnavailable: true });
    expect(h.status).toBe('degraded');
    expect(h.label).toMatch(/no price/i);
  });

  it('reports degraded when the only price on hand is a stale cache', () => {
    const h = deriveProtocolHealth({ ...HEALTHY, displayPriceStale: true });
    expect(h.status).toBe('degraded');
    expect(h.label).toMatch(/stale/i);
  });

  // A failed read defaults `paused` to false in the hook. If the ladder ever
  // consulted `paused` before `pausedReadOk`, an RPC outage would read as
  // "unpaused" and light up green. This locks the ordering.
  it('an unreturned read outranks the pause value it could not read', () => {
    expect(deriveProtocolHealth({ ...HEALTHY, pausedReadOk: false, paused: false }).status).toBe('unknown');
    expect(deriveProtocolHealth({ ...HEALTHY, pausedReadOk: false, paused: true }).status).toBe('unknown');
  });

  // Exhaustive: over every combination of the five inputs, `active` must appear
  // for exactly the one row that proves it.
  it('no input combination reaches active without a successful unpaused read and a live price', () => {
    const bools = [false, true];
    for (const stakingDeployed of bools)
      for (const pausedReadOk of bools)
        for (const paused of bools)
          for (const priceUnavailable of bools)
            for (const displayPriceStale of bools) {
              const input = { stakingDeployed, pausedReadOk, paused, priceUnavailable, displayPriceStale };
              const earned = stakingDeployed && pausedReadOk && !paused && !priceUnavailable && !displayPriceStale;
              expect(
                deriveProtocolHealth(input).status === 'active',
                `active mismatch for ${JSON.stringify(input)}`,
              ).toBe(earned);
            }
  });

  // HONESTY GUARD: the indicator must be able to say what it is derived from.
  // A status word with no stated basis is a claim the user cannot check.
  it('every status discloses its own basis', () => {
    const cases: ProtocolHealthInputs[] = [
      HEALTHY,
      { ...HEALTHY, pausedReadOk: false },
      { ...HEALTHY, stakingDeployed: false },
      { ...HEALTHY, paused: true },
      { ...HEALTHY, priceUnavailable: true },
      { ...HEALTHY, displayPriceStale: true },
    ];
    for (const c of cases) {
      const h = deriveProtocolHealth(c);
      expect(h.basis.length, `empty basis for ${h.status}`).toBeGreaterThan(20);
    }
    // The non-green states must name the limit rather than merely omitting green.
    expect(deriveProtocolHealth({ ...HEALTHY, pausedReadOk: false }).basis).toMatch(/unverified|not returned/i);
    expect(deriveProtocolHealth({ ...HEALTHY, stakingDeployed: false }).basis).toMatch(/cannot be read/i);
  });
});

describe('useProtocolHealth', () => {
  beforeEach(() => {
    wagmiMock.reset();
    priceState.priceUnavailable = false;
    priceState.displayPriceStale = false;
  });

  // Guards the assumption the suite below is built on: if the staking address is
  // ever zeroed in constants, every case here would trivially return 'unknown'
  // and stop testing anything.
  it('is exercised against a wired staking address', () => {
    expect(isDeployed(TEGRIDY_STAKING_ADDRESS)).toBe(true);
  });

  it('renders unknown when the chain read fails', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: undefined, status: 'failure' });
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('unknown');
  });

  it('renders unknown when nothing has answered at all', () => {
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('unknown');
  });

  it('renders paused on a successful true read', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: true });
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('paused');
  });

  it('renders active on a successful false read with a live price', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('active');
  });

  it('does not require a connected wallet to reach active', () => {
    wagmiMock.setAccount({ address: undefined, isConnected: false });
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('active');
  });

  it('degrades when the chain leg is healthy but no price answers', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    priceState.priceUnavailable = true;
    const { result } = renderHook(() => useProtocolHealth());
    expect(result.current.status).toBe('degraded');
  });
});
