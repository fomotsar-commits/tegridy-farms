import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LOCAL_CEILING_DETAIL,
  LOCAL_UNWRITABLE_DETAIL,
  MAX_LOCAL_RULES,
  MAX_POOL_SUBJECTS,
  POOL_CEILING_DETAIL,
  RULES_STORAGE_KEY,
  loadLocalRules,
  newLocalRuleId,
  parseRuleStore,
  poolSubjectsOf,
  saveLocalRules,
  type LocalStoreStatus,
} from '../lib/alerts/ruleStore';
import {
  SUBJECT_SHAPE,
  isDuplicateRule,
  validateRuleDraft,
  type AlertRule,
  type RuleDraft,
} from '../lib/alerts/rules';

// Alert-rule CRUD against this browser's own storage.
//
// WHAT THIS HOOK NO LONGER DOES, AND WHY. It used to be a five-state machine over
// a SIWE-authenticated server store: signed-out / loading / ready / not-configured
// / schema-missing / unreachable, with a premium tier deciding the ceiling. Every
// one of those states except the first was unreachable for a visitor — the venue
// has no sign-in control, and the table behind the store is created by a migration
// nobody has applied — so the surface's only reachable state was a disabled form
// under the sentence "connect and sign in", pointing at a control that does not
// exist. The store moved into localStorage and the state machine collapsed with it.
//
// TWO STATES, and the second one is the honest half. `local` means what is on
// screen is what is stored. `local-unwritable` means a write did NOT land — quota,
// private mode, blocked storage — and the rule stays IN THE LIST for the session
// with a warning above it, on an ENABLED form. The alternative, an empty list, is
// the exact lie this file used to tell: "you have no rules" when the truth was
// "nobody could check".
//
// NO NETWORK CALL IS MADE FROM HERE, AT ALL. That is what unpills /alerts, and
// navConfig.test.ts asserts the store's source contains no fetch so the claim
// cannot rot quietly.

export interface UseAlertsState {
  status: LocalStoreStatus;
  rules: AlertRule[];
  /** Null exactly when `status === 'local'`. */
  detail: string | null;
  /** How many rules this browser holds. A quota number, not a tier. */
  limit: number;
  /** How many distinct pools may be watched at once. */
  poolLimit: number;
  /** Last write's rejection message, cleared on the next attempt. */
  writeError: string | null;
  reload: () => void;
  addRule: (draft: RuleDraft) => boolean;
  removeRule: (id: string) => void;
  setRuleEnabled: (id: string, enabled: boolean) => void;
}

export function useAlerts(): UseAlertsState {
  // Read synchronously on first render. There is no request in flight and never
  // will be, so a `loading` state here would be a spinner over a value we already
  // have — and one more state a caller could mistake for "no rules".
  const [rules, setRules] = useState<AlertRule[]>(loadLocalRules);
  const [status, setStatus] = useState<LocalStoreStatus>('local');
  const [writeError, setWriteError] = useState<string | null>(null);

  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const commit = useCallback((next: AlertRule[]) => {
    const persisted = saveLocalRules(next);
    // The rules go into state either way. In memory for the session is a real,
    // usable state — the evaluation loop reads them and the inbox fills — and it
    // is disclosed rather than hidden, which is the difference from failing quietly.
    setRules(next);
    setStatus(persisted ? 'local' : 'local-unwritable');
    return persisted;
  }, []);

  const reload = useCallback(() => {
    setRules(loadLocalRules());
    setStatus('local');
    setWriteError(null);
  }, []);

  // Another tab of this site is the same store. Adopting its blob wholesale is
  // last-writer-wins — the browser's own semantics for localStorage — and is the
  // only rule under which a DELETE propagates. A "merge, existing wins" policy
  // would resurrect a rule the user deleted in the other tab, which is the one
  // outcome a rule store must never produce.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RULES_STORAGE_KEY) return;
      setRules(parseRuleStore(event.newValue));
      // What is on screen is now exactly what is in storage, whatever this tab's
      // own last write did, so the unwritable warning no longer describes it.
      setStatus('local');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const addRule = useCallback(
    (draft: RuleDraft): boolean => {
      setWriteError(null);
      const validation = validateRuleDraft(draft);
      if (!validation.ok) {
        setWriteError(validation.error);
        return false;
      }
      const current = rulesRef.current;
      if (isDuplicateRule(current, validation.rule)) {
        setWriteError('You already have that exact rule.');
        return false;
      }
      if (current.length >= MAX_LOCAL_RULES) {
        setWriteError(LOCAL_CEILING_DETAIL);
        return false;
      }
      // The pool ceiling is about a third party's quota, not about the user: each
      // watched pool costs a keyless GeckoTerminal request per pass, so the bound
      // is on DISTINCT pools rather than on pool rules — three rules on one pool
      // are one request.
      if (SUBJECT_SHAPE[validation.rule.kind] === 'pool') {
        const pools = poolSubjectsOf(current);
        if (!pools.has(validation.rule.subject) && pools.size >= MAX_POOL_SUBJECTS) {
          setWriteError(POOL_CEILING_DETAIL);
          return false;
        }
      }
      commit([
        ...current,
        { ...validation.rule, id: newLocalRuleId(), createdAt: Math.floor(Date.now() / 1000) },
      ]);
      return true;
    },
    [commit],
  );

  const removeRule = useCallback(
    (id: string) => {
      setWriteError(null);
      const next = rulesRef.current.filter((r) => r.id !== id);
      if (next.length !== rulesRef.current.length) commit(next);
    },
    [commit],
  );

  const setRuleEnabled = useCallback(
    (id: string, enabled: boolean) => {
      setWriteError(null);
      commit(rulesRef.current.map((r) => (r.id === id ? { ...r, enabled } : r)));
    },
    [commit],
  );

  return {
    status,
    rules,
    detail: status === 'local' ? null : LOCAL_UNWRITABLE_DETAIL,
    limit: MAX_LOCAL_RULES,
    poolLimit: MAX_POOL_SUBJECTS,
    writeError,
    reload,
    addRule,
    removeRule,
    setRuleEnabled,
  };
}
