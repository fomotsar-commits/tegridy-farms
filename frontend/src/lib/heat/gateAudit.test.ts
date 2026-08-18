// The audit ring: "every decision is logged replayable".
//
// Two properties matter more than the storage mechanics. First, a row carries the
// values AS THEY WERE at the decision, so a floor that moves next week cannot rewrite
// what last week's door was measuring against. Second, storage failing is never allowed
// to fail a launch — a private-mode browser still gets a row and a gate_decision_id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordGateDecision,
  readGateAudit,
  readGateAuditState,
  isSameAuditAddress,
  findGateDecision,
  clearGateAudit,
} from './gateAudit';
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

// ── The READ half ──────────────────────────────────────────────────────────
// `readGateAudit` answers [] for every kind of failure, which is right for a caller
// that only wants rows and disastrous for one that RENDERS them: a surface built on
// it shows "no decisions" to a wallet whose browser is simply refusing to store any.
// `readGateAuditState` exists so that distinction survives to the screen.

describe('readGateAuditState', () => {
  it('tells an empty record apart from an unavailable one', () => {
    expect(readGateAuditState()).toEqual({ kind: 'ok', rows: [], dropped: 0 });

    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    expect(readGateAuditState()).toEqual({ kind: 'unavailable' });
    spy.mockRestore();
  });

  it('reports a corrupted blob as unreadable, not as an empty record', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', '{not json');
    expect(readGateAuditState()).toEqual({ kind: 'unreadable' });
    // ...and the legacy accessor keeps its own contract.
    expect(readGateAudit()).toEqual([]);
  });

  it('reports a non-array blob as unreadable', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', JSON.stringify({ rows: [] }));
    expect(readGateAuditState()).toEqual({ kind: 'unreadable' });
  });

  it('drops a row missing the fields a renderer dereferences, rather than handing it over', () => {
    // `new Date(undefined * 1000).toISOString()` throws, and a missing floor prints the
    // word "undefined" beside a real degrees figure. Both are worse than one fewer row.
    const good = recordGateDecision(gateDecision(ADDR, reading(100), NOW));
    localStorage.setItem(
      'tegridy.heat.gate.audit.v1',
      JSON.stringify([
        { ...good, decided_at: undefined },
        { ...good, floor: 'eighty' },
        { ...good, verdict: 'MAYBE' },
        { ...good, reason: 'vibes' },
        { ...good, tier: 'Sovereign' },
        { ...good, degrees: 'lots' },
        good,
      ]),
    );
    const state = readGateAuditState();
    expect(state).toMatchObject({ kind: 'ok', dropped: 6 });
    expect(state.kind === 'ok' && state.rows).toHaveLength(1);
  });

  it('keeps the nulls that are real answers — an unread instrument is a valid row', () => {
    const unread = recordGateDecision(gateDecision(ADDR, null, NOW));
    expect(unread).toMatchObject({ degrees: null, tier: null, as_of: null });
    const state = readGateAuditState();
    expect(state).toMatchObject({ kind: 'ok', dropped: 0 });
    expect(state.kind === 'ok' && state.rows).toHaveLength(1);
  });

  it('counts half-written rows it dropped, so a partial list can say it is partial', () => {
    const good = recordGateDecision(gateDecision(ADDR, reading(100), NOW));
    localStorage.setItem(
      'tegridy.heat.gate.audit.v1',
      JSON.stringify([{ nope: true }, good, null]),
    );
    const state = readGateAuditState();
    expect(state).toMatchObject({ kind: 'ok', dropped: 2 });
    expect(state.kind === 'ok' && state.rows.map((r) => r.id)).toEqual([good.id]);
  });

  it('returns rows newest-first, matching the write order', () => {
    recordGateDecision(gateDecision(ADDR, reading(10, 'Drifter'), NOW));
    recordGateDecision(gateDecision(ADDR, reading(195.54), NOW));
    const state = readGateAuditState();
    expect(state.kind === 'ok' && state.rows.map((r) => r.verdict)).toEqual(['WARM', 'COLD']);
  });
});

describe('isSameAuditAddress', () => {
  it('folds EVM case — a checksummed row still matches a lower-cased connection', () => {
    expect(isSameAuditAddress(ADDR, ADDR.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isSameAuditAddress(`  ${ADDR}  `, ADDR)).toBe(true);
  });

  it('never folds base58 — Solana case is significant and folding would merge wallets', () => {
    const a = 'So11111111111111111111111111111111111111112';
    expect(isSameAuditAddress(a, a)).toBe(true);
    expect(isSameAuditAddress(a, a.toLowerCase())).toBe(false);
  });

  it('does not match two different wallets', () => {
    expect(isSameAuditAddress(ADDR, '0x0000000000000000000000000000000000000001')).toBe(false);
  });
});
