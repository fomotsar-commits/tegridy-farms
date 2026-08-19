// The zap surface.
//
// What this panel is FOR is the second half of a zap, not the first. Composing five
// transactions into one click is the easy part; the part that decides whether a user trusts
// the venue is what the screen says when the third of them reverts. So the layout gives the
// run state as much room as the input, and every affordance below is gated on a fact:
//
//   · the Zap button needs a plan, and a plan needs a live floor for every swap leg;
//   · the Resume button needs `zapResume` to say `resume` — a run with an unread leg does
//     not get one, at any price;
//   · nothing renders the word "complete" except a run whose every leg settled.
//
// The refusal states are rendered, not hidden. A user who cannot zap because the quote
// source is down is owed the manual steps, and those are the same steps the venue has
// always had — the swap page, the liquidity tab, the farm.

import { useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { CHAIN_ID } from '../../lib/constants';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { zapVenues, type ZapVenueId } from '../../lib/zap/venues';
import { useZapPlan } from '../../hooks/useZapPlan';
import { useZapRun } from '../../hooks/useZapRun';
import { ZapStepList } from './ZapStepList';

const LOCK_CHOICES: { label: string; seconds: bigint }[] = [
  { label: '30 days', seconds: 2_592_000n },
  { label: '90 days', seconds: 7_776_000n },
  { label: '180 days', seconds: 15_552_000n },
  { label: '365 days', seconds: 31_536_000n },
];

const TONE_CLASS: Record<string, string> = {
  neutral: 'border-white/10 bg-white/[0.02] text-white/70',
  progress: 'border-sky-400/30 bg-sky-500/5 text-sky-200',
  warning: 'border-amber-400/40 bg-amber-500/5 text-amber-200',
  danger: 'border-rose-400/40 bg-rose-500/10 text-rose-200',
  success: 'border-emerald-400/30 bg-emerald-500/5 text-emerald-200',
};

export function ZapPanel() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const venues = useMemo(() => zapVenues(), []);
  const firstAvailable = venues.find((v) => v.available);
  const [venueId, setVenueId] = useState<ZapVenueId>(
    firstAvailable && firstAvailable.available ? firstAvailable.venue.id : 'staking-lock',
  );
  const [inputToken, setInputToken] = useState<TokenInfo>(DEFAULT_TOKENS[0]!);
  const [amountText, setAmountText] = useState('');
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [lockSeconds, setLockSeconds] = useState<bigint>(LOCK_CHOICES[1]!.seconds);

  const amountIn = useMemo(() => {
    if (!amountText.trim()) return 0n;
    try {
      return parseUnits(amountText.trim(), inputToken.decimals);
    } catch {
      return 0n;
    }
  }, [amountText, inputToken.decimals]);

  const { result, isQuoting, fee } = useZapPlan({
    venueId,
    inputToken,
    amountIn,
    slippagePct,
    lockDurationSeconds: venueId === 'staking-lock' ? lockSeconds : undefined,
  });
  const plan = result?.ok ? result.plan : null;
  const {
    run,
    readout,
    resume,
    canBatch,
    persistWarning,
    blockedReason,
    orphanedRun,
    isRunning,
    start,
    resumeRun,
    verifyStep,
    markStepOutcome,
    discard,
  } = useZapRun(plan);

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const canStart = !!plan && !isRunning && !wrongChain && isConnected && !run;
  const canResume = !!run && resume?.kind === 'resume' && !isRunning;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5" htmlFor="zap-venue">
            Destination
          </label>
          <select
            id="zap-venue"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white"
            value={venueId}
            onChange={(e) => setVenueId(e.target.value as ZapVenueId)}
          >
            {venues.map((v) =>
              v.available ? (
                <option key={v.venue.id} value={v.venue.id}>
                  {v.venue.label}
                </option>
              ) : (
                <option key={v.id} value={v.id} disabled>
                  {v.label} — unavailable
                </option>
              ),
            )}
          </select>
          {/* An unavailable venue states its own reason. A greyed-out option with no
              explanation is the shape that makes people think the app is broken. */}
          {venues.flatMap((v) =>
            v.available
              ? []
              : [
                  <p key={v.id} className="mt-1 text-[11px] text-amber-200/80">
                    {v.label}: {v.reason}
                  </p>,
                ],
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5" htmlFor="zap-token">
              Pay with
            </label>
            <select
              id="zap-token"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white"
              value={inputToken.address}
              onChange={(e) =>
                setInputToken(DEFAULT_TOKENS.find((t) => t.address === e.target.value) ?? DEFAULT_TOKENS[0]!)
              }
            >
              {DEFAULT_TOKENS.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5" htmlFor="zap-amount">
              Amount
            </label>
            <input
              id="zap-amount"
              inputMode="decimal"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white font-mono"
              placeholder="0.0"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </div>
        </div>

        {venueId === 'staking-lock' ? (
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5" htmlFor="zap-lock">
              Lock for
            </label>
            <select
              id="zap-lock"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white"
              value={lockSeconds.toString()}
              onChange={(e) => setLockSeconds(BigInt(e.target.value))}
            >
              {LOCK_CHOICES.map((c) => (
                <option key={c.label} value={c.seconds.toString()}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5" htmlFor="zap-slippage">
            Slippage per leg
          </label>
          <input
            id="zap-slippage"
            type="number"
            step="0.1"
            min="0.05"
            max="50"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white font-mono"
            value={slippagePct}
            onChange={(e) => setSlippagePct(Number(e.target.value) || 0.5)}
          />
        </div>
      </section>

      {/* ─── What this will do ─────────────────────────────────────────── */}
      {isQuoting ? (
        <p className="text-[12px] text-white/60">Pricing each leg…</p>
      ) : result && !result.ok ? (
        <section className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-4">
          <h3 className="text-[13px] text-amber-200">This zap cannot be composed right now</h3>
          <p className="mt-1 text-[12px] text-amber-100/85">{result.detail}</p>
          <p className="mt-2 text-[12px] text-white/70">
            Nothing is broken on your side — the steps are still available one at a time on the Trade page, the
            Liquidity tab and the Farm page.
          </p>
        </section>
      ) : plan ? (
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-[13px] text-white">
              {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'} into {plan.venue.positionLabel}
            </h3>
            <span className="text-[11px] text-white/50 font-mono">
              {canBatch
                ? `${plan.stageCount} confirmation${plan.stageCount === 1 ? '' : 's'}`
                : `${plan.steps.length} transaction${plan.steps.length === 1 ? '' : 's'}`}
            </span>
          </div>

          <p className="text-[11px] text-white/60">
            {canBatch
              ? 'Your wallet can group each stage into one confirmation. The stages themselves are still separate — a zap is not atomic, and this page never pretends otherwise.'
              : 'Your wallet signs each step on its own. If one stops, the ones after it are not sent and this page keeps the state so you can pick up where it stopped.'}
          </p>

          <dl className="text-[12px] space-y-1">
            <div className="flex justify-between">
              <dt className="text-white/70">Worst case across all legs</dt>
              <dd className="font-mono text-white">{(plan.composedSlippageBps / 100).toFixed(2)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-white/70">{fee.label}</dt>
              <dd className={`font-mono ${fee.unavailable ? 'text-amber-200' : 'text-white'}`}>{fee.value}</dd>
            </div>
          </dl>
          <p className="text-[11px] text-white/55">{fee.note}</p>

          <ul className="space-y-1">
            {plan.notes.map((note) => (
              <li key={note} className="text-[11px] text-white/60">
                • {note}
              </li>
            ))}
          </ul>

          {amountIn > 0n ? (
            <p className="text-[11px] text-white/45 font-mono">
              Input: {formatUnits(amountIn, inputToken.decimals)} {inputToken.symbol}
            </p>
          ) : null}
        </section>
      ) : null}

      {persistWarning ? (
        <p className="rounded-lg border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-100">
          {persistWarning}
        </p>
      ) : null}

      {/* ─── The run ───────────────────────────────────────────────────── */}
      {run && readout && plan ? (
        <section className={`rounded-xl border p-4 space-y-3 ${TONE_CLASS[readout.tone] ?? TONE_CLASS.neutral}`}>
          <div>
            <h3 className="text-[13px] font-medium">{readout.headline}</h3>
            <p className="mt-1 text-[12px] opacity-90">{readout.detail}</p>
            <p className="mt-2 text-[12px]">
              <span className="opacity-70">You are holding: </span>
              <span className="font-medium">{readout.holding}</span>
            </p>
          </div>

          <ZapStepList
            plan={plan.steps}
            steps={run.steps}
            chainId={chainId}
            onVerify={verifyStep}
            onMark={markStepOutcome}
          />

          {resume?.kind === 'blocked' ? (
            <p className="text-[12px]">{resume.reason}</p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {canResume ? (
              <button type="button" className="btn-primary px-4 py-2 text-[13px]" onClick={() => void resumeRun()}>
                Resume from step {(resume as { fromStep: number }).fromStep + 1}
              </button>
            ) : null}
            <button type="button" className="btn-secondary px-4 py-2 text-[13px]" onClick={discard}>
              {readout.isComplete ? 'Clear' : 'Forget this zap'}
            </button>
          </div>
          {!readout.isComplete ? (
            <p className="text-[11px] opacity-70">
              Forgetting only clears this page's record. It does not undo anything already on-chain, and the steps
              that did land stay landed.
            </p>
          ) : null}
        </section>
      ) : null}

      {orphanedRun ? (
        <section className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-4 space-y-2">
          <h3 className="text-[13px] text-amber-200">An unfinished zap is saved for this wallet</h3>
          <p className="text-[12px] text-amber-100/90 font-mono break-words">{orphanedRun.summary}</p>
          <p className="text-[12px] text-white/70">
            It is not shown above because the composer is set to a different zap. Put the amount and destination
            back the way they were to pick it up, or forget it — forgetting clears this page&apos;s record only and
            undoes nothing on-chain.
          </p>
          <button type="button" className="btn-secondary px-4 py-2 text-[12px]" onClick={discard}>
            Forget the saved zap
          </button>
        </section>
      ) : null}

      {blockedReason ? (
        <p className="rounded-lg border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-100">
          {blockedReason}
        </p>
      ) : null}

      {/* ─── The button ────────────────────────────────────────────────── */}
      {!isConnected ? (
        <p className="text-[12px] text-white/60">Connect a wallet to compose a zap.</p>
      ) : wrongChain ? (
        <p className="text-[12px] text-amber-200">Switch to Ethereum mainnet — every contract this zap touches is there.</p>
      ) : (
        <button
          type="button"
          className="btn-primary w-full py-3 text-[14px] disabled:opacity-40"
          disabled={!canStart}
          onClick={() => void start()}
        >
          {isRunning ? 'Zapping…' : run ? 'Zap in progress' : 'Zap'}
        </button>
      )}
      {!address ? null : (
        <p className="text-[11px] text-white/45">
          This zap has no contract of its own. Every step calls a venue contract this app already uses, at an address
          compiled into the page.
        </p>
      )}
    </div>
  );
}
