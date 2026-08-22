import { formatScaled } from '../../lib/tax/csv';
import { canSign, type SettlementPlan } from '../../lib/commerce/settlement';

// The card a buyer reads BEFORE any signature is offered.
//
// It renders ONLY what `plan.disclosure` decided. Nothing here re-derives a
// figure from a quote or an invoice: a component that computes its own number
// can show one the plan did not refuse on, and "the screen said 100 and the
// wallet moved 140" is the entire failure mode a checkout has.
//
// The two-column shape is deliberate and is the honest asymmetry of the whole
// design — the merchant's side is EXACT and the buyer's side is a MAXIMUM,
// because the route's uncertainty is carried by the payer and never by the
// payee. Both are labelled as such in words, not by a tooltip.
//
// When `plan.refusals` is non-empty the pay control is not rendered at all. Not
// disabled — absent. A greyed-out button beside a red banner invites a reader to
// look for the condition that re-enables it; there isn't one, there is a reason.

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-white/55">{label}</span>
      <span className={emphasis ? 'text-sm font-semibold text-white' : 'text-sm text-white/85'}>{value}</span>
    </div>
  );
}

export function SettlementDisclosure({
  plan,
  onRefreshQuote,
}: {
  plan: SettlementPlan;
  onRefreshQuote?: () => void;
}) {
  const d = plan.disclosure;
  const signable = canSign(plan);

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Before you sign</h2>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-black/25 p-3">
          <p className="text-[11px] uppercase tracking-wide text-white/50">You pay — at most</p>
          <p className="mt-1 text-lg font-semibold text-white">
            {formatScaled(d.payAmountMax, d.payDecimals)} {d.paySymbol}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-white/60">
            A maximum, not a fixed price. The route's slippage is carried here — on your side — so the
            merchant's amount can stay exact.
          </p>
        </div>

        <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
          <p className="text-[11px] uppercase tracking-wide text-white/50">The merchant receives — exactly</p>
          <p className="mt-1 text-lg font-semibold text-white">
            {formatScaled(d.settleAmount, d.settleDecimals)} {d.settleSymbol}
          </p>
          <p className="mt-1 break-all text-[11px] leading-relaxed text-white/60">
            Sent straight to {d.merchant}. Nothing on this venue holds, forwards or escrows it.
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-white/10 pt-2">
        {plan.sameAsset ? (
          <Row label="Route" value="None — you already hold the settlement asset" />
        ) : (
          <>
            <Row
              label="Guaranteed to arrive"
              value={`${formatScaled(d.guaranteedOut, d.settleDecimals)} ${d.settleSymbol}`}
              emphasis
            />
            <Row label="Slippage tolerance" value={d.slippagePct === null ? '—' : `${d.slippagePct}%`} />
            <Row
              label="Quote age"
              value={d.quoteAgeSeconds === null ? '—' : `${d.quoteAgeSeconds}s`}
            />
            {d.buyerSurplus > 0n ? (
              <Row
                label="Left over — yours, not the merchant's"
                value={`${formatScaled(d.buyerSurplus, d.settleDecimals)} ${d.settleSymbol}`}
              />
            ) : null}
          </>
        )}
        <Row
          label="Invoice expires in"
          value={d.expiresInSeconds > 0 ? `${Math.floor(d.expiresInSeconds / 60)}m ${d.expiresInSeconds % 60}s` : 'expired'}
        />
      </div>

      {signable ? (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-white/60">
            What you will sign — {plan.legs.length} transaction{plan.legs.length === 1 ? '' : 's'}
          </p>
          <ol className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-white/75">
            {plan.legs.map((leg, i) =>
              leg.kind === 'swap' ? (
                <li key={`swap-${i}`}>
                  <span className="text-white/50">{i + 1}.</span> Swap {formatScaled(leg.amountIn, d.payDecimals)}{' '}
                  {d.paySymbol} for at least {formatScaled(leg.minOut, d.settleDecimals)} {d.settleSymbol} via{' '}
                  {leg.source}. The output lands in <em>your</em> wallet.
                </li>
              ) : (
                <li key={`transfer-${i}`}>
                  <span className="text-white/50">{i + 1}.</span> Transfer exactly{' '}
                  {formatScaled(leg.amount, d.settleDecimals)} {d.settleSymbol} to the merchant.
                </li>
              ),
            )}
          </ol>
          {plan.legs.length > 1 ? (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-200/80">
              These two are separate transactions and are not atomic. If you sign the first and abandon the
              second, you hold the {d.settleSymbol} and the merchant is unpaid — recoverable, and the reason
              step 2 moves the invoiced amount rather than whatever step 1 produced.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-rose-200/90">
            No payment is offered for this invoice
          </p>
          <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-white/80">
            {plan.refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {onRefreshQuote ? (
            <button type="button" onClick={onRefreshQuote} className="btn-secondary mt-3 px-4 py-1.5 text-[12px]">
              Get a fresh quote
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default SettlementDisclosure;
