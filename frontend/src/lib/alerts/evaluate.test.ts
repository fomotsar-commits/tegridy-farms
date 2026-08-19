// The honesty guard for the alert engine.
//
// This module's only product is silence or a notification, and the test's job is
// to make silence expensive. Every assertion below is a way the engine could tell
// a user "nothing happened" when the truth is "nothing was read":
//
//   - the source was unreachable
//   - the source is not configured on this deployment
//   - the reading came back for a different rule than the one asked
//   - a change rule has no previous reading to compare against
//   - the reading is too old for its own source to stand behind
//   - no reading was produced for the rule at all
//
// The exhaustive sweep at the bottom is the real guard: across every rule kind,
// an `unavailable` reading must produce `cannot-evaluate` — never `quiet` — and
// every non-fired verdict must arrive with a reason attached.

import { describe, it, expect } from 'vitest';
import {
  evaluateAll,
  evaluateRule,
  summarizeEvaluations,
  type PriorSnapshot,
  type RuleFacts,
  type SourceReading,
} from './evaluate';
import { ALERT_RULE_KINDS, type AlertRule, type AlertRuleKind } from './rules';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;
const OTHER = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as const;
const NOW = 1_760_000_000;

function rule(kind: AlertRuleKind, over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: `rule-${kind}`,
    kind,
    subject: SUBJECT,
    threshold: kind === 'whale-move' ? 10_000 : null,
    enabled: true,
    createdAt: NOW - 3600,
    ...over,
  };
}

/** A well-formed, matching reading per kind — the only shape that may ever fire. */
function firingReading(kind: AlertRuleKind, prior?: PriorSnapshot): SourceReading<RuleFacts> {
  switch (kind) {
    case 'whale-move':
      return {
        status: 'ok',
        observedAt: NOW,
        value: {
          kind,
          transfers: [{ txHash: '0xabc', logIndex: 3, valueUsd: 50_000, blockNumber: 21_000_000, at: NOW - 60 }],
        },
      };
    case 'lp-unlock':
      return {
        status: 'ok',
        observedAt: NOW,
        value: { kind, unlocks: [{ ref: 'lock-1', unlockAt: NOW - 10, locker: OTHER, txHash: '0xdef' }] },
      };
    case 'launch-live':
      return {
        status: 'ok',
        observedAt: NOW,
        value: { kind, launches: [{ token: SUBJECT, pool: OTHER, launchedAt: NOW - 30, name: 'TEST' }] },
      };
    case 'heat-tier':
      return {
        status: 'ok',
        observedAt: NOW,
        value: { kind, change: { signature: 'Builder', label: 'Builder (160.00°)', staleDetail: null } },
      };
    case 'deployer-reputation':
      return {
        status: 'ok',
        observedAt: NOW,
        value: { kind, change: { signature: 'c2/a1/t0/n1/u0@low', label: '2 created · 1 active', staleDetail: null } },
      };
  }
  void prior;
  throw new Error(`unhandled kind ${kind}`);
}

const CHANGE_PRIOR: PriorSnapshot = { signature: 'Observer', label: 'Observer (40.00°)', at: NOW - 86_400 };
const REP_PRIOR: PriorSnapshot = { signature: 'c1/a0/t0/n1/u0@low', label: '1 created', at: NOW - 86_400 };

function priorFor(kind: AlertRuleKind): PriorSnapshot | null {
  if (kind === 'heat-tier') return CHANGE_PRIOR;
  if (kind === 'deployer-reputation') return REP_PRIOR;
  return null;
}

describe('an unreadable source is never a quiet market', () => {
  it.each(ALERT_RULE_KINDS)('%s: unavailable → cannot-evaluate, carrying the reason', (kind) => {
    const reading: SourceReading<RuleFacts> = {
      status: 'unavailable',
      detail: 'The indexer is not configured on this deployment.',
    };
    const { evaluation } = evaluateRule(rule(kind), reading, priorFor(kind), NOW);
    expect(evaluation.verdict).toBe('cannot-evaluate');
    expect(evaluation.events).toEqual([]);
    expect(evaluation.detail).toBe('The indexer is not configured on this deployment.');
  });

  it('the reason is never emptied on its way through', () => {
    const { evaluation } = evaluateRule(
      rule('whale-move'),
      { status: 'unavailable', detail: 'Upstream 502.' },
      null,
      NOW,
    );
    expect(evaluation.detail.length).toBeGreaterThan(0);
  });

  it('an unavailable reading does not overwrite a change rule’s baseline', () => {
    // Wiping the baseline on an outage would make the NEXT successful read look
    // like a first read, and the real change that happened in between would be
    // reported as "no baseline" and then silently absorbed.
    const { nextPrior } = evaluateRule(
      rule('heat-tier'),
      { status: 'unavailable', detail: 'oracle down' },
      CHANGE_PRIOR,
      NOW,
    );
    expect(nextPrior).toEqual(CHANGE_PRIOR);
  });
});

describe('a rule nobody read is not a rule that found nothing', () => {
  it('evaluateAll marks a rule with no reading as cannot-evaluate', () => {
    const r = rule('whale-move');
    const { evaluations } = evaluateAll([r], {}, {}, NOW);
    expect(evaluations[0]!.verdict).toBe('cannot-evaluate');
    expect(evaluations[0]!.detail).toMatch(/could not be evaluated/i);
  });

  it('one dark rule does not suppress a readable one', () => {
    const dark = rule('whale-move', { id: 'dark' });
    const live = rule('launch-live', { id: 'live' });
    const { evaluations } = evaluateAll(
      [dark, live],
      { live: firingReading('launch-live') },
      {},
      NOW,
    );
    const byId = Object.fromEntries(evaluations.map((e) => [e.ruleId, e.verdict]));
    expect(byId.dark).toBe('cannot-evaluate');
    expect(byId.live).toBe('fired');
  });
});

describe('a reading for the wrong question is refused, not answered', () => {
  it('mismatched fact kind → cannot-evaluate', () => {
    const reading = firingReading('launch-live');
    const { evaluation } = evaluateRule(rule('whale-move'), reading, null, NOW);
    expect(evaluation.verdict).toBe('cannot-evaluate');
    expect(evaluation.events).toEqual([]);
  });
});

describe('change rules refuse to speak without a baseline', () => {
  it.each(['heat-tier', 'deployer-reputation'] as const)('%s: first reading is cannot-evaluate', (kind) => {
    const { evaluation, nextPrior } = evaluateRule(rule(kind), firingReading(kind), null, NOW);
    expect(evaluation.verdict).toBe('cannot-evaluate');
    expect(evaluation.detail).toMatch(/first reading/i);
    // The baseline IS recorded — otherwise the rule would say this forever.
    expect(nextPrior).not.toBeNull();
  });

  it('the second reading compares, and an unchanged signature is a real quiet', () => {
    const r = rule('heat-tier');
    const first = evaluateRule(r, firingReading('heat-tier'), null, NOW);
    const second = evaluateRule(r, firingReading('heat-tier'), first.nextPrior, NOW + 60);
    expect(second.evaluation.verdict).toBe('quiet');
    expect(second.evaluation.detail).toMatch(/unchanged/i);
  });

  it('a changed signature fires once, with both sides named', () => {
    const { evaluation } = evaluateRule(rule('heat-tier'), firingReading('heat-tier'), CHANGE_PRIOR, NOW);
    expect(evaluation.verdict).toBe('fired');
    expect(evaluation.events).toHaveLength(1);
    expect(evaluation.events[0]!.body).toContain('Observer');
    expect(evaluation.events[0]!.body).toContain('Builder');
  });

  it('re-evaluating the same change produces the same idempotency key', () => {
    const a = evaluateRule(rule('heat-tier'), firingReading('heat-tier'), CHANGE_PRIOR, NOW);
    const b = evaluateRule(rule('heat-tier'), firingReading('heat-tier'), CHANGE_PRIOR, NOW + 600);
    expect(a.evaluation.events[0]!.idempotencyKey).toBe(b.evaluation.events[0]!.idempotencyKey);
  });
});

describe('a stale reading may not pass or fail anyone', () => {
  it('heat: staleDetail → cannot-evaluate, and the stale value never becomes the baseline', () => {
    const reading: SourceReading<RuleFacts> = {
      status: 'ok',
      observedAt: NOW,
      value: {
        kind: 'heat-tier',
        change: { signature: 'Elder', label: 'Elder', staleDetail: 'The island last recalculated 40 days ago.' },
      },
    };
    const { evaluation, nextPrior } = evaluateRule(rule('heat-tier'), reading, CHANGE_PRIOR, NOW);
    expect(evaluation.verdict).toBe('cannot-evaluate');
    expect(evaluation.detail).toMatch(/40 days ago/);
    expect(nextPrior).toEqual(CHANGE_PRIOR);
  });
});

describe('a real negative is allowed to be a real negative', () => {
  it('whale-move below threshold is quiet, and says what was compared', () => {
    const reading: SourceReading<RuleFacts> = {
      status: 'ok',
      observedAt: NOW,
      value: {
        kind: 'whale-move',
        transfers: [{ txHash: '0x1', logIndex: 0, valueUsd: 5, blockNumber: 1, at: NOW }],
      },
    };
    const { evaluation } = evaluateRule(rule('whale-move'), reading, null, NOW);
    expect(evaluation.verdict).toBe('quiet');
    expect(evaluation.events).toEqual([]);
    expect(evaluation.detail).toMatch(/\$10,000/);
  });

  it('launch-live ignores pools for other tokens', () => {
    const reading: SourceReading<RuleFacts> = {
      status: 'ok',
      observedAt: NOW,
      value: { kind: 'launch-live', launches: [{ token: OTHER, pool: null, launchedAt: NOW }] },
    };
    const { evaluation } = evaluateRule(rule('launch-live'), reading, null, NOW);
    expect(evaluation.verdict).toBe('quiet');
  });

  it('lp-unlock does not fire on a lock that has not reached its time', () => {
    const reading: SourceReading<RuleFacts> = {
      status: 'ok',
      observedAt: NOW,
      value: { kind: 'lp-unlock', unlocks: [{ ref: 'l1', unlockAt: NOW + 86_400, locker: OTHER, txHash: null }] },
    };
    const { evaluation } = evaluateRule(rule('lp-unlock'), reading, null, NOW);
    expect(evaluation.verdict).toBe('quiet');
  });
});

describe('a disabled rule is its own state, not a negative', () => {
  it('reports off and reads nothing', () => {
    const { evaluation } = evaluateRule(
      rule('whale-move', { enabled: false }),
      firingReading('whale-move'),
      null,
      NOW,
    );
    expect(evaluation.verdict).toBe('off');
    expect(evaluation.events).toEqual([]);
  });

  it('turning a change rule off keeps its baseline, so turning it back on is not a re-arm', () => {
    const { nextPrior } = evaluateRule(
      rule('heat-tier', { enabled: false }),
      firingReading('heat-tier'),
      CHANGE_PRIOR,
      NOW,
    );
    expect(nextPrior).toEqual(CHANGE_PRIOR);
  });
});

describe('every fired event is attributable', () => {
  it.each(ALERT_RULE_KINDS)('%s: carries provenance and an as-of time', (kind) => {
    const { evaluation } = evaluateRule(rule(kind), firingReading(kind), priorFor(kind), NOW);
    if (evaluation.verdict !== 'fired') return; // change kinds with no prior are covered above
    for (const event of evaluation.events) {
      expect(event.provenance.length).toBeGreaterThan(0);
      expect(event.observedAt).toBeGreaterThan(0);
      expect(event.idempotencyKey).toContain(event.ruleId);
    }
  });

  it('whale and lp events anchor to the transaction that produced them', () => {
    const whale = evaluateRule(rule('whale-move'), firingReading('whale-move'), null, NOW);
    expect(whale.evaluation.events[0]!.anchor).toEqual({ chain: 'ethereum', ref: '0xabc' });
    const lp = evaluateRule(rule('lp-unlock'), firingReading('lp-unlock'), null, NOW);
    expect(lp.evaluation.events[0]!.anchor).toEqual({ chain: 'ethereum', ref: '0xdef' });
  });
});

describe('the exhaustive sweep', () => {
  it('no kind can reach `quiet` from an unavailable reading, in any prior state', () => {
    const priors: (PriorSnapshot | null)[] = [null, CHANGE_PRIOR, REP_PRIOR];
    for (const kind of ALERT_RULE_KINDS) {
      for (const prior of priors) {
        const { evaluation } = evaluateRule(
          rule(kind),
          { status: 'unavailable', detail: 'source down' },
          prior,
          NOW,
        );
        expect(evaluation.verdict, `${kind} / prior=${prior?.signature ?? 'none'}`).toBe('cannot-evaluate');
      }
    }
  });

  it('every verdict carries a non-empty reason and only `fired` carries events', () => {
    const priors: (PriorSnapshot | null)[] = [null, CHANGE_PRIOR, REP_PRIOR];
    const readings: SourceReading<RuleFacts>[] = ALERT_RULE_KINDS.map((k) => firingReading(k));
    for (const kind of ALERT_RULE_KINDS) {
      for (const prior of priors) {
        for (const reading of readings) {
          for (const enabled of [true, false]) {
            const { evaluation } = evaluateRule(rule(kind, { enabled }), reading, prior, NOW);
            expect(evaluation.detail.length, `${kind} detail`).toBeGreaterThan(0);
            if (evaluation.verdict !== 'fired') {
              expect(evaluation.events, `${kind} events on ${evaluation.verdict}`).toEqual([]);
            }
          }
        }
      }
    }
  });

  it('cannot-evaluate is counted apart from quiet', () => {
    const counts = summarizeEvaluations([
      { ruleId: 'a', kind: 'whale-move', verdict: 'quiet', events: [], detail: 'x', evaluatedAt: NOW },
      { ruleId: 'b', kind: 'whale-move', verdict: 'cannot-evaluate', events: [], detail: 'y', evaluatedAt: NOW },
      { ruleId: 'c', kind: 'whale-move', verdict: 'off', events: [], detail: 'z', evaluatedAt: NOW },
    ]);
    expect(counts).toEqual({ fired: 0, quiet: 1, cannotEvaluate: 1, off: 1 });
  });
});
