// Guard for the browser rule store.
//
// This store is the whole reason /alerts works for a visitor at all, so the
// failures worth testing are the ones that would leave somebody believing they
// are watching something they are not:
//
//   - a blob that will not parse must produce NO rules, not half-trusted ones
//   - one bad row must not disarm its siblings
//   - a write that did not land must be reported as not landed
//   - a Solana pool id must come back byte-for-byte, because case IS the value

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LOCAL_CEILING_DETAIL,
  MAX_LOCAL_RULES,
  MAX_POOL_SUBJECTS,
  POOL_CEILING_DETAIL,
  RULES_STORAGE_KEY,
  coerceLocalRule,
  loadLocalRules,
  newLocalRuleId,
  parseRuleStore,
  poolSubjectsOf,
  saveLocalRules,
  serializeRuleStore,
} from './ruleStore';
import { validateRuleDraft, type AlertRule } from './rules';

/** BAYLA's PumpSwap pool, byte-for-byte as bungalows.ts records it. */
const SOLANA_POOL = '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';
const EVM = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return { id: 'local:1', kind: 'heat-tier', subject: EVM, threshold: null, enabled: true, createdAt: 100, ...over };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a rule survives the round trip, or is dropped — never half-trusted', () => {
  it('round-trips a rule set unchanged', () => {
    const rules = [rule(), rule({ id: 'local:2', kind: 'launch-live' })];
    expect(parseRuleStore(serializeRuleStore(rules))).toEqual(rules);
  });

  it('garbage, an empty blob and a non-array all produce no rules', () => {
    for (const blob of [null, '', 'not json', '{}', '[', JSON.stringify({ rules: 'nope' })]) {
      expect(parseRuleStore(blob), String(blob)).toEqual([]);
    }
  });

  it('one bad row is dropped without taking its siblings', () => {
    // The alternative — refusing the whole blob because one row drifted —
    // silently disarms every other rule the user set.
    const blob = JSON.stringify({
      rules: [
        rule(),
        { id: 'local:bad', kind: 'not-a-kind', subject: EVM },
        { id: 'local:bad2', kind: 'heat-tier', subject: 'nonsense' },
        rule({ id: 'local:3', kind: 'launch-live' }),
      ],
    });
    expect(parseRuleStore(blob).map((r) => r.id)).toEqual(['local:1', 'local:3']);
  });

  it('a threshold kind with no usable threshold is dropped, not defaulted', () => {
    // There is no number we could invent that would make this rule fire at the
    // moment the user meant, so a rule that looks armed is worse than none.
    for (const threshold of [undefined, null, 0, -5, 'abc']) {
      const raw = { id: 'x', kind: 'whale-move', subject: EVM, threshold, enabled: true, createdAt: 1 };
      expect(coerceLocalRule(raw), String(threshold)).toBeNull();
    }
  });

  it('a row with no `enabled` flag reads as ON', () => {
    // A rule that went quiet because a flag was lost would produce silence the
    // inbox reports as `off` — a verdict the user never chose.
    expect(coerceLocalRule({ id: 'x', kind: 'heat-tier', subject: EVM, createdAt: 1 })?.enabled).toBe(true);
  });
});

describe('subject case is preserved where case is meaning', () => {
  it('a Solana pool id survives validate → serialize → parse byte-for-byte', () => {
    const validation = validateRuleDraft({ kind: 'pool-price-above', subject: `solana:${SOLANA_POOL}`, threshold: '1' });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const stored = parseRuleStore(serializeRuleStore([{ ...validation.rule, id: 'local:1', createdAt: 1 }]));
    // Lower-casing anywhere on this path points the rule at a pool that does not
    // exist, and the rule then reports calm forever.
    expect(stored[0]!.subject).toBe(`solana:${SOLANA_POOL}`);
  });

  it('an EVM pool id is lower-cased, because there case is only checksum', () => {
    const upper = '0xF02C421E15ABDF2008BB6577336B0F3D7AEC98F0';
    const coerced = coerceLocalRule({
      id: 'x',
      kind: 'pool-price-below',
      subject: `base:${upper}`,
      threshold: 5,
      createdAt: 1,
    });
    expect(coerced?.subject).toBe(`base:${upper.toLowerCase()}`);
  });
});

describe('ids can never be mistaken for server rows', () => {
  it('is prefixed local: and never matches the server’s bare-UUID pattern', () => {
    // api/_lib/alerts.js validates ids against this exact pattern. The prefix
    // means a synced local row is REJECTED rather than colliding with a row the
    // server minted.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (let i = 0; i < 5; i += 1) {
      const id = newLocalRuleId();
      expect(id.startsWith('local:')).toBe(true);
      expect(UUID_RE.test(id)).toBe(false);
    }
  });

  it('is unique across calls', () => {
    expect(new Set([newLocalRuleId(), newLocalRuleId(), newLocalRuleId()]).size).toBe(3);
  });
});

describe('a write that did not land says so', () => {
  it('returns false when storage refuses, and true when it accepts', () => {
    expect(saveLocalRules([rule()])).toBe(true);
    expect(loadLocalRules()).toEqual([rule()]);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // The caller turns this false into a visible warning. Returning true here
    // would produce a rule list that silently evaporates on reload.
    expect(saveLocalRules([rule(), rule({ id: 'local:2' })])).toBe(false);
  });

  it('a read from blocked storage is an empty list, not a throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadLocalRules()).toEqual([]);
  });

  it('writes under the namespaced key the quota sweeper knows about', () => {
    saveLocalRules([rule()]);
    expect(localStorage.getItem(RULES_STORAGE_KEY)).toBeTruthy();
  });
});

describe('the ceilings are quota arithmetic, and say a number', () => {
  it('holds ten rules over five pools', () => {
    expect(MAX_LOCAL_RULES).toBe(10);
    expect(MAX_POOL_SUBJECTS).toBe(5);
    // The copy carries the actual number, so it cannot drift from the constant.
    expect(LOCAL_CEILING_DETAIL).toContain('10');
    expect(POOL_CEILING_DETAIL).toContain('5');
  });

  it('neither ceiling sentence mentions an account or a tier', () => {
    // There is no account behind a browser store, so a tier word here would be
    // selling an upgrade that would not change anything.
    for (const copy of [LOCAL_CEILING_DETAIL, POOL_CEILING_DETAIL]) {
      expect(copy).not.toMatch(/account|premium|tier|free|subscribe|upgrade/i);
    }
  });

  it('counts DISTINCT pools, not pool rules', () => {
    // Three rules on one pool cost one GeckoTerminal request, so bounding rules
    // rather than pools would refuse work that costs nothing.
    const pools = poolSubjectsOf([
      rule({ id: 'a', kind: 'pool-price-above', subject: `solana:${SOLANA_POOL}`, threshold: 1 }),
      rule({ id: 'b', kind: 'pool-price-below', subject: `solana:${SOLANA_POOL}`, threshold: 2 }),
      rule({ id: 'c', kind: 'pool-large-trade', subject: 'base:0xf02c421e15abdf2008bb6577336b0f3d7aec98f0', threshold: 3 }),
      rule({ id: 'd', kind: 'heat-tier' }),
    ]);
    expect(pools.size).toBe(2);
  });

  it('never parses back more rules than the ceiling allows', () => {
    const many = Array.from({ length: MAX_LOCAL_RULES + 5 }, (_, i) => rule({ id: `local:${i}` }));
    expect(parseRuleStore(JSON.stringify({ rules: many }))).toHaveLength(MAX_LOCAL_RULES);
  });
});
