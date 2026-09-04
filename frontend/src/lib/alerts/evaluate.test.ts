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
import { ALERT_RULE_KINDS, SUBJECT_SHAPE, type AlertRule, type AlertRuleKind } from './rules';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;
const OTHER = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as const;
const NOW = 1_760_000_000;

/** A Base pool, in the canonical `network:pool` subject form. */
const POOL_ID = '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0';
const POOL = `base:${POOL_ID}`;

function thresholdFor(kind: AlertRuleKind): number | null {
  if (kind === 'whale-move') return 10_000;
  if (kind === 'loan-deadline') return 24;
  if (kind === 'pool-price-above' || kind === 'pool-price-below') return 100;
  if (kind === 'pool-large-trade') return 5_000;
  return null;
}

function rule(kind: AlertRuleKind, over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: `rule-${kind}`,
    kind,
    subject: SUBJECT_SHAPE[kind] === 'pool' ? POOL : SUBJECT,
    threshold: thresholdFor(kind),
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
    case 'loan-deadline':
      return {
        status: 'ok',
        observedAt: NOW,
        value: {
          kind,
          loans: [
            {
              loanId: 4,
              contract: SUBJECT,
              deadlineAt: NOW + 3600,
              graceEndsAt: NOW + 7200,
              band: 'urgent',
              consequence: 'Repay within 1h or the lender can claim the collateral NFT and keep it.',
            },
          ],
        },
      };
    // Above the $100 threshold, so with a `below` prior it is a crossing UP —
    // which is what an above-rule fires on. The below-rule's own fixture is in
    // its suite, since one reading cannot be a crossing in both directions.
    case 'pool-price-above':
    case 'pool-price-below':
      return { status: 'ok', observedAt: NOW, value: { kind, priceUsd: 150, poolName: 'QR / WETH' } };
    case 'pool-large-trade':
      return {
        status: 'ok',
        observedAt: NOW,
        value: {
          kind,
          trades: [{ txHash: '0xswap', at: NOW - 20, usd: 9_000, kind: 'buy', wallet: OTHER }],
        },
      };
  }
  void prior;
  throw new Error(`unhandled kind ${kind}`);
}

const CHANGE_PRIOR: PriorSnapshot = { signature: 'Observer', label: 'Observer (40.00°)', at: NOW - 86_400 };
const REP_PRIOR: PriorSnapshot = { signature: 'c1/a0/t0/n1/u0@low', label: '1 created', at: NOW - 86_400 };

/** The previous reading was BELOW the threshold, so the fixture above is a crossing up. */
const PRICE_PRIOR: PriorSnapshot = { signature: 'below', label: '$50.00', at: NOW - 120 };
/** A watermark older than the fixture's swap, so the swap is new. */
const TRADE_PRIOR: PriorSnapshot = { signature: '0xold', label: '', at: NOW - 600 };

function priorFor(kind: AlertRuleKind): PriorSnapshot | null {
  if (kind === 'heat-tier') return CHANGE_PRIOR;
  if (kind === 'deployer-reputation') return REP_PRIOR;
  if (kind === 'pool-price-above') return PRICE_PRIOR;
  if (kind === 'pool-price-below') return { signature: 'above', label: '$500.00', at: NOW - 120 };
  if (kind === 'pool-large-trade') return TRADE_PRIOR;
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


describe('a pool price rule fires on a CROSSING, not on a level', () => {
  const priceReading = (priceUsd: number): SourceReading<RuleFacts> => ({
    status: 'ok',
    observedAt: NOW,
    value: { kind: 'pool-price-above', priceUsd, poolName: 'QR / WETH' },
  });

  it('the first reading records a baseline and reports it cannot evaluate', () => {
    const { evaluation, nextPrior } = evaluateRule(rule('pool-price-above'), priceReading(150), null, NOW);
    // There is no second reading, AND no way to know whether a crossing happened
    // before we looked. That is not calm.
    expect(evaluation.verdict).toBe('cannot-evaluate');
    // The SIDE is what gets compared next pass; the label is only ever shown.
    expect(nextPrior?.signature).toBe('above');
    expect(nextPrior?.at).toBe(NOW);
    expect(nextPrior?.label).toContain('150');
  });

  it('below → above fires exactly once, keyed to the pair of readings', () => {
    const prior: PriorSnapshot = { signature: 'below', label: '$50.00', at: NOW - 60 };
    const { evaluation } = evaluateRule(rule('pool-price-above'), priceReading(150), prior, NOW);
    expect(evaluation.verdict).toBe('fired');
    expect(evaluation.events[0]!.idempotencyKey).toBe(`pool-price-above:rule-pool-price-above:${NOW - 60}->${NOW}`);
  });

  it('above → above is quiet — a level is not an event', () => {
    // Firing here would notify once a minute for as long as the price sat still.
    const prior: PriorSnapshot = { signature: 'above', label: '$140.00', at: NOW - 60 };
    expect(evaluateRule(rule('pool-price-above'), priceReading(150), prior, NOW).evaluation.verdict).toBe('quiet');
  });

  it('above → below is quiet for an ABOVE rule', () => {
    // The mutation this catches: dropping the `side === wanted` half of the test
    // and firing on any change of side, which makes every rule bidirectional.
    const prior: PriorSnapshot = { signature: 'above', label: '$140.00', at: NOW - 60 };
    expect(evaluateRule(rule('pool-price-above'), priceReading(50), prior, NOW).evaluation.verdict).toBe('quiet');
  });

  it('a below rule fires on the opposite crossing', () => {
    const reading: SourceReading<RuleFacts> = {
      status: 'ok',
      observedAt: NOW,
      value: { kind: 'pool-price-below', priceUsd: 50, poolName: null },
    };
    const prior: PriorSnapshot = { signature: 'above', label: '$150.00', at: NOW - 60 };
    expect(evaluateRule(rule('pool-price-below'), reading, prior, NOW).evaluation.verdict).toBe('fired');
  });

  it('the event says the time is OURS and the price is a quote', () => {
    const prior: PriorSnapshot = { signature: 'below', label: '$50.00', at: NOW - 60 };
    const event = evaluateRule(rule('pool-price-above'), priceReading(150), prior, NOW).evaluation.events[0]!;
    // GeckoTerminal publishes no as-of time for a quote, so the row must not say
    // "as of" — that would attribute our fetch clock to them.
    expect(event.observedAtKind).toBe('read');
    expect(event.body).toMatch(/read at/);
    expect(event.body).toMatch(/no as-of time/i);
    expect(event.body).toMatch(/quote/i);
  });
});

describe('a large-swap rule fires on swaps past its watermark, and only once each', () => {
  const swap = (txHash: string, at: number, usd: number | null) => ({
    txHash,
    at,
    usd,
    kind: 'buy' as const,
    wallet: OTHER,
  });
  const tradesReading = (trades: ReturnType<typeof swap>[]): SourceReading<RuleFacts> => ({
    status: 'ok',
    observedAt: NOW,
    value: { kind: 'pool-large-trade', trades },
  });

  it('the first pass records the watermark and fires on nothing', () => {
    // The feed's whole page is history. Counting it on the first pass would fire
    // a burst of alerts for trades that happened before the rule existed.
    const { evaluation, nextPrior } = evaluateRule(
      rule('pool-large-trade'),
      tradesReading([swap('0xa', NOW - 100, 9_000), swap('0xb', NOW - 50, 20_000)]),
      null,
      NOW,
    );
    expect(evaluation.verdict).toBe('cannot-evaluate');
    expect(evaluation.events).toEqual([]);
    expect(nextPrior).toEqual({ signature: '0xb', label: '', at: NOW - 50 });
  });

  it('a swap past the watermark fires, and the same swap never fires twice', () => {
    const prior: PriorSnapshot = { signature: '0xold', label: '', at: NOW - 600 };
    const trades = [swap('0xnew', NOW - 60, 9_000)];
    const first = evaluateRule(rule('pool-large-trade'), tradesReading(trades), prior, NOW);
    expect(first.evaluation.verdict).toBe('fired');
    expect(first.evaluation.events[0]!.idempotencyKey).toBe('pool-large-trade:rule-pool-large-trade:0xnew');

    const second = evaluateRule(rule('pool-large-trade'), tradesReading(trades), first.nextPrior, NOW);
    expect(second.evaluation.verdict).toBe('quiet');
  });

  it('a swap older than the watermark never fires', () => {
    const prior: PriorSnapshot = { signature: '0xw', label: '', at: NOW - 60 };
    const result = evaluateRule(rule('pool-large-trade'), tradesReading([swap('0xold', NOW - 600, 50_000)]), prior, NOW);
    expect(result.evaluation.verdict).toBe('quiet');
  });

  it('two swaps in the same second: the remembered one is silent, the new one fires', () => {
    // Time alone cannot separate swaps that share a block, so the watermark
    // carries the hashes at its own second. Without them, a second swap in a
    // marked block would either be lost or re-fire the first.
    const at = NOW - 60;
    const prior: PriorSnapshot = { signature: '0xseen', label: '', at };
    const result = evaluateRule(
      rule('pool-large-trade'),
      tradesReading([swap('0xseen', at, 9_000), swap('0xfresh', at, 9_000)]),
      prior,
      NOW,
    );
    expect(result.evaluation.events.map((e) => e.idempotencyKey)).toEqual([
      'pool-large-trade:rule-pool-large-trade:0xfresh',
    ]);
    expect(result.nextPrior!.signature.split(',').sort()).toEqual(['0xfresh', '0xseen']);
  });

  it('a swap with no USD size is excluded and SAID to be excluded', () => {
    const prior: PriorSnapshot = { signature: '', label: '', at: NOW - 600 };
    const { evaluation } = evaluateRule(
      rule('pool-large-trade'),
      tradesReading([swap('0xunsized', NOW - 60, null)]),
      prior,
      NOW,
    );
    expect(evaluation.verdict).toBe('quiet');
    // Silently dropping it would make an unmeasurable swap indistinguishable
    // from a small one.
    expect(evaluation.detail).toMatch(/carried no USD size/i);
  });

  it('an empty feed never advances an existing watermark', () => {
    const prior: PriorSnapshot = { signature: '0xw', label: '', at: NOW - 60 };
    const { nextPrior } = evaluateRule(rule('pool-large-trade'), tradesReading([]), prior, NOW);
    // Advancing to the read clock would step silently over any trade the feed
    // had not published yet.
    expect(nextPrior).toEqual(prior);
  });

  it('the event anchors to the rule’s OWN chain, not to ethereum', () => {
    const prior: PriorSnapshot = { signature: '', label: '', at: NOW - 600 };
    const { evaluation } = evaluateRule(
      rule('pool-large-trade'),
      tradesReading([swap('0xbase', NOW - 60, 9_000)]),
      prior,
      NOW,
    );
    // The old `chainForKind` answered 'ethereum' for everything that was not
    // Heat, which sends a reader to an explorer where the tx does not exist.
    expect(evaluation.events[0]!.anchor).toEqual({ chain: 'base', ref: '0xbase' });
  });

  it('never calls a swap a transfer, and never calls it a whale', () => {
    const prior: PriorSnapshot = { signature: '', label: '', at: NOW - 600 };
    const { evaluation } = evaluateRule(
      rule('pool-large-trade'),
      tradesReading([swap('0xswap', NOW - 60, 9_000)]),
      prior,
      NOW,
    );
    const text = `${evaluation.events[0]!.title} ${evaluation.events[0]!.body}`;
    expect(text).not.toMatch(/transfer/i);
    expect(text).not.toMatch(/whale/i);
  });
});

describe('the exhaustive sweep', () => {
  it('no kind can reach `quiet` from an unavailable reading, in any prior state', () => {
    const priors: (PriorSnapshot | null)[] = [null, CHANGE_PRIOR, REP_PRIOR, PRICE_PRIOR, TRADE_PRIOR];
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
    const priors: (PriorSnapshot | null)[] = [null, CHANGE_PRIOR, REP_PRIOR, PRICE_PRIOR, TRADE_PRIOR];
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
