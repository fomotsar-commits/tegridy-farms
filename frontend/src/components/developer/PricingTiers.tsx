import type { ApiTier } from '../../../api/_lib/apiTiers';
import { API_TIERS, API_TIER_ORDER, API_BILLING_ENABLED, API_PRICING_STATE } from '../../../api/_lib/apiTiers.js';

/**
 * The table is built from the SAME module the limiter enforces
 * (api/_lib/apiTiers.js), not from copy typed into this file. A page that
 * advertises 300 rpm while the limiter grants 10 is not a stale document, it is a
 * false claim about a product someone paid for — and the only way to keep two
 * numbers in lock-step is for the second one not to exist.
 */
const TIERS: ApiTier[] = API_TIER_ORDER.map((id) => API_TIERS[id]).filter(
  (t): t is ApiTier => t !== undefined,
);

function money(n: number): string {
  return n === 0 ? 'Free' : `$${n.toLocaleString('en-US')}/mo`;
}

export function PricingTiers() {
  return (
    <section aria-labelledby="pricing-heading">
      <h2 id="pricing-heading" className="text-2xl font-bold mb-2">
        Tiers
      </h2>

      {/*
        The disclosure sits ABOVE the numbers, not in a footnote under them. This is
        an unproven revenue category launching with design partners, and billing is
        not wired at all — a reader who sees "$499/mo" and has to scroll to learn
        that nothing can take their money has already been misled.
      */}
      {API_PRICING_STATE !== 'published' && (
        <p
          className="mb-4 rounded-xl px-4 py-3 text-sm"
          style={{ border: '1px solid var(--color-purple-12)', background: 'rgba(0,0,0,0.25)' }}
          data-testid="pricing-disclosure"
        >
          <strong>These prices are proposed, not live.</strong> No payment processor is connected to
          this deployment, nothing here takes a card, and no invoice is issued. Paid tiers are
          granted by the operator after a settled agreement.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="pricing-table">
          <thead>
            <tr className="text-left opacity-70">
              <th className="py-2 pr-4">Tier</th>
              <th className="py-2 pr-4">Price</th>
              <th className="py-2 pr-4">Included calls / month</th>
              <th className="py-2 pr-4">Rate limit</th>
              <th className="py-2 pr-4">Past the quota</th>
              <th className="py-2">Issued by</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((tier) => (
              <tr key={tier.id} style={{ borderTop: '1px solid var(--color-purple-12)' }}>
                <th scope="row" className="py-3 pr-4 font-semibold text-left">
                  {tier.label}
                  <span className="block font-normal opacity-70">{tier.blurb}</span>
                </th>
                <td className="py-3 pr-4 whitespace-nowrap">{money(tier.priceUsdMonthly)}</td>
                <td className="py-3 pr-4">{tier.includedCallsPerMonth.toLocaleString('en-US')}</td>
                <td className="py-3 pr-4 whitespace-nowrap">{tier.rateLimitPerMinute} req/min</td>
                <td className="py-3 pr-4">
                  {/*
                    An overage RATE next to a limiter that silently 429s is the same
                    lie in two places. While billing is off the quota is a hard stop
                    for every tier, and this cell says so instead of quoting a price
                    nothing can charge.
                  */}
                  {API_BILLING_ENABLED && tier.overageUsdPerCall !== null
                    ? `$${tier.overageUsdPerCall}/call`
                    : 'Hard stop — 429 until the month rolls over'}
                </td>
                <td className="py-3">
                  {tier.selfServe && tier.priceUsdMonthly === 0 ? 'Self-serve' : 'Operator'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!API_BILLING_ENABLED && (
        <p className="mt-3 text-xs opacity-70">
          Overage rates are published so integrators can model cost. They are not charged on this
          deployment: with no processor wired, serving past the quota would give the product away
          under a price list that says otherwise, so the quota stops instead.
        </p>
      )}
    </section>
  );
}
