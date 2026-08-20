// Honesty guard for the evaluation loop.
//
// The loop is where "nothing was read" becomes visible or invisible, and there
// are two ways it could go quiet dishonestly:
//
//   PARKED. Disabled, or handed no rules. It has read nothing, so it must report
//     nothing — including `lastRunAt: null`, because a leftover timestamp from an
//     earlier pass would date a verdict that is no longer being produced.
//
//   DARK SOURCES. A rule whose source this deployment cannot read must come back
//     `cannot-evaluate`, so the inbox writes a gap. If it came back `quiet` the
//     surface would look like a watched, calm token.
//
// It also pins the coverage sentence, which is the one thing a user of this
// feature has to read: evaluation happens in this tab only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { COVERAGE_STATEMENT, PRIORS_STORAGE_KEY, useAlertsEvaluation } from './useAlertsEvaluation';
import type { AlertRule } from '../lib/alerts/rules';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'r1',
    kind: 'whale-move',
    subject: SUBJECT,
    threshold: 10_000,
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('a parked loop reports nothing, not calm', () => {
  it('with no rules there are no evaluations and no last pass', () => {
    const { result } = renderHook(() => useAlertsEvaluation([]));
    expect(result.current.evaluations).toEqual([]);
    expect(result.current.lastRunAt).toBeNull();
  });

  it('disabled behaves the same as empty', () => {
    const { result } = renderHook(() => useAlertsEvaluation([rule()], { enabled: false }));
    expect(result.current.evaluations).toEqual([]);
    expect(result.current.lastRunAt).toBeNull();
  });

  it('the counts are all zero rather than reporting a quiet rule', () => {
    const { result } = renderHook(() => useAlertsEvaluation([rule()], { enabled: false }));
    expect(result.current.counts).toEqual({ fired: 0, quiet: 0, cannotEvaluate: 0, off: 0 });
  });
});

describe('a rule whose source is dark surfaces as cannot-evaluate', () => {
  it('an unconfigured indexer produces a gap-shaped verdict, never quiet', async () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const rules = [rule()];
    const { result } = renderHook(() => useAlertsEvaluation(rules, { intervalMs: 0 }));
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    expect(result.current.counts.cannotEvaluate).toBe(1);
    expect(result.current.counts.quiet).toBe(0);
    expect(result.current.evaluations[0]!.detail.length).toBeGreaterThan(20);
  });

  it('a disabled rule is `off`, which is neither a gap nor a negative', async () => {
    vi.stubEnv('VITE_INDEXER_URL', '');
    const rules = [rule({ enabled: false })];
    const { result } = renderHook(() => useAlertsEvaluation(rules, { intervalMs: 0 }));
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    expect(result.current.counts).toMatchObject({ off: 1, quiet: 0, cannotEvaluate: 0 });
  });
});

describe('coverage is stated, not implied', () => {
  it('says evaluation happens in this tab only', () => {
    const { result } = renderHook(() => useAlertsEvaluation([]));
    expect(result.current.coverage).toBe(COVERAGE_STATEMENT);
    expect(COVERAGE_STATEMENT).toMatch(/only while this page is open/i);
    expect(COVERAGE_STATEMENT).toMatch(/Nothing evaluates them when it is closed/i);
  });
});

describe('priors survive a pass, and a corrupt store re-baselines instead of lying', () => {
  it('a garbage priors blob does not become a comparison', async () => {
    localStorage.setItem(PRIORS_STORAGE_KEY, '{{{not json');
    vi.stubEnv('VITE_INDEXER_URL', '');
    const rules = [rule()];
    const { result } = renderHook(() => useAlertsEvaluation(rules, { intervalMs: 0 }));
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    expect(result.current.counts.quiet).toBe(0);
  });

  it('a priors entry missing its signature is discarded rather than half-trusted', async () => {
    localStorage.setItem(PRIORS_STORAGE_KEY, JSON.stringify({ r1: { label: 'Observer' } }));
    vi.stubEnv('VITE_INDEXER_URL', '');
    const rules = [rule()];
    const { result } = renderHook(() => useAlertsEvaluation(rules, { intervalMs: 0 }));
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    // whale-move keeps no prior at all, so the stored junk must simply be gone.
    expect(JSON.parse(localStorage.getItem(PRIORS_STORAGE_KEY) ?? '{}')).toEqual({});
  });
});

describe('injected reader capabilities reach the pass without driving it', () => {
  // The loan reader needs a wallet and an RPC client this loop must not acquire,
  // so it arrives as a capability. Two properties matter: it is actually used
  // (otherwise a deadline rule silently reports "nothing read it" forever), and
  // its identity does not schedule work (otherwise a caller rebuilding the
  // object each render spends a network pass per render).
  const deadlineRule = (): AlertRule => rule({ id: 'loan-1', kind: 'loan-deadline', threshold: 24 });

  it('hands the supplied reader to the rule that needs it', async () => {
    const loanDeadlineReader = vi.fn(async () => ({
      status: 'ok' as const,
      observedAt: 1,
      value: { kind: 'loan-deadline' as const, loans: [] },
    }));
    const { result } = renderHook(() =>
      useAlertsEvaluation([deadlineRule()], { intervalMs: 0, readerDeps: { loanDeadlineReader } }),
    );
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    expect(loanDeadlineReader).toHaveBeenCalled();
    expect(result.current.counts.quiet).toBe(1);
  });

  it('without one, the rule is cannot-evaluate — never quiet', async () => {
    const { result } = renderHook(() => useAlertsEvaluation([deadlineRule()], { intervalMs: 0 }));
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    expect(result.current.counts.cannotEvaluate).toBe(1);
    expect(result.current.counts.quiet).toBe(0);
  });

  it('a new deps object on re-render does not spend another pass', async () => {
    const loanDeadlineReader = vi.fn(async () => ({
      status: 'ok' as const,
      observedAt: 1,
      value: { kind: 'loan-deadline' as const, loans: [] },
    }));
    const rules = [deadlineRule()];
    const { result, rerender } = renderHook(() =>
      // A fresh object literal every render, which is what a naive caller writes.
      useAlertsEvaluation(rules, { intervalMs: 0, readerDeps: { loanDeadlineReader } }),
    );
    await waitFor(() => expect(result.current.lastRunAt).not.toBeNull());
    const passes = loanDeadlineReader.mock.calls.length;
    rerender();
    rerender();
    expect(loanDeadlineReader.mock.calls.length).toBe(passes);
  });
});
