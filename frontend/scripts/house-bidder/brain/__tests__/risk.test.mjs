// @vitest-environment node
//
// The breakers (BUILD-SPEC 3.5 step 4): each one trips on its own condition and not next to it,
// lands in the right kind (integrity / market / cap), and the market kind resumes on its own
// after 2 hours at one unit while the integrity kind waits for a person.
import { describe, it, expect } from 'vitest';
import { createRisk, classify, classifyAdmin, diffSnapshots, restoreRisk, INTEGRITY, MARKET, CAPS, actionsFor } from '../risk.mjs';
import { DEFAULT_PARAMS } from '../params.mjs';
import { fakeClock, snapshotOf, milli } from '../../exec/__tests__/fakes.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup() {
  const clock = fakeClock();
  const risk = createRisk({ now: clock.now });
  risk.noteRestRead({ ok: true, startedAt: clock.now() });
  return { clock, risk };
}

describe('classification', () => {
  it('puts every reason in exactly one kind, and nothing else anywhere', () => {
    for (const r of INTEGRITY) expect(classify(r)).toBe('integrity');
    for (const r of MARKET) expect(classify(r)).toBe('market');
    for (const r of CAPS) expect(classify(r)).toBe(r === 'stolen-loss' ? 'halt' : 'cap');
    expect(classify('made-up')).toBe(null);
    expect(actionsFor('integrity')).toEqual(['cancel-all', 'kill']);
    expect(actionsFor('market')).toEqual(['cancel-all']);
  });

  it('refuses a reason from the wrong list', () => {
    const { risk } = setup();
    expect(() => risk.integrity('floor-drop-1h')).toThrow();
    expect(() => risk.market('mint')).toThrow();
    expect(() => risk.cap('mint')).toThrow();
  });

  it('reads admin changes from two snapshots: mints, maxSupply, owners, seed, lock', () => {
    const a = snapshotOf();
    const reasons = (over) => diffSnapshots(a, snapshotOf(over)).map((d) => d.reason);
    expect(reasons({ jbac: { totalSupply: 5556n } })).toEqual(['mint']);
    expect(reasons({ gnss: { totalSupply: 9698n } })).toEqual(['mint']);
    expect(reasons({ jbac: { totalSupply: 5554n } })).toEqual([]); // a burn is not a mint
    expect(reasons({ jbac: { maxSupply: 6000n } })).toEqual(['jbac-max-supply']);
    expect(reasons({ jbac: { owner: '0x4444444444444444444444444444444444444444' } })).toEqual(['jbac-owner']);
    expect(reasons({ gnss: { owner: '0x4444444444444444444444444444444444444444' } })).toEqual(['gnss-owner']);
    expect(reasons({ gnss: { seed: '0x0000000000000000000000000000000000000abd' } })).toEqual(['gnss-seed']);
    expect(reasons({ gnss: { contractLocked: true } })).toEqual(['gnss-locked']);
    expect(reasons({})).toEqual([]);
    expect(diffSnapshots(null, a)).toEqual([]);
  });

  it('maps a chain watcher admin event by its field, and an unknown field still halts', () => {
    expect(classifyAdmin({ field: 'jbac.maxSupply' })).toBe('jbac-max-supply');
    expect(classifyAdmin({ field: 'gnss.seed' })).toBe('gnss-seed');
    expect(classifyAdmin({ field: 'gnss.contractLocked' })).toBe('gnss-locked');
    expect(classifyAdmin({ field: 'junglebay.owner' })).toBe('jbac-owner');
    expect(classifyAdmin({ field: 'gnssart owner' })).toBe('gnss-owner');
    expect(classifyAdmin({ field: 'baseURI' })).toBe('admin-change');
  });

  it('reads a supply change from the chain watcher as a mint when it grew, and as no breaker when it shrank (a burn)', () => {
    expect(classifyAdmin({ field: 'jbac.totalSupply', before: 5555n, after: 5556n })).toBe('mint');
    expect(classifyAdmin({ field: 'gnss.totalSupply', before: '9697', after: '9698' })).toBe('mint');
    expect(classifyAdmin({ field: 'jbac.totalSupply', before: 5555n, after: 5554n })).toBe(null);
    expect(classifyAdmin({ field: 'jbac.totalSupply', before: 'x', after: 'y' })).toBe('admin-change');
  });
});

describe('integrity: halts until a person restarts', () => {
  it('closes the gate and keeps it closed until acknowledged', () => {
    const { clock, risk } = setup();
    const e = risk.integrity('mint', 'JBAC #5556');
    expect(e.actions).toEqual(['cancel-all', 'kill']);
    expect(risk.gate().canPost).toBe(false);
    clock.advance(48 * HOUR);
    expect(risk.gate().canPost).toBe(false);
    expect(risk.integrity('jbac-owner')).toBe(null); // the first reason stands
    expect(risk.ackHalt().reason).toBe('mint');
    expect(risk.gate().canPost).toBe(true);
  });
});

describe('market breakers', () => {
  it('trips when the floor proxy falls more than 15% within an hour, not at 14%', () => {
    const { clock, risk } = setup();
    risk.noteFloor('junglebay', clock.now(), milli(50));
    clock.advance(30 * MIN);
    risk.noteFloor('junglebay', clock.now(), milli(43)); // -14%
    expect(risk.evaluate()).toEqual([]);
    clock.advance(10 * MIN);
    risk.noteFloor('junglebay', clock.now(), milli(42)); // -16%
    expect(risk.evaluate().map((e) => e.reason)).toEqual(['floor-drop-1h']);
  });

  it('trips when the floor proxy falls more than 25% within a day, not at 24%', () => {
    const { clock, risk } = setup();
    risk.noteFloor('junglebay', clock.now(), milli(50));
    for (let i = 1; i <= 20; i++) {
      clock.advance(HOUR);
      risk.noteFloor('junglebay', clock.now(), milli(50 - 0.6 * i)); // a slow slide, under 15% an hour
    }
    // 50 -> 38: -24%
    expect(risk.evaluate()).toEqual([]);
    clock.advance(HOUR);
    risk.noteFloor('junglebay', clock.now(), milli(37)); // -26% on the day, -2.6% on the hour
    expect(risk.evaluate().map((e) => e.reason)).toEqual(['floor-drop-24h']);
  });

  it('trips when the stream is silent over 2 minutes while REST reads fail, and not for either alone', () => {
    const { clock, risk } = setup();
    const quiet = clock.now() - 3 * MIN;
    expect(risk.evaluate({ streamLastMessageAt: quiet })).toEqual([]); // REST still fine
    risk.noteRestRead({ ok: false, startedAt: clock.now() });
    expect(risk.evaluate({ streamLastMessageAt: clock.now() - MIN })).toEqual([]); // stream fine
    expect(risk.evaluate({ streamLastMessageAt: quiet }).map((e) => e.reason)).toEqual(['stream-silent']);
  });

  it('trips at 3 units bought in 24 hours, not at 2, and not on older fills', () => {
    const { clock, risk } = setup();
    const s = clock.sec();
    expect(risk.evaluate({ fills: [{ time: s - 100 }, { time: s - 200 }, { time: s - 25 * 3600 }] })).toEqual([]);
    expect(risk.evaluate({ fills: [{ time: s - 100 }, { time: s - 200 }, { time: s - 300 }] }).map((e) => e.reason)).toEqual(['fill-burst']);
  });

  it('pauses for 2 hours, then resumes on its own at one unit, then for a day', () => {
    const { clock, risk } = setup();
    risk.market('stream-silent', 'test');
    expect(risk.gate().canPost).toBe(false);
    clock.advance(2 * HOUR - MIN);
    expect(risk.gate().canPost).toBe(false);
    clock.advance(MIN);
    expect(risk.gate()).toMatchObject({ canPost: true, maxQty: 1 });
    expect(risk.takeEvents().map((e) => e.kind)).toEqual(['market', 'resume']);
    clock.advance(24 * HOUR);
    expect(risk.gate()).toMatchObject({ canPost: true, maxQty: null });
  });

  it('does not re-trip on the same drop the moment the pause lifts', () => {
    const { clock, risk } = setup();
    risk.noteFloor('junglebay', clock.now(), milli(50));
    clock.advance(10 * MIN);
    risk.noteFloor('junglebay', clock.now(), milli(40));
    expect(risk.evaluate().map((e) => e.reason)).toEqual(['floor-drop-1h']);
    clock.advance(2 * HOUR);
    risk.noteFloor('junglebay', clock.now(), milli(40));
    expect(risk.evaluate()).toEqual([]);
    expect(risk.gate().canPost).toBe(true);
  });
});

describe('caps and gates', () => {
  it('stops new bids for the rest of the UTC day at the daily unit cap', () => {
    const clock = fakeClock(Date.parse('2026-11-16T20:00:00Z'));
    const risk = createRisk({ now: clock.now });
    risk.noteRestRead({ ok: true, startedAt: clock.now() });
    const ev = risk.evaluate({ daily: { wethSpent: 0n, units: DEFAULT_PARAMS.dailyMaxUnits, gasSpent: 0n } });
    expect(ev.map((e) => [e.kind, e.reason])).toEqual([['cap', 'daily-units']]);
    clock.advance(3 * HOUR); // 23:00 UTC
    expect(risk.gate().canPost).toBe(false);
    clock.advance(2 * HOUR); // 01:00 UTC the next day
    expect(risk.gate().canPost).toBe(true);
  });

  it('trips the WETH and gas caps', () => {
    const { risk } = setup();
    expect(risk.evaluate({ daily: { wethSpent: DEFAULT_PARAMS.dailyMaxWethWei, units: 0, gasSpent: 0n } })[0].reason).toBe('daily-weth');
    const b = setup();
    expect(b.risk.evaluate({ daily: { wethSpent: 0n, units: 0, gasSpent: DEFAULT_PARAMS.dailyMaxGasWei } })[0].reason).toBe('daily-gas');
  });

  it('halts at one stolen item in a month', () => {
    const { clock, risk } = setup();
    expect(risk.evaluate({ stolenThisMonth: 0 })).toEqual([]);
    expect(risk.evaluate({ stolenThisMonth: 1 }).map((e) => [e.kind, e.reason])).toEqual([['halt', 'stolen-loss']]);
    clock.advance(40 * 24 * HOUR);
    expect(risk.gate().canPost).toBe(false); // a halt waits for a person
  });

  it('after a stream gap posts nothing until the listings are re-read over REST', () => {
    const { clock, risk } = setup();
    const gapAt = clock.now();
    risk.noteGap(gapAt);
    expect(risk.gate().reason).toMatch(/data-gap/);
    risk.noteRestRead({ ok: true, startedAt: gapAt - 1000 }); // a read that began before the gap
    expect(risk.gate().canPost).toBe(false);
    clock.advance(5000);
    risk.noteRestRead({ ok: true, startedAt: clock.now() });
    expect(risk.gate().canPost).toBe(true);
  });
});

describe('restart', () => {
  it('stays halted after an unacknowledged integrity trip, and clears on an acknowledgement', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const trip = { kind: 'breaker', breaker: 'integrity', reason: 'mint', at: now - HOUR };
    expect(restoreRisk([trip], { nowMs: now }).halted.reason).toBe('mint');
    expect(restoreRisk([trip, { kind: 'ack-halt', at: now - 1000 }], { nowMs: now }).halted).toBe(null);
    // shadow lines never halt a live run
    expect(restoreRisk([{ ...trip, shadow: true }], { nowMs: now }).halted).toBe(null);
  });

  it('keeps a market pause that is still running, and the floor history, and starts with a data gap', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const s = restoreRisk(
      [
        { kind: 'breaker', breaker: 'market', reason: 'fill-burst', at: now - HOUR },
        { kind: 'mark', slug: 'junglebay', floorProxy: '50000000000000000', at: now - 30 * MIN },
      ],
      { nowMs: now },
    );
    expect(s.paused.until).toBe(now + HOUR);
    expect(s.floor.junglebay).toHaveLength(1);
    expect(s.dataGapSince).toBe(now);
    const risk = createRisk({ now: () => now, state: s });
    expect(risk.gate().canPost).toBe(false);
  });
});
