// Driving a zap, and being honest about where it stopped.
//
// The hook owns three things the pure modules cannot: the wallet, the chain reads that
// bind a measured leg, and the record on disk. Every DECISION it makes is delegated —
// `machine.ts` says what a run means, `calls.ts` says what a leg encodes, `persistence.ts`
// says whether a record may be resumed. What is left here is sequencing and I/O, which is
// deliberate: the interrupted paths are testable in those modules without a wallet, and
// this file is the thin part that needs one mocked.
//
// THREE RULES THIS FILE MUST NOT BREAK.
//   · A leg is never sent while an earlier leg's outcome is unread. `zapResume` is the
//     only source of a starting index, and it refuses in that case. There is no override.
//   · A leg in flight when the page went away comes back as `unknown`, not as `pending`.
//     Restoring it as pending is exactly the bug that double-swaps somebody's money.
//   · A send that errored WITHOUT returning a hash is only recorded as inert when the
//     wallet said the user rejected it. Any other error may still have broadcast, so it
//     becomes `unknown` and waits for somebody to look.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID, TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';
import {
  callsId,
  getWalletCapabilities,
  isAtomicBatchSupported,
  sendCalls,
  type Eip1193Like,
  type WalletCall,
} from '../lib/eip5792';
import { parseCallsStatus } from '../lib/zap/batchStatus';
import { bindZapStep, type ZapBalances } from '../lib/zap/calls';
import {
  applyZapEvent,
  baselineOf,
  initialRunState,
  pendingStepsOfStage,
  zapProgress,
  zapReadout,
  zapResume,
  type ZapEvent,
  type ZapReadout,
  type ZapResume,
  type ZapRunState,
} from '../lib/zap/machine';
import { clearZapRun, loadZapRun, restoreRunAgainstPlan, saveZapRun } from '../lib/zap/persistence';
import type { ZapMeasureKey, ZapPlan, ZapStepPlan } from '../lib/zap/planner';

const CHAIN_HEX = '0x1';
/** How long a batch may stay pending before its legs are recorded as unread. */
const BATCH_POLL_ATTEMPTS = 40;
const BATCH_POLL_INTERVAL_MS = 3000;

const MEASURED_TOKENS: Record<ZapMeasureKey, Address> = {
  towelie: TOWELI_ADDRESS,
  lp: TEGRIDY_LP_ADDRESS,
};

export interface UseZapRun {
  run: ZapRunState | null;
  readout: ZapReadout | null;
  resume: ZapResume | null;
  /** True only when the wallet advertises atomic batching on this chain. */
  canBatch: boolean;
  /** False when the browser refused to store the record — surfaced BEFORE signing. */
  persisted: boolean;
  persistWarning: string | null;
  /** Set when a stage could not be bound, or a stored record could not be trusted. */
  blockedReason: string | null;
  /**
   * An unfinished run this page is NOT showing, because the composer has moved on to a
   * different zap. It keeps the stranded run reachable instead of letting an edit to the
   * amount box bury it.
   */
  orphanedRun: { summary: string; reason: string } | null;
  isRunning: boolean;
  start: () => Promise<void>;
  resumeRun: () => Promise<void>;
  /** Read the chain for an unread leg. The preferred way out of a blocked resume. */
  verifyStep: (index: number) => Promise<void>;
  /**
   * Record what the USER found for an unread leg with no hash to look up. Their assertion,
   * not a read — the surface offering it has to say so.
   */
  markStepOutcome: (index: number, outcome: 'confirmed' | 'reverted') => void;
  /** Forget the record. Undoes nothing on-chain, and the surface says so. */
  discard: () => void;
}

interface PublicClientLike {
  readContract(args: { address: Address; abi: unknown; functionName: string; args?: unknown[] }): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string }>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string } | null>;
}

function isRejection(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return true;
  return typeof e?.message === 'string' && /user rejected|user denied|rejected the request/i.test(e.message);
}

function describeError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.length > 0 ? message : 'The wallet reported no reason.';
}

export function useZapRun(plan: ZapPlan | null): UseZapRun {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID }) as unknown as PublicClientLike | undefined;

  const [run, setRun] = useState<ZapRunState | null>(null);
  const [canBatch, setCanBatch] = useState(false);
  const [persistWarning, setPersistWarning] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [orphanedRun, setOrphanedRun] = useState<UseZapRun['orphanedRun']>(null);
  const [isRunning, setIsRunning] = useState(false);
  const runRef = useRef<ZapRunState | null>(null);

  // Bound to the plan it was created for, not to a ref read at call time. An in-flight
  // stage keeps writing under the descriptor it started with even if a quote refresh
  // rebuilds the plan mid-run, which is what makes the record and the run agree.
  const commit = useCallback(
    (next: ZapRunState) => {
      runRef.current = next;
      setRun(next);
      if (!plan) return;
      const saved = saveZapRun(plan.descriptor, next);
      setPersistWarning(saved.stored ? null : saved.reason);
    },
    [plan],
  );

  const emit = useCallback(
    (event: ZapEvent) => {
      const current = runRef.current;
      if (!current) return;
      const next = applyZapEvent(current, event);
      if (next !== current) commit(next);
    },
    [commit],
  );

  // ─── Restore ──────────────────────────────────────────────────────────────
  // Keyed on the plan ID rather than the plan object: `useZapPlan` rebuilds the plan on
  // every quote refresh, and re-running this on identity would wipe a live run.
  const planKey = plan?.id ?? null;
  useEffect(() => {
    if (!planKey || !plan || !address || chainId !== CHAIN_ID) {
      runRef.current = null;
      setRun(null);
      return;
    }
    const loaded = loadZapRun(address, chainId);
    if (loaded.kind !== 'run') {
      runRef.current = null;
      setRun(null);
      setOrphanedRun(null);
      setBlockedReason(loaded.kind === 'unreadable' ? loaded.reason : null);
      return;
    }
    const restored = restoreRunAgainstPlan(
      loaded.record,
      plan.id,
      plan.steps.map((s) => s.id),
    );
    if (restored.kind !== 'ok') {
      runRef.current = null;
      setRun(null);
      setBlockedReason(restored.reason);
      // An unfinished record the composer has moved past is not junk — it is somebody's
      // half-placed money. Kept, named, and rescued by restoring the inputs it was made
      // for. `start()` refuses to overwrite it.
      const stored = loaded.record;
      setOrphanedRun(
        zapProgress(stored.run).kind === 'complete'
          ? null
          : {
              summary: `${stored.descriptor.amountIn} base units of ${stored.descriptor.inputSymbol} into the ${stored.descriptor.venueId} venue`,
              reason: restored.reason,
            },
      );
      return;
    }
    setOrphanedRun(null);
    // A leg recorded as in-flight was in flight when this page went away. It is NOT
    // pending — it was sent, and whether it landed is exactly what nobody read.
    const stale = restored.run.steps
      .map((s, i) => (s.status === 'signing' || s.status === 'submitted' ? i : -1))
      .filter((i) => i !== -1);
    const recovered =
      stale.length === 0
        ? restored.run
        : applyZapEvent(restored.run, {
            type: 'lost',
            steps: stale,
            detail: 'This page went away while the step was in flight, so its outcome was never read.',
            at: Date.now(),
          });
    runRef.current = recovered;
    setRun(recovered);
    setBlockedReason(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, address, chainId]);

  // ─── Wallet capability ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!address || !connector || chainId !== CHAIN_ID) {
      setCanBatch(false);
      return;
    }
    (async () => {
      try {
        const provider = (await connector.getProvider()) as Eip1193Like;
        const caps = await getWalletCapabilities(provider, address);
        if (!cancelled) setCanBatch(isAtomicBatchSupported(caps, CHAIN_HEX));
      } catch {
        // No `wallet_getCapabilities` is the common case, not an edge case. Sequential.
        if (!cancelled) setCanBatch(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, connector, chainId]);

  // ─── Chain reads ──────────────────────────────────────────────────────────

  const readMeasured = useCallback(
    async (account: Address): Promise<Partial<Record<ZapMeasureKey, bigint>>> => {
      if (!publicClient) return {};
      const out: Partial<Record<ZapMeasureKey, bigint>> = {};
      for (const key of Object.keys(MEASURED_TOKENS) as ZapMeasureKey[]) {
        try {
          const value = await publicClient.readContract({
            address: MEASURED_TOKENS[key],
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [account],
          });
          if (typeof value === 'bigint') out[key] = value;
        } catch {
          // Left ABSENT, never defaulted to 0n: an absent balance blocks the leg that
          // needs it, while a zero reads as "the previous leg produced nothing".
        }
      }
      return out;
    },
    [publicClient],
  );

  const readAllowances = useCallback(
    async (account: Address, steps: ZapStepPlan[]): Promise<Record<string, bigint>> => {
      const out: Record<string, bigint> = {};
      if (!publicClient) return out;
      for (const step of steps) {
        if (step.kind !== 'approve' || !step.token || !step.spender) continue;
        try {
          const value = await publicClient.readContract({
            address: step.token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [account, step.spender],
          });
          if (typeof value === 'bigint') out[`${step.token.toLowerCase()}:${step.spender.toLowerCase()}`] = value;
        } catch {
          // Absent means unknown, and `bindZapStep` never treats unknown as sufficient.
        }
      }
      return out;
    },
    [publicClient],
  );

  // ─── Sending ──────────────────────────────────────────────────────────────

  const sendAsBatch = useCallback(
    async (provider: Eip1193Like, account: Address, bound: { index: number; call: WalletCall }[]): Promise<boolean> => {
      const indexes = bound.map((b) => b.index);
      emit({ type: 'signing', steps: indexes, at: Date.now() });
      let batchId: string;
      try {
        const result = await sendCalls(provider, {
          from: account,
          chainId: CHAIN_HEX,
          calls: bound.map((b) => b.call),
        });
        batchId = callsId(result);
      } catch (error) {
        if (isRejection(error)) {
          emit({ type: 'rejected', steps: indexes, detail: describeError(error), at: Date.now() });
        } else {
          emit({ type: 'lost', steps: indexes, detail: describeError(error), at: Date.now() });
        }
        return false;
      }
      emit({ type: 'submitted', steps: indexes, batchId, at: Date.now() });

      for (let attempt = 0; attempt < BATCH_POLL_ATTEMPTS; attempt++) {
        let raw: unknown;
        try {
          raw = await provider.request({ method: 'wallet_getCallsStatus', params: [batchId] });
        } catch (error) {
          emit({ type: 'lost', steps: indexes, detail: describeError(error), at: Date.now() });
          return false;
        }
        const parsed = parseCallsStatus(raw, bound.length);
        if (parsed.kind === 'pending') {
          await new Promise((r) => setTimeout(r, BATCH_POLL_INTERVAL_MS));
          continue;
        }
        if (parsed.kind === 'failed') {
          emit({ type: 'rejected', steps: indexes, detail: parsed.detail, at: Date.now() });
          return false;
        }
        if (parsed.kind === 'unreadable') {
          emit({ type: 'lost', steps: indexes, detail: parsed.detail, at: Date.now() });
          return false;
        }
        // Per-call outcomes: a batch sent without `atomicRequired` may land in part, so
        // each leg is recorded from its own receipt rather than from the batch's verdict.
        let allConfirmed = true;
        parsed.calls.forEach((outcome, i) => {
          const index = bound[i]!.index;
          if (outcome.status === 'confirmed') {
            emit({ type: 'confirmed', steps: [index], txHash: outcome.txHash, at: Date.now() });
          } else {
            allConfirmed = false;
            emit({
              type: 'reverted',
              steps: [index],
              txHash: outcome.txHash,
              detail: 'This call reverted inside the batch.',
              at: Date.now(),
            });
          }
        });
        return allConfirmed;
      }
      emit({
        type: 'lost',
        steps: indexes,
        detail: 'The wallet never reported the batch as settled, so its calls may or may not have executed.',
        at: Date.now(),
      });
      return false;
    },
    [emit],
  );

  const sendSequentially = useCallback(
    async (provider: Eip1193Like, account: Address, bound: { index: number; call: WalletCall }[]): Promise<boolean> => {
      for (const { index, call } of bound) {
        emit({ type: 'signing', steps: [index], at: Date.now() });
        let hash: `0x${string}`;
        try {
          const result = await provider.request({
            method: 'eth_sendTransaction',
            params: [{ from: account, to: call.to, data: call.data, value: call.value }],
          });
          hash = String(result) as `0x${string}`;
        } catch (error) {
          // A wallet that says the user rejected is the ONLY error here that proves
          // nothing was broadcast. Anything else — a dropped socket mid-send, a wallet
          // that threw after relaying — leaves an open question, so it stays open.
          if (isRejection(error)) {
            emit({ type: 'rejected', steps: [index], detail: describeError(error), at: Date.now() });
          } else {
            emit({
              type: 'lost',
              steps: [index],
              detail: `${describeError(error)} No transaction hash came back, so this step cannot be looked up automatically — check your wallet's activity.`,
              at: Date.now(),
            });
          }
          return false;
        }
        emit({ type: 'submitted', steps: [index], txHash: hash, at: Date.now() });

        if (!publicClient) {
          emit({
            type: 'lost',
            steps: [index],
            detail: 'No chain connection was available to read this receipt.',
            at: Date.now(),
          });
          return false;
        }
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === 'success') {
            emit({ type: 'confirmed', steps: [index], txHash: hash, at: Date.now() });
          } else {
            emit({
              type: 'reverted',
              steps: [index],
              txHash: hash,
              detail: 'The transaction reverted on-chain.',
              at: Date.now(),
            });
            return false;
          }
        } catch (error) {
          // The hash is out there and the receipt did not arrive. This is the case the
          // whole `unknown` status exists for — never recorded as a failure.
          emit({ type: 'lost', steps: [index], detail: describeError(error), at: Date.now() });
          return false;
        }
      }
      return true;
    },
    [emit, publicClient],
  );

  /** Run one stage. Returns false when the caller must stop. */
  const executeStage = useCallback(
    async (thePlan: ZapPlan, account: Address, provider: Eip1193Like, stage: number): Promise<boolean> => {
      const state = runRef.current;
      if (!state) return false;
      const indexes = pendingStepsOfStage(state, thePlan, stage);
      if (indexes.length === 0) return true;

      const stepsOfStage = indexes.map((i) => thePlan.steps[i]!);
      const balances: ZapBalances = {
        baseline: { towelie: baselineOf(state, 'towelie'), lp: baselineOf(state, 'lp') },
        current: await readMeasured(account),
        allowances: await readAllowances(account, stepsOfStage),
      };

      const nowSeconds = Math.floor(Date.now() / 1000);
      const bound: { index: number; call: WalletCall }[] = [];
      for (const index of indexes) {
        const result = bindZapStep(thePlan.steps[index]!, account, balances, nowSeconds);
        if (result.kind === 'blocked') {
          // Nothing is sent and no step changes status: the run stays exactly where it
          // was, and the reason is what the surface shows instead of a spinner.
          setBlockedReason(result.reason);
          return false;
        }
        if (result.kind === 'skip') {
          emit({ type: 'skipped', steps: [index], detail: result.reason, at: Date.now() });
          continue;
        }
        bound.push({ index, call: result.call });
      }
      if (bound.length === 0) return true;
      setBlockedReason(null);

      return canBatch && bound.length > 1
        ? sendAsBatch(provider, account, bound)
        : sendSequentially(provider, account, bound);
    },
    [canBatch, emit, readAllowances, readMeasured, sendAsBatch, sendSequentially],
  );

  const drive = useCallback(
    async (thePlan: ZapPlan, account: Address, fromStage: number) => {
      if (!connector) return;
      const provider = (await connector.getProvider()) as Eip1193Like;
      setIsRunning(true);
      try {
        for (let stage = fromStage; stage < thePlan.stageCount; stage++) {
          const ok = await executeStage(thePlan, account, provider, stage);
          if (!ok) return;
        }
      } finally {
        setIsRunning(false);
      }
    },
    [connector, executeStage],
  );

  const start = useCallback(async () => {
    if (!plan || !address || chainId !== CHAIN_ID) return;
    // One record per account per chain. Starting a different zap over an unfinished one
    // would overwrite the only evidence of where the first stopped — so it refuses, and
    // says which two ways out there are.
    const existing = loadZapRun(address, chainId);
    if (
      existing.kind === 'run' &&
      existing.record.run.planId !== plan.id &&
      zapProgress(existing.record.run).kind !== 'complete'
    ) {
      setBlockedReason(
        'There is already an unfinished zap saved for this wallet, and starting a new one would overwrite the ' +
          'record of where it stopped. Restore the amount and destination it was composed for to resume it, or ' +
          'forget it first.',
      );
      return;
    }
    setBlockedReason(null);
    const baselineBalances = await readMeasured(address);
    // A baseline that could not be read is recorded as 0n. The measured leg that needs it
    // then blocks on its own missing read rather than depositing against a made-up start.
    commit(
      initialRunState(
        plan,
        { towelie: baselineBalances.towelie ?? 0n, lp: baselineBalances.lp ?? 0n },
        Date.now(),
      ),
    );
    await drive(plan, address, 0);
  }, [plan, address, chainId, readMeasured, commit, drive]);

  const resumeRun = useCallback(async () => {
    const state = runRef.current;
    if (!plan || !address || !state || chainId !== CHAIN_ID) return;
    const decision = zapResume(state);
    // THE single gate. A blocked resume is never overridden from here, and there is no
    // force path: the only ways past it are `verifyStep` and `markStepOutcome`.
    if (decision.kind !== 'resume') return;
    setBlockedReason(null);
    await drive(plan, address, plan.steps[decision.fromStep]!.stage);
  }, [plan, address, chainId, drive]);

  const verifyStep = useCallback(
    async (index: number) => {
      const state = runRef.current;
      if (!state || !publicClient) return;
      const step = state.steps[index];
      if (!step?.txHash) return;
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: step.txHash as `0x${string}` });
        if (!receipt) return;
        emit({
          type: 'observed',
          step: index,
          outcome: receipt.status === 'success' ? 'confirmed' : 'reverted',
          txHash: step.txHash,
          at: Date.now(),
        });
      } catch {
        // Still unread. The leg stays `unknown` and the resume stays blocked, which is
        // the correct outcome of a failed lookup — not a licence to assume anything.
      }
    },
    [emit, publicClient],
  );

  const markStepOutcome = useCallback(
    (index: number, outcome: 'confirmed' | 'reverted') => {
      emit({ type: 'observed', step: index, outcome, at: Date.now() });
    },
    [emit],
  );

  const discard = useCallback(() => {
    if (address) clearZapRun(address, chainId);
    runRef.current = null;
    setRun(null);
    setBlockedReason(null);
    setOrphanedRun(null);
  }, [address, chainId]);

  const readout = useMemo(() => (run && plan ? zapReadout(run, plan) : null), [run, plan]);
  const resume = useMemo(() => (run ? zapResume(run) : null), [run]);

  return {
    run,
    readout,
    resume,
    canBatch,
    persisted: persistWarning === null,
    persistWarning,
    blockedReason,
    orphanedRun,
    isRunning,
    start,
    resumeRun,
    verifyStep,
    markStepOutcome,
    discard,
  };
}
