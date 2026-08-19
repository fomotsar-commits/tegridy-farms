// Holding the resume state across a reload.
//
// The record IS the safety property. A zap that stops between stages leaves value in a
// place the user did not ask for, and the only thing that turns that from a loss into an
// inconvenience is a record of which legs landed. So this module is deliberately paranoid
// in one direction and permissive in none:
//
//   - It stores the DESCRIPTOR, not the calldata. A resumed run re-plans from the same
//     inputs and re-quotes; replaying month-old calldata with a lapsed deadline and a
//     lapsed floor is not a resume, it is a different transaction wearing its name.
//   - It records the step ids alongside the statuses, and a load whose ids no longer match
//     the rebuilt plan is REFUSED rather than realigned by position. A plan that gained a
//     leg would otherwise map "confirmed" onto the wrong one.
//   - It reports whether the write succeeded. A browser that cannot store the record is a
//     browser where an interrupted zap is unrecoverable, and the user is entitled to know
//     that before they start rather than after they close the tab.

import { safeGetItem, safeJsonParse, safeSetItem } from '../storage';
import type { ZapDescriptor } from './planner';
import type { ZapRunState, ZapStepState } from './machine';

const VERSION = 1;
/** `tegridy_` prefix so lib/storage's eviction sweeper can reclaim it under quota. */
const KEY_PREFIX = 'tegridy_zap_run_v1';

export interface ZapRunRecord {
  version: number;
  descriptor: ZapDescriptor;
  run: ZapRunState;
}

/** One in-flight zap per account per chain. A second would race the first's balances. */
export function zapRunKey(account: string, chainId: number): string {
  return `${KEY_PREFIX}:${chainId}:${account.toLowerCase()}`;
}

export type ZapSaveResult =
  | { stored: true }
  /** The run continues, but an interrupted run could not be recovered after a reload. */
  | { stored: false; reason: string };

export function saveZapRun(descriptor: ZapDescriptor, run: ZapRunState): ZapSaveResult {
  const record: ZapRunRecord = { version: VERSION, descriptor, run };
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return { stored: false, reason: 'This zap could not be written down, so it will not survive a page reload.' };
  }
  const ok = safeSetItem(zapRunKey(descriptor.account, descriptor.chainId), serialized);
  return ok
    ? { stored: true }
    : {
        stored: false,
        reason:
          'This browser refused to store the zap record (private mode or a full quota). If you reload before it ' +
          'finishes, you will have to check your balances by hand.',
      };
}

export type ZapLoadResult =
  | { kind: 'none' }
  | { kind: 'run'; record: ZapRunRecord }
  /** Something was stored and could not be trusted. Reported, never silently dropped. */
  | { kind: 'unreadable'; reason: string };

export function loadZapRun(account: string, chainId: number): ZapLoadResult {
  const raw = safeGetItem(zapRunKey(account, chainId));
  if (raw === null) return { kind: 'none' };
  const parsed = safeJsonParse<unknown>(raw, null);
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'unreadable', reason: 'A saved zap was found but could not be parsed.' };
  }
  const record = parsed as Partial<ZapRunRecord>;
  if (record.version !== VERSION) {
    return {
      kind: 'unreadable',
      reason: 'A saved zap from an older version of this page was found. It will not be resumed automatically.',
    };
  }
  if (!record.descriptor || !record.run || !Array.isArray(record.run.steps) || record.run.steps.length === 0) {
    return { kind: 'unreadable', reason: 'A saved zap was found but its record is incomplete.' };
  }
  if (record.descriptor.account?.toLowerCase() !== account.toLowerCase() || record.descriptor.chainId !== chainId) {
    return { kind: 'unreadable', reason: 'A saved zap was found for a different account or chain.' };
  }
  return { kind: 'run', record: record as ZapRunRecord };
}

export function clearZapRun(account: string, chainId: number): void {
  try {
    localStorage.removeItem(zapRunKey(account, chainId));
  } catch {
    // A browser that will not delete is not a browser that lost anything; the next save
    // overwrites the key and `loadZapRun`'s shape checks stop a stale record being resumed.
  }
}

/**
 * Line the stored statuses up with a freshly-built plan, or refuse.
 *
 * Positional restoration is the trap: rebuild a plan that gained an approval leg — because
 * an allowance was spent since — and every stored status shifts by one, so "confirmed" now
 * names a leg nobody sent. Matching on the id sequence makes that a refusal instead.
 */
export function restoreRunAgainstPlan(
  record: ZapRunRecord,
  planId: string,
  planStepIds: readonly string[],
): { kind: 'ok'; run: ZapRunState } | { kind: 'mismatch'; reason: string } {
  const storedIds = record.run.steps.map((s: ZapStepState) => s.id);
  if (storedIds.length !== planStepIds.length || storedIds.some((id, i) => id !== planStepIds[i])) {
    return {
      kind: 'mismatch',
      reason:
        'The saved zap no longer matches the steps this page would run, so it will not be resumed. Check your ' +
        'balances: some of its steps may already have gone through.',
    };
  }
  if (record.run.planId !== planId) {
    return {
      kind: 'mismatch',
      reason:
        'The saved zap was composed for a different amount, venue or lock, so it will not be resumed against this ' +
        'one. Check your balances before starting again.',
    };
  }
  return { kind: 'ok', run: record.run };
}
