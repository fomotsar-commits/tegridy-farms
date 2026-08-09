// The audit ring: "every decision is logged replayable".
//
// Two properties matter more than the storage mechanics. First, a row carries the
// values AS THEY WERE at the decision, so a floor that moves next week cannot rewrite
// what last week's door was measuring against. Second, storage failing is never allowed
// to fail a launch — a private-mode browser still gets a row and a gate_decision_id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordGateDecision, readGateAudit, findGateDecision, clearGateAudit } from './gateAudit';
import { gateDecision, parseHeatReading, type HeatReading } from './heatOracle';

const ADDR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const NOW = 1786104024;

function reading(degrees: number, tier = 'Builder'): HeatReading {
  return parseHeatReading({
    address: ADDR,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: NOW - 400 * 86_400,
    as_of_unix: NOW,
    token_count: 1,
    breakdown: [],
  });
}

beforeEach(() => {
  clearGateAudit();
});

describe('recordGateDecision', () => {
  it('stores the spec’s row and hands back its gate_decision_id', () => {
    const row = recordGateDecision(gateDecision(ADDR, reading(195.54), NOW));
    expect(row).toMatchObject({
      address: ADDR,
      degrees: 195.54,
      tier: 'Builder',
      as_of: NOW,
      floor: 80,
      verdict: 'WARM',
    });
    expect(findGateDecision(row.id)).toMatchObject({ id: row.id, verdict: 'WARM' });
  });

  it('newest first', () => {
    recordGateDecision(gateDecision(ADDR, reading(10, 'Drifter'), NOW));
    recordGateDecision(gateDecision(ADDR, reading(195.54), NOW));
    expect(readGateAudit().map((r) => r.verdict)).toEqual(['WARM', 'COLD']);
  });

  it('ids are unique across decisions', () => {
    const ids = new Set(Array.from({ length: 50 }, () => recordGateDecision(gateDecision(ADDR, reading(100), NOW)).id));
    expect(ids.size).toBe(50);
  });

  it('freezes the floor into the row — a later floor change cannot rewrite history', () => {
    const row = recordGateDecision(gateDecision(ADDR, reading(100), NOW, 250));
    expect(row.floor).toBe(250);
    expect(row.verdict).toBe('COLD');
    // A subsequent, more permissive decision leaves the old row untouched.
    recordGateDecision(gateDecision(ADDR, reading(100), NOW, 30));
    expect(findGateDecision(row.id)).toMatchObject({ floor: 250, verdict: 'COLD' });
  });

  it('an unreadable decision stores null degrees, never 0', () => {
    const row = recordGateDecision(gateDecision(ADDR, null, NOW));
    expect(row.degrees).toBeNull();
    expect(row.tier).toBeNull();
    expect(row.verdict).toBe('STALE');
  });

  it('caps the ring rather than growing forever', () => {
    for (let i = 0; i < 260; i++) recordGateDecision(gateDecision(ADDR, reading(100), NOW));
    expect(readGateAudit()).toHaveLength(200);
  });

  it('survives a corrupted store instead of crashing the surface that renders it', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', '{not json');
    expect(readGateAudit()).toEqual([]);
    // …and a write still lands afterwards.
    expect(recordGateDecision(gateDecision(ADDR, reading(100), NOW)).id).toBeTruthy();
  });

  it('drops half-written rows rather than handing them to the UI', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', JSON.stringify([{ nope: true }, null, 7]));
    expect(readGateAudit()).toEqual([]);
  });

  it('STILL returns a row when storage throws — a private-mode browser can launch', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const row = recordGateDecision(gateDecision(ADDR, reading(195.54), NOW));
    expect(row.id).toBeTruthy();
    expect(row.verdict).toBe('WARM');
    spy.mockRestore();
  });
});
