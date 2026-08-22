import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readAll, type ReaderDeps } from '../lib/alerts/readers';
import {
  evaluateAll,
  summarizeEvaluations,
  type Evaluation,
  type PriorState,
} from '../lib/alerts/evaluate';
import type { AlertRule } from '../lib/alerts/rules';

// The evaluation loop.
//
// IT ONLY RUNS WHILE THIS TAB IS OPEN. That is not a limitation to be papered
// over — it is the single most important thing a user of this feature has to
// know, because a rule that looks armed and is not is worse than no rule. The
// hook therefore exposes `coverage`, which every consuming surface renders, and
// nothing here ever claims continuous watching.
//
// PRIORS. Change-detection rules compare against the previous reading, kept in
// localStorage per device. A missing prior is NOT "unchanged": evaluate.ts turns
// it into `cannot-evaluate` and records the baseline, so the first pass after
// clearing storage says so rather than reporting calm.

export const PRIORS_STORAGE_KEY = 'tegridy-alert-priors-v1';

/** Default cadence. Long enough not to spend third-party quota, short enough to be useful. */
export const DEFAULT_INTERVAL_MS = 60_000;

/** Stable identity so a parked loop does not hand consumers a new array each render. */
const EMPTY_EVALUATIONS: Evaluation[] = [];

export const COVERAGE_STATEMENT =
  'Rules are evaluated in this browser tab, roughly once a minute, only while this page is open. Nothing evaluates them when it is closed.';

function loadPriors(): PriorState {
  try {
    const raw = localStorage.getItem(PRIORS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PriorState = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.signature !== 'string' || typeof v.label !== 'string') continue;
      out[id] = { signature: v.signature, label: v.label, at: typeof v.at === 'number' ? v.at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

function savePriors(priors: PriorState): void {
  try {
    localStorage.setItem(PRIORS_STORAGE_KEY, JSON.stringify(priors));
  } catch {
    /* quota or private mode — the next pass simply re-baselines and says so */
  }
}

export interface UseAlertsEvaluationOptions {
  /** False parks the loop without reading anything. */
  enabled?: boolean;
  intervalMs?: number;
  /**
   * Extra capabilities for readers that cannot fetch on their own — today, the
   * loan reader, which needs a wallet and an RPC client this loop has no business
   * acquiring. Held in a ref rather than a dependency: a caller rebuilding the
   * object each render must not spend a network pass, and a reader appearing
   * mid-session is a new capability, not a reason to re-read.
   */
  readerDeps?: Omit<ReaderDeps, 'signal'>;
}

export interface UseAlertsEvaluationState {
  evaluations: Evaluation[];
  /** Unix seconds of the last completed pass, or null when none has completed. */
  lastRunAt: number | null;
  running: boolean;
  counts: { fired: number; quiet: number; cannotEvaluate: number; off: number };
  /** The honest scope of this loop. Rendered wherever evaluations are shown. */
  coverage: string;
  runNow: () => void;
}

export function useAlertsEvaluation(
  rules: readonly AlertRule[],
  opts: UseAlertsEvaluationOptions = {},
): UseAlertsEvaluationState {
  const { enabled = true, intervalMs = DEFAULT_INTERVAL_MS, readerDeps } = opts;

  const readerDepsRef = useRef<Omit<ReaderDeps, 'signal'>>(readerDeps ?? {});
  readerDepsRef.current = readerDeps ?? {};

  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);

  // Structural key so a caller rebuilding the array on every render does not
  // re-trigger a network pass — this loop spends third-party quota, so an extra
  // pass per render would be a real cost, not just churn. Ordering is stable
  // (the store sorts). Same pattern as useIndexedQuery's `variablesKey`.
  const rulesKey = JSON.stringify(rules);
  const activeRules = useMemo(() => JSON.parse(rulesKey) as AlertRule[], [rulesKey]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runNow = useCallback(() => setTick((t) => t + 1), []);

  const parked = !enabled || activeRules.length === 0;

  useEffect(() => {
    if (parked) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      setRunning(true);
      try {
        const readings = await readAll(activeRules, {
          ...readerDepsRef.current,
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return;
        const now = Math.floor(Date.now() / 1000);
        const { evaluations: next, nextPriors } = evaluateAll(activeRules, readings, loadPriors(), now);
        savePriors(nextPriors);
        if (!mounted.current) return;
        setEvaluations(next);
        setLastRunAt(now);
      } finally {
        if (mounted.current && !cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [parked, activeRules, tick]);

  useEffect(() => {
    if (parked || intervalMs <= 0) return;
    const id = setInterval(() => {
      // Skip passes while the tab is hidden: they would spend third-party quota
      // for a surface nobody is looking at, and the loop is honest about only
      // covering the time the page is open anyway.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [parked, intervalMs]);

  // Parked means nothing was read, so nothing may be reported. Returning the
  // last pass's evaluations here would show a stale verdict as a current one.
  const visible = parked ? EMPTY_EVALUATIONS : evaluations;

  return {
    evaluations: visible,
    lastRunAt: parked ? null : lastRunAt,
    running,
    counts: summarizeEvaluations(visible),
    coverage: COVERAGE_STATEMENT,
    runNow,
  };
}
