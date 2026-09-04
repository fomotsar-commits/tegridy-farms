import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useWriteContract } from 'wagmi';
import { ERC20_ABI } from '../../lib/contracts';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { safeGetItem, safeSetItem } from '../../lib/storage';
import { formatScaled } from '../../lib/tax/csv';
import {
  allowanceForPeriods,
  pullTrustNotice,
  pushLapseNotice,
  renewalNotice,
  type ChargeInitiator,
  type Subscription,
} from '../../lib/commerce/subscription';
import { useCheckoutSubscription } from '../../hooks/useCheckoutSubscription';

// Recurring billing as it actually exists on this venue.
//
// ─── NO CONTRACT, AND NO KEEPER ─────────────────────────────────────────────
//
// There is no subscription contract here and none is planned, so the pull shape
// is a plain ERC-20 allowance granted to the MERCHANT'S OWN ADDRESS. That adds
// nothing to the attack surface and it buys nothing either: no schedule is
// enforced on chain, and the panel says that at the point of granting rather
// than in a footnote. There is likewise no keeper, so neither shape renews on
// its own and both say so.
//
// ─── THE TERMS ARE THE PAYER'S RECORD, NOT AN ENFORCEMENT ───────────────────
//
// Amount, period and the count of periods paid live in this browser's local
// storage, because nothing on chain records them. The panel labels them as a
// record. The two figures that ARE facts — the standing allowance and the
// balance — are read from chain by useCheckoutSubscription and are the only
// things any verdict rests on.
//
// The consequence a payer has to see: clearing site data loses the record, not
// the allowance. Revoking is what cancels.

const STORAGE_KEY = 'tegridy_subscription_draft_v1';

/**
 * PERF-10 (2026-09-03): the draft used to be JSON-serialised and written to
 * localStorage on EVERY change. Two of its fields are free-text inputs, so
 * typing a 42-character merchant address cost 42 serialisations and 42
 * synchronous, main-thread storage writes — on /checkout, while the payer is
 * mid-keystroke. The draft is a convenience record, not a receipt; it does not
 * need to be durable between two keystrokes.
 *
 * Short enough that a reader who types and immediately closes the tab is
 * covered by the unmount flush below rather than by luck.
 */
const PERSIST_DEBOUNCE_MS = 250;

interface Draft {
  merchant: string;
  tokenAddress: string;
  amountWhole: string;
  periodDays: number;
  periodsAgreed: number;
  periodsCharged: number;
  initiator: ChargeInitiator;
  startedAt: number;
}

function loadDraft(): Draft | null {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.merchant !== 'string' || typeof d.tokenAddress !== 'string') return null;
    return {
      merchant: d.merchant,
      tokenAddress: d.tokenAddress,
      amountWhole: typeof d.amountWhole === 'string' ? d.amountWhole : '',
      periodDays: typeof d.periodDays === 'number' ? d.periodDays : 30,
      periodsAgreed: typeof d.periodsAgreed === 'number' ? d.periodsAgreed : 12,
      periodsCharged: typeof d.periodsCharged === 'number' ? d.periodsCharged : 0,
      initiator: d.initiator === 'payer-push' ? 'payer-push' : 'merchant-pull',
      startedAt: typeof d.startedAt === 'number' ? d.startedAt : Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

/** Whole-token string → smallest units, exactly. Null on anything lossy. */
function toSmallestUnits(whole: string, decimals: number): bigint | null {
  const s = whole.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, '0'));
}

export function SubscriptionPanel() {
  const { address } = useAccount();
  const chainId = useChainId();
  const now = Math.floor(Date.now() / 1000);

  const [draft, setDraft] = useState<Draft>(
    () =>
      loadDraft() ?? {
        merchant: '',
        tokenAddress: DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')?.address ?? '',
        amountWhole: '10',
        periodDays: 30,
        periodsAgreed: 12,
        periodsCharged: 0,
        initiator: 'merchant-pull',
        startedAt: Math.floor(Date.now() / 1000),
      },
  );

  // Holds the newest draft that has NOT reached storage yet. A debounce that
  // eats the last edit is worse than no debounce, so unmount flushes it.
  const unpersistedRef = useRef<Draft | null>(null);

  useEffect(() => {
    unpersistedRef.current = draft;
    const timer = setTimeout(() => {
      unpersistedRef.current = null;
      safeSetItem(STORAGE_KEY, JSON.stringify(draft));
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(
    () => () => {
      const pending = unpersistedRef.current;
      if (pending !== null) safeSetItem(STORAGE_KEY, JSON.stringify(pending));
    },
    [],
  );

  const token = useMemo(
    () => DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === draft.tokenAddress.toLowerCase()) ?? null,
    [draft.tokenAddress],
  );

  const subscription: Subscription | null = useMemo(() => {
    if (!address || !token) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(draft.merchant)) return null;
    const amount = toSmallestUnits(draft.amountWhole, token.decimals);
    if (amount === null || amount <= 0n) return null;
    return {
      id: 'local-draft',
      payer: address,
      merchant: draft.merchant as `0x${string}`,
      chainId: chainId ?? 1,
      token: token.address as `0x${string}`,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amountPerPeriod: amount,
      periodSeconds: Math.max(1, draft.periodDays) * 86_400,
      startedAt: draft.startedAt,
      periodsCharged: draft.periodsCharged,
      periodsAgreed: draft.periodsAgreed > 0 ? draft.periodsAgreed : null,
      initiator: draft.initiator,
      cancelledAt: null,
    };
  }, [address, token, draft, chainId]);

  const read = useCheckoutSubscription({ subscription, now });
  const { writeContract, isPending } = useWriteContract();

  const grantAmount =
    subscription && subscription.initiator === 'merchant-pull'
      ? allowanceForPeriods(subscription, draft.periodsAgreed > 0 ? draft.periodsAgreed : 1)
      : null;

  function grant(amount: bigint) {
    if (!subscription) return;
    writeContract({
      address: subscription.token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [subscription.merchant, amount],
      chainId: subscription.chainId,
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Terms</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-white/60">
          These terms are YOUR record, kept in this browser. Nothing on chain stores them and nothing on chain
          enforces them — the only on-chain facts are the allowance and your balance, read below.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label htmlFor="sub-merchant" className="text-[11px] uppercase tracking-wide text-white/55">
            Merchant address
            <input
              id="sub-merchant"
              value={draft.merchant}
              onChange={(e) => setDraft({ ...draft, merchant: e.target.value.trim() })}
              placeholder="0x…"
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 font-mono text-xs text-white"
            />
          </label>

          <label htmlFor="sub-token" className="text-[11px] uppercase tracking-wide text-white/55">
            Token
            <select
              id="sub-token"
              value={draft.tokenAddress}
              onChange={(e) => setDraft({ ...draft, tokenAddress: e.target.value })}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            >
              {DEFAULT_TOKENS.filter((t) => !t.isNative).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="sub-amount" className="text-[11px] uppercase tracking-wide text-white/55">
            Amount per period
            <input
              id="sub-amount"
              value={draft.amountWhole}
              onChange={(e) => setDraft({ ...draft, amountWhole: e.target.value })}
              inputMode="decimal"
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="sub-period" className="text-[11px] uppercase tracking-wide text-white/55">
            Period (days)
            <input
              id="sub-period"
              type="number"
              min={1}
              value={draft.periodDays}
              onChange={(e) => setDraft({ ...draft, periodDays: Number(e.target.value) })}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="sub-periods" className="text-[11px] uppercase tracking-wide text-white/55">
            Periods agreed
            <input
              id="sub-periods"
              type="number"
              min={1}
              max={120}
              value={draft.periodsAgreed}
              onChange={(e) => setDraft({ ...draft, periodsAgreed: Number(e.target.value) })}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="sub-charged" className="text-[11px] uppercase tracking-wide text-white/55">
            Periods already paid (your record)
            <input
              id="sub-charged"
              type="number"
              min={0}
              value={draft.periodsCharged}
              onChange={(e) => setDraft({ ...draft, periodsCharged: Number(e.target.value) })}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="text-[11px] uppercase tracking-wide text-white/55">Who initiates each charge</legend>
          <div className="mt-2 space-y-2">
            {(
              [
                ['merchant-pull', 'The merchant pulls it (allowance + transferFrom)'],
                ['payer-push', 'I pay each period myself'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-start gap-2 text-[12px] text-white/80">
                <input
                  type="radio"
                  name="sub-initiator"
                  value={value}
                  checked={draft.initiator === value}
                  onChange={() => setDraft({ ...draft, initiator: value })}
                  className="mt-0.5"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      {subscription ? (
        <>
          <section className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
            <h2 className="text-sm font-semibold text-white">What this actually authorises</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-white/85">
              {subscription.initiator === 'merchant-pull'
                ? pullTrustNotice(subscription, draft.periodsAgreed > 0 ? draft.periodsAgreed : 1)
                : pushLapseNotice(subscription)}
            </p>
            <p className="mt-2 text-[13px] font-medium text-white">{renewalNotice(subscription)}</p>
          </section>

          <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
            <h2 className="text-sm font-semibold text-white">On-chain standing</h2>
            {read.charge === null ? (
              <p className="mt-2 text-[13px] leading-relaxed text-white/70">{read.detail}</p>
            ) : (
              <>
                <p className="mt-2 text-[13px] leading-relaxed text-white/85">{read.charge.detail}</p>
                <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-2">
                  <div>
                    <dt className="text-white/50">Verdict</dt>
                    <dd className="text-white/90">{read.charge.verdict}</dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Periods behind</dt>
                    <dd className="text-white/90">{read.charge.missedPeriods}</dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Next period opens</dt>
                    <dd className="text-white/90">
                      {read.charge.nextChargeAt === null
                        ? '—'
                        : new Date(read.charge.nextChargeAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Allowance covers</dt>
                    <dd className="text-white/90">
                      {read.charge.periodsCoveredByAllowance === null
                        ? 'no allowance is involved in this shape'
                        : `${read.charge.periodsCoveredByAllowance} period(s)`}
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </section>

          {subscription.initiator === 'merchant-pull' && grantAmount !== null ? (
            <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
              <h2 className="text-sm font-semibold text-white">Allowance</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-white/75">
                Granting sets the allowance to exactly{' '}
                {formatScaled(grantAmount, subscription.tokenDecimals)} {subscription.tokenSymbol} — {draft.periodsAgreed}{' '}
                charge(s), and no more. There is no unlimited option here.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => grant(grantAmount)}
                  disabled={isPending}
                  className="btn-primary px-5 py-2 text-[13px]"
                >
                  Grant {draft.periodsAgreed} charge(s)
                </button>
                <button
                  type="button"
                  onClick={() => grant(0n)}
                  disabled={isPending}
                  className="btn-secondary px-5 py-2 text-[13px]"
                >
                  Revoke — the only cancellation that binds
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          <p className="text-[13px] leading-relaxed text-white/70">
            {address
              ? 'Fill in a merchant address and a positive amount to see what a subscription on these terms would authorise. Nothing is evaluated against a wallet until then.'
              : 'Connect a wallet to read the allowance and balance this would depend on. Nothing below is a statement about any wallet until then.'}
          </p>
        </section>
      )}
    </div>
  );
}

export default SubscriptionPanel;
