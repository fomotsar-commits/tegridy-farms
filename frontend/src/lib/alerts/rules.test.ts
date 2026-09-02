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
  RULE_KIND_LABELS,
  RULE_KIND_MEANING,
  SUBJECT_LABEL,
  SUBJECT_SHAPE,
  THRESHOLD_LABEL,
  canonicalSubject,
  describeRule,
  formatThreshold,
  isChangeDetectionKind,
  isDuplicateRule,
  parsePoolSubject,
  ruleKey,
  usesThreshold,
  validateRuleDraft,
  type AlertRule,
  type AlertRuleKind,
} from './rules';

/** BAYLA's PumpSwap pool, byte-for-byte as bungalows.ts records it. */
const SOLANA_POOL = '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';
const BASE_POOL = '0xF02C421E15ABDF2008BB6577336B0F3D7AEC98F0';

/** A subject of the shape each kind actually wants. */
function subjectFor(kind: AlertRuleKind): string {
  return SUBJECT_SHAPE[kind] === 'pool' ? `solana:${SOLANA_POOL}` : SUBJECT;
}

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

  it('exactly the measured kinds take a threshold', () => {
    expect(ALERT_RULE_KINDS.filter(usesThreshold)).toEqual([
      'whale-move',
      'loan-deadline',
      'pool-price-above',
      'pool-price-below',
      'pool-large-trade',
    ]);
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
    // The three pool kinds share a form field and do NOT share a quantity: two
    // are a price per token, one is the size of a single swap. A label that said
    // only "USD" on all three would make a $50 price rule and a $50 swap rule
    // look like the same question.
    expect(THRESHOLD_LABEL['pool-price-above']).toMatch(/price/i);
    expect(THRESHOLD_LABEL['pool-price-below']).toMatch(/price/i);
    expect(THRESHOLD_LABEL['pool-large-trade']).toMatch(/swap size/i);
  });

  it('the swap kind is never described as a transfer or a whale', () => {
    // It reads a DEX's trade feed. Calling a swap a transfer would promise the
    // token-movement coverage the indexer would give and this does not have —
    // and 'whale-move' is a real, separate kind that stays dark.
    const meaning = RULE_KIND_MEANING['pool-large-trade'];
    expect(meaning).not.toMatch(/transfer/i);
    expect(meaning).not.toMatch(/whale/i);
    expect(meaning).toMatch(/swap/i);
  });

  it('the price kinds admit the quote is a quote, with no as-of time', () => {
    for (const kind of ['pool-price-above', 'pool-price-below'] as const) {
      expect(RULE_KIND_MEANING[kind], kind).toMatch(/quote/i);
      expect(RULE_KIND_MEANING[kind], kind).toMatch(/as-of/i);
    }
  });

  it('the change-detection kinds are exactly the two that compare readings', () => {
    expect(ALERT_RULE_KINDS.filter(isChangeDetectionKind)).toEqual(['deployer-reputation', 'heat-tier']);
  });
});

describe('pool subjects are parsed, and their case is respected', () => {
  it('preserves a Solana pool id byte-for-byte, and lower-cases an EVM one', () => {
    // Base58 has no case-folding: '8z52…' and '8Z52…' are different values, and
    // only one of them is a pool. The lower-casing that is correct for a hex EVM
    // address is data corruption here.
    expect(canonicalSubject('pool-price-above', `solana:${SOLANA_POOL}`)).toBe(`solana:${SOLANA_POOL}`);
    expect(canonicalSubject('pool-price-above', `base:${BASE_POOL}`)).toBe(`base:${BASE_POOL.toLowerCase()}`);
  });

  it('refuses a bare address, an unknown network, and a mis-cased Solana id', () => {
    expect(canonicalSubject('pool-price-above', SOLANA_POOL)).toBeNull();
    expect(canonicalSubject('pool-price-above', `polygon:${SUBJECT}`)).toBeNull();
    // 'l' is not in the base58 alphabet — it is excluded precisely because it is
    // indistinguishable from '1' in most fonts.
    expect(parsePoolSubject('solana:llllllllllllllllllllllllllllllll')).toBeNull();
  });

  it('an EVM-subject kind refuses a network-prefixed subject', () => {
    expect(canonicalSubject('heat-tier', `eth:${SUBJECT}`)).toBeNull();
  });

  it('two Solana pools differing only by case are two different rules', () => {
    const existing: AlertRule[] = [
      { id: 'a', kind: 'pool-price-above', subject: `solana:${SOLANA_POOL}`, threshold: 1, enabled: true, createdAt: 0 },
    ];
    const swapped = SOLANA_POOL.replace('phbct', 'PHBCT');
    expect(swapped).not.toBe(SOLANA_POOL);
    expect(
      isDuplicateRule(existing, {
        kind: 'pool-price-above',
        subject: `solana:${swapped}`,
        threshold: 1,
        enabled: true,
      }),
      'lower-casing inside ruleKey would merge two different pools into one rule',
    ).toBe(false);
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

describe('no kind is gated behind anything', () => {
  it('every kind validates, given a subject of its own shape', () => {
    for (const kind of ALERT_RULE_KINDS) {
      const result = validateRuleDraft({
        kind,
        subject: subjectFor(kind),
        threshold: usesThreshold(kind) ? '1000' : null,
      });
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

describe('formatThreshold — a rule must not describe itself as a different rule', () => {
  // The bug this pins was found in the running app: a pool-price rule saved with a
  // threshold of 0.000025 rendered as "above $0" in both the rule list and the inbox,
  // because toLocaleString() with no options caps at three fraction digits. On a venue
  // whose pools trade in millionths of a dollar that is nearly every price rule.
  it('keeps a sub-cent pool price legible instead of rounding it to zero', () => {
    expect(formatThreshold(0.000025)).toBe('0.000025');
    expect(formatThreshold(0.0000001234)).toContain('0.000000123');
    // The whole point: it must not read as the number zero, which is a different rule.
    expect(formatThreshold(0.000025)).not.toBe('0');
  });

  it('reads a saved sub-cent rule back in its own words', () => {
    const rule = {
      kind: 'pool-price-above',
      subject: 'solana:31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
      threshold: 0.000025,
      enabled: true,
      id: 'local:test',
      createdAt: 1788365712,
    } as AlertRule;
    expect(describeRule(rule)).toContain('0.000025');
    expect(describeRule(rule)).not.toContain('above $0 ');
  });

  it('still groups a size at or above one, and never invents precision', () => {
    expect(formatThreshold(50000)).toBe((50000).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    expect(formatThreshold(24)).toBe('24');
    expect(formatThreshold(0)).toBe('0');
  });

  it('renders an absent or unusable threshold as an em dash, never as a number', () => {
    expect(formatThreshold(null)).toBe('—');
    expect(formatThreshold(undefined)).toBe('—');
    expect(formatThreshold(Number.NaN)).toBe('—');
    expect(formatThreshold(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
