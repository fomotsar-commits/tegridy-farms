// Guard for the rule store hook.
//
// This hook used to be the reason /alerts did nothing: it read a SIWE-gated
// server store, so with no wallet it answered `signed-out` with an empty rule
// list and a sentence pointing at a sign-in control that does not exist in this
// venue. The claims tested here are the ones that replaced it:
//
//   - it makes NO network call, ever (this is what unpills the nav entry)
//   - a fourth rule with no wallet is accepted, and no copy mentions a tier
//   - a write that did not reach storage is reported, and the rule STAYS listed
//   - another tab's delete propagates rather than being resurrected

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAlerts } from './useAlerts';
import {
  LOCAL_UNWRITABLE_DETAIL,
  MAX_LOCAL_RULES,
  MAX_POOL_SUBJECTS,
  RULES_STORAGE_KEY,
  serializeRuleStore,
} from '../lib/alerts/ruleStore';
import type { AlertRule } from '../lib/alerts/rules';

const EVM = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';
const SOLANA_POOL = '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';

/** A distinct EVM address per index, so ceiling tests are not tripped by dedup. */
function subjectN(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

function storedRule(over: Partial<AlertRule> = {}): AlertRule {
  return { id: 'local:seed', kind: 'heat-tier', subject: EVM, threshold: null, enabled: true, createdAt: 1, ...over };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  // Nothing in this hook may reach the network. A call arriving here is the
  // assertion failing, not the stub.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('useAlerts must not make a request');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the store is this browser, and it needs nothing else', () => {
  it('reads existing rules synchronously and never calls fetch', () => {
    localStorage.setItem(RULES_STORAGE_KEY, serializeRuleStore([storedRule()]));
    const { result } = renderHook(() => useAlerts());
    // No loading state: there is no request in flight and never will be, so a
    // spinner here would be a spinner over a value we already have.
    expect(result.current.status).toBe('local');
    expect(result.current.rules).toHaveLength(1);
    expect(result.current.detail).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds a rule with no wallet, persists it, and still calls nothing', () => {
    const { result } = renderHook(() => useAlerts());
    act(() => {
      expect(result.current.addRule({ kind: 'heat-tier', subject: EVM })).toBe(true);
    });
    expect(result.current.rules).toHaveLength(1);
    expect(localStorage.getItem(RULES_STORAGE_KEY)).toContain('heat-tier');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a fourth rule is accepted, and no message mentions an account or a tier', () => {
    // The old ceiling was `ruleLimitFor(false)` = 3, with copy offering
    // PremiumAccess — a paywall over a store that lives in the user's own
    // browser, which no subscription could enlarge.
    const { result } = renderHook(() => useAlerts());
    for (let i = 1; i <= 4; i += 1) {
      act(() => {
        expect(result.current.addRule({ kind: 'heat-tier', subject: subjectN(i) }), `rule ${i}`).toBe(true);
      });
    }
    expect(result.current.rules).toHaveLength(4);
    expect(result.current.writeError).toBeNull();
    expect(result.current.limit).toBe(MAX_LOCAL_RULES);
  });

  it('refuses rule eleven with the browser’s own quota sentence', () => {
    const { result } = renderHook(() => useAlerts());
    for (let i = 1; i <= MAX_LOCAL_RULES; i += 1) {
      act(() => void result.current.addRule({ kind: 'heat-tier', subject: subjectN(i) }));
    }
    act(() => {
      expect(result.current.addRule({ kind: 'heat-tier', subject: subjectN(99) })).toBe(false);
    });
    expect(result.current.writeError).toContain(String(MAX_LOCAL_RULES));
    expect(result.current.writeError).not.toMatch(/account|premium|tier|subscribe/i);
  });

  it('refuses a sixth POOL while allowing more rules on pools it already watches', () => {
    const { result } = renderHook(() => useAlerts());
    for (let i = 1; i <= MAX_POOL_SUBJECTS; i += 1) {
      act(() => {
        expect(
          result.current.addRule({ kind: 'pool-price-above', subject: `base:${subjectN(i)}`, threshold: '10' }),
          `pool ${i}`,
        ).toBe(true);
      });
    }
    // A second rule on a pool already watched costs no extra request, so it is
    // allowed: the bound is on DISTINCT pools, not on pool rules.
    act(() => {
      expect(
        result.current.addRule({ kind: 'pool-price-below', subject: `base:${subjectN(1)}`, threshold: '5' }),
      ).toBe(true);
    });
    act(() => {
      expect(
        result.current.addRule({ kind: 'pool-price-above', subject: `solana:${SOLANA_POOL}`, threshold: '1' }),
      ).toBe(false);
    });
    expect(result.current.writeError).toContain(String(MAX_POOL_SUBJECTS));
  });

  it('refuses a duplicate question', () => {
    const { result } = renderHook(() => useAlerts());
    act(() => void result.current.addRule({ kind: 'heat-tier', subject: EVM }));
    act(() => {
      expect(result.current.addRule({ kind: 'heat-tier', subject: EVM.toUpperCase().replace('0X', '0x') })).toBe(false);
    });
    expect(result.current.writeError).toMatch(/already have that exact rule/i);
  });
});

describe('a write that did not land is disclosed, not hidden', () => {
  it('flips to local-unwritable and KEEPS the rule in the list', () => {
    const { result } = renderHook(() => useAlerts());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    act(() => {
      expect(result.current.addRule({ kind: 'heat-tier', subject: EVM })).toBe(true);
    });
    expect(result.current.status).toBe('local-unwritable');
    expect(result.current.detail).toBe(LOCAL_UNWRITABLE_DETAIL);
    // In memory for the session is a real state — the loop evaluates it and the
    // inbox fills. Dropping the rule would add a silent failure to a disclosed one.
    expect(result.current.rules).toHaveLength(1);
  });

  it('a later successful write clears the warning', () => {
    const { result } = renderHook(() => useAlerts());
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    act(() => void result.current.addRule({ kind: 'heat-tier', subject: EVM }));
    expect(result.current.status).toBe('local-unwritable');
    spy.mockRestore();
    act(() => void result.current.addRule({ kind: 'launch-live', subject: subjectN(7) }));
    expect(result.current.status).toBe('local');
    expect(result.current.detail).toBeNull();
  });
});

describe('two tabs are one store, and a delete propagates', () => {
  function fireStorage(newValue: string | null) {
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: RULES_STORAGE_KEY, newValue }));
    });
  }

  it('adopts another tab’s rule set wholesale', () => {
    const { result } = renderHook(() => useAlerts());
    act(() => void result.current.addRule({ kind: 'heat-tier', subject: EVM }));
    expect(result.current.rules).toHaveLength(1);

    const foreign = [storedRule({ id: 'local:foreign', kind: 'launch-live', subject: otherSubject() })];
    fireStorage(serializeRuleStore(foreign));
    expect(result.current.rules.map((r) => r.id)).toEqual(['local:foreign']);
  });

  it('a rule deleted in the other tab does NOT come back', () => {
    // The critics' "merge, existing wins" alternative would resurrect it, which
    // is the one outcome a rule store must never produce: a watch the user
    // switched off starts firing again.
    localStorage.setItem(RULES_STORAGE_KEY, serializeRuleStore([storedRule(), storedRule({ id: 'local:2' })]));
    const { result } = renderHook(() => useAlerts());
    expect(result.current.rules).toHaveLength(2);

    fireStorage(serializeRuleStore([storedRule()]));
    expect(result.current.rules.map((r) => r.id)).toEqual(['local:seed']);
  });

  it('ignores a storage event for someone else’s key', () => {
    localStorage.setItem(RULES_STORAGE_KEY, serializeRuleStore([storedRule()]));
    const { result } = renderHook(() => useAlerts());
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'tegridy-theme', newValue: 'dark' }));
    });
    expect(result.current.rules).toHaveLength(1);
  });
});

describe('toggling and deleting', () => {
  it('turns a rule off without removing it, and persists that', () => {
    localStorage.setItem(RULES_STORAGE_KEY, serializeRuleStore([storedRule()]));
    const { result } = renderHook(() => useAlerts());
    act(() => result.current.setRuleEnabled('local:seed', false));
    expect(result.current.rules[0]!.enabled).toBe(false);
    expect(localStorage.getItem(RULES_STORAGE_KEY)).toContain('"enabled":false');
  });

  it('removes a rule', () => {
    localStorage.setItem(RULES_STORAGE_KEY, serializeRuleStore([storedRule()]));
    const { result } = renderHook(() => useAlerts());
    act(() => result.current.removeRule('local:seed'));
    expect(result.current.rules).toEqual([]);
  });
});

/** A second distinct EVM subject, kept out of the fixtures above for clarity. */
function otherSubject(): string {
  return '0x1111111111111111111111111111111111111111';
}
