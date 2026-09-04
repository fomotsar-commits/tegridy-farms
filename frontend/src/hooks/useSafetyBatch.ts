import { useCallback, useRef, useState } from 'react';
import { ScanError, scanTokenLive } from '../lib/scanner';
import type { MarketRow } from '../lib/geckoTerminal/pools';
import {
  assessRowSafety,
  componentUnread,
  distributionReadFrom,
  type RowSafety,
} from '../lib/terminal/rowSafety';
import { DEPLOYER_NOT_ON_THIS_CHAIN, NO_CREATOR_LOOKUP_REASON } from './useTerminalSafety';

// OPT-IN, BUDGETED holder read across the top few visible rows.
//
// The page's resting rule is one row on select (useTerminalSafety), because
// three upstreams times fifty rows is a request storm that rate-limits all three
// and then reports the rate limiting as a page full of unknowns — an outage that
// is self-inflicted and looks exactly like the honest state. This is the
// deliberate exception, and it is bounded on three axes at once:
//
//   LIMIT   five rows, never the visible page.
//   SPACING at least 1.5s between reads, sequentially — never in parallel.
//   ABORT   the first `unavailable` or `rate-limited` upstream stops the run and
//           is NAMED, so the reader learns the source refused rather than
//           watching four more rows silently fail.
//
// IT CAN NEVER PRODUCE A PASS, and that is structural rather than a policy this
// hook applies. The deployer component is `componentUnread` on every row here by
// construction — there is no contract-creator lookup on this build, and this
// batch does not ask a visitor to paste one — so `assessRowSafety` can only ever
// return `unscored`, or `scored`+`partial` when the holder read found something.
// `isKnownSafe` requires `coverage === 'complete'`. A test asserts the negative
// directly rather than trusting this paragraph.
//
// IT BYPASSES useTokenScan ON PURPOSE. That hook flattens a `rate-limited`
// ScanError into status `error` (statusForError), which is right for one pasted
// address and wrong here: a batch that cannot tell "this token failed" from "the
// upstream is refusing everything" would keep hammering a source that already
// said no. Reading the ScanError directly is what makes the abort possible.

export const SAFETY_BATCH_LIMIT = 5;
export const SAFETY_BATCH_GAP_MS = 1500;

export interface SafetyBatchProgress {
  done: number;
  total: number;
  /** Names the upstream that refused, or null. Non-null means the run stopped early. */
  stoppedBy: string | null;
}

export interface SafetyBatchState {
  run: (rows: readonly MarketRow[]) => void;
  abort: () => void;
  /** Keyed by `MarketRow.key`. Absent means not read — never "clean". */
  results: Map<string, RowSafety>;
  progress: SafetyBatchProgress;
  running: boolean;
}

export interface UseSafetyBatchOptions {
  limit?: number;
  gapMs?: number;
}

const IDLE: SafetyBatchProgress = { done: 0, total: 0, stoppedBy: null };

/** The token is a token, not a wallet — so there is no Heat reading to request. */
const HEAT_NOT_APPLICABLE =
  'No wallet was supplied, so no Heat reading was requested. Heat measures a wallet’s holding history and is never part of a safety result.';

function deployerReason(network: MarketRow['network']): string {
  return network === 'eth' ? NO_CREATOR_LOOKUP_REASON : DEPLOYER_NOT_ON_THIS_CHAIN[network];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function useSafetyBatch(opts: UseSafetyBatchOptions = {}): SafetyBatchState {
  const limit = opts.limit ?? SAFETY_BATCH_LIMIT;
  const gapMs = opts.gapMs ?? SAFETY_BATCH_GAP_MS;

  const [results, setResults] = useState<Map<string, RowSafety>>(() => new Map());
  const [progress, setProgress] = useState<SafetyBatchProgress>(IDLE);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(
    (rows: readonly MarketRow[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const batch = rows.slice(0, limit);
      setResults(new Map());
      setProgress({ done: 0, total: batch.length, stoppedBy: null });
      setRunning(true);

      void (async () => {
        for (let i = 0; i < batch.length; i += 1) {
          if (controller.signal.aborted) return;

          // Spacing BEFORE each read but the first: the gap is a promise to the
          // upstream, so it has to hold even when a read returns instantly.
          if (i > 0) {
            await sleep(gapMs, controller.signal);
            if (controller.signal.aborted) return;
          }

          const row = batch[i];
          if (!row) continue;

          let safety: RowSafety;
          try {
            const outcome = await scanTokenLive(row.token, {
              signal: controller.signal,
              // Base is 0x-shaped and cannot be auto-detected apart from
              // Ethereum; scanning it under Ethereum's holder source would
              // answer confidently about a different contract.
              chainOverride: row.network === 'base' ? 'base' : undefined,
            });
            safety = assessRowSafety({
              distribution: distributionReadFrom(outcome.analysis),
              deployer: componentUnread(deployerReason(row.network)),
              heat: componentUnread(HEAT_NOT_APPLICABLE),
            });
          } catch (err) {
            if (controller.signal.aborted) return;

            if (err instanceof ScanError && (err.code === 'unavailable' || err.code === 'rate-limited')) {
              // The SOURCE refused, not this token. Continuing would turn one
              // refusal into five and teach the reader that every remaining row
              // is unreadable, which is a claim about the tokens.
              setProgress({
                done: i,
                total: batch.length,
                stoppedBy: `the holder data source (${err.code}): ${err.message}`,
              });
              setRunning(false);
              return;
            }

            safety = assessRowSafety({
              distribution: componentUnread(
                err instanceof Error
                  ? err.message
                  : 'The holder read did not complete. This is a statement about the read, not about the token.',
              ),
              deployer: componentUnread(deployerReason(row.network)),
              heat: componentUnread(HEAT_NOT_APPLICABLE),
            });
          }

          if (controller.signal.aborted) return;
          setResults((prev) => new Map(prev).set(row.key, safety));
          setProgress({ done: i + 1, total: batch.length, stoppedBy: null });
        }
        setRunning(false);
      })();
    },
    [limit, gapMs],
  );

  return { run, abort, results, progress, running };
}
