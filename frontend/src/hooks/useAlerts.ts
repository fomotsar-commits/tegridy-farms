import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  createRule,
  deleteRule,
  listRules,
  toggleRule,
  type DeliveryReport,
  type RuleStoreResult,
  type RuleStoreStatus,
} from '../lib/alerts/rulesClient';
import {
  isDuplicateRule,
  ruleLimitFor,
  validateRuleDraft,
  type AlertRule,
  type RuleDraft,
} from '../lib/alerts/rules';
import { usePremiumAccess } from './usePremiumAccess';

// Alert-rule CRUD, bound to the SIWE session.
//
// The state machine is five-valued for the same reason useIndexedQuery's is: a
// two-state (loading / rules) hook cannot express "the store could not be read",
// and that failure renders as an empty rule list — which tells a user they are
// watching nothing when the truth is that nobody could check. `rules` is empty in
// every non-`ready` state so a caller that ignores `status` shows nothing rather
// than something false.
//
// PREMIUM GATING IS A UI AFFORDANCE, NOT AN ENFORCED LIMIT. The API enforces one
// hard ceiling per wallet (25) because it cannot cheaply read PremiumAccess
// on-chain. The free-tier count below is checked here only, and the surface must
// not claim the database enforces it.

export interface UseAlertsState {
  status: RuleStoreStatus | 'loading';
  rules: AlertRule[];
  /** Null only when `status === 'ready'`. */
  detail: string | null;
  /** What an operator must do, when anything. */
  operatorStep: string | null;
  /** What the SERVER says about delivery. Null when the server never answered. */
  delivery: DeliveryReport | null;
  /** Rules this wallet may hold, from the tier. */
  limit: number;
  hasPremium: boolean;
  /** Last write's rejection message, cleared on the next attempt. */
  writeError: string | null;
  busy: boolean;
  reload: () => void;
  addRule: (draft: RuleDraft) => Promise<boolean>;
  removeRule: (id: string) => Promise<void>;
  setRuleEnabled: (id: string, enabled: boolean) => Promise<void>;
}

function applyResult(
  result: RuleStoreResult,
  set: (s: Partial<UseAlertsState>) => void,
): void {
  set({
    status: result.status,
    rules: result.rules,
    detail: result.detail,
    operatorStep: result.operatorStep,
    delivery: result.delivery,
  });
}

export function useAlerts(): UseAlertsState {
  const { address, isConnected } = useAccount();
  const { hasPremium } = usePremiumAccess();

  const [status, setStatus] = useState<UseAlertsState['status']>('loading');
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [operatorStep, setOperatorStep] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryReport | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = useCallback((s: Partial<UseAlertsState>) => {
    if (!mounted.current) return;
    if (s.status !== undefined) setStatus(s.status);
    if (s.rules !== undefined) setRules(s.rules);
    if (s.detail !== undefined) setDetail(s.detail);
    if (s.operatorStep !== undefined) setOperatorStep(s.operatorStep);
    if (s.delivery !== undefined) setDelivery(s.delivery);
  }, []);

  useEffect(() => {
    // Not connected is not an outage: there is genuinely nothing to read, and
    // saying so plainly is different from failing to read.
    if (!isConnected || !address) {
      set({
        status: 'signed-out',
        rules: [],
        detail: 'Alert rules are stored against your wallet. Connect and sign in to read them.',
        operatorStep: null,
        delivery: null,
      });
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    (async () => {
      const result = await listRules({ signal: controller.signal });
      if (controller.signal.aborted) return;
      applyResult(result, set);
    })();
    return () => controller.abort();
  }, [address, isConnected, reloadKey, set]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const limit = ruleLimitFor(hasPremium === true);

  const addRule = useCallback(
    async (draft: RuleDraft): Promise<boolean> => {
      setWriteError(null);
      const validation = validateRuleDraft(draft);
      if (!validation.ok) {
        setWriteError(validation.error);
        return false;
      }
      if (isDuplicateRule(rules, validation.rule)) {
        setWriteError('You already have that exact rule.');
        return false;
      }
      if (rules.length >= limit) {
        setWriteError(
          hasPremium === true
            ? `You are at the ${limit}-rule ceiling. Delete one to add another.`
            : `Free accounts hold ${limit} rules. Delete one, or subscribe to PremiumAccess for more.`,
        );
        return false;
      }
      setBusy(true);
      try {
        const result = await createRule(validation.rule);
        applyResult(result, set);
        if (result.status !== 'ready') {
          setWriteError(result.detail);
          return false;
        }
        return true;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [rules, limit, hasPremium, set],
  );

  const removeRule = useCallback(
    async (id: string) => {
      setWriteError(null);
      setBusy(true);
      try {
        const result = await deleteRule(id);
        applyResult(result, set);
        if (result.status !== 'ready') setWriteError(result.detail);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [set],
  );

  const setRuleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setWriteError(null);
      setBusy(true);
      try {
        const result = await toggleRule(id, enabled);
        applyResult(result, set);
        if (result.status !== 'ready') setWriteError(result.detail);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [set],
  );

  return {
    status,
    rules: status === 'ready' ? rules : [],
    detail,
    operatorStep,
    delivery,
    limit,
    hasPremium: hasPremium === true,
    writeError,
    busy,
    reload,
    addRule,
    removeRule,
    setRuleEnabled,
  };
}
