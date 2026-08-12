// THE ACCEPTANCE LIST, as tests. Launch-gate spec §3:
//
//   "A wallet above floor sees the open lane · below floor sees its degrees and the
//    path · stale closes the gate · no token list exists anywhere in venue code ·
//    every decision is logged replayable · zero manual verification steps anywhere
//    in the flow."

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { meetsHeatFloor, assertMayLaunch, HeatGateDenied } from './launchGate';
import { parseHeatReading, LAUNCH_FLOOR, type HeatReading } from './heatOracle';
import { readGateAudit, clearGateAudit, findGateDecision } from './gateAudit';

const ADDR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const NOW = 1786104024;
const DAY = 86_400;

/** A reading of exactly `degrees`, reckoned `agoDays` before NOW. */
function reading(degrees: number, tier = 'Resident', agoDays = 0): HeatReading {
  return parseHeatReading({
    address: ADDR,
    degrees,
    tier,
    is_cold: degrees === 0,
    held_since_unix: NOW - 400 * DAY,
    as_of_unix: NOW - agoDays * DAY,
    token_count: 1,
    breakdown: [
      {
        token_address: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca',
        chain: 'base',
        name: 'TOWELI',
        symbol: 'TOWELI',
        heat_degrees: degrees,
        first_seen_at_unix: NOW - 400 * DAY,
        last_transfer_at_unix: NOW - DAY,
      },
    ],
  });
}

const warmRead = async () => reading(195.54, 'Builder');
const coldRead = async () => reading(12, 'Drifter');
const staleRead = async () => reading(195.54, 'Builder', 30);
const deadOracle = async () => {
  throw new Error('ECONNRESET');
};

beforeEach(() => {
  clearGateAudit();
});

describe('meetsHeatFloor — a wallet above the floor sees the open lane', () => {
  it('WARM above the floor', async () => {
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: warmRead });
    expect(decision.state).toBe('WARM');
    expect(decision.qualified).toBe(true);
  });

  it('uses the island’s floor of 80 by default — Residents may plant', async () => {
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: async () => reading(80) });
    expect(decision.floor).toBe(LAUNCH_FLOOR);
    expect(decision.state).toBe('WARM');
  });
});

describe('below floor sees its degrees and the path', () => {
  it('COLD, carrying the wallet’s OWN number', async () => {
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: coldRead });
    expect(decision.state).toBe('COLD');
    expect(decision.degrees).toBe(12);
    expect(decision.detail).toContain('12.00°');
    expect(decision.detail).toContain('held time');
  });
});

describe('stale closes the gate — fail-closed, never a silent pass', () => {
  it('an unreachable oracle is STALE, never a pass and never a zero score', async () => {
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: deadOracle });
    expect(decision.state).toBe('STALE');
    expect(decision.qualified).toBe(false);
    // The distinction that matters: we could not ask. Not "you scored nothing".
    expect(decision.degrees).toBeNull();
    expect(decision.reason).toBe('unreadable');
  });

  it('a reading older than 7 days closes the gate on a wallet that would otherwise pass', async () => {
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: staleRead });
    expect(decision.state).toBe('STALE');
    expect(decision.qualified).toBe(false);
  });

  it('does NOT throw on an outage — the door renders the reason without a try/catch', async () => {
    await expect(meetsHeatFloor(ADDR, { nowUnix: NOW, read: deadOracle })).resolves.toBeTruthy();
  });

  it('reads FRESH on the verdict path — a cached reading never decides anything', async () => {
    const read = vi.fn(warmRead);
    await meetsHeatFloor(ADDR, { nowUnix: NOW, read });
    await meetsHeatFloor(ADDR, { nowUnix: NOW, read });
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('every decision is logged replayable', () => {
  it('logs the spec’s row: address, degrees, tier, as_of, floor, verdict', async () => {
    const { audit } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: warmRead });
    expect(audit).toMatchObject({
      address: ADDR,
      degrees: 195.54,
      tier: 'Builder',
      as_of: NOW,
      floor: 80,
      verdict: 'WARM',
    });
    expect(typeof audit!.id).toBe('string');
  });

  it('logs DENIALS too, not only passes', async () => {
    await meetsHeatFloor(ADDR, { nowUnix: NOW, read: coldRead });
    await meetsHeatFloor(ADDR, { nowUnix: NOW, read: deadOracle });
    expect(readGateAudit().map((r) => r.verdict)).toEqual(['STALE', 'COLD']);
  });

  it('the row is retrievable by its gate_decision_id — that is what makes it replayable', async () => {
    const { audit } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: warmRead });
    expect(findGateDecision(audit!.id)?.degrees).toBe(195.54);
  });

  it('records the floor the decision was TAKEN against, so moving the floor cannot rewrite history', async () => {
    const { audit } = await meetsHeatFloor(ADDR, { nowUnix: NOW, floor: 250, read: warmRead });
    expect(audit!.floor).toBe(250);
    expect(audit!.verdict).toBe('COLD'); // 195.54 < 250
  });

  it('an unreadable row stores degrees as null, never as 0', async () => {
    const { audit } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: deadOracle });
    expect(audit!.degrees).toBeNull();
    expect(audit!.tier).toBeNull();
  });

  it('skipAudit keeps the door’s re-renders out of the ring', async () => {
    await meetsHeatFloor(ADDR, { nowUnix: NOW, read: warmRead, skipAudit: true });
    expect(readGateAudit()).toHaveLength(0);
  });
});

describe('assertMayLaunch — the enforcement form', () => {
  it('returns the audit row on a pass, so the birth can carry gate_decision_id', async () => {
    const row = await assertMayLaunch(ADDR, { nowUnix: NOW, read: warmRead });
    expect(row).not.toBeNull();
    expect(row!.verdict).toBe('WARM');
  });

  it('throws HeatGateDenied below the floor', async () => {
    await expect(assertMayLaunch(ADDR, { nowUnix: NOW, read: coldRead })).rejects.toBeInstanceOf(HeatGateDenied);
  });

  it('throws on an unreachable oracle — an outage is never a pass', async () => {
    await expect(assertMayLaunch(ADDR, { nowUnix: NOW, read: deadOracle })).rejects.toBeInstanceOf(HeatGateDenied);
  });

  it('the denial carries the decision AND the audit id the user can quote', async () => {
    const err = await assertMayLaunch(ADDR, { nowUnix: NOW, read: coldRead }).catch((e) => e);
    expect(err).toBeInstanceOf(HeatGateDenied);
    expect((err as HeatGateDenied).decision.state).toBe('COLD');
    expect(findGateDecision((err as HeatGateDenied).audit.id)).not.toBeNull();
  });

  it('the denial is a PLAIN Error subclass — no signature, so it can never read as broadcast', async () => {
    const err = (await assertMayLaunch(ADDR, { nowUnix: NOW, read: coldRead }).catch((e) => e)) as HeatGateDenied;
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as { signature?: unknown }).signature).toBeUndefined();
  });
});

describe('no token list, no day-rule, no calendar, no human', () => {
  it('the whole verdict comes from one number and one date', async () => {
    // A wallet holding NOTHING the venue has ever heard of, but 500° island-side, passes.
    // If a token allowlist existed anywhere on this path, this could not be true.
    const exotic = parseHeatReading({
      address: ADDR,
      degrees: 500,
      tier: 'Elder',
      is_cold: false,
      held_since_unix: NOW - DAY,
      as_of_unix: NOW,
      token_count: 1,
      breakdown: [
        {
          token_address: '0xffffffffffffffffffffffffffffffffffffffff',
          chain: 'some-chain-we-do-not-know',
          name: 'Enrolled Tomorrow',
          symbol: 'NEW',
          heat_degrees: 500,
          first_seen_at_unix: NOW - DAY,
          last_transfer_at_unix: NOW,
        },
      ],
    });
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: async () => exotic });
    expect(decision.state).toBe('WARM');
  });

  it('one day of held history is no obstacle — the instrument is the time rule', async () => {
    const fresh = parseHeatReading({
      address: ADDR,
      degrees: 195.54,
      tier: 'Builder',
      is_cold: false,
      held_since_unix: NOW - DAY,
      as_of_unix: NOW,
      token_count: 1,
      breakdown: [],
    });
    const { decision } = await meetsHeatFloor(ADDR, { nowUnix: NOW, read: async () => fresh });
    expect(decision.state).toBe('WARM');
  });
});
