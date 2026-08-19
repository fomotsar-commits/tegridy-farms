// The leg-by-leg readout: what was sent, what landed, and what nobody read.
//
// The copy table is exported and tested separately from the DOM, because the property that
// matters is a property of the WORDS. A status vocabulary where `unknown` reads as "failed"
// tells a user their swap did not happen when it may well have, and the component rendering
// it would still pass any test that only checked the element was there.

import type { ZapStepState, ZapStepStatus } from '../../lib/zap/machine';
import type { ZapStepPlan } from '../../lib/zap/planner';
import { getTxUrl } from '../../lib/explorer';

export interface StepStatusCopy {
  label: string;
  /** One line, in the user's terms, about what this status means for their money. */
  meaning: string;
  tone: 'idle' | 'progress' | 'good' | 'warn' | 'bad';
}

/**
 * One entry per status. `confirmed` is the ONLY one whose label may read as done, and
 * `unknown` is deliberately the longest, because it is the one that needs an action.
 */
export const STEP_STATUS_COPY: Record<ZapStepStatus, StepStatusCopy> = {
  pending: { label: 'Not started', meaning: 'Nothing has been sent for this step.', tone: 'idle' },
  signing: { label: 'Waiting on your wallet', meaning: 'The request is with your wallet.', tone: 'progress' },
  submitted: { label: 'Sent', meaning: 'It is on-chain; the receipt has not been read yet.', tone: 'progress' },
  confirmed: { label: 'Confirmed', meaning: 'This step landed on-chain.', tone: 'good' },
  reverted: { label: 'Reverted', meaning: 'The chain rejected it, so it had no effect. Gas was still spent.', tone: 'warn' },
  rejected: { label: 'Not signed', meaning: 'It never reached the chain, so it had no effect.', tone: 'warn' },
  unknown: {
    label: 'Outcome unread',
    meaning: 'This was sent and its result was never read. It may have gone through — check before continuing.',
    tone: 'bad',
  },
  skipped: { label: 'Not needed', meaning: 'Your existing allowance already covered this step.', tone: 'good' },
};

const TONE_CLASS: Record<StepStatusCopy['tone'], string> = {
  idle: 'text-white/45',
  progress: 'text-sky-300',
  good: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-rose-300',
};

export interface ZapStepListProps {
  plan: ZapStepPlan[];
  steps: ZapStepState[];
  chainId: number;
  /** Called for a step whose outcome is unread and which carries a hash to look up. */
  onVerify?: (index: number) => void;
  /** Called when the user reports what they found for an unread step with no hash. */
  onMark?: (index: number, outcome: 'confirmed' | 'reverted') => void;
}

export function ZapStepList({ plan, steps, chainId, onVerify, onMark }: ZapStepListProps) {
  return (
    <ol className="space-y-2">
      {plan.map((step, i) => {
        const state = steps[i];
        const status = state?.status ?? 'pending';
        const copy = STEP_STATUS_COPY[status];
        const isUnknown = status === 'unknown';
        return (
          <li
            key={`${step.id}-${i}`}
            className={`rounded-lg border px-3 py-2 ${isUnknown ? 'border-rose-400/40 bg-rose-500/5' : 'border-white/10 bg-white/[0.02]'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] text-white">
                  <span className="text-white/40 tabular-nums">{i + 1}.</span> {step.label}
                </p>
                <p className="mt-0.5 text-[11px] text-white/60">{copy.meaning}</p>
                {state?.detail && status !== 'skipped' ? (
                  <p className="mt-0.5 text-[11px] text-white/45 break-words">{state.detail}</p>
                ) : null}
              </div>
              <span className={`shrink-0 text-[11px] font-mono ${TONE_CLASS[copy.tone]}`}>{copy.label}</span>
            </div>

            {state?.txHash ? (
              <a
                className="mt-1 inline-block text-[11px] text-sky-300 underline"
                href={getTxUrl(chainId, state.txHash as `0x${string}`)}
                target="_blank"
                rel="noopener noreferrer"
              >
                View transaction
              </a>
            ) : null}

            {isUnknown ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {state?.txHash && onVerify ? (
                  <button type="button" className="btn-secondary px-3 py-1 text-[11px]" onClick={() => onVerify(i)}>
                    Check the chain for this step
                  </button>
                ) : null}
                {!state?.txHash && onMark ? (
                  <>
                    {/* No hash came back, so nothing can be looked up automatically. These
                        record the USER's finding, and the label says whose claim it is. */}
                    <span className="text-[11px] text-white/60">No transaction hash — check your wallet, then tell us:</span>
                    <button type="button" className="btn-secondary px-3 py-1 text-[11px]" onClick={() => onMark(i, 'confirmed')}>
                      It went through
                    </button>
                    <button type="button" className="btn-secondary px-3 py-1 text-[11px]" onClick={() => onMark(i, 'reverted')}>
                      It did not
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
