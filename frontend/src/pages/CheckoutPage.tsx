import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { CheckoutWidget } from '../components/commerce/CheckoutWidget';
import { InvoiceBuilder } from '../components/commerce/InvoiceBuilder';
import { SubscriptionPanel } from '../components/commerce/SubscriptionPanel';

// CHECKOUT — pay an invoice, publish one, or set up recurring billing.
//
// Three refusals hold this page together, all of them enforced in lib/commerce
// rather than here:
//
//   1. The buyer sees the exact amount and the exact settlement asset before a
//      signature is offered, and no signature is offered at all when the route
//      cannot guarantee the merchant's exact amount — settlement.ts,
//      `buildSettlementPlan`. A checkout that quotes one number and settles
//      another is fraud with good intentions, which is why the refusal is a
//      returned value and not a warning banner.
//   2. Nothing here is custodial and nothing here can become custodial. Both
//      legs are signed in the buyer's own wallet with the merchant as the direct
//      recipient; api/_lib/commerce.js holds no key and has no signer, and
//      api/__tests__/commerce-surface-parity.test.js fails if one appears.
//   3. No subscription renews on its own. There is no keeper on this venue, so
//      every charge is either payer-signed or merchant-pulled, and
//      subscription.ts makes the panel say which — a subscription that silently
//      never renews is worse than none.
//
// The invoice store lives behind a migration an operator applies by hand, so
// until `021_commerce.sql` is run every lookup answers 503 `schema-missing` and
// the widget prints that with the operator step attached — deliberately NOT "no
// such invoice", which would tell a buyer their merchant's link is fake.

type Tab = 'pay' | 'sell' | 'subscriptions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'pay', label: 'Pay' },
  { id: 'sell', label: 'Get paid' },
  { id: 'subscriptions', label: 'Subscriptions' },
];

export default function CheckoutPage() {
  usePageTitle(
    'Checkout',
    'Pay a merchant in any token and settle in the one they asked for — with the exact amount and the exact ' +
      'settlement asset shown before you sign, and no signature offered when the route cannot guarantee it. ' +
      'Non-custodial: both legs are signed in your own wallet.',
  );

  const { search } = useLocation();
  const invoiceId = new URLSearchParams(search).get('invoice');
  // A link with an invoice on it opens on Pay; a merchant arriving cold does not
  // land on a form asking them to pay themselves.
  const [tab, setTab] = useState<Tab>(invoiceId ? 'pay' : 'sell');

  return (
    <div className="relative">
      <PageArtBackdrop pageId="checkout" />
      <div className="relative z-10 mx-auto w-full max-w-4xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Checkout</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            A merchant names an exact amount of an exact asset. A buyer pays in whatever they hold, sees the
            exact figure on both sides before signing, and sends the merchant's amount straight to the
            merchant. Nothing on this venue holds, forwards or escrows any of it, and no server here holds a
            key.
          </p>
        </header>

        <nav className="mt-6 flex flex-wrap gap-2" aria-label="Checkout sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`rounded-full px-4 py-1.5 text-[13px] ${
                tab === t.id ? 'bg-white/15 text-white' : 'bg-white/[0.04] text-white/70'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="mt-6">
          {tab === 'pay' ? <CheckoutWidget invoiceId={invoiceId} /> : null}
          {tab === 'sell' ? <InvoiceBuilder /> : null}
          {tab === 'subscriptions' ? <SubscriptionPanel /> : null}
        </div>

        <p className="mt-8 text-[11px] leading-relaxed text-white/45">
          This venue runs no keeper. Nothing on this page executes on a schedule — a subscription charge, a
          settlement notification and an invoice expiry all happen because somebody with a signer acts, or
          they do not happen.
        </p>
      </div>
    </div>
  );
}
