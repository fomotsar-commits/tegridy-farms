// Guard for the rule vocabulary.
//
// A rule that was coerced into a different rule than the one the user typed fires
// on the wrong thing and is discovered by the alert it does not send, so
// validation here rejects rather than repairs. The other half of the file pins
// the vocabulary itself: every kind must declare what it means and what its
// subject is, because a builder that offers an unexplained kind is selling a
// promise nobody wrote down.

import { describe, it, expect } from 'vitest';
import {
  ALERT_RULE_KINDS,
  FREE_RULE_LIMIT,
  PREMIUM_RULE_LIMIT,
  RULE_KIND_LABELS,
  RULE_KIND_MEANING,
  SUBJECT_LABEL,
  THRESHOLD_LABEL,
  describeRule,
  isChangeDetectionKind,
  isDuplicateRule,
  ruleKey,
  ruleLimitFor,
  usesThreshold,
  validateRuleDraft,
  type AlertRule,
} from './rules';

const SUBJECT = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';

describe('the vocabulary is fully described', () => {
  it('every kind has a label, a meaning and a subject label', () => {
    for (const kind of ALERT_RULE_KINDS) {
      expect(RULE_KIND_LABELS[kind], kind).toBeTruthy();
      expect(RULE_KIND_MEANING[kind]?.length, kind).toBeGreaterThan(40);
      expect(SUBJECT_LABEL[kind], kind).toBeTruthy();
    }
  });

  it('no kind promises prediction — the meanings speak about what was read', () => {
    for (const kind of ALERT_RULE_KINDS) {
      expect(RULE_KIND_MEANING[kind], kind).not.toMatch(/predict|forecast|about to|likely to/i);
    }
  });

  it('exactly the two measured kinds take a threshold', () => {
    expect(ALERT_RULE_KINDS.filter(usesThreshold)).toEqual(['whale-move', 'loan-deadline']);
  });

  it('a threshold kind names its unit, and a non-threshold kind names none', () => {
    // The two thresholds are not the same quantity — dollars and hours — and a
    // form that labels both "USD threshold" creates a rule that fires at the
    // wrong time or never.
    for (const kind of ALERT_RULE_KINDS) {
      if (usesThreshold(kind)) {
        expect(THRESHOLD_LABEL[kind], kind).toBeTruthy();
      } else {
        expect(THRESHOLD_LABEL[kind], kind).toBeNull();
      }
    }
    expect(THRESHOLD_LABEL['whale-move']).toMatch(/USD/i);
    expect(THRESHOLD_LABEL['loan-deadline']).toMatch(/hours/i);
  });

  it('the change-detection kinds are exactly the two that compare readings', () => {
    expect(ALERT_RULE_KINDS.filter(isChangeDetectionKind)).toEqual(['deployer-reputation', 'heat-tier']);
  });
});

describe('validation rejects rather than repairs', () => {
  it('accepts a well-formed draft and lower-cases the subject', () => {
    const result = validateRuleDraft({ kind: 'heat-tier', subject: SUBJECT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.subject).toBe(SUBJECT.toLowerCase());
      expect(result.rule.threshold).toBeNull();
      expect(result.rule.enabled).toBe(true);
    }
  });

  it('refuses a malformed address and names the field', () => {
    const result = validateRuleDraft({ kind: 'whale-move', subject: '0x123', threshold: '1000' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(SUBJECT_LABEL['whale-move']);
  });

  it('refuses an unknown kind', () => {
    // @ts-expect-error — deliberately outside the union: the runtime guard exists
    // because a rule kind can arrive from a stored row or a hand-made request.
    expect(validateRuleDraft({ kind: 'price-prediction', subject: SUBJECT }).ok).toBe(false);
  });

  it('refuses a whale rule with no threshold, and with a nonsense one', () => {
    for (const threshold of [undefined, null, '', '0', '-5', 'abc', Number.NaN, Infinity]) {
      const result = validateRuleDraft({ kind: 'whale-move', subject: SUBJECT, threshold });
      expect(result.ok, String(threshold)).toBe(false);
    }
  });

  it('a threshold on a kind that ignores it is dropped, not silently applied', () => {
    const result = validateRuleDraft({ kind: 'heat-tier', subject: SUBJECT, threshold: '9999' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.threshold).toBeNull();
  });
});

describe('duplicates', () => {
  const existing: AlertRule[] = [
    { id: 'a', kind: 'whale-move', subject: SUBJECT.toLowerCase() as `0x${string}`, threshold: 1000, enabled: true, createdAt: 0 },
  ];

  it('same question is a duplicate regardless of address casing', () => {
    expect(
      isDuplicateRule(existing, {
        kind: 'whale-move',
        subject: SUBJECT as `0x${string}`,
        threshold: 1000,
        enabled: true,
      }),
    ).toBe(true);
  });

  it('a different threshold is a different question', () => {
    expect(
      isDuplicateRule(existing, {
        kind: 'whale-move',
        subject: SUBJECT.toLowerCase() as `0x${string}`,
        threshold: 2000,
        enabled: true,
      }),
    ).toBe(false);
  });

  it('the key ignores threshold for kinds that do not use it', () => {
    expect(ruleKey('heat-tier', SUBJECT, 5)).toBe(ruleKey('heat-tier', SUBJECT.toLowerCase(), null));
  });
});

describe('tier limits are counts, not feature gates', () => {
  it('free is lower than premium and both are positive', () => {
    expect(FREE_RULE_LIMIT).toBeGreaterThan(0);
    expect(PREMIUM_RULE_LIMIT).toBeGreaterThan(FREE_RULE_LIMIT);
    expect(ruleLimitFor(false)).toBe(FREE_RULE_LIMIT);
    expect(ruleLimitFor(true)).toBe(PREMIUM_RULE_LIMIT);
  });

  it('every kind is available at the free tier — only the count is bounded', () => {
    for (const kind of ALERT_RULE_KINDS) {
      const result = validateRuleDraft({ kind, subject: SUBJECT, threshold: usesThreshold(kind) ? '1000' : null });
      expect(result.ok, kind).toBe(true);
    }
  });
});

describe('descriptions', () => {
  it('a whale rule states its threshold', () => {
    const rule: AlertRule = {
      id: 'a',
      kind: 'whale-move',
      subject: SUBJECT.toLowerCase() as `0x${string}`,
      threshold: 12_500,
      enabled: true,
      createdAt: 0,
    };
    expect(describeRule(rule)).toContain('12,500');
  });
});
